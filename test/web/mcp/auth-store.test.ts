import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { McpAuthStore, ACCESS_TOKEN_TTL_MS } from '../../../src/web/mcp/auth-store.ts';

// Persistence for Bellhop's MCP authorization server (#65/#66,
// data-model.md): every token-like value is stored only as its SHA-256.
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const sha = (v: string) => createHash('sha256').update(v).digest('hex');

const CLIENT: OAuthClientInformationFull = {
  client_id: 'client-1',
  client_id_issued_at: 1000,
  client_name: 'Example MCP client',
  redirect_uris: ['http://localhost:33418/callback'],
  token_endpoint_auth_method: 'none',
};

function setup() {
  const clock = { now: 1_000_000 };
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'mcp-auth-')), 'sessions.sqlite3');
  const store = new McpAuthStore(file, () => clock.now);
  return { clock, store, file };
}

function issueCode(store: McpAuthStore, clientId = 'client-1') {
  return store.issueCode({
    clientId,
    redirectUri: 'http://localhost:33418/callback',
    codeChallenge: 'challenge-1',
    resource: 'https://bellhop.example.com/mcp',
    sessionHash: 's'.repeat(64),
  });
}

test('a registered client is read back as registered', () => {
  const { store } = setup();
  store.saveClient(CLIENT);
  assert.deepEqual(store.getClient('client-1'), CLIENT);
  assert.equal(store.getClient('nope'), undefined);
});

test('registrations never used for a grant are purged 24 hours later, on the next registration', () => {
  const { store, clock } = setup();
  store.saveClient(CLIENT);
  store.saveClient({ ...CLIENT, client_id: 'client-used' });
  store.createGrant({ clientId: 'client-used', sessionHash: 's'.repeat(64) });
  clock.now += 24 * HOUR;
  store.saveClient({ ...CLIENT, client_id: 'client-new' });
  assert.equal(store.getClient('client-1'), undefined);
  assert.ok(store.getClient('client-used'));
  assert.ok(store.getClient('client-new'));
});

test('a pending consent is read by hash until consumed, and expires after 10 minutes', () => {
  const { store, clock } = setup();
  const id = store.createPending({
    clientId: 'client-1',
    redirectUri: 'http://localhost:33418/callback',
    codeChallenge: 'challenge-1',
    state: 'client-state',
    scopes: [],
  });
  const hash = sha(id);
  assert.equal(store.getPending(hash)?.state, 'client-state');
  assert.equal(store.consumePending(hash)?.clientId, 'client-1');
  assert.equal(store.consumePending(hash), undefined, 'single use');

  const late = sha(store.createPending({ clientId: 'client-1', redirectUri: 'x', codeChallenge: 'c', scopes: [] }));
  clock.now += 10 * MIN;
  assert.equal(store.getPending(late), undefined);
});

test('a code is single use, for its own client, and expires after 10 minutes', () => {
  const { store, clock } = setup();
  const code = issueCode(store);
  assert.equal(store.peekCode('client-2', code), undefined, 'another client cannot see it');
  assert.equal(store.peekCode('client-1', code)?.codeChallenge, 'challenge-1');
  assert.equal(store.consumeCode('client-1', code)?.sessionHash, 's'.repeat(64));
  assert.equal(store.consumeCode('client-1', code), undefined);

  const late = issueCode(store);
  clock.now += 10 * MIN;
  assert.equal(store.consumeCode('client-1', late), undefined);
});

test('a grant issues an access token valid for an hour and a refresh token that rotates', () => {
  const { store, clock } = setup();
  const issued = store.createGrant({ clientId: 'client-1', sessionHash: 's'.repeat(64), resource: 'https://bellhop.example.com/mcp' });
  assert.equal(issued.expiresInSeconds, ACCESS_TOKEN_TTL_MS / 1000);
  const access = store.resolveAccess(issued.accessToken);
  assert.equal(access?.grantId, issued.grantId);
  assert.equal(access?.sessionHash, 's'.repeat(64));

  const rotated = store.rotateRefresh('client-1', issued.refreshToken);
  assert.ok(rotated);
  assert.notEqual(rotated.refreshToken, issued.refreshToken);
  assert.equal(store.rotateRefresh('client-1', issued.refreshToken), undefined, 'the old refresh token is dead');
  assert.equal(store.rotateRefresh('client-2', rotated.refreshToken), undefined, 'another client cannot use it');
  assert.ok(store.resolveAccess(rotated.accessToken));

  clock.now += ACCESS_TOKEN_TTL_MS;
  assert.equal(store.resolveAccess(rotated.accessToken), undefined, 'expired');
});

