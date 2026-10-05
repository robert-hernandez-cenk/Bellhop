import * as oidc from 'openid-client';
import type { WebLoginConfig } from './config.ts';

// Bellhop's own OIDC relying party for the web UI (#69 research R1). Routes,
// requireAuth and the session service depend only on the WebLoginClient
// interface; RealWebLoginClient is the one file in the codebase that imports
// openid-client, and route tests inject a fake (the repo's SSHClient /
// AuthentikClient injection pattern).
//
// Secrecy: no message produced here -- a thrown WebLoginError or a recheck
// `reason` -- ever carries the client secret, a refresh token, an access
// token or an ID token. They name the issuer and an OAuth error code or a
// fixed library message, nothing more. Library errors are deliberately not
// attached as `cause`: their causes hold Response objects and decoded claims,
// and a logger that prints the cause chain would print them.

// The configured branch of webLoginConfig(): everything needed to talk to the
// provider. Read per request by the caller, so a Settings change applies on
// the next call (R7).
export type WebLoginSettings = Extract<WebLoginConfig, { configured: true }>;

// What a sign-in attempt must remember between /auth/login and /auth/callback
// (stored server-side in login_attempts, never in the browser).
export interface PendingLogin {
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface StartedLogin extends PendingLogin {
  authorizationUrl: string;
}

export interface LoginIdentity {
  username: string; // preferred_username (required)
  uid: string; // sub
  email?: string;
  groups: string[]; // group names; absent claim = []
  refreshToken: string;
  idToken: string;
}

// After a refresh the provider may or may not issue a new ID token (optional
// in OIDC). `idToken` is undefined when it did not, and the caller keeps the
// one it already has (it is only used as id_token_hint at sign-out).
// `refreshToken` is always set: the rotated one, or the presented one when the
// provider does not rotate.
export type RecheckIdentity = Omit<LoginIdentity, 'idToken'> & { idToken?: string };

// R4: `refused` means the provider says this session is no longer valid
// (the caller deletes it); `unreachable` means we could not get an answer
// (the caller keeps the last-known identity and retries later).
export type RecheckResult =
  | { kind: 'ok'; identity: RecheckIdentity }
  | { kind: 'refused'; reason: string }
  // When the refresh grant itself succeeded but a later step (userinfo) could
  // not get an answer, the provider has already consumed the presented
  // refresh token (Authentik rotates on use). `refreshToken`/`idToken` then
  // carry what the grant returned, and the caller MUST persist them while
  // keeping the last-known identity -- otherwise its next re-check presents
  // the consumed token, gets invalid_grant, and signs the user out over a
  // transient outage. Both are absent when the grant never returned.
  | { kind: 'unreachable'; reason: string; refreshToken?: string; idToken?: string };

export interface WebLoginClient {
  startLogin(cfg: WebLoginSettings): Promise<StartedLogin>;
  // `callbackUrl` is the URL the browser arrived at /auth/callback with; only
  // its query string is read (see completeLogin below).
  completeLogin(cfg: WebLoginSettings, callbackUrl: string | URL, pending: PendingLogin): Promise<LoginIdentity>;
  recheck(cfg: WebLoginSettings, refreshToken: string, expectedSub: string): Promise<RecheckResult>;
  // undefined when the provider advertises no end_session_endpoint, or when
  // discovery fails: sign-out must never fail because the provider is down
  // (contracts/http-auth.md, R13).
  endSessionUrl(cfg: WebLoginSettings, idToken: string, postLogoutRedirectUri: string): Promise<string | undefined>;
}

// contracts/http-auth.md. offline_access is what makes Authentik issue a
// refresh token (R15).
export const LOGIN_SCOPE = 'openid profile email offline_access';

// Matches the bound the repo uses for Authentik API calls. openid-client's
// own default is 30 s, too long for a request blocked on a re-check.
const DEFAULT_TIMEOUT_SECONDS = 10;

// `code` lets the routes tell "could not reach the provider" (502 page) from
// "this sign-in failed" (400 page) without parsing the message.
export class WebLoginError extends Error {
  constructor(
    message: string,
    readonly code: 'discovery_failed' | 'login_failed'
  ) {
    super(message);
    this.name = 'WebLoginError';
  }
}

// An identity the provider returned but Bellhop cannot accept. Internal: it is
// turned into a WebLoginError (sign-in) or a refusal (re-check).
class IdentityError extends Error {}

export interface RealWebLoginClientOptions {
  // TESTS ONLY: lets openid-client talk plain HTTP to the in-process fake
  // provider (test/support/fake-oidc-provider.ts). Production never sets it;
  // a real issuer is always https.
  allowInsecureRequests?: boolean;
  // Per-request timeout, in seconds. Tests shorten it to exercise timeouts.
  timeoutSeconds?: number;
}

export class RealWebLoginClient implements WebLoginClient {
  // A single-slot cache (R7): one deployment has one OIDC configuration at a
  // time, so a settings change simply replaces the entry. Keyed by
  // (issuer, clientId, clientSecret) so a changed secret or client id gets a
  // fresh Configuration. The promise is cached so concurrent first requests
  // share one discovery; a rejected one is dropped so the next call retries.
  private cached: { key: string; config: Promise<oidc.Configuration> } | undefined;

