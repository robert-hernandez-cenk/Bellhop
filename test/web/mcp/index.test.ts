import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { buildMcpHttp } from '../../../src/web/mcp/index.ts';
import { McpAuthStore } from '../../../src/web/mcp/auth-store.ts';
import { mcpHttpDeps, listen } from '../../support/mcp-http-harness.ts';
import { newTestSessions, TEST_WEB_LOGIN_CONFIG } from '../../support/web-session.ts';

// The authorization server's router is built on the first request that
// passes through (its issuer comes from settings read per request). That
// must not make express-rate-limit log its "created in a request handler"
// warning on ordinary requests -- the router is cached per issuer, so its
// counters are never reset (#65/#66).
test('passing through the MCP routes logs nothing', async (t) => {
  const logged: unknown[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => logged.push(args[0]));
  t.mock.method(console, 'warn', (...args: unknown[]) => logged.push(args[0]));
  const { deps } = mcpHttpDeps();
  const mcp = buildMcpHttp({
    mcp: deps,
    sessions: newTestSessions(),
    authStore: new McpAuthStore(':memory:'),
    webLoginConfig: () => TEST_WEB_LOGIN_CONFIG,
  });
  const app = express();
  app.use(mcp.router);
  app.use((_req, res) => res.send('ok'));
  const server = await listen(app);
  t.after(async () => {
    await mcp.host.close();
    await server.close();
  });
  assert.equal(await (await fetch(`${server.base}/api/settings`)).text(), 'ok');
  assert.equal((await fetch(`${server.base}/.well-known/oauth-authorization-server`)).status, 200);
  assert.deepEqual(logged, []);
});
