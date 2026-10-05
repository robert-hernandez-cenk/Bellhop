import type { WebLoginConfig } from '../../src/web/login/config.ts';
import { SESSION_COOKIE } from '../../src/web/login/cookies.ts';
import { SessionStore } from '../../src/web/login/session-store.ts';
import { SessionService } from '../../src/web/login/sessions.ts';
import { FakeWebLoginClient } from './fake-web-login-client.ts';

// Session fixtures for web tests (#69, research R14): an in-memory store and
// a SessionService over a FakeWebLoginClient, plus a way to mint a signed-in
// Cookie header without going through /auth/login. Pass the returned service
// as buildApp's `sessions` dep and `.set('Cookie', sessionCookie(...))`.

// An example configured OIDC web login, so a test whose clock makes a
// re-check due reaches the fake client instead of reading the real settings
// store. Example values only (constitution Principle I).
export const TEST_WEB_LOGIN_CONFIG: Extract<WebLoginConfig, { configured: true }> = {
  configured: true,
  issuer: 'https://authentik.example.com/application/o/bellhop/',
  clientId: 'example-client-id',
  clientSecret: 'example-client-secret',
  redirectUri: 'https://bellhop.example.com/auth/callback',
};

export type TestSessions = SessionService & { client: FakeWebLoginClient };

export interface TestSessionsOptions {
  client?: FakeWebLoginClient;
  // The store's clock (epoch ms); defaults to Date.now.
  now?: () => number;
  // Defaults to TEST_WEB_LOGIN_CONFIG.
  config?: () => WebLoginConfig;
}

export function newTestSessions(opts: TestSessionsOptions = {}): TestSessions {
  const client = opts.client ?? new FakeWebLoginClient();
  const store = new SessionStore(':memory:', opts.now);
  const service = new SessionService({ store, client, config: opts.config ?? (() => TEST_WEB_LOGIN_CONFIG) });
  return Object.assign(service, { client });
}

export interface TestSessionUser {
  username: string;
  groups: string[];
  uid?: string;
  email?: string;
}

// Inserts a fresh session (checked just now, so its first use makes no
// provider call) and returns the Cookie header value carrying it.
export function sessionCookie(sessions: SessionService, user: TestSessionUser): string {
  const id = sessions.create({
    username: user.username,
    uid: user.uid ?? `uid-${user.username}`,
    ...(user.email !== undefined ? { email: user.email } : {}),
    groups: user.groups,
    refreshToken: 'example-refresh-token',
    idToken: 'example-id-token',
  });
  return `${SESSION_COOKIE}=${id}`;
}
