import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveRequestUser, requireAdminGroup, isAdminUser, authMode } from '../../src/web/auth.ts';
import { authentikConfig } from '../../src/lib/authentik-config.ts';
import { buildApp } from '../../src/web/app.ts';
import { JobStore } from '../../src/web/jobs/job-store.ts';
import { createJobLog } from '../../src/web/jobs/job-log.ts';
import { JobRunner } from '../../src/web/jobs/job-runner.ts';
import { FakeSSHClient } from '../support/fake-ssh-client.ts';
import { FakeAuthentikClient } from '../support/fake-authentik-client.ts';
import { resetConfigStore, tempConfigStore } from '../support/config-store.ts';
import { newTestSessions, sessionCookie } from '../support/web-session.ts';

const ADMIN_GROUP_NAME = authentikConfig({}).adminGroup;
const AUTHENTIK_BUILTIN_ADMIN_GROUP_NAME = authentikConfig({}).builtinAdminGroup;

afterEach(() => resetConfigStore());

// The forward-auth headers a reverse proxy used to add. #69 (FR-018):
// Bellhop's own authentication never reads them, in either mode.
const HEADERS = {
  'x-authentik-username': 'header-user',
  'x-authentik-groups': ADMIN_GROUP_NAME,
  'x-authentik-uid': 'uid-header-user',
  'x-authentik-email': 'header-user@example.com',
};

// --- authMode (#69 research R10) ---------------------------------------------

test('authMode defaults to none when the variable is unset or empty', () => {
  assert.equal(authMode({}), 'none');
  assert.equal(authMode({ WEB_UI_AUTH_MODE: '' }), 'none');
});

test('authMode accepts oidc and none from the environment', () => {
  assert.equal(authMode({ WEB_UI_AUTH_MODE: 'oidc' }), 'oidc');
  assert.equal(authMode({ WEB_UI_AUTH_MODE: 'none' }), 'none');
});

for (const retired of ['auto', 'authentik']) {
  test(`authMode rejects the retired WEB_UI_AUTH_MODE=${retired} with a pointer to the new modes`, () => {
    assert.throws(
      () => authMode({ WEB_UI_AUTH_MODE: retired }),
      (err: Error) =>
        err.message ===
        `WEB_UI_AUTH_MODE=${retired} is no longer supported -- use oidc (sign-in required) or none (no authentication); see docs/authentik.md`
    );
  });
}

test('authMode rejects an unrecognized value, listing the valid ones', () => {
  assert.throws(() => authMode({ WEB_UI_AUTH_MODE: 'bogus' }), /must be one of oidc, none/);
});

test('authMode reads the stored webUiAuthMode when a config store is registered', () => {
  tempConfigStore({ webUiAuthMode: 'oidc' });
  assert.equal(authMode({}), 'oidc');
});

test('authMode: WEB_UI_AUTH_MODE overrides the stored webUiAuthMode', () => {
  tempConfigStore({ webUiAuthMode: 'oidc' });
  assert.equal(authMode({ WEB_UI_AUTH_MODE: 'none' }), 'none');
});

test('authMode still rejects an invalid WEB_UI_AUTH_MODE with a store registered', () => {
  tempConfigStore({ webUiAuthMode: 'none' });
  assert.throws(() => authMode({ WEB_UI_AUTH_MODE: 'bogus' }), /must be one of oidc, none/);
});

// --- resolveRequestUser: session -> WEB_UI_DEV_USER -> local operator (R6) -----

test('a valid session wins over WEB_UI_DEV_USER and the local operator, in either mode', async () => {
  const sessions = newTestSessions();
  const cookie = sessionCookie(sessions, { username: 'alice', groups: ['homelab'], uid: 'uid-alice', email: 'alice@example.com' });
  for (const mode of ['oidc', 'none']) {
    const user = await resolveRequestUser({ cookie }, sessions, { WEB_UI_AUTH_MODE: mode, WEB_UI_DEV_USER: 'dev-user' });
    assert.deepEqual(user, { username: 'alice', uid: 'uid-alice', email: 'alice@example.com', groups: ['homelab'], viaOidc: true });
  }
});

test('the session identity carries uid and viaOidc', async () => {
  const sessions = newTestSessions();
  const cookie = sessionCookie(sessions, { username: 'test-user', groups: [], uid: 'uid-test-user' });
  const user = await resolveRequestUser({ cookie }, sessions, { WEB_UI_AUTH_MODE: 'oidc' });
  assert.equal(user?.uid, 'uid-test-user');
  assert.equal(user?.viaOidc, true);
  assert.ok(user && !('localOperator' in user));
});

test('WEB_UI_DEV_USER is next, ahead of the local operator in none mode', async () => {
  const sessions = newTestSessions();
  const user = await resolveRequestUser({}, sessions, { WEB_UI_AUTH_MODE: 'none', WEB_UI_DEV_USER: 'dev-user' });
  assert.deepEqual(user, { username: 'dev-user', groups: [] });
});

