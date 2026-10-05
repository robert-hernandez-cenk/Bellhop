import type { RequestHandler, Router } from 'express';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { McpDeps } from '../../mcp/build-server.ts';
import { webLoginConfig, type WebLoginConfig } from '../login/config.ts';
import type { SessionService } from '../login/sessions.ts';
import type { McpSignInFinisher } from '../routes/auth.ts';
import { McpHttpHost } from './http-host.ts';
import { mcpRoutes } from './routes.ts';
import { apiKeyConfigured } from './api-key.ts';
import { McpAuthStore } from './auth-store.ts';
import { BellhopOAuthProvider } from './oauth-provider.ts';
import { consentRoutes, mcpSignInFinisher } from './consent.ts';

// Wires the HTTP MCP endpoint into the web service (#65/#66): one host for
// every session, the fail-closed guard, the bearer verifier (API key, then
// Bellhop's own tokens), Bellhop's authorization server, and the consent
// and callback steps of an MCP sign-in.

export interface McpHttpDeps {
  mcp: McpDeps;
  sessions: SessionService;
  // data/sessions.sqlite3 in production; tests pass an in-memory one.
  authStore: McpAuthStore;
  // Read per request; tests inject a fixed one.
  webLoginConfig?: () => WebLoginConfig;
  // The auth store's clock (tests).
  now?: () => number;
}

export interface McpHttp {
  router: Router;
  consentRouter: Router;
  signIn: McpSignInFinisher;
  host: McpHttpHost;
}

// An invalid WEB_UI_OIDC_* value counts as "not configured" here: sign-in
// cannot work with it, and its own error already reaches the operator on
// /auth/login.
function signedInConfig(read: () => WebLoginConfig): Extract<WebLoginConfig, { configured: true }> | undefined {
  try {
    const cfg = read();
    return cfg.configured ? cfg : undefined;
  } catch {
    return undefined;
  }
}

// The issuer is this deployment's own origin, taken from the registered
// web-login redirect URI (FR-015). The SDK refuses a non-HTTPS issuer other
// than localhost/127.0.0.1; that leaves sign-in off (API key only) rather
// than failing requests.
function issuerFor(cfg: Extract<WebLoginConfig, { configured: true }>): URL | undefined {
  const url = new URL('/', cfg.redirectUri);
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  return url.protocol === 'https:' || loopback ? url : undefined;
}

// Behind the reverse proxy every client shares the proxy's address and the
// app does not set `trust proxy`; the limits still cap anonymous floods
// (e.g. /register), so they stay, without express-rate-limit's
// X-Forwarded-For misconfiguration warning. Its creationStack check is off
// too: the router is built on the first request for an issuer (the issuer
// comes from settings), but then cached, so the counters that check
// protects are never reset.
const RATE_LIMIT = { rateLimit: { validate: { xForwardedForHeader: false, creationStack: false } } };

export function buildMcpHttp(deps: McpHttpDeps): McpHttp {
  const readConfig = deps.webLoginConfig ?? (() => webLoginConfig());
  const host = new McpHttpHost({ deps: deps.mcp });
  const provider = new BellhopOAuthProvider({ store: deps.authStore, sessions: deps.sessions, now: deps.now });
  const currentIssuer = (): URL | undefined => {
    const cfg = signedInConfig(readConfig);
    return cfg ? issuerFor(cfg) : undefined;
  };

  // Built once per issuer and reused, so a settings change (a new address,
  // sign-in turned off) applies on the next request without a restart.
  const authRouters = new Map<string, RequestHandler>();
  const authRouter = (): RequestHandler | undefined => {
    const issuer = currentIssuer();
    if (!issuer) return undefined;
    let router = authRouters.get(issuer.href);
    if (!router) {
      router = mcpAuthRouter({
        provider,
        issuerUrl: issuer,
        resourceServerUrl: new URL('/mcp', issuer),
        resourceName: 'Bellhop',
        authorizationOptions: RATE_LIMIT,
        clientRegistrationOptions: RATE_LIMIT,
        tokenOptions: RATE_LIMIT,
        revocationOptions: RATE_LIMIT,
      });
      authRouters.set(issuer.href, router);
    }
    return router;
  };

  const router = mcpRoutes({
    host,
    verifier: provider,
    enabled: () => apiKeyConfigured() || currentIssuer() !== undefined,
    resourceMetadataUrl: () => {
      const issuer = currentIssuer();
      return issuer ? getOAuthProtectedResourceMetadataUrl(new URL('/mcp', issuer)) : undefined;
    },
    authRouter,
  });
  return {
    router,
    consentRouter: consentRoutes({ store: deps.authStore, sessions: deps.sessions }),
    signIn: mcpSignInFinisher({ store: deps.authStore, sessions: deps.sessions }),
    host,
  };
}
