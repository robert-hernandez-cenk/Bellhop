import { test, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from '../../../src/web/app.ts';
import { JobStore } from '../../../src/web/jobs/job-store.ts';
import { createJobLog } from '../../../src/web/jobs/job-log.ts';
import { JobRunner, controlAttributionLine } from '../../../src/web/jobs/job-runner.ts';
import { loadInventory } from '../../../src/lib/inventory.ts';
import { FakeSSHClient, defaultResponder } from '../../support/fake-ssh-client.ts';
import { FakeAuthentikClient } from '../../support/fake-authentik-client.ts';
import { resetConfigStore, tempConfigStore } from '../../support/config-store.ts';
import { listen, connectHttpClient, rawPost, INITIALIZE } from '../../support/mcp-http-harness.ts';
import { parse, waitForFinished } from '../../support/mcp-harness.ts';
import type { Inventory } from '../../../src/lib/inventory.ts';

// /mcp mounted on the real web app (#65/#66): ahead of requireAuth, so a
// sign-in-required deployment still serves MCP to a bearer, while /api keeps
// requiring a session.
const KEY = 'example-mcp-key-0123456789-abcdefghijk';
const INVENTORY: Partial<Inventory> = {
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
};

let savedDevUser: string | undefined;
beforeEach(() => {
  savedDevUser = process.env.WEB_UI_DEV_USER;
  delete process.env.WEB_UI_DEV_USER;
});
afterEach(() => {
  if (savedDevUser !== undefined) process.env.WEB_UI_DEV_USER = savedDevUser;
  resetConfigStore();
});

async function setup(secrets: { mcpApiKey?: string } = {}) {
  const inventoryPath = tempConfigStore({ webUiAuthMode: 'oidc', ...INVENTORY }, secrets);
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'mcp-app-log-')));
  const ssh = new FakeSSHClient(defaultResponder);
  const jobRunner = new JobRunner(jobStore, jobLog, ssh);
  const app = buildApp({
    inventory: loadInventory(inventoryPath),
    baseSsh: ssh,
    jobStore,
    jobLog,
    jobRunner,
    inventoryPath,
    authentik: new FakeAuthentikClient(),
  });
  const server = await listen(app);
  return { base: server.base, jobStore, close: server.close };
}

test('in oidc mode /api still needs a session while /mcp serves a valid API key', async (t) => {
  const s = await setup({ mcpApiKey: KEY });
  t.after(s.close);
  assert.equal((await fetch(`${s.base}/api/inventory`)).status, 401);
  const { call } = await connectHttpClient(`${s.base}/mcp`, { headers: { authorization: `Bearer ${KEY}` } });
  assert.equal(parse(await call('get_inventory')).domain, 'example.com');
});

test('a job started with the API key is owned by the web runner and records api-key', async (t) => {
  const s = await setup({ mcpApiKey: KEY });
  t.after(s.close);
  const { call } = await connectHttpClient(`${s.base}/mcp`, { headers: { authorization: `Bearer ${KEY}` } });
  const started = parse(await call('create_lxc', { host: 'pve1', mid: 5, hostname: 'new-lxc', template: 'debian-12', apply: true }));
  await waitForFinished(s.jobStore, started.jobId);
  const job = s.jobStore.get(started.jobId)!;
  assert.equal(job.owner, 'web');
  assert.equal(job.triggeredByUsername, 'api-key');
  assert.equal(job.triggeredVia, 'mcp');
});

test('a wrong key is answered 401', async (t) => {
  const s = await setup({ mcpApiKey: KEY });
  t.after(s.close);
  assert.equal((await rawPost(`${s.base}/mcp`, { authorization: `Bearer ${KEY}x` }, INITIALIZE)).status, 401);
});

test('with neither sign-in nor a key configured /mcp answers 503 and the app still serves', async (t) => {
  const s = await setup();
  t.after(s.close);
  assert.equal((await rawPost(`${s.base}/mcp`, { authorization: `Bearer ${KEY}` }, INITIALIZE)).status, 503);
  assert.equal((await fetch(`${s.base}/api/inventory`)).status, 401);
});

// Review finding: a control request sent over HTTP MCP (here, cancelling a
// job a stdio MCP server owns) must say it came from MCP and who sent it,
// not "web UI" with no name -- the web service is merely hosting it.
test('job control over HTTP MCP is attributed to MCP and the caller', async (t) => {
  const s = await setup({ mcpApiKey: KEY });
  t.after(s.close);
  const id = s.jobStore.createJob({ command: 'install-app', category: 'provisioning', argsJson: '{}', owner: `mcp:${process.pid}` });
  s.jobStore.markRunning(id);
  const { call } = await connectHttpClient(`${s.base}/mcp`, { headers: { authorization: `Bearer ${KEY}` } });
  const result = await call('cancel_job', { id });
  assert.equal(result.isError, undefined, result.content[0].text);
  const [request] = s.jobStore.pendingControlRequests(`mcp:${process.pid}`);
  assert.equal(request.requestedByOwner, 'mcp:http');
  assert.equal(request.requestedByUsername, 'api-key');
  assert.equal(controlAttributionLine('cancel', request.requestedByOwner, request.requestedByUsername), 'Stop requested from MCP by api-key');
});