  constructor(private readonly options: RealWebLoginClientOptions = {}) {}

  private discover(cfg: WebLoginSettings): Promise<oidc.Configuration> {
    const key = JSON.stringify([cfg.issuer, cfg.clientId, cfg.clientSecret]);
    if (this.cached?.key === key) return this.cached.config;
    const execute: Array<(c: oidc.Configuration) => void> = [
      // Also verify ID-token signatures against the JWKS, not only the claims.
      // openid-client skips this for tokens received straight from the token
      // endpoint (TLS already authenticates the issuer); checking anyway costs
      // one cached JWKS fetch and means a token Bellhop accepts was provably
      // minted by the provider's key.
      oidc.enableNonRepudiationChecks,
    ];
    if (this.options.allowInsecureRequests) execute.push(oidc.allowInsecureRequests);
    const config = oidc
      .discovery(new URL(cfg.issuer), cfg.clientId, undefined, oidc.ClientSecretPost(cfg.clientSecret), {
        execute,
        timeout: this.options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
      })
      .catch((err: unknown) => {
        if (this.cached?.key === key) this.cached = undefined;
        throw new WebLoginError(
          `Could not reach the identity provider at ${cfg.issuer} (${describe(err)})`,
          'discovery_failed'
        );
      });
    this.cached = { key, config };
    return config;
  }

  async startLogin(cfg: WebLoginSettings): Promise<StartedLogin> {
    const config = await this.discover(cfg);
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const url = oidc.buildAuthorizationUrl(config, {
      response_type: 'code',
      redirect_uri: cfg.redirectUri,
      scope: LOGIN_SCOPE,
      state,
      nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: 'S256',
    });
    return { authorizationUrl: url.href, state, nonce, codeVerifier };
  }

  async completeLogin(cfg: WebLoginSettings, callbackUrl: string | URL, pending: PendingLogin): Promise<LoginIdentity> {
    const config = await this.discover(cfg);
    // openid-client sends the URL it is given (minus its query) as the token
    // request's redirect_uri, which must equal the one in the authorization
    // request. Behind a reverse proxy the URL Express sees has the internal
    // origin, so rebuild it from the configured redirect URI and keep only
    // the callback's query (code, state, error...).
    const current = new URL(cfg.redirectUri);
    current.search = new URL(callbackUrl, cfg.redirectUri).search;
    const fail = (reason: string) => new WebLoginError(`Sign-in with ${cfg.issuer} failed: ${reason}`, 'login_failed');

    let tokens: Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>;
    try {
      // Validates state, then exchanges the code with the PKCE verifier and
      // checks the ID token's signature, iss, aud, exp and nonce.
      tokens = await oidc.authorizationCodeGrant(config, current, {
        expectedState: pending.state,
        expectedNonce: pending.nonce,
        pkceCodeVerifier: pending.codeVerifier,
        idTokenExpected: true,
      });
    } catch (err) {
      throw fail(describe(err));
    }
    const claims = tokens.claims();
    if (!claims || !tokens.id_token) throw fail('the provider returned no ID token');
    // R15: without a refresh token the session could never be re-checked.
    if (!tokens.refresh_token) {
      throw fail(
        'the provider issued no refresh token. Attach the offline_access scope mapping ' +
          "(goauthentik.io/providers/oauth2/scope-offline_access) to Bellhop's OAuth2 provider -- " +
          'run: bellhop sync-authentik --apply'
      );
    }
    try {
      // R2: userinfo is the source of truth (re-checks must use it anyway),
      // with ID-token claims as the fallback for anything it omits.
      const userinfo = await oidc.fetchUserInfo(config, tokens.access_token, claims.sub);
      return { ...buildIdentity(claims.sub, userinfo, claims, tokens.refresh_token), idToken: tokens.id_token };
    } catch (err) {
      throw fail(describe(err));
    }
  }

  async recheck(cfg: WebLoginSettings, refreshToken: string, expectedSub: string): Promise<RecheckResult> {
    let config: oidc.Configuration;
    try {
      config = await this.discover(cfg);
    } catch (err) {
      // Never `refused`: a broken or unreachable discovery document (even a
      // 404 from a mistyped issuer) says nothing about this session.
      return { kind: 'unreachable', reason: (err as Error).message };
    }
    // Set once the grant returns: from then on the presented refresh token
    // is spent, so every later failure has to hand the new one back.
    let granted: { refreshToken?: string; idToken?: string } | undefined;
    try {
      const tokens = await oidc.refreshTokenGrant(config, refreshToken);
      granted = { refreshToken: tokens.refresh_token, idToken: tokens.id_token };
      // A refreshed ID token is optional; when present its iss/aud/exp were
      // validated by openid-client, but its sub must still be the same user.
      const claims = tokens.claims();
      if (claims && claims.sub !== expectedSub) throw new IdentityError('the refreshed ID token is for a different subject');
      const userinfo = await oidc.fetchUserInfo(config, tokens.access_token, expectedSub);
      return {
        kind: 'ok',
        identity: {
          ...buildIdentity(expectedSub, userinfo, claims, tokens.refresh_token ?? refreshToken),
          idToken: tokens.id_token,
        },
      };
    } catch (err) {
      if (classify(err) === 'refused') {
        // The session is deleted, so a rotated token has nothing to go to.
        return { kind: 'refused', reason: `Re-check with ${cfg.issuer} was refused: ${describe(err)}` };
      }
      return {
        kind: 'unreachable',
        reason: `Re-check with ${cfg.issuer} failed: ${describe(err)}`,
        ...(granted?.refreshToken ? { refreshToken: granted.refreshToken } : {}),
        ...(granted?.idToken ? { idToken: granted.idToken } : {}),
      };
    }
  }

