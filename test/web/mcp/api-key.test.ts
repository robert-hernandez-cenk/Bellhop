import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { clearSecret } from '../../../src/lib/config.ts';
import { apiKeyConfigured, verifyApiKey, API_KEY_PRINCIPAL } from '../../../src/web/mcp/api-key.ts';
import { tempConfigStore, resetConfigStore } from '../../support/config-store.ts';

// #66: the single API key /mcp accepts besides a signed-in token, read from
// the settings store (or MCP_API_KEY) on every request.
const KEY = 'example-mcp-key-0123456789-abcdefghijk';

afterEach(resetConfigStore);

test('the stored key verifies as the api-key principal', () => {
  tempConfigStore({}, { mcpApiKey: KEY });
  const info = verifyApiKey(KEY, {});
  assert.ok(info);
  assert.equal(info.extra?.principal, API_KEY_PRINCIPAL);
  assert.equal(info.extra?.username, 'api-key');
  assert.ok(typeof info.expiresAt === 'number' && info.expiresAt > Date.now() / 1000);
});

test('a different value is not the key', () => {
  tempConfigStore({}, { mcpApiKey: KEY });
  assert.equal(verifyApiKey(`${KEY}x`, {}), undefined);
  assert.equal(verifyApiKey(KEY.slice(0, -1), {}), undefined);
});

test('with no key configured nothing verifies', () => {
  tempConfigStore();
  assert.equal(apiKeyConfigured({}), false);
  assert.equal(verifyApiKey(KEY, {}), undefined);
});

test('MCP_API_KEY overrides the stored key', () => {
  tempConfigStore({}, { mcpApiKey: KEY });
  const env = { MCP_API_KEY: 'example-env-key-0123456789-abcdefghijklm' };
  assert.equal(apiKeyConfigured(env), true);
  assert.equal(verifyApiKey(KEY, env), undefined);
  assert.ok(verifyApiKey(env.MCP_API_KEY, env));
});

test('a cleared key stops verifying', () => {
  const db = tempConfigStore({}, { mcpApiKey: KEY });
  assert.ok(verifyApiKey(KEY, {}));
  clearSecret(db, 'mcpApiKey');
  assert.equal(verifyApiKey(KEY, {}), undefined);
});

test('an invalid env key is refused with a message naming the variable, never the value', () => {
  tempConfigStore();
  const env = { MCP_API_KEY: 'short-leak-marker' };
  assert.throws(
    () => verifyApiKey('short-leak-marker', env),
    (err: Error) => err instanceof InvalidTokenError === false && /MCP_API_KEY/.test(err.message) && !err.message.includes('leak-marker')
  );
});
