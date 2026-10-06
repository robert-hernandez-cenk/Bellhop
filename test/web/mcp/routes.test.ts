import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { InsufficientScopeError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { McpHttpHost } from '../../../src/web/mcp/http-host.ts';
import { mcpRoutes, MCP_NOT_ENABLED_MESSAGE } from '../../../src/web/mcp/routes.ts';
import { mcpHttpDeps, listen, connectHttpClient, rawPost, INITIALIZE } from '../../support/mcp-http-harness.ts';
import { parse } from '../../support/mcp-harness.ts';

// mcpRoutes' own checks (#65/#66, contracts/http-mcp.md steps 1-3), with a
// stub verifier: 'good' is a valid admin token, 'demoted' a signed-in user
// who is no longer an admin, anything else unknown.
const verifier = {
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (token === 'demoted') throw new InsufficientScopeError('No longer a Bellhop admin');
    if (token !== 'good') throw new InvalidTokenError('Unknown token');
    return {
      token,
      clientId: 'client-1',
      scopes: [],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      extra: { principal: 'grant:1', username: 'admin' },
    };
  },
};

async function setup(opts: { enabled?: boolean; resourceMetadataUrl?: string } = {}) {
  const { deps } = mcpHttpDeps();
  const host = new McpHttpHost({ deps });
  const app = express();
  app.use(express.json());
  app.use(
    mcpRoutes({
      host,
      verifier,
      enabled: () => opts.enabled ?? true,
      resourceMetadataUrl: () => opts.resourceMetadataUrl,
    })
  );
  app.use((_req, res) => res.status(418).send('fell through'));
  const server = await listen(app);
  return {
    url: `${server.base}/mcp`,
    base: server.base,
    close: async () => {
      await host.close();
      await server.close();
    },
  };
}

test('with neither sign-in nor a key configured, /mcp answers 503 naming both fixes', async (t) => {
  const s = await setup({ enabled: false });
  t.after(s.close);
  const res = await rawPost(s.url, { authorization: 'Bearer good' }, INITIALIZE);
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.error, MCP_NOT_ENABLED_MESSAGE);
  assert.doesNotMatch(MCP_NOT_ENABLED_MESSAGE, /configure-web-login/, 'the removed command is not offered');
  assert.match(MCP_NOT_ENABLED_MESSAGE, /flag Bellhop/);
  assert.match(MCP_NOT_ENABLED_MESSAGE, /mcpApiKey/);
});

test('a request without a bearer token is answered 401 with the resource metadata pointer', async (t) => {
  const s = await setup({ resourceMetadataUrl: 'https://bellhop.example.com/.well-known/oauth-protected-resource/mcp' });
  t.after(s.close);
  const res = await rawPost(s.url, {}, INITIALIZE);
  assert.equal(res.status, 401);
  assert.match(
    res.headers.get('www-authenticate') ?? '',
    /resource_metadata="https:\/\/bellhop\.example\.com\/\.well-known\/oauth-protected-resource\/mcp"/
  );
});

test('without sign-in the 401 carries no resource metadata pointer', async (t) => {
  const s = await setup();
  t.after(s.close);
  const res = await rawPost(s.url, { authorization: 'Bearer wrong' }, INITIALIZE);
  assert.equal(res.status, 401);
  assert.doesNotMatch(res.headers.get('www-authenticate') ?? '', /resource_metadata/);
});

test('a browser session cookie does not authenticate /mcp', async (t) => {
  const s = await setup();
  t.after(s.close);
  const res = await rawPost(s.url, { cookie: 'bellhop_session=anything' }, INITIALIZE);
  assert.equal(res.status, 401);
});

test('a signed-in caller who is no longer an admin is answered 403', async (t) => {
  const s = await setup();
  t.after(s.close);
  const res = await rawPost(s.url, { authorization: 'Bearer demoted' }, INITIALIZE);
  assert.equal(res.status, 403);
});

test('a valid bearer reaches the MCP server', async (t) => {
  const s = await setup();
  t.after(s.close);
  const { call } = await connectHttpClient(s.url, { headers: { authorization: 'Bearer good' } });
  assert.equal(parse(await call('get_inventory')).domain, 'example.com');
});

test('other paths fall through untouched', async (t) => {
  const s = await setup();
  t.after(s.close);
  const res = await fetch(`${s.base}/api/whoami`);
  assert.equal(res.status, 418);
});