test('revoking a refresh token ends the grant and its access tokens; revoking an access token ends only it', () => {
  const { store } = setup();
  const a = store.createGrant({ clientId: 'client-1', sessionHash: 's'.repeat(64) });
  const b = store.rotateRefresh('client-1', a.refreshToken)!;
  store.revoke('client-1', b.accessToken);
  assert.equal(store.resolveAccess(b.accessToken), undefined);
  assert.ok(store.resolveAccess(a.accessToken));
  store.revoke('client-1', b.refreshToken);
  assert.equal(store.resolveAccess(a.accessToken), undefined);
  assert.equal(store.rotateRefresh('client-1', b.refreshToken), undefined);
});

test('deleteGrant removes the grant and its tokens', () => {
  const { store } = setup();
  const g = store.createGrant({ clientId: 'client-1', sessionHash: 's'.repeat(64) });
  store.deleteGrant(g.grantId);
  assert.equal(store.resolveAccess(g.accessToken), undefined);
  assert.equal(store.rotateRefresh('client-1', g.refreshToken), undefined);
});

test('no raw token, code or consent id is ever written to the file', () => {
  const { store, file } = setup();
  const pending = store.createPending({ clientId: 'client-1', redirectUri: 'x', codeChallenge: 'c', scopes: [] });
  const code = issueCode(store);
  const g = store.createGrant({ clientId: 'client-1', sessionHash: 's'.repeat(64) });
  store.close();
  const db = new Database(file, { readonly: true });
  const dump = ['mcp_pending', 'mcp_codes', 'mcp_grants', 'mcp_access_tokens']
    .map((t) => JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all()))
    .join('\n');
  db.close();
  for (const raw of [pending, code, g.accessToken, g.refreshToken]) assert.ok(!dump.includes(raw), 'raw value stored');
});

// Review finding: only registrations that never signed in are purged; a
// client whose grant ended (revoked, refused, expired) keeps its client_id,
// which MCP clients cache and reuse to sign in again.
test('a client whose grant ended is not purged as unused', () => {
  const { store, clock } = setup();
  store.saveClient(CLIENT);
  const g = store.createGrant({ clientId: 'client-1', sessionHash: 's'.repeat(64) });
  store.deleteGrant(g.grantId);
  clock.now += 25 * HOUR;
  store.saveClient({ ...CLIENT, client_id: 'client-new' });
  assert.ok(store.getClient('client-1'));
});

// Review finding: ending a grant must say which sign-in it held, so the
// caller can delete that session row (and its Authentik tokens) with it.
test('revoke and deleteGrant report the ended grant session hash', () => {
  const { store } = setup();
  const a = store.createGrant({ clientId: 'client-1', sessionHash: 'a'.repeat(64) });
  const b = store.createGrant({ clientId: 'client-1', sessionHash: 'b'.repeat(64) });
  assert.equal(store.revoke('client-1', a.refreshToken), 'a'.repeat(64));
  assert.equal(store.revoke('client-1', b.accessToken), undefined, 'an access token ends no grant');
  assert.equal(store.deleteGrant(b.grantId), 'b'.repeat(64));
});

test('grants older than the 30-day sign-in lifetime are purged on the next grant', () => {
  const { store, clock } = setup();
  const old = store.createGrant({ clientId: 'client-1', sessionHash: 'a'.repeat(64) });
  clock.now += 30 * 24 * HOUR;
  store.createGrant({ clientId: 'client-1', sessionHash: 'b'.repeat(64) });
  assert.equal(store.rotateRefresh('client-1', old.refreshToken), undefined);
});
