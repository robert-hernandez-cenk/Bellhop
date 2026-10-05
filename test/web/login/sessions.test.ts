import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureWarnings } from '../../support/capture-warnings.ts';
import { gate } from '../../support/gate.ts';
import { newTestSessions, sessionCookie, TEST_WEB_LOGIN_CONFIG } from '../../support/web-session.ts';
import { SESSION_COOKIE } from '../../../src/web/login/cookies.ts';
import type { WebLoginConfig } from '../../../src/web/login/config.ts';
import type { LoginIdentity, RecheckResult } from '../../../src/web/login/oidc-client.ts';

const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;

const IDENTITY: LoginIdentity = {
  username: 'test-user',
  uid: 'uid-1',
  email: 'test-user@example.com',
  groups: ['example-users'],
  refreshToken: 'example-refresh-token',
  idToken: 'example-id-token',
};

const OK: RecheckResult = {
  kind: 'ok',
  identity: {
    username: 'renamed-user',
    uid: 'uid-1',
    groups: ['example-users', 'example-admins'],
    refreshToken: 'rotated-refresh-token',
    idToken: 'new-id-token',
  },
};

function setup(config?: () => WebLoginConfig) {
  const clock = { now: 1_000_000 };
  const sessions = newTestSessions({ now: () => clock.now, ...(config ? { config } : {}) });
  const id = sessions.create(IDENTITY);
  return { clock, sessions, id };
}

test('resolve: an unknown or empty id is undefined', async () => {
  const { sessions } = setup();
  assert.equal(await sessions.resolve('no-such-session'), undefined);
  assert.equal(await sessions.resolve(''), undefined);
  assert.equal(sessions.client.calls.length, 0);
});

test('resolve: a session past 30 days is undefined', async () => {
  const { sessions, clock, id } = setup();
  clock.now += 30 * DAY;
  assert.equal(await sessions.resolve(id), undefined);
  assert.equal(sessions.store.getSession(id), undefined);
  assert.equal(sessions.client.calls.length, 0);
});

test('resolve: check not due returns the stored identity as an OIDC AuthUser, with no provider call', async () => {
  const { sessions, clock, id } = setup();
  clock.now += 5 * MIN - 1;
  assert.deepEqual(await sessions.resolve(id), {
    username: 'test-user',
    uid: 'uid-1',
    email: 'test-user@example.com',
    groups: ['example-users'],
    viaOidc: true,
  });
  assert.equal(sessions.client.calls.length, 0);
});

test('resolve: an identity with no email has no email field', async () => {
  const { sessions, clock } = setup();
  const id = sessions.create({ ...IDENTITY, email: undefined });
  clock.now += MIN;
  const user = await sessions.resolve(id);
  assert.equal(user && 'email' in user, false);
});

test('resolve: check due -> one recheck, identity replaced, last_checked_at stamped, refresh token rotated', async () => {
  const { sessions, clock, id } = setup();
  sessions.client.recheckResults.push(OK);
  clock.now += 5 * MIN;
  const user = await sessions.resolve(id);
  assert.deepEqual(user, {
    username: 'renamed-user',
    uid: 'uid-1',
    groups: ['example-users', 'example-admins'],
    viaOidc: true,
  });
  const calls = sessions.client.callsTo('recheck');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.refreshToken, 'example-refresh-token');
  assert.equal(calls[0]!.expectedSub, 'uid-1');
  assert.deepEqual(calls[0]!.cfg, TEST_WEB_LOGIN_CONFIG);
  const stored = sessions.store.getSession(id)!;
  assert.equal(stored.lastCheckedAt, clock.now);
  assert.equal(stored.refreshToken, 'rotated-refresh-token');
  assert.equal(stored.idToken, 'new-id-token');
  assert.equal(stored.email, null);
  // The next request inside the 5 minutes makes no further call.
  clock.now += MIN;
  assert.equal((await sessions.resolve(id))?.username, 'renamed-user');
  assert.equal(sessions.client.callsTo('recheck').length, 1);
});

test('resolve: refused -> session deleted, undefined', async () => {
  const { sessions, clock, id } = setup();
  sessions.client.recheckResults.push({ kind: 'refused', reason: 'Re-check with https://authentik.example.com/ was refused: HTTP 400 invalid_grant' });
  clock.now += 6 * MIN;
  assert.equal(await sessions.resolve(id), undefined);
  assert.equal(sessions.store.getSession(id), undefined);
  assert.equal(await sessions.resolve(id), undefined);
  assert.equal(sessions.client.callsTo('recheck').length, 1);
});

