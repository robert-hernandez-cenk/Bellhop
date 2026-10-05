import { createHash, timingSafeEqual } from 'node:crypto';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { configValue } from '../../lib/config.ts';
import { SETTING_DEFS, settingSchema } from '../../lib/settings-defs.ts';

// The single API key /mcp accepts besides a signed-in token (#66, research
// R6): the mcpApiKey secret, or MCP_API_KEY, read on every request so a
// Settings-page change applies at once. Its caller is recorded on jobs as
// 'api-key' and gets the same operator trust stdio has.

export const API_KEY_PRINCIPAL = 'api-key';
// bearerAuth requires an expiry; the key itself has none, so each accepted
// request is reported as valid for an hour (nothing caches it).
const REPORTED_LIFETIME_S = 3600;

// The effective key, or undefined. A stored value is re-validated by the
// accessor; an environment value is checked here, since configValue leaves
// env values to their consumer. Either failure names the setting and its
// variable, never the value.
function effectiveKey(env: NodeJS.ProcessEnv): string | undefined {
  const { value, source } = configValue('mcpApiKey', env);
  if (value === undefined) return undefined;
  if (source === 'environment' && !settingSchema('mcpApiKey').safeParse(value).success) {
    throw new Error(
      `${SETTING_DEFS.mcpApiKey.envVar} is invalid (it must be at least 32 characters with no whitespace); fix or unset it`
    );
  }
  return value;
}

export function apiKeyConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return configValue('mcpApiKey', env).value !== undefined;
}

// Compared as SHA-256 digests with timingSafeEqual: equal lengths always,
// so neither the content nor the length of the key leaks through timing.
export function verifyApiKey(presented: string, env: NodeJS.ProcessEnv = process.env): AuthInfo | undefined {
  const key = effectiveKey(env);
  if (key === undefined) return undefined;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  if (!timingSafeEqual(digest(presented), digest(key))) return undefined;
  return {
    token: presented,
    clientId: API_KEY_PRINCIPAL,
    scopes: [],
    expiresAt: Math.floor(Date.now() / 1000) + REPORTED_LIFETIME_S,
    extra: { principal: API_KEY_PRINCIPAL, username: API_KEY_PRINCIPAL },
  };
}
