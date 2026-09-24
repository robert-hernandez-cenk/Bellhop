import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PROVISIONING_OPERATIONS } from '../../src/operations/provisioning.ts';
import { PROVISIONING_COMMANDS } from '../../src/web/commands-meta.ts';
import { parseOperationInput, previewAndEnqueue } from '../../src/operations/core.ts';
import { FakeSSHClient, defaultResponder } from '../support/fake-ssh-client.ts';
import { UnconfiguredCloudflareClient } from '../../src/lib/cloudflare-client.ts';
import { FakeAuthentikClient } from '../support/fake-authentik-client.ts';
import { loadInventory, saveInventory, type Inventory } from '../../src/lib/inventory.ts';
import type { OperationDeps } from '../../src/operations/types.ts';
import { withCapturedConsole } from '../../src/web/console-capture.ts';
import { JobStore } from '../../src/web/jobs/job-store.ts';
import { createJobLog } from '../../src/web/jobs/job-log.ts';
import { JobRunner } from '../../src/web/jobs/job-runner.ts';

const inventory: Inventory = {
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
  guests: [{ name: 'caddy-lxc', type: 'lxc', vmid: 4002, host: 'pve1', ip: '192.168.1.2', caddy: true }],
};

function deps(): OperationDeps {
  const inventoryPath = path.join(mkdtempSync(path.join(tmpdir(), 'opprov-')), 'bellhop.db');
  saveInventory(inventoryPath, inventory);
  return {
    ssh: new FakeSSHClient(defaultResponder),
    inventory: structuredClone(inventory),
    inventoryPath,
    authentik: new FakeAuthentikClient(), cloudflare: new UnconfiguredCloudflareClient(),
  };
}

test('every web form field for a provisioning command is part of its operation shape', () => {
  for (const cmd of PROVISIONING_COMMANDS) {
    const op = PROVISIONING_OPERATIONS[cmd.id];
    assert.ok(op, `no operation for ${cmd.id}`);
    for (const field of cmd.fields) {
      assert.ok(field.name in op.shape, `${cmd.id}: form field '${field.name}' missing from operation shape`);
    }
  }
});

test('secretFields match the web form fields declared kind secret', () => {
  for (const cmd of PROVISIONING_COMMANDS) {
    const secrets = cmd.fields.filter((f) => f.kind === 'secret').map((f) => f.name).sort();
    assert.deepEqual([...(PROVISIONING_OPERATIONS[cmd.id].secretFields ?? [])].sort(), secrets, cmd.id);
  }
});

test('create-lxc apply records the new guest in inventory', async () => {
  const d = deps();
  const op = PROVISIONING_OPERATIONS['create-lxc'];
  const input = parseOperationInput(op, { host: 'pve1', mid: 5, hostname: 'new-lxc', template: 'debian-12' });
  await op.apply(input, d);
  const saved = loadInventory(d.inventoryPath).guests.find((g) => g.name === 'new-lxc');
  assert.equal(saved?.vmid, 4005);
  assert.equal(saved?.ip, '192.168.1.5');
  assert.ok(d.inventory.guests.some((g) => g.name === 'new-lxc'));
});

// #16: a job can apply long after the in-memory inventory was last loaded
// (queued behind another job, or a minutes-long install). An edit written to
// disk meanwhile must survive the apply's own saveInventory.
test('create-lxc apply does not clobber inventory edits made after deps.inventory was loaded', async () => {
  const d = deps();
  saveInventory(d.inventoryPath, { ...structuredClone(inventory), dnsServer: '192.168.3.53' });
  const op = PROVISIONING_OPERATIONS['create-lxc'];
  // Captured only to keep the create-lxc apply's own log lines out of test output.
  await withCapturedConsole(() =>
    op.apply(parseOperationInput(op, { host: 'pve1', mid: 5, hostname: 'new-lxc', template: 'debian-12' }), d)
  );
  const saved = loadInventory(d.inventoryPath);
  assert.equal(saved.dnsServer, '192.168.3.53');
  assert.ok(saved.guests.some((g) => g.name === 'new-lxc'));
});

test('delete-guest apply refuses the caddy guest', async () => {
  const d = deps();
  const op = PROVISIONING_OPERATIONS['delete-guest'];
  await assert.rejects(op.apply(parseOperationInput(op, { guest: 'caddy-lxc' }), d), /caddy: true/);
});

test('install-app is the only provisioning operation that watches for prompts', () => {
  const watching = Object.values(PROVISIONING_OPERATIONS).filter((op) => op.watchForPrompts).map((op) => op.id);
  assert.deepEqual(watching, ['install-app']);
});

