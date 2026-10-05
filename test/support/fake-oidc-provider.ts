import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Request, type Response } from 'express';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';

// An in-process stand-in for an Authentik OAuth2/OIDC provider (#69 research
// R14), so RealWebLoginClient is tested against real HTTP, real RS256
// signatures and real PKCE rather than a mock of openid-client. It serves the
// live-captured discovery document (test/fixtures/authentik/oidc-discovery.json,
// never edited here) with every authentik.example.com URL rewritten to this
// server's origin, so the endpoint layout -- shared /application/o/token/,
// per-application issuer, jwks and end-session -- is Authentik's own.
//
// Everything a test needs to vary lives on `behavior`, reset to defaults by
// reset(); every request is appended to `requests` so tests can assert on the
// PKCE/state/nonce parameters the client actually sent.

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/authentik/oidc-discovery.json');
const CAPTURED_ORIGIN = 'https://authentik.example.com';
const KID = 'fake-oidc-key';

export const FAKE_CLIENT_ID = 'example-client-id';
export const FAKE_CLIENT_SECRET = 'example-client-secret-token';
export const FAKE_REDIRECT_URI = 'https://bellhop.example.com/auth/callback';

export type Endpoint = 'discovery' | 'authorize' | 'token' | 'userinfo' | 'jwks' | 'end-session';

// A scripted failure for one endpoint: an HTTP status with an optional JSON
// body, a dropped connection, or no response at all (for timeouts).
export type Failure = { status: number; body?: Record<string, unknown> } | 'disconnect' | 'hang';

export interface FakeOidcBehavior {
  // The signed-in user's claims, used for both the ID token and userinfo.
  claims: Record<string, unknown>;
  // Merged over `claims` for userinfo only: set a field to `undefined` to have
  // userinfo omit it, or a different `sub` to simulate a mismatch.
  userinfoClaims: Record<string, unknown>;
  // Merged over the standard ID-token claims (iss, aud, nonce, exp...) to
  // produce an invalid token.
  idTokenClaims: Record<string, unknown>;
  // Sign ID tokens with a key that is not the one published at the JWKS URI.
  signWithForeignKey: boolean;
  issueRefreshToken: boolean;
  // Authentik rotates refresh tokens on use: the presented one is consumed
  // and a second use gets invalid_grant.
  rotateRefreshTokens: boolean;
  idTokenOnRefresh: boolean;
  omitEndSession: boolean;
  failures: Partial<Record<Endpoint, Failure>>;
}

export interface RecordedRequest {
  endpoint: Endpoint;
  method: string;
  query: Record<string, string>;
  body: Record<string, string>;
  authorization?: string;
}

interface IssuedCode {
  nonce?: string;
  codeChallenge?: string;
  redirectUri?: string;
}

export interface FakeOidcProvider {
  origin: string;
  issuer: string;
  behavior: FakeOidcBehavior;
  requests: RecordedRequest[];
  // Every refresh token issued so far, in order (tests assert none leaks).
  issuedRefreshTokens: string[];
  issuedIdTokens: string[];
  // Follows an authorization URL as a browser would (the user is already
  // signed in at the provider) and returns the callback URL it redirects to.
  authorize(authorizationUrl: string): Promise<string>;
  reset(): void;
  close(): Promise<void>;
}

function defaultBehavior(): FakeOidcBehavior {
  return {
    claims: {
      sub: 'example-sub-1',
      preferred_username: 'test-user',
      email: 'test-user@example.com',
      name: 'Test User',
      groups: ['bellhop-admins', 'homelab-users'],
    },
    userinfoClaims: {},
    idTokenClaims: {},
    signWithForeignKey: false,
    issueRefreshToken: true,
    rotateRefreshTokens: true,
    idTokenOnRefresh: true,
    omitEndSession: false,
    failures: {},
  };
}

function strings(input: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (input && typeof input === 'object') {
    for (const [k, v] of Object.entries(input)) if (typeof v === 'string') out[k] = v;
  }
  return out;
}

const token = () => randomBytes(24).toString('base64url');

