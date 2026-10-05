import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { McpHttpHost, type McpPrincipal } from '../../../src/web/mcp/http-host.ts';
import { mcpHttpDeps, listen, connectHttpClient, rawPost, INITIALIZE } from '../../support/mcp-http-harness.ts';
import { parse } from '../../support/mcp-harness.ts';

// The host alone (#65/#66, FR-003/FR-006): authentication is mcpRoutes'
// job, so these tests hand it a principal from a test header.
async function setup(opts: { now?: () => number } = {}) {
  const { deps, jobStore } = mcpHttpDeps();
  const host = new McpHttpHost({ deps, now: opts.now });
  const app = express();
  app.use(express.json());
  app.all('/mcp', (req, res) => {
    const id = String(req.headers['x-test-principal'] ?? 'grant:1');
    const principal: McpPrincipal = { id, username: id === 'api-key' ? 'api-key' : 'admin' };
    void host.handle(req, res, principal);
  });
  const server = await listen(app);
  const url = `${server.base}/mcp`;
  return {
    host,
    url,
    jobStore,
    close: async () => {
      await host.close();
      await server.close();
    },
  };
}

test('an MCP client initializes a session over HTTP and calls a tool', async (t) => {
  const s = await setup();
  t.after(s.close);
  const { client, call } = await connectHttpClient(s.url);
  const tools = await client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === 'get_inventory'));
  const inventory = parse(await call('get_inventory'));
  assert.equal(inventory.domain, 'example.com');
  assert.equal(s.host.size, 1);
});

test('a request naming an unknown session id is answered 404', async (t) => {
  const s = await setup();
  t.after(s.close);
  const res = await rawPost(s.url, { 'mcp-session-id': 'no-such-session' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(res.status, 404);
});

test('a request without a session id that is not initialize is answered 400', async (t) => {
  const s = await setup();
  t.after(s.close);
  const res = await rawPost(s.url, {}, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(res.status, 400);
});

test("a session refuses another principal's request with 403", async (t) => {
  const s = await setup();
  t.after(s.close);
  const { transport } = await connectHttpClient(s.url, { headers: { 'x-test-principal': 'grant:1' } });
  const sessionId = transport.sessionId!;
  const other = await rawPost(
    s.url,
    { 'mcp-session-id': sessionId, 'x-test-principal': 'api-key', 'mcp-protocol-version': '2025-06-18' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' }
  );
  assert.equal(other.status, 403);
});

test('a raw initialize creates a session and returns its id', async (t) => {
  const s = await setup();
  t.after(s.close);
  const res = await rawPost(s.url, {}, INITIALIZE);
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('mcp-session-id'));
});

test('the idle sweep closes a session unused for 30 minutes, after which its id is unknown', async (t) => {
  let now = 1_000_000;
  const s = await setup({ now: () => now });
  t.after(s.close);
  const { transport } = await connectHttpClient(s.url);
  const sessionId = transport.sessionId!;
  now += 29 * 60 * 1000;
  s.host.sweep();
  assert.equal(s.host.size, 1, 'not idle long enough yet');
  now += 60 * 1000;
  s.host.sweep();
  assert.equal(s.host.size, 0);
  const res = await rawPost(
    s.url,
    { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
    { jsonrpc: '2.0', id: 3, method: 'tools/list' }
  );
  assert.equal(res.status, 404);
});
