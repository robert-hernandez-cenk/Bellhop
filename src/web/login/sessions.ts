import { logInfo, logWarn } from '../../lib/log.ts';
import type { AuthUser } from '../auth.ts';
import { webLoginConfig, type WebLoginConfig } from './config.ts';
import type { LoginIdentity, RecheckResult, WebLoginClient } from './oidc-client.ts';
import { hashId, type SessionRecord, type SessionStore } from './session-store.ts';

// Turns a bellhop_session cookie into the signed-in user (#69, data-model.md
// "State transitions", research R4). The store owns persistence and the
// clock; this service owns the re-check policy: a session's identity is
// asked of the provider again (refresh grant + userinfo) at most every 5
// minutes, a refusal signs the user out, and an outage keeps the last-known
// identity and retries after a minute -- so a provider blip does not sign
// everyone out, while a deactivated user or changed group lands within 5
// minutes of their next request.

export interface SessionServiceDeps {
  store: SessionStore;
  client: WebLoginClient;
  // Read on every re-check, never cached, so a Settings-page change applies
  // without a restart (R7). Tests inject a fixed config.
  config?: () => WebLoginConfig;
}

export class SessionService {
  readonly store: SessionStore;
  readonly client: WebLoginClient;
  private readonly config: () => WebLoginConfig;
  // Single-flight re-checks, keyed by the session's id hash (R4). Authentik
  // rotates the refresh token on every use, so two concurrent requests from
  // one browser each presenting the stored token would make the second one
  // get invalid_grant and wrongly sign the user out. One service process
  // owns the store, so an in-process map is enough. An entry is removed as
  // soon as its re-check settles.
  private readonly inflight = new Map<string, Promise<AuthUser | undefined>>();

  constructor(deps: SessionServiceDeps) {
    this.store = deps.store;
    this.client = deps.client;
    this.config = deps.config ?? (() => webLoginConfig());
  }

  // Stores a session for a completed sign-in and returns the raw cookie
  // value. It counts as checked just now, so its first use makes no
  // provider call.
  create(identity: LoginIdentity): string {
    return this.store.createSession({
      username: identity.username,
      uid: identity.uid,
      email: identity.email ?? null,
      groups: identity.groups,
      refreshToken: identity.refreshToken,
      idToken: identity.idToken,
    });
  }

  // Sign-out. Returns the deleted session (its idToken is the end-session
  // hint), or undefined if there was none.
  destroy(rawId: string): SessionRecord | undefined {
    const session = this.store.getSession(rawId);
    if (session) this.store.deleteSession(rawId);
    return session;
  }

  // The signed-in user for a raw cookie value, or undefined when the
  // session is unknown, past 30 days, or refused on re-check.
  async resolve(rawId: string): Promise<AuthUser | undefined> {
    const session = this.store.getSession(rawId);
    if (!session) return undefined;
    if (!this.store.checkDue(session)) return toAuthUser(session);
    const key = hashId(rawId);
    const pending = this.inflight.get(key);
    if (pending) return pending;
    // Registered synchronously, before the first await, so a second request
    // arriving while this one waits on the provider joins it.
    const check = this.recheck(rawId, session).finally(() => this.inflight.delete(key));
    this.inflight.set(key, check);
    return check;
  }

  private async recheck(rawId: string, session: SessionRecord): Promise<AuthUser | undefined> {
    let cfg: WebLoginConfig;
    try {
      cfg = this.config();
    } catch (err) {
      // Controller ruling: an invalid environment-sourced OIDC value is an
      // operator mistake, not a verdict on this session -- treat it as
      // unreachable (keep the identity, retry after a minute). The message
      // names the key and env var, never the value (config.ts).
      this.store.markCheckAttempt(rawId);
      logWarn(`Web login re-check for ${session.username} skipped: ${(err as Error).message}; keeping the last-known identity`);
      return toAuthUser(session);
    }
    if (!cfg.configured) {
      // Controller ruling: with no client configured nothing can vouch for
      // the session any more, so it is treated as refused.
      this.store.deleteSession(rawId);
      logInfo(`Signed out ${session.username}: web login is no longer configured, so the session cannot be re-checked`);
      return undefined;
    }

    let result: RecheckResult;
    try {
      result = await this.client.recheck(cfg, session.refreshToken, session.uid);
    } catch {
      // The client is not supposed to throw; if it does, no answer came back
      // from the provider. Its message is not logged: an unexpected error
      // carries no secrecy guarantee.
      result = { kind: 'unreachable', reason: `Re-check with ${cfg.issuer} failed: unexpected error` };
    }

    switch (result.kind) {
      case 'ok': {
        const { identity } = result;
        this.store.updateAfterCheck(rawId, {
          username: identity.username,
          email: identity.email ?? null,
          groups: identity.groups,
          refreshToken: identity.refreshToken,
          ...(identity.idToken !== undefined ? { idToken: identity.idToken } : {}),
        });
        // Re-read rather than build from `identity`: a sign-out that landed
        // while the provider was answering has deleted the row, and the
        // update above then matched nothing.
        const updated = this.store.getSession(rawId);
        return updated ? toAuthUser(updated) : undefined;
      }
      case 'refused':
        this.store.deleteSession(rawId);
        // `reason` names the issuer and an OAuth error code only (oidc-client.ts).
        logInfo(`Signed out ${session.username}: ${result.reason}`);
        return undefined;
      case 'unreachable':
        // Persist any token the grant already rotated (see RecheckResult),
        // keeping the identity as it was.
        this.store.markCheckAttempt(rawId, {
          ...(result.refreshToken !== undefined ? { refreshToken: result.refreshToken } : {}),
          ...(result.idToken !== undefined ? { idToken: result.idToken } : {}),
        });
        // `reason` names the issuer and the failure, never a token.
        logWarn(`${result.reason}; keeping the last-known identity for ${session.username} and retrying in a minute`);
        return toAuthUser(session);
    }
  }
}

function toAuthUser(session: SessionRecord): AuthUser {
  return {
    username: session.username,
    uid: session.uid,
    ...(session.email !== null ? { email: session.email } : {}),
    groups: session.groups,
    viaOidc: true,
  };
}
