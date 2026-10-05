import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SessionStore } from '../../../src/web/login/session-store.ts';

const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;

const SESSION = {
  username: 'test-user',
  uid: 'uid-1',
  email: 'test-user@example.com',
  groups: ['example-users', 'example-admins'],
  refreshToken: 'example-refresh-token',
  idToken: 'example-id-token',
};
const ATTEMPT = { state: 'state-1', nonce: 'nonce-1', codeVerifier: 'verifier-1', returnTo: '/hosts' };

function storeWithClock(): { store: SessionStore; clock: { now: number } } {
  const clock = { now: 1_000_000 };
  return { store: new SessionStore(':memory:', () => clock.now), clock };
}

test('createSession returns a 32-byte base64url id and stores only its SHA-256 hex', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bellhop-sessions-'));
  const file = path.join(dir, 'sessions.sqlite3');
  const store = new SessionStore(file, () => 1_000_000);
  const id = store.createSession(SESSION);
  store.close();
  assert.match(id, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(id, 'base64url').length, 32);
  const db = new Database(file, { readonly: true });
  const rows = db.prepare('SELECT * FROM sessions').all() as Array<Record<string, unknown>>;
  db.close();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id_hash, createHash('sha256').update(id).digest('hex'));
  assert.ok(!JSON.stringify(rows[0]).includes(id), 'the raw id is never stored');
});

test('getSession returns the stored identity by raw id, and nothing for an unknown id', () => {
  const { store } = storeWithClock();
  const id = store.createSession(SESSION);
  assert.deepEqual(store.getSession(id), {
    ...SESSION,
    createdAt: 1_000_000,
    lastCheckedAt: 1_000_000,
    lastAttemptAt: null,
  });
  assert.equal(store.getSession('nope'), undefined);
  assert.equal(store.getSession(''), undefined);
});

test('a session is valid for 30 days from sign-in and deleted on sight after', () => {
  const { store, clock } = storeWithClock();
  const id = store.createSession(SESSION);
  clock.now += 30 * DAY - 1;
  assert.ok(store.getSession(id));
  clock.now += 1;
  assert.equal(store.getSession(id), undefined);
  // Gone for good, not merely hidden: rewinding the clock does not revive it.
  clock.now -= 5 * DAY;
  assert.equal(store.getSession(id), undefined);
});

test('updateAfterCheck refreshes identity and tokens and clears the failed-attempt mark', () => {
  const { store, clock } = storeWithClock();
  const id = store.createSession(SESSION);
  clock.now += 6 * MIN;
  store.markCheckAttempt(id);
  clock.now += 2 * MIN;
  store.updateAfterCheck(id, {
    username: 'renamed',
    email: null,
    groups: ['example-users'],
    refreshToken: 'rotated-refresh-token',
    idToken: 'new-id-token',
  });
  const s = store.getSession(id);
  assert.equal(s?.username, 'renamed');
  assert.equal(s?.uid, 'uid-1', 'uid (sub) never changes');
  assert.equal(s?.email, null);
  assert.deepEqual(s?.groups, ['example-users']);
  assert.equal(s?.refreshToken, 'rotated-refresh-token');
  assert.equal(s?.idToken, 'new-id-token');
  assert.equal(s?.lastCheckedAt, clock.now);
  assert.equal(s?.lastAttemptAt, null);
  assert.equal(s?.createdAt, 1_000_000, 'the 30-day clock is not restarted by a re-check');
});

test('updateAfterCheck keeps the old ID token when the provider returns no new one', () => {
  const { store } = storeWithClock();
  const id = store.createSession(SESSION);
  store.updateAfterCheck(id, {
    username: 'test-user',
    email: 'test-user@example.com',
    groups: [],
    refreshToken: 'rotated',
  });
  assert.equal(store.getSession(id)?.idToken, 'example-id-token');
});

test('markCheckAttempt sets last_attempt_at without touching identity', () => {
  const { store, clock } = storeWithClock();
  const id = store.createSession(SESSION);
  clock.now += 10 * MIN;
  store.markCheckAttempt(id);
  const s = store.getSession(id);
  assert.equal(s?.lastAttemptAt, clock.now);
  assert.equal(s?.lastCheckedAt, 1_000_000);
  assert.equal(s?.refreshToken, 'example-refresh-token');
});

