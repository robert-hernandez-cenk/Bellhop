import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from '../../../src/web/app.ts';
import { JobStore } from '../../../src/web/jobs/job-store.ts';
import { createJobLog } from '../../../src/web/jobs/job-log.ts';
import { JobRunner } from '../../../src/web/jobs/job-runner.ts';
import { WebLoginError, type LoginIdentity, type StartedLogin } from '../../../src/web/login/oidc-client.ts';
import { FakeSSHClient } from '../../support/fake-ssh-client.ts';
import { FakeAuthentikClient } from '../../support/fake-authentik-client.ts';
import { resetConfigStore, tempConfigStore } from '../../support/config-store.ts';
import { newTestSessions, sessionCookie, TEST_WEB_LOGIN_CONFIG, type TestSessions } from '../../support/web-session.ts';

// GET /auth/login and GET /auth/callback (#69 US1, contracts/http-auth.md).
// The provider is a FakeWebLoginClient (the SessionService's client); the
// OIDC settings come from a temp settings store, read exactly as production
// reads them.

afterEach(resetConfigStore);

const ISSUER = TEST_WEB_LOGIN_CONFIG.issuer;
const AUTHORIZATION_URL = 'https://authentik.example.com/application/o/authorize/?client_id=example-client-id';

// The values no response may ever carry: the client secret, the provider's
// tokens and the attempt's PKCE verifier.
const SECRETS = ['example-client-secret', 'example-refresh-token', 'example-id-token', 'example-code-verifier'];

function configureWebLogin(): void {
  tempConfigStore(
    {
      webUiOidcIssuer: ISSUER,
      webUiOidcClientId: TEST_WEB_LOGIN_CONFIG.clientId,
      webUiOidcRedirectUri: TEST_WEB_LOGIN_CONFIG.redirectUri,
    },
    { webUiOidcClientSecret: 'example-client-secret' }
  );
}

function testApp(sessions: TestSessions = newTestSessions()) {
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const app = buildApp({
    inventory: { domain: 'example.com', hosts: [], guests: [] },
    baseSsh: ssh,
    jobStore,
    jobLog,
    jobRunner: new JobRunner(jobStore, jobLog, ssh),
    inventoryPath: path.join(mkdtempSync(path.join(tmpdir(), 'inventory-')), 'bellhop.db'),
    authentik: new FakeAuthentikClient(),
    sessions,
  });
  return { app, sessions };
}

const started = (state = 'example-state'): StartedLogin => ({
  authorizationUrl: AUTHORIZATION_URL,
  state,
  nonce: 'example-nonce',
  codeVerifier: 'example-code-verifier',
});

const identity: LoginIdentity = {
  username: 'alice',
  uid: 'uid-alice',
  email: 'alice@example.com',
  groups: ['bellhop-admins'],
  refreshToken: 'example-refresh-token',
  idToken: 'example-id-token',
};

function setCookies(res: request.Response): string[] {
  const raw = res.headers['set-cookie'] as unknown;
  if (raw === undefined) return [];
  return Array.isArray(raw) ? raw : [String(raw)];
}

function cookieNamed(res: request.Response, name: string): string | undefined {
  return setCookies(res).find((c) => c.startsWith(`${name}=`));
}

// The bellhop_login value /auth/login set, as the browser would send it back.
function loginCookieFrom(res: request.Response): string {
  const cookie = cookieNamed(res, 'bellhop_login');
  assert.ok(cookie, `expected a bellhop_login cookie, got: ${setCookies(res).join(' | ')}`);
  return cookie.split(';')[0]!;
}

function assertNoSecrets(res: request.Response): void {
  const text = `${res.text ?? ''} ${JSON.stringify(res.headers)}`;
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `response leaked ${secret}`);
}