  async endSessionUrl(cfg: WebLoginSettings, idToken: string, postLogoutRedirectUri: string): Promise<string | undefined> {
    let config: oidc.Configuration;
    try {
      config = await this.discover(cfg);
    } catch {
      return undefined;
    }
    if (!config.serverMetadata().end_session_endpoint) return undefined;
    return oidc.buildEndSessionUrl(config, {
      id_token_hint: idToken,
      post_logout_redirect_uri: postLogoutRedirectUri,
    }).href;
  }
}

type Claims = Record<string, unknown>;

function buildIdentity(sub: string, userinfo: Claims, idClaims: Claims | undefined, refreshToken: string): Omit<LoginIdentity, 'idToken'> {
  const pick = (name: string): unknown => (userinfo[name] !== undefined ? userinfo[name] : idClaims?.[name]);
  const username = pick('preferred_username');
  if (typeof username !== 'string' || username === '') {
    throw new IdentityError("the provider returned no preferred_username claim (check the provider's profile scope mapping)");
  }
  const email = pick('email');
  const groups = pick('groups');
  return {
    username,
    uid: sub,
    ...(typeof email === 'string' && email !== '' ? { email } : {}),
    groups: Array.isArray(groups) ? groups.filter((g): g is string => typeof g === 'string') : [],
    refreshToken,
  };
}

// R4's split, decided by whether there is evidence the provider answered.
// Unreachable -- no answer: a network error (fetch's TypeError), a timeout or
// abort, or an HTTP 5xx. Refused -- everything else, because the provider
// did answer and the answer does not hold up: an OAuth error or any non-5xx
// error status (invalid_grant, invalid_client, a userinfo 401), a sub
// mismatch, and any failure processing a 2xx response (an ID token with a bad
// signature, wrong aud/iss, expired, a missing required claim, an
// unparseable body) -- the same treatment as a wrong aud. Discovery failures
// never reach here; recheck() maps them to unreachable itself.
function classify(err: unknown): 'refused' | 'unreachable' {
  const status = httpStatus(err);
  if (status !== undefined) return status >= 500 ? 'unreachable' : 'refused';
  if (err instanceof TypeError) return 'unreachable';
  if (err instanceof oidc.ClientError && (err.code === 'OAUTH_TIMEOUT' || err.code === 'OAUTH_ABORT')) return 'unreachable';
  if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) return 'unreachable';
  return 'refused';
}

function httpStatus(err: unknown): number | undefined {
  if (err instanceof oidc.ResponseBodyError || err instanceof oidc.WWWAuthenticateChallengeError) return err.status;
  // "unexpected HTTP response status code": openid-client puts the Response
  // in `cause`.
  if (err instanceof oidc.ClientError && err.cause instanceof Response) return err.cause.status;
  return undefined;
}

// A short, secret-free description of a failure for messages and logs.
function describe(err: unknown): string {
  if (err instanceof IdentityError) return err.message;
  // The OAuth error code only; error_description is provider free text.
  if (err instanceof oidc.ResponseBodyError) return `HTTP ${err.status} ${err.error}`;
  if (err instanceof oidc.AuthorizationResponseError) return `the provider returned ${err.error}`;
  if (err instanceof oidc.WWWAuthenticateChallengeError) {
    const challenge = err.cause[0]?.parameters.error;
    return `HTTP ${err.status}${challenge ? ` ${challenge}` : ''}`;
  }
  const status = httpStatus(err);
  if (status !== undefined) return `HTTP ${status}`;
  if (err instanceof Error) {
    // openid-client's and oauth4webapi's messages are fixed text (they name
    // a claim or an attribute, never its value); a fetch TypeError's cause
    // carries the system error code (ECONNREFUSED...).
    const cause = err.cause instanceof Error ? err.cause : undefined;
    const code = (cause as { code?: unknown } | undefined)?.code;
    if (err instanceof TypeError) return `${err.message}${typeof code === 'string' ? ` (${code})` : ''}`;
    return cause && cause.message !== err.message ? `${err.message}: ${cause.message}` : err.message;
  }
  return 'unknown error';
}
