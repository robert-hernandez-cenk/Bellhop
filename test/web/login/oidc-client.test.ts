import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { RealWebLoginClient, WebLoginError, type WebLoginSettings } from '../../../src/web/login/oidc-client.ts';
import {
  FAKE_CLIENT_ID,
  FAKE_CLIENT_SECRET,
  FAKE_REDIRECT_URI,
  startFakeOidcProvider,
  type FakeOidcProvider,
} from '../../support/fake-oidc-provider.ts';

// RealWebLoginClient against an in-process provider over real HTTP (#69
// research R14): signatures, issuer/audience/nonce/expiry and PKCE are
// checked by openid-client itself, not by a mock. allowInsecureRequests is
// passed only through the constructor option, because the fake is plain HTTP.

let provider: FakeOidcProvider;
before(async () => {
  provider = await startFakeOidcProvider();
});
after(async () => {
  await provider.close();
});
beforeEach(() => provider.reset());

function settings(overrides: Partial<WebLoginSettings> = {}): WebLoginSettings {
  return {
    configured: true,
    issuer: provider.issuer,
    clientId: FAKE_CLIENT_ID,
    clientSecret: FAKE_CLIENT_SECRET,
    redirectUri: FAKE_REDIRECT_URI,
    ...overrides,
  };
}

const newClient = (timeoutSeconds?: number) =>
  new RealWebLoginClient({ allowInsecureRequests: true, ...(timeoutSeconds ? { timeoutSeconds } : {}) });

async function signIn(client: RealWebLoginClient, cfg = settings()) {
  const pending = await client.startLogin(cfg);
  const callbackUrl = await provider.authorize(pending.authorizationUrl);
  return { pending, callbackUrl, identity: await client.completeLogin(cfg, callbackUrl, pending) };
}

const discoveries = () => provider.requests.filter((r) => r.endpoint === 'discovery').length;

// ---- startLogin ----

test('startLogin builds an authorization-code URL with PKCE S256, state, nonce and the offline_access scope', async () => {
  const client = newClient();
  const pending = await client.startLogin(settings());
  const url = new URL(pending.authorizationUrl);
  assert.equal(url.origin + url.pathname, `${provider.origin}/application/o/authorize/`);
  const q = url.searchParams;
  assert.equal(q.get('response_type'), 'code');
  assert.equal(q.get('client_id'), FAKE_CLIENT_ID);
  assert.equal(q.get('redirect_uri'), FAKE_REDIRECT_URI);
  assert.equal(q.get('scope'), 'openid profile email offline_access');
  assert.equal(q.get('state'), pending.state);
  assert.equal(q.get('nonce'), pending.nonce);
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.equal(q.get('code_challenge'), createHash('sha256').update(pending.codeVerifier).digest('base64url'));
  assert.equal(q.get('client_secret'), null);

  const again = await client.startLogin(settings());
  assert.notEqual(again.state, pending.state);
  assert.notEqual(again.nonce, pending.nonce);
  assert.notEqual(again.codeVerifier, pending.codeVerifier);
});

// ---- completeLogin ----

test('completeLogin exchanges the code with the verifier and builds the identity from userinfo', async () => {
  provider.behavior.userinfoClaims = { email: 'from-userinfo@example.com', groups: ['bellhop-admins'] };
  const { pending, identity } = await signIn(newClient());

  const tokenReq = provider.requests.find((r) => r.endpoint === 'token');
  assert.equal(tokenReq?.body.grant_type, 'authorization_code');
  assert.equal(tokenReq?.body.code_verifier, pending.codeVerifier);
  assert.equal(tokenReq?.body.redirect_uri, FAKE_REDIRECT_URI);
  assert.ok(provider.requests.some((r) => r.endpoint === 'userinfo' && r.authorization?.startsWith('Bearer ')));

  assert.deepEqual(identity, {
    username: 'test-user',
    uid: 'example-sub-1',
    email: 'from-userinfo@example.com',
    groups: ['bellhop-admins'],
    refreshToken: provider.issuedRefreshTokens.at(-1),
    idToken: provider.issuedIdTokens.at(-1),
  });
});

test('completeLogin falls back to ID-token claims for fields userinfo omits', async () => {
  provider.behavior.userinfoClaims = { email: undefined, groups: undefined };
  const { identity } = await signIn(newClient());
  assert.equal(identity.email, 'test-user@example.com');
  assert.deepEqual(identity.groups, ['bellhop-admins', 'homelab-users']);
});