test('resolve: unreachable -> stored identity kept, last_attempt_at set, warning names the issuer only, no retry within 1 minute', async () => {
  const { sessions, clock, id } = setup();
  const reason = `Re-check with ${TEST_WEB_LOGIN_CONFIG.issuer} failed: HTTP 503`;
  sessions.client.recheckResults.push({ kind: 'unreachable', reason });
  clock.now += 6 * MIN;
  const { result: user, warnings } = await captureWarnings(() => sessions.resolve(id));
  assert.equal(user?.username, 'test-user');
  assert.deepEqual(user?.groups, ['example-users']);
  assert.equal(user?.viaOidc, true);
  const stored = sessions.store.getSession(id)!;
  assert.equal(stored.lastAttemptAt, clock.now);
  assert.equal(stored.lastCheckedAt, 1_000_000);
  assert.equal(stored.refreshToken, 'example-refresh-token');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /\[WARN/);
  assert.ok(warnings[0]!.includes(TEST_WEB_LOGIN_CONFIG.issuer));
  assert.ok(warnings[0]!.includes('HTTP 503'));
  for (const secret of ['example-refresh-token', 'example-id-token', TEST_WEB_LOGIN_CONFIG.clientSecret]) {
    assert.ok(!warnings[0]!.includes(secret), `warning must not contain ${secret}`);
  }

  clock.now += MIN - 1;
  assert.equal((await sessions.resolve(id))?.username, 'test-user');
  assert.equal(sessions.client.callsTo('recheck').length, 1, 'no retry within 1 minute');

  clock.now += 1;
  sessions.client.recheckResults.push(OK);
  assert.equal((await sessions.resolve(id))?.username, 'renamed-user');
  assert.equal(sessions.client.callsTo('recheck').length, 2, 'retried after 1 minute');
  assert.equal(sessions.store.getSession(id)?.lastAttemptAt, null);
});

test('resolve: unreachable after the grant rotated the refresh token persists the new tokens, identity unchanged', async () => {
  const { sessions, clock, id } = setup();
  sessions.client.recheckResults.push({
    kind: 'unreachable',
    reason: `Re-check with ${TEST_WEB_LOGIN_CONFIG.issuer} failed: HTTP 502`,
    refreshToken: 'rotated-refresh-token',
    idToken: 'new-id-token',
  });
  clock.now += 6 * MIN;
  const { result: user, warnings } = await captureWarnings(() => sessions.resolve(id));
  assert.equal(user?.username, 'test-user');
  assert.equal(warnings.some((w) => w.includes('rotated-refresh-token') || w.includes('new-id-token')), false);
  const stored = sessions.store.getSession(id)!;
  assert.equal(stored.refreshToken, 'rotated-refresh-token');
  assert.equal(stored.idToken, 'new-id-token');
  assert.equal(stored.username, 'test-user');
  assert.deepEqual(stored.groups, ['example-users']);
  assert.equal(stored.lastAttemptAt, clock.now);

  // The next attempt presents the rotated token, not the consumed one.
  clock.now += MIN;
  sessions.client.recheckResults.push(OK);
  await sessions.resolve(id);
  assert.equal(sessions.client.callsTo('recheck')[1]!.refreshToken, 'rotated-refresh-token');
});

test('resolve: two concurrent resolves of one due session share a single recheck', async () => {
  const { sessions, clock, id } = setup();
  const held = gate();
  sessions.client.recheckResults.push(async () => {
    await held.promise;
    return OK;
  });
  clock.now += 5 * MIN;
  const first = sessions.resolve(id);
  const second = sessions.resolve(id);
  held.open();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a?.username, 'renamed-user');
  assert.deepEqual(a, b);
  assert.equal(sessions.client.callsTo('recheck').length, 1);

  // The in-flight entry is cleared once settled: a later due check runs again.
  clock.now += 5 * MIN;
  sessions.client.recheckResults.push(OK);
  await sessions.resolve(id);
  assert.equal(sessions.client.callsTo('recheck').length, 2);
});

test('resolve: re-checks of different sessions are not merged', async () => {
  const { sessions, clock, id } = setup();
  const other = sessions.create({ ...IDENTITY, uid: 'uid-2', username: 'other-user', refreshToken: 'other-refresh-token' });
  sessions.client.recheckResults.push(OK, {
    kind: 'ok',
    identity: { username: 'other-user', uid: 'uid-2', groups: [], refreshToken: 'other-rotated' },
  });
  clock.now += 5 * MIN;
  const [a, b] = await Promise.all([sessions.resolve(id), sessions.resolve(other)]);
  assert.equal(a?.username, 'renamed-user');
  assert.equal(b?.username, 'other-user');
  assert.equal(sessions.client.callsTo('recheck').length, 2);
});

