import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema, type ElicitRequest, type ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpDeps } from '../../src/mcp/build-server.ts';
import { JobStore } from '../../src/web/jobs/job-store.ts';
import { createJobLog } from '../../src/web/jobs/job-log.ts';
import { JobRunner } from '../../src/web/jobs/job-runner.ts';
import { UnconfiguredCloudflareClient } from '../../src/lib/cloudflare-client.ts';
import { UnconfiguredAuthentikClient } from '../../src/lib/authentik-client.ts';
import { loadInventory, saveInventory } from '../../src/lib/inventory.ts';
import type { SSHClient } from '../../src/lib/ssh-client.ts';
import { FakeSSHClient, defaultResponder } from './fake-ssh-client.ts';
import { MCP_TEST_INVENTORY, type TextResult } from './mcp-harness.ts';

// The web service's side of HTTP MCP tests (#65/#66): the deps a
// McpHttpHost/mcpRoutes is built from, with the job runner owned by 'web'
// as in production.
export function mcpHttpDeps(opts: { jobSsh?: SSHClient; runnerOptions?: ConstructorParameters<typeof JobRunner>[3] } = {}) {
  const inventoryPath = path.join(mkdtempSync(path.join(tmpdir(), 'mcp-http-')), 'bellhop.db');
  saveInventory(inventoryPath, MCP_TEST_INVENTORY);
  const ssh = new FakeSSHClient(defaultResponder);
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'mcp-http-log-')));
  const jobRunner = new JobRunner(jobStore, jobLog, opts.jobSsh ?? ssh, { owner: 'web', ...opts.runnerOptions });
  const deps: McpDeps = {
    ssh,
    inventory: loadInventory(inventoryPath),
    inventoryPath,
    authentik: new UnconfiguredAuthentikClient(),
    cloudflare: new UnconfiguredCloudflareClient(),
    fetchImpl: (async () => new Response(null, { status: 404 })) as unknown as typeof fetch,
    jobStore,
    jobLog,
    jobRunner,
  };
  return { deps, ssh, jobStore, jobRunner, inventoryPath };
}

// Listens on an ephemeral loopback port; close() also drops keep-alive
// sockets so the test process can exit.
export async function listen(handler: http.RequestListener): Promise<{ base: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export interface HttpClientOptions {
  headers?: Record<string, string>;
  elicit?: (request: ElicitRequest, signal: AbortSignal) => Promise<ElicitResult>;
}

// A real SDK client over Streamable HTTP, as a remote MCP client uses it.
export async function connectHttpClient(url: string, opts: HttpClientOptions = {}) {
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: opts.headers ?? {} } });
  const client = new Client({ name: 'test', version: '1.0.0' }, opts.elicit ? { capabilities: { elicitation: {} } } : undefined);
  if (opts.elicit) {
    const elicit = opts.elicit;
    client.setRequestHandler(ElicitRequestSchema, (request, extra) => elicit(request, extra.signal));
  }
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as TextResult;
  return { client, transport, call };
}

// One JSON-RPC POST without the SDK, for status-code assertions.
export async function rawPost(url: string, headers: Record<string, string>, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
}

export const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1.0.0' } },
};