test('completeLogin treats absent groups as none and absent email as undefined', async () => {
  provider.behavior.claims = { sub: 'example-sub-1', preferred_username: 'test-user' };
  const { identity } = await signIn(newClient());
  assert.deepEqual(identity.groups, []);
  assert.equal(identity.email, undefined);
});

const now = () => Math.floor(Date.now() / 1000);
const invalidIdTokens: Array<[string, () => void, RegExp]> = [
  ['a bad signature', () => void (provider.behavior.signWithForeignKey = true), /signature/],
  ['a wrong issuer', () => void (provider.behavior.idTokenClaims = { iss: 'https://authentik.example.com/application/o/other/' }), /"iss"/],
  ['a wrong audience', () => void (provider.behavior.idTokenClaims = { aud: 'another-client-id' }), /"aud"/],
  ['a wrong nonce', () => void (provider.behavior.idTokenClaims = { nonce: 'not-the-nonce' }), /"nonce"/],
  ['an expired token', () => void (provider.behavior.idTokenClaims = { iat: now() - 7200, exp: now() - 3600 }), /"exp"/],
];
for (const [label, arrange, reason] of invalidIdTokens) {
  test(`completeLogin rejects an ID token with ${label}`, async () => {
    arrange();
    await assert.rejects(signIn(newClient()), (err: Error) => err instanceof WebLoginError && reason.test(err.message));
  });
}

test('completeLogin rejects a state mismatch without calling the token endpoint', async () => {
  const client = newClient();
  const pending = await client.startLogin(settings());
  const callbackUrl = await provider.authorize(pending.authorizationUrl);
  await assert.rejects(client.completeLogin(settings(), callbackUrl, { ...pending, state: 'another-state' }), WebLoginError);
  assert.equal(provider.requests.filter((r) => r.endpoint === 'token').length, 0);
});

test('completeLogin rejects a provider error in the callback, naming the OAuth error', async () => {
  const client = newClient();
  const pending = await client.startLogin(settings());
  const callbackUrl = `${FAKE_REDIRECT_URI}?error=access_denied&state=${pending.state}`;
  await assert.rejects(client.completeLogin(settings(), callbackUrl, pending), /access_denied/);
});

test('completeLogin fails without preferred_username', async () => {
  provider.behavior.claims = { sub: 'example-sub-1', email: 'test-user@example.com' };
  await assert.rejects(signIn(newClient()), (err: Error) => err instanceof WebLoginError && /preferred_username/.test(err.message));
});

test('completeLogin fails when no refresh token is issued, naming the offline_access scope mapping', async () => {
  provider.behavior.issueRefreshToken = false;
  await assert.rejects(
    signIn(newClient()),
    (err: Error) => err instanceof WebLoginError && /offline_access/.test(err.message) && /sync-authentik --apply/.test(err.message)
  );
});

// ---- recheck ----

test('recheck returns a fresh identity and the rotated refresh token', async () => {
  const client = newClient();
  const { identity } = await signIn(client);
  provider.behavior.claims = { ...provider.behavior.claims, groups: ['homelab-users'], email: 'new@example.com' };

  const result = await client.recheck(settings(), identity.refreshToken, identity.uid);
  assert.equal(result.kind, 'ok');
  if (result.kind !== 'ok') return;
  assert.equal(result.identity.username, 'test-user');
  assert.equal(result.identity.uid, 'example-sub-1');
  assert.equal(result.identity.email, 'new@example.com');
  assert.deepEqual(result.identity.groups, ['homelab-users']);
  assert.notEqual(result.identity.refreshToken, identity.refreshToken);
  assert.equal(result.identity.refreshToken, provider.issuedRefreshTokens.at(-1));
  assert.equal(result.identity.idToken, provider.issuedIdTokens.at(-1));
  const refreshReq = provider.requests.find((r) => r.endpoint === 'token' && r.body.grant_type === 'refresh_token');
  assert.equal(refreshReq?.body.refresh_token, identity.refreshToken);
});