test('WEB_UI_DEV_USER also authenticates in oidc mode (dev/test only)', async () => {
  const sessions = newTestSessions();
  const user = await resolveRequestUser({}, sessions, { WEB_UI_AUTH_MODE: 'oidc', WEB_UI_DEV_USER: 'dev-user', WEB_UI_DEV_GROUPS: 'a|b' });
  assert.deepEqual(user, { username: 'dev-user', groups: ['a', 'b'] });
});

test('none mode with no session and no dev user yields the synthetic local operator, who is an admin', async () => {
  const sessions = newTestSessions();
  const user = await resolveRequestUser({}, sessions, {});
  assert.deepEqual(user, { username: 'local', groups: [ADMIN_GROUP_NAME], localOperator: true });
  assert.equal(isAdminUser(user!.groups, {}), true);
});

test('WEB_UI_LOCAL_USER names the local operator', async () => {
  const user = await resolveRequestUser({}, newTestSessions(), { WEB_UI_LOCAL_USER: 'alice' });
  assert.equal(user!.username, 'alice');
});

test('oidc mode with no session and no dev user is unauthenticated', async () => {
  assert.equal(await resolveRequestUser({}, newTestSessions(), { WEB_UI_AUTH_MODE: 'oidc' }), undefined);
});

test('an unknown session cookie falls through to the next rung', async () => {
  const sessions = newTestSessions();
  const headers = { cookie: 'bellhop_session=not-a-real-session' };
  assert.equal(await resolveRequestUser(headers, sessions, { WEB_UI_AUTH_MODE: 'oidc' }), undefined);
  const local = await resolveRequestUser(headers, sessions, { WEB_UI_AUTH_MODE: 'none' });
  assert.equal(local?.localOperator, true);
});

test('x-authentik-* headers have no effect in oidc mode', async () => {
  assert.equal(await resolveRequestUser(HEADERS, newTestSessions(), { WEB_UI_AUTH_MODE: 'oidc' }), undefined);
});

test('x-authentik-* headers have no effect in none mode', async () => {
  const user = await resolveRequestUser(HEADERS, newTestSessions(), { WEB_UI_AUTH_MODE: 'none' });
  assert.deepEqual(user, { username: 'local', groups: [ADMIN_GROUP_NAME], localOperator: true });
});

test('x-authentik-* headers do not displace the dev user', async () => {
  const user = await resolveRequestUser(HEADERS, newTestSessions(), { WEB_UI_DEV_USER: 'dev-user' });
  assert.deepEqual(user, { username: 'dev-user', groups: [] });
});

test('dev/local identities never carry a uid or viaOidc', async () => {
  const sessions = newTestSessions();
  const devUser = await resolveRequestUser({}, sessions, { WEB_UI_DEV_USER: 'dev-user' });
  assert.ok(devUser && !('uid' in devUser) && !('viaOidc' in devUser));
  const local = await resolveRequestUser({}, sessions, {});
  assert.ok(local && !('uid' in local) && !('viaOidc' in local));
});

// --- requireAuth through the app: unauthenticated responses ------------------

function testApp(sessions = newTestSessions()) {
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
  // A stand-in for the SPA fallback server.ts adds after buildApp, so a page
  // navigation that gets past requireAuth has somewhere to land.
  app.use((_req, res) => {
    res.status(200).send('page');
  });
  return { app, sessions };
}

// Runs `fn` in oidc mode with the suite-wide WEB_UI_DEV_USER removed.
async function signedOutInOidcMode(fn: () => Promise<void>): Promise<void> {
  tempConfigStore({ webUiAuthMode: 'oidc' });
  const original = process.env.WEB_UI_DEV_USER;
  delete process.env.WEB_UI_DEV_USER;
  try {
    await fn();
  } finally {
    if (original !== undefined) process.env.WEB_UI_DEV_USER = original;
  }
}

test('oidc mode: an unauthenticated /api request gets 401 JSON, whatever the method', async () => {
  await signedOutInOidcMode(async () => {
    const { app } = testApp();
    for (const res of [await request(app).get('/api/whoami'), await request(app).post('/api/jobs/1/cancel')]) {
      assert.equal(res.status, 401);
      assert.deepEqual(res.body, { error: 'unauthorized' });
    }
  });
});

test('oidc mode: an unauthenticated page GET redirects to /auth/login with the path and query as returnTo', async () => {
  await signedOutInOidcMode(async () => {
    const { app } = testApp();
    const res = await request(app).get('/jobs?x=1');
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/auth/login?returnTo=%2Fjobs%3Fx%3D1');
    const head = await request(app).head('/settings');
    assert.equal(head.status, 302);
    assert.equal(head.headers.location, '/auth/login?returnTo=%2Fsettings');
  });
});

test('oidc mode: an unauthenticated non-GET outside /api gets 401', async () => {
  await signedOutInOidcMode(async () => {
    const { app } = testApp();
    const res = await request(app).post('/something');
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: 'unauthorized' });
  });
});