// Starts a sign-in and returns the cookie tying the browser to it.
async function startLogin(app: ReturnType<typeof testApp>['app'], sessions: TestSessions, returnTo?: string, state?: string) {
  sessions.client.startLoginResults.push(started(state));
  const url = returnTo === undefined ? '/auth/login' : `/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
  const res = await request(app).get(url);
  assert.equal(res.status, 302, res.text);
  return loginCookieFrom(res);
}

// --- GET /auth/login ----------------------------------------------------------

test('GET /auth/login with web login not configured shows a page listing the missing keys and both fixes', async () => {
  resetConfigStore();
  const { app, sessions } = testApp();
  const res = await request(app).get('/auth/login');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.match(res.text, /Web login is not configured/);
  for (const key of ['webUiOidcIssuer', 'webUiOidcClientId', 'webUiOidcRedirectUri', 'webUiOidcClientSecret']) {
    assert.ok(res.text.includes(key), `expected the page to name ${key}`);
  }
  assert.ok(res.text.includes('bellhop configure-web-login &lt;entry&gt; --apply'), res.text);
  assert.ok(res.text.includes('bellhop set-config webUiAuthMode none --apply'), res.text);
  assert.equal(sessions.client.calls.length, 0);
});

test('GET /auth/login lists only the keys still missing', async () => {
  tempConfigStore({ webUiOidcIssuer: ISSUER, webUiOidcClientId: 'example-client-id' });
  const { app } = testApp();
  const res = await request(app).get('/auth/login');
  assert.equal(res.status, 200);
  assert.ok(res.text.includes('webUiOidcRedirectUri'));
  assert.ok(res.text.includes('webUiOidcClientSecret'));
  assert.ok(!res.text.includes('webUiOidcIssuer'), 'a key that is set is not listed as missing');
});

test('GET /auth/login with an invalid environment value names the key and variable, never the value', async () => {
  resetConfigStore();
  const original = process.env.WEB_UI_OIDC_ISSUER;
  process.env.WEB_UI_OIDC_ISSUER = 'not-a-url-example-value';
  try {
    const { app } = testApp();
    const res = await request(app).get('/auth/login');
    assert.equal(res.status, 200);
    assert.ok(res.text.includes('webUiOidcIssuer'));
    assert.ok(res.text.includes('WEB_UI_OIDC_ISSUER'));
    assert.ok(!res.text.includes('not-a-url-example-value'), 'the invalid value must not be echoed');
  } finally {
    if (original === undefined) delete process.env.WEB_UI_OIDC_ISSUER;
    else process.env.WEB_UI_OIDC_ISSUER = original;
  }
});

test('GET /auth/login answers 502 naming the issuer when discovery fails, with a Try again link', async () => {
  configureWebLogin();
  const { app, sessions } = testApp();
  sessions.client.startLoginResults.push(() => {
    throw new WebLoginError(`Could not reach the identity provider at ${ISSUER} (fetch failed)`, 'discovery_failed');
  });
  const res = await request(app).get('/auth/login?returnTo=%2Fjobs');
  assert.equal(res.status, 502);
  assert.ok(res.text.includes(`Could not reach the identity provider at ${ISSUER}`), res.text);
  assert.ok(res.text.includes('href="/auth/login?returnTo=%2Fjobs"'), res.text);
  assert.match(res.text, /Try again/);
  assert.equal(cookieNamed(res, 'bellhop_login'), undefined);
  assertNoSecrets(res);
});

test('GET /auth/login redirects to the provider and sets the bellhop_login cookie', async () => {
  configureWebLogin();
  const { app, sessions } = testApp();
  sessions.client.startLoginResults.push(started());
  const res = await request(app).get('/auth/login');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, AUTHORIZATION_URL);
  const cookie = cookieNamed(res, 'bellhop_login');
  assert.ok(cookie);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /Secure/i);
  assert.match(cookie, /SameSite=Lax/i);
  assert.match(cookie, /Path=\/auth(;|$)/);
  assert.match(cookie, /Max-Age=600/);
  // The started login was asked for with the configured settings.
  assert.deepEqual(sessions.client.callsTo('startLogin')[0]!.cfg, TEST_WEB_LOGIN_CONFIG);
  assertNoSecrets(res);
});

test('GET /auth/login is reachable without a session in oidc mode', async () => {
  tempConfigStore({ webUiAuthMode: 'oidc' });
  const original = process.env.WEB_UI_DEV_USER;
  delete process.env.WEB_UI_DEV_USER;
  try {
    const { app } = testApp();
    const res = await request(app).get('/auth/login');
    assert.equal(res.status, 200);
    assert.match(res.text, /Web login is not configured/);
  } finally {
    if (original !== undefined) process.env.WEB_UI_DEV_USER = original;
  }
});

// --- returnTo: kept only for same-origin paths (FR-011) -------------------------

for (const [returnTo, expected] of [
  ['/jobs?x=1', '/jobs?x=1'],
  ['/', '/'],
  ['//evil.example', '/'],
  ['/\\evil.example', '/'],
  ['https://evil.example', '/'],
  ['javascript:alert(1)', '/'],
  ['jobs', '/'],
] as const) {
  test(`returnTo ${JSON.stringify(returnTo)} lands the signed-in browser on ${expected}`, async () => {
    configureWebLogin();
    const { app, sessions } = testApp();
    const loginCookie = await startLogin(app, sessions, returnTo);
    sessions.client.completeLoginResults.push(identity);
    const res = await request(app).get('/auth/callback?code=example-code&state=example-state').set('Cookie', loginCookie);
    assert.equal(res.status, 302, res.text);
    assert.equal(res.headers.location, expected);
  });
}

// --- GET /auth/callback -----------------------------------------------------------

test('GET /auth/callback signs the user in: bellhop_session set, bellhop_login cleared, redirect to returnTo', async () => {
  configureWebLogin();
  const { app, sessions } = testApp();
  const loginCookie = await startLogin(app, sessions, '/jobs');
  sessions.client.completeLoginResults.push(identity);
  const res = await request(app).get('/auth/callback?code=example-code&state=example-state').set('Cookie', loginCookie);
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/jobs');

  const session = cookieNamed(res, 'bellhop_session');
  assert.ok(session, `expected a bellhop_session cookie, got: ${setCookies(res).join(' | ')}`);
  assert.match(session, /HttpOnly/i);
  assert.match(session, /Secure/i);
  assert.match(session, /SameSite=Lax/i);
  assert.match(session, /Path=\/(;|$)/);
  assert.match(session, /Max-Age=2592000/);
  const cleared = cookieNamed(res, 'bellhop_login');
  assert.ok(cleared, 'the login cookie is cleared');
  assert.match(cleared, /Expires=Thu, 01 Jan 1970/);

  // completeLogin got the attempt's stored state/nonce/verifier and the
  // callback URL the browser arrived with.
  const call = sessions.client.callsTo('completeLogin')[0]!;
  assert.deepEqual(call.pending, { state: 'example-state', nonce: 'example-nonce', codeVerifier: 'example-code-verifier' });
  assert.match(call.callbackUrl, /\/auth\/callback\?code=example-code&state=example-state$/);
  assertNoSecrets(res);

  // The new cookie authenticates as the provider's identity.
  const original = process.env.WEB_UI_DEV_USER;
  delete process.env.WEB_UI_DEV_USER;
  try {
    const whoami = await request(app).get('/api/whoami').set('Cookie', session.split(';')[0]!);
    assert.equal(whoami.status, 200);
    assert.equal(whoami.body.username, 'alice');
    assert.equal(whoami.body.uid, 'uid-alice');
    assert.equal(whoami.body.email, 'alice@example.com');
    assert.equal(whoami.body.isAdmin, true);
  } finally {
    if (original !== undefined) process.env.WEB_UI_DEV_USER = original;
  }
});

async function assertSignInFailed(res: request.Response, retryReturnTo: string, reason?: RegExp): Promise<void> {
  assert.equal(res.status, 400, res.text);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.match(res.text, /Sign-in failed/);
  assert.ok(
    res.text.includes(`href="/auth/login?returnTo=${encodeURIComponent(retryReturnTo)}"`),
    `expected a retry link for ${retryReturnTo}: ${res.text}`
  );
  if (reason) assert.match(res.text, reason);
  assert.equal(cookieNamed(res, 'bellhop_session'), undefined, 'no session on a failed sign-in');
  assertNoSecrets(res);
}

test('GET /auth/callback with no bellhop_login cookie fails with a retry link', async () => {
  configureWebLogin();
  const { app, sessions } = testApp();
  const res = await request(app).get('/auth/callback?code=example-code&state=example-state');
  await assertSignInFailed(res, '/');
  assert.equal(sessions.client.callsTo('completeLogin').length, 0);
});

test('GET /auth/callback with an unknown attempt fails', async () => {
  configureWebLogin();
  const { app } = testApp();
  const res = await request(app)
    .get('/auth/callback?code=example-code&state=example-state')
    .set('Cookie', 'bellhop_login=not-a-real-attempt');
  await assertSignInFailed(res, '/');
});

test('GET /auth/callback with an attempt older than 10 minutes fails', async () => {
  configureWebLogin();
  let clock = 1_000_000;
  const { app, sessions } = testApp(newTestSessions({ now: () => clock }));
  const loginCookie = await startLogin(app, sessions, '/jobs');
  clock += 10 * 60 * 1000;
  const res = await request(app).get('/auth/callback?code=example-code&state=example-state').set('Cookie', loginCookie);
  await assertSignInFailed(res, '/');
  assert.equal(sessions.client.callsTo('completeLogin').length, 0);
});

test('GET /auth/callback is single use: replaying a successful callback fails', async () => {
  configureWebLogin();
  const { app, sessions } = testApp();
  const loginCookie = await startLogin(app, sessions, '/jobs');
  sessions.client.completeLoginResults.push(identity);
  const first = await request(app).get('/auth/callback?code=example-code&state=example-state').set('Cookie', loginCookie);
  assert.equal(first.status, 302);
  const replay = await request(app).get('/auth/callback?code=example-code&state=example-state').set('Cookie', loginCookie);
  await assertSignInFailed(replay, '/');
});

test('GET /auth/callback with a state mismatch fails and still consumes the attempt', async () => {
  configureWebLogin();
  const { app, sessions } = testApp();
  const loginCookie = await startLogin(app, sessions, '/jobs');
  const res = await request(app).get('/auth/callback?code=example-code&state=other-state').set('Cookie', loginCookie);
  await assertSignInFailed(res, '/jobs', /state/);
  assert.equal(sessions.client.callsTo('completeLogin').length, 0);
  assert.ok(cookieNamed(res, 'bellhop_login'), 'the login cookie is cleared on failure too');

  const retry = await request(app).get('/auth/callback?code=example-code&state=example-state').set('Cookie', loginCookie);
  await assertSignInFailed(retry, '/');
});

test('GET /auth/callback with a provider error fails without exchanging a code, escaping the error', async () => {
  configureWebLogin();
  const { app, sessions } = testApp();
  const loginCookie = await startLogin(app, sessions, '/jobs');
  const res = await request(app)
    .get('/auth/callback?error=%3Cscript%3Ealert(1)%3C%2Fscript%3E&error_description=nope&state=example-state')
    .set('Cookie', loginCookie);
  await assertSignInFailed(res, '/jobs');
  assert.ok(!res.text.includes('<script>'), 'provider-supplied text is escaped');
  assert.ok(res.text.includes('&lt;script&gt;'), res.text);
  assert.equal(sessions.client.callsTo('completeLogin').length, 0);
});

test('GET /auth/callback with access_denied names the provider error', async () => {
  configureWebLogin();
  const { app, sessions } = testApp();
  const loginCookie = await startLogin(app, sessions, '/jobs');
  const res = await request(app).get('/auth/callback?error=access_denied&state=example-state').set('Cookie', loginCookie);
  await assertSignInFailed(res, '/jobs', /access_denied/);
});

test('GET /auth/callback shows the client error when completeLogin fails', async () => {
  configureWebLogin();
  const { app, sessions } = testApp();
  const loginCookie = await startLogin(app, sessions, '/jobs');
  sessions.client.completeLoginResults.push(() => {
    throw new WebLoginError(`Sign-in with ${ISSUER} failed: the provider issued no refresh token`, 'login_failed');
  });
  const res = await request(app).get('/auth/callback?code=example-code&state=example-state').set('Cookie', loginCookie);
  await assertSignInFailed(res, '/jobs', /the provider issued no refresh token/);
});

test('GET /auth/callback does not echo an unexpected error message', async () => {
  configureWebLogin();
  const { app, sessions } = testApp();
  const loginCookie = await startLogin(app, sessions, '/jobs');
  sessions.client.completeLoginResults.push(() => {
    throw new Error('boom example-refresh-token');
  });
  const res = await request(app).get('/auth/callback?code=example-code&state=example-state').set('Cookie', loginCookie);
  await assertSignInFailed(res, '/jobs');
});

test('GET /auth/callback fails when web login stopped being configured mid sign-in', async () => {
  configureWebLogin();
  const { app, sessions } = testApp();
  const loginCookie = await startLogin(app, sessions, '/jobs');
  resetConfigStore();
  const res = await request(app).get('/auth/callback?code=example-code&state=example-state').set('Cookie', loginCookie);
  await assertSignInFailed(res, '/jobs', /not configured/);
  assert.equal(sessions.client.callsTo('completeLogin').length, 0);
});

// --- re-sign-in replaces the browser's existing session ----------------------------

test('GET /auth/callback destroys the session the browser already carries, leaving only the new one', async () => {
  configureWebLogin();
  const { app, sessions } = testApp();
  const oldCookie = sessionCookie(sessions, { username: 'alice', groups: [] });
  const oldId = oldCookie.split('=')[1]!;
  const loginCookie = await startLogin(app, sessions, '/jobs');
  sessions.client.completeLoginResults.push(identity);
  const res = await request(app)
    .get('/auth/callback?code=example-code&state=example-state')
    .set('Cookie', `${loginCookie}; ${oldCookie}`);
  assert.equal(res.status, 302);
  assert.equal(sessions.store.getSession(oldId), undefined, 'the old session is gone');
  const fresh = cookieNamed(res, 'bellhop_session')!.split(';')[0]!.split('=')[1]!;
  assert.notEqual(fresh, oldId);
  assert.ok(sessions.store.getSession(fresh));
});

// --- POST /auth/logout ----------------------------------------------------------------

const END_SESSION = 'https://authentik.example.com/application/o/bellhop/end-session/?id_token_hint=example-id-token';

// Runs `fn` with the suite-wide WEB_UI_DEV_USER removed, so a request without
// a valid session is genuinely unauthenticated.
async function withoutDevUser(fn: () => Promise<void>): Promise<void> {
  const original = process.env.WEB_UI_DEV_USER;
  delete process.env.WEB_UI_DEV_USER;
  try {
    await fn();
  } finally {
    if (original !== undefined) process.env.WEB_UI_DEV_USER = original;
  }
}

function assertSessionCookieCleared(res: request.Response): void {
  const cleared = cookieNamed(res, 'bellhop_session');
  assert.ok(cleared, `expected bellhop_session to be cleared, got: ${setCookies(res).join(' | ')}`);
  assert.match(cleared, /^bellhop_session=;/);
  assert.match(cleared, /Expires=Thu, 01 Jan 1970/);
  assert.match(cleared, /Path=\/(;|$)/);
  assert.match(cleared, /HttpOnly/i);
  assert.match(cleared, /Secure/i);
  assert.match(cleared, /SameSite=Lax/i);
}

test('POST /auth/logout deletes the session, clears the cookie and sends the browser to the end-session URL', async () => {
  configureWebLogin();
  const { app, sessions } = testApp();
  const cookie = sessionCookie(sessions, { username: 'alice', groups: ['bellhop-admins'] });
  sessions.client.endSessionUrlResults.push(END_SESSION);
  const res = await request(app).post('/auth/logout').set('Cookie', cookie);
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, END_SESSION);
  assertSessionCookieCleared(res);
  assert.equal(sessions.store.getSession(cookie.split('=')[1]!), undefined);

  const call = sessions.client.callsTo('endSessionUrl')[0]!;
  assert.equal(call.idToken, 'example-id-token');
  assert.equal(call.postLogoutRedirectUri, 'https://bellhop.example.com/auth/signed-out');
  assert.deepEqual(call.cfg, TEST_WEB_LOGIN_CONFIG);

  await withoutDevUser(async () => {
    tempConfigStore({ webUiAuthMode: 'oidc' });
    const after = await request(app).get('/api/whoami').set('Cookie', cookie);
    assert.equal(after.status, 401, 'the logged-out cookie no longer authenticates');
  });
});

test('POST /auth/logout falls back to /auth/signed-out when the provider has no end-session endpoint', async () => {
  configureWebLogin();
  const { app, sessions } = testApp();
  const cookie = sessionCookie(sessions, { username: 'alice', groups: [] });
  sessions.client.endSessionUrlResults.push(undefined);
  const res = await request(app).post('/auth/logout').set('Cookie', cookie);
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/auth/signed-out');
  assertSessionCookieCleared(res);
  assert.equal(sessions.store.getSession(cookie.split('=')[1]!), undefined);
});

test('POST /auth/logout still signs out when asking the provider throws', async () => {
  configureWebLogin();
  const { app, sessions } = testApp();
  const cookie = sessionCookie(sessions, { username: 'alice', groups: [] });
  sessions.client.endSessionUrlResults.push(() => {
    throw new Error('boom example-id-token');
  });
  const res = await request(app).post('/auth/logout').set('Cookie', cookie);
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/auth/signed-out');
  assertSessionCookieCleared(res);
  assert.equal(sessions.store.getSession(cookie.split('=')[1]!), undefined);
  assertNoSecrets(res);
});

test('POST /auth/logout still signs out when web login is no longer configured', async () => {
  resetConfigStore();
  const { app, sessions } = testApp();
  const cookie = sessionCookie(sessions, { username: 'alice', groups: [] });
  const res = await request(app).post('/auth/logout').set('Cookie', cookie);
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/auth/signed-out');
  assertSessionCookieCleared(res);
  assert.equal(sessions.store.getSession(cookie.split('=')[1]!), undefined);
  assert.equal(sessions.client.callsTo('endSessionUrl').length, 0);
});

test('POST /auth/logout still signs out when the web login settings are invalid', async () => {
  resetConfigStore();
  const original = process.env.WEB_UI_OIDC_ISSUER;
  process.env.WEB_UI_OIDC_ISSUER = 'not-a-url-example-value';
  try {
    const { app, sessions } = testApp();
    const cookie = sessionCookie(sessions, { username: 'alice', groups: [] });
    const res = await request(app).post('/auth/logout').set('Cookie', cookie);
    assert.equal(res.status, 303);
    assert.equal(res.headers.location, '/auth/signed-out');
    assertSessionCookieCleared(res);
    assert.equal(sessions.store.getSession(cookie.split('=')[1]!), undefined);
  } finally {
    if (original === undefined) delete process.env.WEB_UI_OIDC_ISSUER;
    else process.env.WEB_UI_OIDC_ISSUER = original;
  }
});

test('POST /auth/logout with no session (or an unknown one) is still a 303 to /auth/signed-out', async () => {
  configureWebLogin();
  const { app, sessions } = testApp();
  for (const cookie of [undefined, 'bellhop_session=not-a-real-session']) {
    const req = request(app).post('/auth/logout');
    const res = await (cookie ? req.set('Cookie', cookie) : req);
    assert.equal(res.status, 303);
    assert.equal(res.headers.location, '/auth/signed-out');
    assertSessionCookieCleared(res);
  }
  assert.equal(sessions.client.callsTo('endSessionUrl').length, 0, 'no id token, so nothing to hint with');
});

test('POST /auth/logout is reachable in oidc mode without a session', async () => {
  await withoutDevUser(async () => {
    tempConfigStore({ webUiAuthMode: 'oidc' });
    const { app } = testApp();
    const res = await request(app).post('/auth/logout');
    assert.equal(res.status, 303);
  });
});

// --- GET /auth/signed-out ----------------------------------------------------------------

test('GET /auth/signed-out is a public page with a Sign in again link', async () => {
  await withoutDevUser(async () => {
    tempConfigStore({ webUiAuthMode: 'oidc' });
    const { app } = testApp();
    const res = await request(app).get('/auth/signed-out');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.text, /You are signed out/);
    assert.ok(res.text.includes('href="/auth/login"'), res.text);
    assert.match(res.text, /Sign in again/);
  });
});