test('recheck keeps the presented refresh token when the provider does not rotate, and has no ID token when none is issued', async () => {
  const client = newClient();
  const { identity } = await signIn(client);
  provider.behavior.rotateRefreshTokens = false;
  provider.behavior.idTokenOnRefresh = false;
  const result = await client.recheck(settings(), identity.refreshToken, identity.uid);
  assert.equal(result.kind, 'ok');
  if (result.kind !== 'ok') return;
  assert.equal(result.identity.refreshToken, identity.refreshToken);
  assert.equal(result.identity.idToken, undefined);
});

test('recheck is refused when a consumed (rotated-away) refresh token is presented again', async () => {
  const client = newClient();
  const { identity } = await signIn(client);
  assert.equal((await client.recheck(settings(), identity.refreshToken, identity.uid)).kind, 'ok');
  const second = await client.recheck(settings(), identity.refreshToken, identity.uid);
  assert.equal(second.kind, 'refused');
  if (second.kind === 'refused') assert.match(second.reason, /invalid_grant/);
});

test('recheck is refused on invalid_client', async () => {
  const client = newClient();
  const { identity } = await signIn(client);
  const result = await client.recheck(settings({ clientSecret: 'wrong-example-token' }), identity.refreshToken, identity.uid);
  assert.equal(result.kind, 'refused');
  if (result.kind === 'refused') assert.match(result.reason, /invalid_client/);
});

test('recheck is refused on a token-endpoint 400 without an OAuth error body', async () => {
  const client = newClient();
  const { identity } = await signIn(client);
  provider.behavior.failures.token = { status: 400, body: {} };
  assert.equal((await client.recheck(settings(), identity.refreshToken, identity.uid)).kind, 'refused');
});

test('recheck is refused on a userinfo 401', async () => {
  const client = newClient();
  const { identity } = await signIn(client);
  provider.behavior.failures.userinfo = { status: 401, body: { error: 'invalid_token' } };
  assert.equal((await client.recheck(settings(), identity.refreshToken, identity.uid)).kind, 'refused');
});

test('recheck is refused when userinfo returns a different sub', async () => {
  const client = newClient();
  const { identity } = await signIn(client);
  provider.behavior.userinfoClaims = { sub: 'example-sub-2' };
  provider.behavior.idTokenOnRefresh = false;
  assert.equal((await client.recheck(settings(), identity.refreshToken, identity.uid)).kind, 'refused');
});

test('recheck is refused when the refreshed ID token is for a different sub', async () => {
  const client = newClient();
  const { identity } = await signIn(client);
  const result = await client.recheck(settings(), identity.refreshToken, 'example-sub-2');
  assert.equal(result.kind, 'refused');
});

test('recheck is unreachable on a 5xx from the token endpoint', async () => {
  const client = newClient();
  const { identity } = await signIn(client);
  provider.behavior.failures.token = { status: 503 };
  assert.equal((await client.recheck(settings(), identity.refreshToken, identity.uid)).kind, 'unreachable');
  provider.behavior.failures.token = { status: 502, body: { error: 'server_error' } };
  assert.equal((await client.recheck(settings(), identity.refreshToken, identity.uid)).kind, 'unreachable');
});

test('recheck is unreachable on a 5xx from userinfo', async () => {
  const client = newClient();
  const { identity } = await signIn(client);
  provider.behavior.failures.userinfo = { status: 500 };
  assert.equal((await client.recheck(settings(), identity.refreshToken, identity.uid)).kind, 'unreachable');
});

test('recheck is unreachable when the connection drops', async () => {
  const client = newClient();
  const { identity } = await signIn(client);
  provider.behavior.failures.token = 'disconnect';
  assert.equal((await client.recheck(settings(), identity.refreshToken, identity.uid)).kind, 'unreachable');
});

test('recheck is unreachable when the provider does not answer within the timeout', async () => {
  const client = newClient(1);
  const { identity } = await signIn(client);
  provider.behavior.failures.token = 'hang';
  const result = await client.recheck(settings(), identity.refreshToken, identity.uid);
  assert.equal(result.kind, 'unreachable');
});

