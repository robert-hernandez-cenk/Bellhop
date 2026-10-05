import { test, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import { buildApp } from '../../../src/web/app.ts';
import { JobStore } from '../../../src/web/jobs/job-store.ts';
import { createJobLog } from '../../../src/web/jobs/job-log.ts';
import { JobRunner } from '../../../src/web/jobs/job-runner.ts';
import { loadInventory } from '../../../src/lib/inventory.ts';
import { webLoginConfig } from '../../../src/web/login/config.ts';
import { McpAuthStore } from '../../../src/web/mcp/auth-store.ts';
import type { LoginIdentity, RecheckResult } from '../../../src/web/login/oidc-client.ts';
import { authentikConfig } from '../../../src/lib/authentik-config.ts';
import { FakeSSHClient, defaultResponder } from '../../support/fake-ssh-client.ts';
import { FakeAuthentikClient } from '../../support/fake-authentik-client.ts';
import { resetConfigStore, tempConfigStore } from '../../support/config-store.ts';
import { newTestSessions, sessionCookie, type TestSessions } from '../../support/web-session.ts';
import { listen, connectHttpClient, rawPost, INITIALIZE } from '../../support/mcp-http-harness.ts';
import { parse } from '../../support/mcp-harness.ts';

// The standard MCP sign-in against the real web app (#65/#66, US1/US2,
// contracts/http-mcp.md): register -> authorize (consent page) -> consent
// -> Authentik (FakeWebLoginClient) -> /auth/callback -> code -> token ->
// /mcp. Served from http://127.0.0.1 -- the loopback exception both the SDK
// (issuer) and the web-login settings (redirect URI) allow.
const MIN = 60 * 1000;
const ADMIN_GROUP = authentikConfig({}).adminGroup;
const CLIENT_REDIRECT = 'http://localhost:33418/callback';

const ADMIN: LoginIdentity = {
  username: 'admin',
  uid: 'uid-admin',
  groups: [ADMIN_GROUP],
  refreshToken: 'example-refresh-admin',
  idToken: 'example-id-admin',
};

let savedDevUser: string | undefined;
beforeEach(() => {
  savedDevUser = process.env.WEB_UI_DEV_USER;
  delete process.env.WEB_UI_DEV_USER;
});
afterEach(() => {
  if (savedDevUser !== undefined) process.env.WEB_UI_DEV_USER = savedDevUser;
  resetConfigStore();
});

interface Flow {
  base: string;
  sessions: TestSessions;
  clock: { now: number };
  close: () => Promise<void>;
}

async function setup(): Promise<Flow> {
  let app: http.RequestListener | undefined;
  const server = await listen((req, res) => app!(req, res));
  const base = server.base;
  const inventoryPath = tempConfigStore(
    {
      webUiAuthMode: 'oidc',
      webUiOidcIssuer: 'https://authentik.example.com/application/o/bellhop/',
      webUiOidcClientId: 'example-client-id',
      webUiOidcRedirectUri: `${base}/auth/callback`,
    },
    { webUiOidcClientSecret: 'example-client-secret' }
  );
  const clock = { now: Date.now() };
  const sessions = newTestSessions({ now: () => clock.now, config: () => webLoginConfig() });
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'mcp-flow-log-')));
  const ssh = new FakeSSHClient(defaultResponder);
  app = buildApp({
    inventory: loadInventory(inventoryPath),
    baseSsh: ssh,
    jobStore,
    jobLog,
    jobRunner: new JobRunner(jobStore, jobLog, ssh),
    inventoryPath,
    authentik: new FakeAuthentikClient(),
    sessions,
    mcpAuthStore: new McpAuthStore(':memory:', () => clock.now),
  });
  return { base, sessions, clock, close: server.close };
}

const b64url = (buf: Buffer) => buf.toString('base64url');

function cookiesFrom(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    out[pair.slice(0, eq)] = decodeURIComponent(pair.slice(eq + 1));
  }
  return out;
}

const cookieHeader = (cookies: Record<string, string>) =>
  Object.entries(cookies)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('; ');

