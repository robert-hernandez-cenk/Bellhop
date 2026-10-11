import { Router, type RequestHandler } from 'express';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { McpHttpHost } from './http-host.ts';

// /mcp on the web service (#65/#66, contracts/http-mcp.md). Mounted ahead
// of requireAuth: a browser session cookie never authenticates it, only an
// Authorization: Bearer credential the verifier accepts (an access token
// from Bellhop's own authorization server, or the API key). Checks, in
// order, each before any MCP handling:
//   1. neither sign-in nor a key configured -> 503 naming both fixes (FR-020)
//   2. missing/unknown/expired credential   -> 401 (+ resource_metadata)
//   3. signed-in caller no longer an admin   -> 403 (the verifier throws
//      InsufficientScopeError)
// then the host, which binds the session to the caller.

export const MCP_NOT_ENABLED_MESSAGE =
  "MCP over HTTP is not enabled: configure web sign-in with an https:// redirect URI (flag Bellhop's own guest as Bellhop, or set the Settings > Web login values) " +
  'or set an API key (Settings > MCP, or bellhop set-config mcpApiKey --stdin --apply)';

const AUTH_SERVER_PATHS = ['/.well-known', '/authorize', '/token', '/register', '/revoke'];

export interface McpRoutesOptions {
  host: McpHttpHost;
  verifier: OAuthTokenVerifier;
  // Read per request, so a settings change applies without a restart.
  enabled: () => boolean;
  // The protected-resource metadata URL, only while sign-in is configured.
  resourceMetadataUrl: () => string | undefined;
  // The authorization server's own routes (discovery, /register,
  // /authorize, /token, /revoke), only while sign-in is configured.
  authRouter?: () => RequestHandler | undefined;
}

export function mcpRoutes(options: McpRoutesOptions): Router {
  const router = Router();

  if (options.authRouter) {
    const authRouter = options.authRouter;
    // Only its own paths consult it (and so read the web-login settings);
    // every other request -- page loads, /api -- passes straight through.
    // Checked by hand rather than mounted on those paths: mounting would
    // strip the prefix from req.url, and the SDK router matches full paths.
    router.use((req, res, next) => {
      if (!AUTH_SERVER_PATHS.some((path) => req.path === path || req.path.startsWith(`${path}/`))) return next();
      const handler = authRouter();
      if (!handler) return next();
      handler(req, res, next);
    });
  }

  router.all('/mcp', (req, res, next) => {
    if (!options.enabled()) {
      res.status(503).json({ error: MCP_NOT_ENABLED_MESSAGE });
      return;
    }
    // Built per request: the metadata URL follows the current settings.
    requireBearerAuth({ verifier: options.verifier, resourceMetadataUrl: options.resourceMetadataUrl() })(req, res, next);
  });

  router.all('/mcp', (req, res) => {
    const extra = req.auth?.extra ?? {};
    const principal = { id: String(extra.principal), username: String(extra.username) };
    void options.host.handle(req, res, principal);
  });

  return router;
}