async function closedPortIssuer(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}/application/o/bellhop/`;
}

test('recheck is unreachable when discovery cannot connect', async () => {
  const result = await newClient().recheck(settings({ issuer: await closedPortIssuer() }), 'example-token', 'example-sub-1');
  assert.equal(result.kind, 'unreachable');
});

// ---- endSessionUrl ----

test('endSessionUrl returns the provider end-session URL with id_token_hint and post_logout_redirect_uri', async () => {
  const url = await newClient().endSessionUrl(settings(), 'example-id-token', 'https://bellhop.example.com/auth/signed-out');
  assert.ok(url);
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, `${provider.origin}/application/o/bellhop/end-session/`);
  assert.equal(parsed.searchParams.get('id_token_hint'), 'example-id-token');
  assert.equal(parsed.searchParams.get('post_logout_redirect_uri'), 'https://bellhop.example.com/auth/signed-out');
});

test('endSessionUrl is undefined when discovery does not advertise an end-session endpoint', async () => {
  provider.behavior.omitEndSession = true;
  assert.equal(await newClient().endSessionUrl(settings(), 'example-id-token', 'https://bellhop.example.com/auth/signed-out'), undefined);
});

test('endSessionUrl is undefined (never throws) when discovery fails', async () => {
  const url = await newClient().endSessionUrl(
    settings({ issuer: await closedPortIssuer() }),
    'example-id-token',
    'https://bellhop.example.com/auth/signed-out'
  );
  assert.equal(url, undefined);
});

// ---- discovery cache ----

test('discovery is cached per (issuer, clientId, clientSecret) and a changed setting rediscovers', async () => {
  const client = newClient();
  await client.startLogin(settings());
  await client.startLogin(settings());
  assert.equal(discoveries(), 1);
  await client.startLogin(settings({ clientSecret: 'rotated-example-token' }));
  assert.equal(discoveries(), 2);
  await client.startLogin(settings({ clientId: 'another-client-id' }));
  assert.equal(discoveries(), 3);
});

test('a failed discovery is not cached', async () => {
  const client = newClient();
  provider.behavior.failures.discovery = { status: 503 };
  await assert.rejects(client.startLogin(settings()), (err: Error) => err instanceof WebLoginError && err.message.includes(provider.issuer));
  delete provider.behavior.failures.discovery;
  await client.startLogin(settings());
  assert.equal(discoveries(), 2);
});

// ---- secrecy ----

test('no error message or refusal reason contains the client secret, a refresh token or an ID token', async () => {
  const messages: string[] = [];
  const capture = async (p: Promise<unknown>) => {
    try {
      const result = (await p) as { kind?: string; reason?: string } | undefined;
      if (result?.reason) messages.push(result.reason);
    } catch (err) {
      messages.push(String((err as Error).message), String(err));
    }
  };

  const client = newClient(1);
  const { identity } = await signIn(client);
  await capture(client.recheck(settings(), identity.refreshToken, identity.uid));
  await capture(client.recheck(settings(), identity.refreshToken, identity.uid)); // consumed
  await capture(client.recheck(settings({ clientSecret: 'wrong-example-token' }), identity.refreshToken, identity.uid));
  await capture(client.recheck(settings(), provider.issuedRefreshTokens.at(-1)!, 'example-sub-2'));
  provider.behavior.failures.token = { status: 500 };
  await capture(client.recheck(settings(), provider.issuedRefreshTokens.at(-1)!, identity.uid));
  provider.behavior.failures = { userinfo: { status: 401 } };
  await capture(client.recheck(settings(), provider.issuedRefreshTokens.at(-1)!, identity.uid));
  provider.behavior.failures = {};

  for (const arrange of [
    () => void (provider.behavior.signWithForeignKey = true),
    () => void (provider.behavior.idTokenClaims = { nonce: 'not-the-nonce' }),
    () => void (provider.behavior.issueRefreshToken = false),
    () => void (provider.behavior.claims = { sub: 'example-sub-1' }),
    () => void (provider.behavior.failures.token = { status: 401, body: { error: 'invalid_client' } }),
  ]) {
    provider.reset();
    arrange();
    await capture(signIn(client));
  }
  provider.reset();
  provider.behavior.failures.discovery = { status: 500 };
  await capture(newClient().startLogin(settings()));

  assert.ok(messages.length >= 12, `expected failures to capture, got ${messages.length}`);
  const forbidden = [FAKE_CLIENT_SECRET, 'wrong-example-token', ...provider.issuedRefreshTokens, ...provider.issuedIdTokens];
  for (const message of messages) {
    for (const value of forbidden) assert.ok(!message.includes(value), `leaked a secret or token: ${message}`);
  }
});