async function register(f: Flow): Promise<string> {
  const res = await fetch(`${f.base}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Example MCP client',
      redirect_uris: [CLIENT_REDIRECT],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  assert.equal(res.status, 201);
  return (await res.json()).client_id;
}

// Up to the consent page: returns its pending id and cookie.
async function authorize(f: Flow, clientId: string, verifier: string) {
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const url = new URL(`${f.base}/authorize`);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: CLIENT_REDIRECT,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'client-state',
    resource: `${f.base}/mcp`,
  }).toString();
  const res = await fetch(url, { redirect: 'manual' });
  assert.equal(res.status, 200);
  const html = await res.text();
  const pending = /name="pending" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(pending, 'consent form carries the pending id');
  return { html, pending, cookies: cookiesFrom(res) };
}

async function consent(f: Flow, pending: string, cookies: Record<string, string>, decision: 'approve' | 'deny') {
  return fetch(`${f.base}/auth/mcp/consent`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(cookies) },
    body: new URLSearchParams({ pending, decision }).toString(),
  });
}

// The whole browser leg for `identity`; returns the callback response.
async function signIn(f: Flow, clientId: string, verifier: string, identity: LoginIdentity, state = 'idp-state-1') {
  const { pending, cookies } = await authorize(f, clientId, verifier);
  f.sessions.client.startLoginResults.push({
    authorizationUrl: `https://authentik.example.com/authorize?state=${state}`,
    state,
    nonce: 'nonce-1',
    codeVerifier: 'idp-verifier-1',
  });
  const approved = await consent(f, pending, cookies, 'approve');
  assert.equal(approved.status, 302);
  assert.equal(approved.headers.get('location'), `https://authentik.example.com/authorize?state=${state}`);
  f.sessions.client.completeLoginResults.push(identity);
  return fetch(`${f.base}/auth/callback?state=${state}&code=idp-code`, {
    redirect: 'manual',
    headers: { cookie: cookieHeader(cookiesFrom(approved)) },
  });
}

async function token(f: Flow, body: Record<string, string>) {
  return fetch(`${f.base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
}

async function signedInTokens(f: Flow, identity: LoginIdentity = ADMIN) {
  const clientId = await register(f);
  const verifier = b64url(randomBytes(32));
  const callback = await signIn(f, clientId, verifier, identity);
  assert.equal(callback.status, 302);
  const code = new URL(callback.headers.get('location')!).searchParams.get('code')!;
  const res = await token(f, {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: clientId,
    redirect_uri: CLIENT_REDIRECT,
  });
  assert.equal(res.status, 200);
  return { clientId, tokens: await res.json() };
}

test('discovery documents point MCP clients at Bellhop as their authorization server', async (t) => {
  const f = await setup();
  t.after(f.close);
  const resource = await (await fetch(`${f.base}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(resource.resource, `${f.base}/mcp`);
  assert.deepEqual(resource.authorization_servers, [`${f.base}/`]);
  const as = await (await fetch(`${f.base}/.well-known/oauth-authorization-server`)).json();
  assert.equal(as.authorization_endpoint, `${f.base}/authorize`);
  assert.equal(as.token_endpoint, `${f.base}/token`);
  assert.equal(as.registration_endpoint, `${f.base}/register`);
  assert.equal(as.revocation_endpoint, `${f.base}/revoke`);
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);

  const unauth = await rawPost(`${f.base}/mcp`, {}, INITIALIZE);
  assert.equal(unauth.status, 401);
  assert.match(unauth.headers.get('www-authenticate') ?? '', /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp"/);
});

test('the consent page names the client and where it returns to', async (t) => {
  const f = await setup();
  t.after(f.close);
  const clientId = await register(f);
  const { html, cookies } = await authorize(f, clientId, b64url(randomBytes(32)));
  assert.match(html, /Example MCP client/);
  assert.match(html, /http:\/\/localhost:33418/);
  assert.ok(Object.keys(cookies).some((name) => name.startsWith('bellhop_mcp_')), 'consent cookie set');
});

test('an admin signs in and the client calls tools with the issued token', async (t) => {
  const f = await setup();
  t.after(f.close);
  const clientId = await register(f);
  const verifier = b64url(randomBytes(32));
  const callback = await signIn(f, clientId, verifier, ADMIN);
  assert.equal(callback.status, 302);
  const location = new URL(callback.headers.get('location')!);
  assert.equal(`${location.origin}${location.pathname}`, CLIENT_REDIRECT);
  assert.equal(location.searchParams.get('state'), 'client-state');
  assert.ok(!Object.keys(cookiesFrom(callback)).includes('bellhop_session'), 'no browser session is created');

  const wrongVerifier = await token(f, {
    grant_type: 'authorization_code',
    code: location.searchParams.get('code')!,
    code_verifier: b64url(randomBytes(32)),
    client_id: clientId,
  });
  assert.equal(wrongVerifier.status, 400, 'PKCE is enforced');
});

test('the full flow yields a token that reaches /mcp as the signed-in admin', async (t) => {
  const f = await setup();
  t.after(f.close);
  const { tokens } = await signedInTokens(f);
  assert.equal(tokens.token_type.toLowerCase(), 'bearer');
  assert.equal(tokens.expires_in, 3600);
  const { call } = await connectHttpClient(`${f.base}/mcp`, { headers: { authorization: `Bearer ${tokens.access_token}` } });
  assert.equal(parse(await call('get_inventory')).domain, 'example.com');
});

