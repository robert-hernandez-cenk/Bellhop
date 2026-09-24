import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema, type ElicitRequest, type ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { buildMcpServer } from '../../src/mcp/build-server.ts';
import { JobStore } from '../../src/web/jobs/job-store.ts';
import { createJobLog } from '../../src/web/jobs/job-log.ts';
import { JobRunner } from '../../src/web/jobs/job-runner.ts';
import { FakeSSHClient, defaultResponder } from './fake-ssh-client.ts';
import { UnconfiguredCloudflareClient } from '../../src/lib/cloudflare-client.ts';
import { UnconfiguredAuthentikClient } from '../../src/lib/authentik-client.ts';
import type { AuthentikClient } from '../../src/lib/authentik-client.ts';
import { loadInventory, saveInventory, type Inventory } from '../../src/lib/inventory.ts';
import type { SSHClient } from '../../src/lib/ssh-client.ts';

export const MCP_TEST_INVENTORY: Inventory = {
  domain: 'example.com',
  hosts: [
    {
      name: 'pve1',
      ssh_target: 'pve1.local',
      ssh_user: 'root',
      midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' },
      storages: [
        { name: 'local', type: 'dir', content: ['vztmpl'], active: true },
        { name: 'local-lvm', type: 'lvmthin', content: ['rootdir', 'images'], active: true },
      ],
    },
  ],
  guests: [
    { name: 'caddy-lxc', type: 'lxc', vmid: 4002, host: 'pve1', ip: '192.168.1.2', caddy: true },
    { name: 'app-lxc', type: 'lxc', vmid: 4003, host: 'pve1', ip: '192.168.1.3' },
  ],
};

export type TextResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

export interface McpHarnessOptions {
  jobSsh?: SSHClient;
  runnerOptions?: ConstructorParameters<typeof JobRunner>[3];
  // When set, the client declares the elicitation capability and answers
  // every elicitation/create request with this. `signal` aborts when the
  // server withdraws the request.
  elicit?: (request: ElicitRequest, signal: AbortSignal) => Promise<ElicitResult>;
  serverOptions?: Parameters<typeof buildMcpServer>[1];
  // Overrides the default MCP_TEST_INVENTORY fixture -- e.g. an OIDC-mode
  // entry (issue #1) or customScriptsRepo/customScriptsBranch (issue #11).
  inventory?: Inventory;
  // Overrides the default UnconfiguredAuthentikClient, for the
  // OIDC-credential-reading tests (issue #1).
  authentik?: AuthentikClient;
  // Overrides the default always-404 fetch stub.
  fetchImpl?: typeof fetch;
}

export async function setupMcp(opts: McpHarnessOptions = {}) {
  const inventoryPath = path.join(mkdtempSync(path.join(tmpdir(), 'mcp-')), 'bellhop.db');
  saveInventory(inventoryPath, opts.inventory ?? MCP_TEST_INVENTORY);
  const ssh = new FakeSSHClient(defaultResponder);
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'mcp-log-')));
  const jobRunner = new JobRunner(jobStore, jobLog, opts.jobSsh ?? ssh, { owner: 'mcp:test', ...opts.runnerOptions });
  const server = buildMcpServer(
    {
      ssh,
      inventory: loadInventory(inventoryPath),
      inventoryPath,
      authentik: opts.authentik ?? new UnconfiguredAuthentikClient(),
      cloudflare: new UnconfiguredCloudflareClient(),
      fetchImpl: opts.fetchImpl ?? ((async () => new Response(null, { status: 404 })) as unknown as typeof fetch),
      jobStore,
      jobLog,
      jobRunner,
    },
    opts.serverOptions
  );
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' }, opts.elicit ? { capabilities: { elicitation: {} } } : undefined);
  if (opts.elicit) {
    const elicit = opts.elicit;
    client.setRequestHandler(ElicitRequestSchema, (request, extra) => elicit(request, extra.signal));
  }
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as TextResult;
  return { client, call, ssh, jobStore, jobLog, jobRunner, inventoryPath };
}

export function parse(result: TextResult) {
  return JSON.parse(result.content[0].text);
}

export function waitForFinished(store: JobStore, id: number): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      const status = store.get(id)?.status;
      if (status && !['queued', 'running', 'awaiting_input'].includes(status)) resolve();
      else setTimeout(check, 10);
    };
    check();
  });
}

// Polls every 10ms for up to 5s.
export async function until(cond: () => boolean, label = 'condition'): Promise<void> {
  for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(cond(), `timed out waiting for ${label}`);
}
