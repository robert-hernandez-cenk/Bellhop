import type { Router } from 'express';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { McpDeps } from '../../mcp/build-server.ts';
import { webLoginConfig, type WebLoginConfig } from '../login/config.ts';
import { McpHttpHost } from './http-host.ts';
import { mcpRoutes } from './routes.ts';
import { apiKeyConfigured, verifyApiKey } from './api-key.ts';

// Wires the HTTP MCP endpoint into the web service (#65/#66): one host for
// every session, the fail-closed guard, and the bearer verifier.

export interface McpHttpDeps {
  mcp: McpDeps;
  // Read per request; tests inject a fixed one.
  webLoginConfig?: () => WebLoginConfig;
}

export interface McpHttp {
  router: Router;
  host: McpHttpHost;
}

// An invalid WEB_UI_OIDC_* value counts as "not configured" here: sign-in
// cannot work with it, and its own error already reaches the operator on
// /auth/login.
export function signInConfigured(read: () => WebLoginConfig): boolean {
  try {
    return read().configured;
  } catch {
    return false;
  }
}

export function buildMcpHttp(deps: McpHttpDeps): McpHttp {
  const readConfig = deps.webLoginConfig ?? (() => webLoginConfig());
  const host = new McpHttpHost({ deps: deps.mcp });
  const verifier = {
    async verifyAccessToken(token: string) {
      const info = verifyApiKey(token);
      if (info) return info;
      throw new InvalidTokenError('Invalid or expired token');
    },
  };
  const router = mcpRoutes({
    host,
    verifier,
    enabled: () => apiKeyConfigured() || signInConfigured(readConfig),
    resourceMetadataUrl: () => undefined,
  });
  return { router, host };
}