test('a code works once', async (t) => {
  const f = await setup();
  t.after(f.close);
  const clientId = await register(f);
  const verifier = b64url(randomBytes(32));
  const callback = await signIn(f, clientId, verifier, ADMIN);
  const code = new URL(callback.headers.get('location')!).searchParams.get('code')!;
  const body = { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId };
  assert.equal((await token(f, body)).status, 200);
  assert.equal((await token(f, body)).status, 400);
});

test('refresh rotates the refresh token, and the old one is refused', async (t) => {
  const f = await setup();
  t.after(f.close);
  const { clientId, tokens } = await signedInTokens(f);
  const refreshed = await token(f, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId });
  assert.equal(refreshed.status, 200);
  const next = await refreshed.json();
  assert.notEqual(next.refresh_token, tokens.refresh_token);
  const reused = await token(f, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId });
  assert.equal(reused.status, 400);
  assert.equal((await reused.json()).error, 'invalid_grant');
});

test('revoking the refresh token ends access', async (t) => {
  const f = await setup();
  t.after(f.close);
  const { clientId, tokens } = await signedInTokens(f);
  const revoked = await fetch(`${f.base}/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: tokens.refresh_token, client_id: clientId }).toString(),
  });
  assert.equal(revoked.status, 200);
  assert.equal((await rawPost(`${f.base}/mcp`, { authorization: `Bearer ${tokens.access_token}` }, INITIALIZE)).status, 401);
});

test('declining consent sends the client access_denied and issues nothing', async (t) => {
  const f = await setup();
  t.after(f.close);
  const clientId = await register(f);
  const { pending, cookies } = await authorize(f, clientId, b64url(randomBytes(32)));
  const denied = await consent(f, pending, cookies, 'deny');
  assert.equal(denied.status, 302);
  const location = new URL(denied.headers.get('location')!);
  assert.equal(location.searchParams.get('error'), 'access_denied');
  assert.equal(location.searchParams.get('state'), 'client-state');
  assert.equal(f.sessions.client.callsTo('startLogin').length, 0);
});

test('a consent post without its cookie is refused', async (t) => {
  const f = await setup();
  t.after(f.close);
  const clientId = await register(f);
  const { pending } = await authorize(f, clientId, b64url(randomBytes(32)));
  const res = await consent(f, pending, {}, 'approve');
  assert.equal(res.status, 400);
  assert.equal(f.sessions.client.callsTo('startLogin').length, 0);
});

test('a non-admin is refused at the callback: no code, an explanatory page', async (t) => {
  const f = await setup();
  t.after(f.close);
  const clientId = await register(f);
  const callback = await signIn(f, clientId, b64url(randomBytes(32)), {
    ...ADMIN,
    username: 'viewer',
    uid: 'uid-viewer',
    groups: ['example-users'],
  });
  assert.equal(callback.status, 403);
  assert.equal(callback.headers.get('location'), null);
  assert.match(await callback.text(), /MCP access is limited to Bellhop admins/);
});

// FR-010, both ways (review finding: the first version signed out no
// session at all). The person is signed in to the web UI and to MCP.
test('signing out of the web UI leaves MCP access working', async (t) => {
  const f = await setup();
  t.after(f.close);
  const browser = sessionCookie(f.sessions, { username: 'admin', groups: [ADMIN_GROUP], uid: 'uid-admin' });
  const { tokens } = await signedInTokens(f);
  assert.equal((await fetch(`${f.base}/api/whoami`, { headers: { cookie: browser } })).status, 200);
  f.sessions.client.endSessionUrlResults.push(undefined);
  const out = await fetch(`${f.base}/auth/logout`, { method: 'POST', redirect: 'manual', headers: { cookie: browser } });
  assert.equal(out.status, 303);
  assert.equal((await fetch(`${f.base}/api/whoami`, { headers: { cookie: browser } })).status, 401, 'web session ended');
  const { call } = await connectHttpClient(`${f.base}/mcp`, { headers: { authorization: `Bearer ${tokens.access_token}` } });
  assert.equal(parse(await call('get_inventory')).domain, 'example.com');
});

test('an admin removed from the admin groups is refused with 403 after the next re-check', async (t) => {
  const f = await setup();
  t.after(f.close);
  const { tokens } = await signedInTokens(f);
  f.clock.now += 5 * MIN;
  const demoted: RecheckResult = {
    kind: 'ok',
    identity: { username: 'admin', uid: 'uid-admin', groups: ['example-users'], refreshToken: 'example-refresh-2' },
  };
  f.sessions.client.recheckResults.push(demoted);
  const res = await rawPost(`${f.base}/mcp`, { authorization: `Bearer ${tokens.access_token}` }, INITIALIZE);
  assert.equal(res.status, 403);
});

test('a sign-in the provider refuses on re-check ends the token with 401', async (t) => {
  const f = await setup();
  t.after(f.close);
  const { clientId, tokens } = await signedInTokens(f);
  f.clock.now += 5 * MIN;
  f.sessions.client.recheckResults.push({ kind: 'refused', reason: 'example refused' });
  assert.equal((await rawPost(`${f.base}/mcp`, { authorization: `Bearer ${tokens.access_token}` }, INITIALIZE)).status, 401);
  const refresh = await token(f, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId });
  assert.equal(refresh.status, 400, 'the grant is gone too');
});

// Review finding: approving restarts the pending request's 10 minutes, so a
// slow consent plus a slow Authentik sign-in (MFA) still completes.
test('approval restarts the pending clock, so a slow consent and sign-in still get a code', async (t) => {
  const f = await setup();
  t.after(f.close);
  const clientId = await register(f);
  const { pending, cookies } = await authorize(f, clientId, b64url(randomBytes(32)));
  f.clock.now += 9.5 * MIN;
  f.sessions.client.startLoginResults.push({
    authorizationUrl: 'https://authentik.example.com/authorize?state=slow-state',
    state: 'slow-state',
    nonce: 'nonce-1',
    codeVerifier: 'idp-verifier-1',
  });
  const approved = await consent(f, pending, cookies, 'approve');
  assert.equal(approved.status, 302);
  f.clock.now += 1 * MIN;
  f.sessions.client.completeLoginResults.push(ADMIN);
  const callback = await fetch(`${f.base}/auth/callback?state=slow-state&code=idp-code`, {
    redirect: 'manual',
    headers: { cookie: cookieHeader(cookiesFrom(approved)) },
  });
  assert.equal(callback.status, 302);
  assert.ok(new URL(callback.headers.get('location')!).searchParams.get('code'));
});

// Review finding: a failed MCP sign-in hands the client an OAuth error
// instead of a web-login page whose links start a browser sign-in.
test('the provider refusing the sign-in sends the client access_denied', async (t) => {
  const f = await setup();
  t.after(f.close);
  const clientId = await register(f);
  const { pending, cookies } = await authorize(f, clientId, b64url(randomBytes(32)));
  f.sessions.client.startLoginResults.push({
    authorizationUrl: 'https://authentik.example.com/authorize?state=deny-state',
    state: 'deny-state',
    nonce: 'nonce-1',
    codeVerifier: 'idp-verifier-1',
  });
  const approved = await consent(f, pending, cookies, 'approve');
  const callback = await fetch(`${f.base}/auth/callback?state=deny-state&error=access_denied`, {
    redirect: 'manual',
    headers: { cookie: cookieHeader(cookiesFrom(approved)) },
  });
  assert.equal(callback.status, 302);
  const location = new URL(callback.headers.get('location')!);
  assert.equal(`${location.origin}${location.pathname}`, CLIENT_REDIRECT);
  assert.equal(location.searchParams.get('error'), 'access_denied');
  assert.equal(location.searchParams.get('state'), 'client-state');
});

test('an unreachable identity provider at approval sends the client temporarily_unavailable', async (t) => {
  const f = await setup();
  t.after(f.close);
  const clientId = await register(f);
  const { pending, cookies } = await authorize(f, clientId, b64url(randomBytes(32)));
  f.sessions.client.startLoginResults.push(() => {
    throw new Error('connect ECONNREFUSED');
  });
  const approved = await consent(f, pending, cookies, 'approve');
  assert.equal(approved.status, 302);
  const location = new URL(approved.headers.get('location')!);
  assert.equal(`${location.origin}${location.pathname}`, CLIENT_REDIRECT);
  assert.equal(location.searchParams.get('error'), 'temporarily_unavailable');
});

test('revoking MCP access leaves the web UI session working', async (t) => {
  const f = await setup();
  t.after(f.close);
  const browser = sessionCookie(f.sessions, { username: 'admin', groups: [ADMIN_GROUP], uid: 'uid-admin' });
  const { clientId, tokens } = await signedInTokens(f);
  await fetch(`${f.base}/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: tokens.refresh_token, client_id: clientId }).toString(),
  });
  assert.equal((await rawPost(`${f.base}/mcp`, { authorization: `Bearer ${tokens.access_token}` }, INITIALIZE)).status, 401);
  assert.equal((await fetch(`${f.base}/api/whoami`, { headers: { cookie: browser } })).status, 200);
});