test('oidc mode: x-authentik-* headers alone are unauthenticated', async () => {
  await signedOutInOidcMode(async () => {
    const { app } = testApp();
    const api = await request(app).get('/api/whoami').set(HEADERS);
    assert.equal(api.status, 401);
    const page = await request(app).get('/').set(HEADERS);
    assert.equal(page.status, 302);
  });
});

test('oidc mode: a session cookie authenticates both /api and pages', async () => {
  await signedOutInOidcMode(async () => {
    const { app, sessions } = testApp();
    const cookie = sessionCookie(sessions, { username: 'alice', groups: ['homelab'], uid: 'uid-alice' });
    const api = await request(app).get('/api/whoami').set('Cookie', cookie);
    assert.equal(api.status, 200);
    assert.equal(api.body.username, 'alice');
    assert.equal(api.body.uid, 'uid-alice');
    assert.equal(api.body.localOperator, false);
    assert.equal('viaOidc' in api.body, false, 'viaOidc is a server-side guard input, not part of whoami');
    const page = await request(app).get('/jobs').set('Cookie', cookie);
    assert.equal(page.status, 200);
  });
});

test('/auth/* is reachable without a session in oidc mode', async () => {
  await signedOutInOidcMode(async () => {
    const { app } = testApp();
    const res = await request(app).get('/auth/login');
    assert.equal(res.status, 200);
    assert.match(res.text, /Web login is not configured/);
  });
});

test('none mode: a request with only x-authentik-* headers is the local operator', async () => {
  tempConfigStore({ webUiAuthMode: 'none' });
  const original = process.env.WEB_UI_DEV_USER;
  delete process.env.WEB_UI_DEV_USER;
  try {
    const { app } = testApp();
    const res = await request(app).get('/api/whoami').set(HEADERS);
    assert.equal(res.status, 200);
    assert.equal(res.body.username, 'local');
    assert.equal(res.body.localOperator, true);
  } finally {
    if (original !== undefined) process.env.WEB_UI_DEV_USER = original;
  }
});

test('none mode: a session is honored, showing the operator as themselves', async () => {
  tempConfigStore({ webUiAuthMode: 'none' });
  const { app, sessions } = testApp();
  const res = await request(app)
    .get('/api/whoami')
    .set('Cookie', sessionCookie(sessions, { username: 'alice', groups: [ADMIN_GROUP_NAME] }));
  assert.equal(res.body.username, 'alice');
  assert.equal(res.body.localOperator, false);
});

// --- Admin predicates ---------------------------------------------------------

test('isAdminUser honors a configured admin group name', () => {
  assert.equal(isAdminUser(['my-admins'], { AUTHENTIK_ADMIN_GROUP: 'my-admins' }), true);
  assert.equal(isAdminUser([ADMIN_GROUP_NAME], { AUTHENTIK_ADMIN_GROUP: 'my-admins' }), false);
});

test('isAdminUser honors a configured built-in admin group name', () => {
  assert.equal(isAdminUser(['superusers'], { AUTHENTIK_BUILTIN_ADMIN_GROUP: 'superusers' }), true);
});

function fakeRes() {
  const state: { statusCode?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      state.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      state.body = payload;
    },
  };
  return { res: res as unknown as Parameters<typeof requireAdminGroup>[1], state };
}

test('requireAdminGroup calls next() when the user is in the admin group', () => {
  const req = { user: { username: 'alice', groups: [ADMIN_GROUP_NAME] } } as unknown as Parameters<typeof requireAdminGroup>[0];
  const { res } = fakeRes();
  let called = false;
  requireAdminGroup(req, res, () => {
    called = true;
  });
  assert.equal(called, true);
});

test('requireAdminGroup calls next() when the user is only in the built-in authentik Admins group', () => {
  const req = { user: { username: 'alice', groups: [AUTHENTIK_BUILTIN_ADMIN_GROUP_NAME] } } as unknown as Parameters<typeof requireAdminGroup>[0];
  const { res } = fakeRes();
  let called = false;
  requireAdminGroup(req, res, () => {
    called = true;
  });
  assert.equal(called, true);
});

test('requireAdminGroup returns 403 when authenticated but not in the admin group', () => {
  const req = { user: { username: 'alice', groups: ['homelab'] } } as unknown as Parameters<typeof requireAdminGroup>[0];
  const { res, state } = fakeRes();
  let called = false;
  requireAdminGroup(req, res, () => {
    called = true;
  });
  assert.equal(called, false);
  assert.equal(state.statusCode, 403);
  assert.deepEqual(state.body, { error: 'forbidden' });
});

test('requireAdminGroup returns 403 when req.user is undefined', () => {
  const req = {} as unknown as Parameters<typeof requireAdminGroup>[0];
  const { res, state } = fakeRes();
  let called = false;
  requireAdminGroup(req, res, () => {
    called = true;
  });
  assert.equal(called, false);
  assert.equal(state.statusCode, 403);
});