test('checkDue: 5 minutes since the last check, and 1 minute since a failed attempt', () => {
  const { store, clock } = storeWithClock();
  const id = store.createSession(SESSION);
  const due = () => store.checkDue(store.getSession(id)!);
  assert.equal(due(), false);
  clock.now += 5 * MIN - 1;
  assert.equal(due(), false);
  clock.now += 1;
  assert.equal(due(), true);
  store.markCheckAttempt(id);
  assert.equal(due(), false);
  clock.now += MIN - 1;
  assert.equal(due(), false);
  clock.now += 1;
  assert.equal(due(), true);
});

test('deleteSession removes the row', () => {
  const { store } = storeWithClock();
  const id = store.createSession(SESSION);
  store.deleteSession(id);
  assert.equal(store.getSession(id), undefined);
  store.deleteSession(id); // already gone: not an error
});

test('purgeExpired removes expired sessions and attempts and keeps live ones', () => {
  const { store, clock } = storeWithClock();
  const oldSession = store.createSession(SESSION);
  const oldAttempt = store.createAttempt(ATTEMPT);
  clock.now += 20 * DAY;
  const liveSession = store.createSession({ ...SESSION, uid: 'uid-2' });
  clock.now += 10 * DAY - 1;
  const liveAttempt = store.createAttempt(ATTEMPT);
  clock.now += 1;
  store.purgeExpired();
  assert.equal(store.getSession(oldSession), undefined);
  assert.ok(store.getSession(liveSession));
  assert.equal(store.consumeAttempt(oldAttempt), undefined);
  assert.ok(store.consumeAttempt(liveAttempt));
});

test('purgeExpired removes an attempt past 10 minutes from the table itself', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bellhop-sessions-'));
  const file = path.join(dir, 'sessions.sqlite3');
  const clock = { now: 1_000_000 };
  const store = new SessionStore(file, () => clock.now);
  store.createAttempt(ATTEMPT);
  clock.now += 11 * MIN;
  store.purgeExpired();
  store.close();
  const db = new Database(file, { readonly: true });
  const n = (db.prepare('SELECT COUNT(*) AS n FROM login_attempts').get() as { n: number }).n;
  db.close();
  assert.equal(n, 0);
});

test('a new sign-in purges expired rows', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bellhop-sessions-'));
  const file = path.join(dir, 'sessions.sqlite3');
  const clock = { now: 1_000_000 };
  const store = new SessionStore(file, () => clock.now);
  store.createSession(SESSION);
  clock.now += 31 * DAY;
  store.createSession({ ...SESSION, uid: 'uid-2' });
  store.close();
  const db = new Database(file, { readonly: true });
  const n = (db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n;
  db.close();
  assert.equal(n, 1);
});

test('login attempts are single-use', () => {
  const { store } = storeWithClock();
  const id = store.createAttempt(ATTEMPT);
  assert.match(id, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(store.consumeAttempt(id), { ...ATTEMPT, createdAt: 1_000_000 });
  assert.equal(store.consumeAttempt(id), undefined);
  assert.equal(store.consumeAttempt('unknown'), undefined);
});

test('a login attempt is invalid after 10 minutes, and consuming it still removes it', () => {
  const { store, clock } = storeWithClock();
  const fresh = store.createAttempt(ATTEMPT);
  clock.now += 10 * MIN - 1;
  assert.ok(store.consumeAttempt(fresh));
  const stale = store.createAttempt(ATTEMPT);
  clock.now += 10 * MIN;
  assert.equal(store.consumeAttempt(stale), undefined);
  clock.now -= 10 * MIN;
  assert.equal(store.consumeAttempt(stale), undefined, 'the stale row was deleted by the failed consume');
});

test('sessions persist across reopening a file-backed store', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bellhop-sessions-'));
  const file = path.join(dir, 'nested', 'sessions.sqlite3');
  const first = new SessionStore(file, () => 1_000_000);
  const id = first.createSession(SESSION);
  first.close();
  const second = new SessionStore(file, () => 1_000_000 + DAY);
  assert.equal(second.getSession(id)?.uid, 'uid-1');
  second.close();
});