// --- custom script repository (issue #11), real install-app wiring ---
// Fix round 1: T010's original coverage used a stand-in demo operation
// (test/operations/core.test.ts), which never exercised
// PROVISIONING_OPERATIONS['install-app']'s own resolvesApp: true and
// `source: i.appSource` plumbing (src/operations/provisioning.ts). This runs
// previewAndEnqueue against the real operation, a real FakeSSHClient, and a
// real JobRunner, the same way the web/MCP front ends do.
// Example values only (constitution Principle I) -- example-user/ProxmoxVED
// on branch my-apps is the same example the spec/plan/data-model/
// test/lib/app-source.test.ts use.

const fixtureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'github');
const HEAD_SHA_RAW = readFileSync(path.join(fixtureDir, 'branch-head-sha.txt'), 'utf8');
const SHA = HEAD_SHA_RAW.trim();
const CUSTOM_OWNER = 'example-user';
const CUSTOM_REPO = 'ProxmoxVED';
const CUSTOM_BRANCH = 'my-apps';
const HEAD_SHA_URL = `https://api.github.com/repos/${CUSTOM_OWNER}/${CUSTOM_REPO}/commits/${CUSTOM_BRANCH}`;
const customCtUrl = (slug: string) => `https://raw.githubusercontent.com/${CUSTOM_OWNER}/${CUSTOM_REPO}/${SHA}/ct/${slug}.sh`;
const customScriptsBaseUrl = `https://raw.githubusercontent.com/${CUSTOM_OWNER}/${CUSTOM_REPO}/${SHA}`;
const customInstallUrl = (slug: string) => `${customScriptsBaseUrl}/install/${slug}-install.sh`;

function waitForJobFinished(store: JobStore, id: number): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      const status = store.get(id)?.status;
      if (status && status !== 'queued' && status !== 'running') resolve();
      else setTimeout(check, 10);
    };
    check();
  });
}

test("previewAndEnqueue on the real install-app operation pins one custom-repository resolution across preview and the job's apply, and the applied script exports COMMUNITY_SCRIPTS_URL at the pinned commit", async () => {
  const customInventory: Inventory = {
    ...inventory,
    customScriptsRepo: `${CUSTOM_OWNER}/${CUSTOM_REPO}`,
    customScriptsBranch: CUSTOM_BRANCH,
  };
  const inventoryPath = path.join(mkdtempSync(path.join(tmpdir(), 'opprov-install-')), 'bellhop.db');
  saveInventory(inventoryPath, customInventory);

  const ssh = new FakeSSHClient(defaultResponder);
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'opprov-install-log-')));
  const jobRunner = new JobRunner(jobStore, jobLog, ssh, { owner: 'test' });

  let headShaCalls = 0;
  const fetchImpl = (async (url: unknown) => {
    const href = String(url);
    if (href === HEAD_SHA_URL) {
      headShaCalls++;
      return new Response(HEAD_SHA_RAW, { status: 200 });
    }
    if (href === customCtUrl('myapp')) return new Response('#!/usr/bin/env bash\n', { status: 200 });
    if (href === customInstallUrl('myapp')) return new Response('no prompts here\n', { status: 200 });
    // Upstream shadow probes -- "not present" for this test.
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;

  const d: OperationDeps = {
    ssh,
    inventory: structuredClone(customInventory),
    inventoryPath,
    authentik: new FakeAuthentikClient(),
    cloudflare: new UnconfiguredCloudflareClient(),
    fetchImpl,
  };

  const op = PROVISIONING_OPERATIONS['install-app'];
  const { jobId } = await previewAndEnqueue(op, { app: 'myapp', host: 'pve1', mid: 5, hostname: 'myapp-lxc' }, d, jobRunner, {});
  assert.equal(headShaCalls, 1, 'resolveHeadSha should run exactly once, during preview');

  await waitForJobFinished(jobStore, jobId);
  assert.equal(jobStore.get(jobId)!.status, 'success');
  assert.equal(
    headShaCalls,
    1,
    "apply must not re-resolve -- it reuses the source previewAndEnqueue already pinned onto input.appSource"
  );

  const installCall = ssh.history.find((c) => c.command.includes('COMMUNITY_SCRIPTS_URL'));
  assert.ok(installCall, 'the applied install-app exec should be recorded on the FakeSSHClient');
  assert.ok(
    installCall!.command.includes(`export COMMUNITY_SCRIPTS_URL='${customScriptsBaseUrl}'`),
    `expected COMMUNITY_SCRIPTS_URL at the pinned SHA in: ${installCall!.command}`
  );
});