test('resolve: a client that throws is treated as unreachable, and the error text is not logged', async () => {
  const { sessions, clock, id } = setup();
  sessions.client.recheckResults.push(() => {
    throw new Error('boom example-refresh-token');
  });
  clock.now += 5 * MIN;
  const { result: user, warnings } = await captureWarnings(() => sessions.resolve(id));
  assert.equal(user?.username, 'test-user');
  assert.equal(sessions.store.getSession(id)?.lastAttemptAt, clock.now);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0]!.includes(TEST_WEB_LOGIN_CONFIG.issuer));
  assert.ok(!warnings[0]!.includes('example-refresh-token'));
});

test('resolve: check due while web login is not configured -> refused (session deleted)', async () => {
  const { sessions, clock, id } = setup(() => ({ configured: false, missing: ['webUiOidcIssuer'] }));
  clock.now += 5 * MIN;
  assert.equal(await sessions.resolve(id), undefined);
  assert.equal(sessions.store.getSession(id), undefined);
  assert.equal(sessions.client.calls.length, 0);
});

test('resolve: check due while the web login config throws -> unreachable (kept, warned, retried later)', async () => {
  const { sessions, clock, id } = setup(() => {
    throw new Error("Setting 'webUiOidcIssuer' from environment variable WEB_UI_OIDC_ISSUER is invalid (must be a URL)");
  });
  clock.now += 5 * MIN;
  const { result: user, warnings } = await captureWarnings(() => sessions.resolve(id));
  assert.equal(user?.username, 'test-user');
  assert.equal(sessions.client.calls.length, 0);
  assert.equal(sessions.store.getSession(id)?.lastAttemptAt, clock.now);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /WEB_UI_OIDC_ISSUER/);
});

test('create stores a fresh session that resolves without a re-check; destroy deletes it and returns it', async () => {
  const { sessions, id } = setup();
  assert.equal((await sessions.resolve(id))?.username, 'test-user');
  assert.equal(sessions.client.calls.length, 0);
  const destroyed = sessions.destroy(id);
  assert.equal(destroyed?.idToken, 'example-id-token');
  assert.equal(await sessions.resolve(id), undefined);
  assert.equal(sessions.destroy(id), undefined);
  assert.equal(sessions.destroy(''), undefined);
});

test('sessionCookie returns a Cookie header for a fresh session', async () => {
  const sessions = newTestSessions();
  const cookie = sessionCookie(sessions, { username: 'admin', groups: ['example-admins'] });
  assert.match(cookie, new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]{43}$`));
  const user = await sessions.resolve(cookie.slice(SESSION_COOKIE.length + 1));
  assert.deepEqual(user, { username: 'admin', uid: 'uid-admin', groups: ['example-admins'], viaOidc: true });
  assert.equal(sessions.client.calls.length, 0);
});

test('resolve: unreachable while the session is signed out meanwhile -> undefined, not the stale identity', async () => {
  const { sessions, clock, id } = setup();
  const release = gate();
  sessions.client.recheckResults.push(async () => {
    await release.promise;
    return { kind: 'unreachable', reason: `Re-check with ${TEST_WEB_LOGIN_CONFIG.issuer} failed: HTTP 503` } as RecheckResult;
  });
  clock.now += 6 * MIN;
  const pending = captureWarnings(() => sessions.resolve(id));
  await new Promise((r) => setImmediate(r));
  sessions.destroy(id);
  release.open();
  assert.equal((await pending).result, undefined);
});

test('resolve: a config() that throws a non-Error is treated as unreachable with fixed text', async () => {
  const { sessions, clock, id } = setup(() => {
    throw 'a string, not an Error';
  });
  clock.now += 6 * MIN;
  const { result: user, warnings } = await captureWarnings(() => sessions.resolve(id));
  assert.equal(user?.username, 'test-user');
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0]!.includes('invalid web login settings'), warnings[0]);
  assert.ok(!warnings[0]!.includes('a string, not an Error'));
});

test('resolve: re-checks never extend a session past 30 days from sign-in (FR-014a)', async () => {
  const { sessions, clock, id } = setup();
  for (let day = 1; day < 30; day++) {
    clock.now += DAY;
    sessions.client.recheckResults.push(OK);
    assert.ok(await sessions.resolve(id), `day ${day}`);
  }
  assert.equal(sessions.store.getSession(id)?.createdAt, 1_000_000);
  clock.now = 1_000_000 + 30 * DAY - 1;
  sessions.client.recheckResults.push(OK);
  assert.ok(await sessions.resolve(id), 'still valid one ms before the 30th day');
  clock.now = 1_000_000 + 30 * DAY;
  sessions.client.recheckResults.push(OK);
  assert.equal(await sessions.resolve(id), undefined);
  assert.equal(sessions.store.getSession(id), undefined);
});