export async function startFakeOidcProvider(): Promise<FakeOidcProvider> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const foreign = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: KID, alg: 'RS256', use: 'sig' };

  const codes = new Map<string, IssuedCode>();
  const accessTokens = new Map<string, true>();
  // refresh token -> still usable?
  const refreshTokens = new Map<string, boolean>();

  const app = express();
  app.use(express.urlencoded({ extended: false }));

  const provider: FakeOidcProvider = {
    origin: '',
    issuer: '',
    behavior: defaultBehavior(),
    requests: [],
    issuedRefreshTokens: [],
    issuedIdTokens: [],
    async authorize(authorizationUrl) {
      const res = await fetch(authorizationUrl, { redirect: 'manual' });
      const location = res.headers.get('location');
      if (res.status !== 302 || !location) throw new Error(`fake authorize returned ${res.status}`);
      return location;
    },
    reset() {
      provider.behavior = defaultBehavior();
      provider.requests.length = 0;
    },
    close: async () => {},
  };

  // Records the request, then applies a scripted failure if one is set.
  // Returns true when the failure has handled (or swallowed) the response.
  function intercept(endpoint: Endpoint, req: Request, res: Response): boolean {
    provider.requests.push({
      endpoint,
      method: req.method,
      query: strings(req.query),
      body: strings(req.body),
      authorization: req.headers.authorization,
    });
    const failure = provider.behavior.failures[endpoint];
    if (failure === undefined) return false;
    if (failure === 'disconnect') req.socket.destroy();
    else if (failure === 'hang') {
      // Never answer; the client's timeout has to fire.
    } else res.status(failure.status).json(failure.body ?? { error: 'server_error' });
    return true;
  }

  async function idToken(extra: Record<string, unknown>): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      ...provider.behavior.claims,
      iss: provider.issuer,
      aud: FAKE_CLIENT_ID,
      iat: now,
      exp: now + 300,
      auth_time: now,
      ...extra,
      ...provider.behavior.idTokenClaims,
    };
    const key: CryptoKey = provider.behavior.signWithForeignKey ? foreign.privateKey : privateKey;
    const jwt = await new SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid: KID, typ: 'JWT' }).sign(key);
    provider.issuedIdTokens.push(jwt);
    return jwt;
  }

  function newRefreshToken(): string {
    const value = token();
    refreshTokens.set(value, true);
    provider.issuedRefreshTokens.push(value);
    return value;
  }

  // Client authentication: client_secret_post (openid-client's default) or
  // client_secret_basic, as Authentik's discovery document advertises.
  function clientAuthenticated(req: Request): boolean {
    const body = strings(req.body);
    let id = body.client_id;
    let secret = body.client_secret;
    const header = req.headers.authorization;
    if (header?.startsWith('Basic ')) {
      const [user, pass] = Buffer.from(header.slice(6), 'base64').toString().split(':');
      id = decodeURIComponent(user ?? '');
      secret = decodeURIComponent(pass ?? '');
    }
    return id === FAKE_CLIENT_ID && secret === FAKE_CLIENT_SECRET;
  }

  const invalidGrant = (res: Response) => res.status(400).json({ error: 'invalid_grant' });

  app.get('/application/o/bellhop/.well-known/openid-configuration', (req, res) => {
    if (intercept('discovery', req, res)) return;
    const raw = readFileSync(FIXTURE, 'utf8').split(CAPTURED_ORIGIN).join(provider.origin);
    const doc = JSON.parse(raw) as Record<string, unknown>;
    if (provider.behavior.omitEndSession) delete doc.end_session_endpoint;
    res.json(doc);
  });

  app.get('/application/o/bellhop/jwks/', (req, res) => {
    if (intercept('jwks', req, res)) return;
    res.json({ keys: [jwk] });
  });

  app.get('/application/o/authorize/', (req, res) => {
    if (intercept('authorize', req, res)) return;
    const q = strings(req.query);
    const code = token();
    codes.set(code, { nonce: q.nonce, codeChallenge: q.code_challenge, redirectUri: q.redirect_uri });
    const target = new URL(q.redirect_uri ?? FAKE_REDIRECT_URI);
    target.searchParams.set('code', code);
    if (q.state !== undefined) target.searchParams.set('state', q.state);
    res.redirect(302, target.href);
  });

  app.post('/application/o/token/', async (req, res) => {
    if (intercept('token', req, res)) return;
    if (!clientAuthenticated(req)) {
      res.status(401).json({ error: 'invalid_client' });
      return;
    }
    const body = strings(req.body);
    const b = provider.behavior;
    const accessToken = token();

    if (body.grant_type === 'authorization_code') {
      const issued = body.code ? codes.get(body.code) : undefined;
      if (!issued) return void invalidGrant(res);
      codes.delete(body.code!); // single use
      const challenge = body.code_verifier
        ? createHash('sha256').update(body.code_verifier).digest('base64url')
        : undefined;
      if (challenge !== issued.codeChallenge || body.redirect_uri !== issued.redirectUri) return void invalidGrant(res);
      accessTokens.set(accessToken, true);
      res.json({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 3600,
        id_token: await idToken(issued.nonce !== undefined ? { nonce: issued.nonce } : {}),
        ...(b.issueRefreshToken ? { refresh_token: newRefreshToken() } : {}),
      });
      return;
    }

    if (body.grant_type === 'refresh_token') {
      const presented = body.refresh_token ?? '';
      if (refreshTokens.get(presented) !== true) return void invalidGrant(res);
      let next = presented;
      if (b.rotateRefreshTokens) {
        refreshTokens.set(presented, false);
        next = newRefreshToken();
      }
      accessTokens.set(accessToken, true);
      res.json({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: next,
        ...(b.idTokenOnRefresh ? { id_token: await idToken({}) } : {}),
      });
      return;
    }

    res.status(400).json({ error: 'unsupported_grant_type' });
  });

  app.get('/application/o/userinfo/', (req, res) => {
    if (intercept('userinfo', req, res)) return;
    const presented = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
    if (!accessTokens.has(presented)) {
      res.status(401).set('WWW-Authenticate', 'Bearer error="invalid_token"').end();
      return;
    }
    res.json({ ...provider.behavior.claims, ...provider.behavior.userinfoClaims });
  });

  app.get('/application/o/bellhop/end-session/', (req, res) => {
    if (intercept('end-session', req, res)) return;
    res.send('signed out');
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  provider.origin = `http://127.0.0.1:${port}`;
  provider.issuer = `${provider.origin}/application/o/bellhop/`;
  provider.close = () =>
    new Promise<void>((resolve) => {
      // 'hang' leaves requests open; drop them so close() can finish.
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return provider;
}
