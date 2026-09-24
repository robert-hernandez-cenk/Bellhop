import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JobStore } from '../../src/web/jobs/job-store.ts';
import { createJobLog } from '../../src/web/jobs/job-log.ts';
import { JobRunner } from '../../src/web/jobs/job-runner.ts';
import { FakeSSHClient, defaultResponder } from '../support/fake-ssh-client.ts';
import { UnconfiguredCloudflareClient } from '../../src/lib/cloudflare-client.ts';
import { FakeAuthentikClient } from '../support/fake-authentik-client.ts';
import type { Operation, OperationDeps } from '../../src/operations/types.ts';
import { saveInventory, type Inventory } from '../../src/lib/inventory.ts';
import { reqStr, optStr } from '../../src/operations/fields.ts';
import { UPSTREAM_STABLE_BASE, UPSTREAM_DEV_BASE } from '../../src/lib/app-source.ts';
import {
  parseOperationInput,
  redactSecrets,
  scrubSecretValues,
  previewAndEnqueue,
  enqueueWithoutPreview,
} from '../../src/operations/core.ts';

const applied: Array<Record<string, any>> = [];
const op: Operation = {
  id: 'demo-op',
  category: 'maintenance',
  description: 'demo',
  shape: { guest: reqStr('Guest'), token: optStr('Token') },
  target: (i) => i.guest,
  targetType: 'guest',
  secretFields: ['token'],
  preview: async (i) => `would touch ${i.guest} using ${i.token ?? 'nothing'}`,
  apply: async (i) => {
    applied.push(i);
    console.log(`touched ${i.guest}`);
  },
};

function setup() {
  const ssh = new FakeSSHClient(defaultResponder);
  const store = new JobStore(':memory:');
  const log = createJobLog(mkdtempSync(path.join(tmpdir(), 'opcore-')));
  const runner = new JobRunner(store, log, ssh, { owner: 'mcp:1' });
  // A real temp database, not a placeholder path: every job now reloads
  // inventory from inventoryPath before apply (#16).
  const inventoryPath = path.join(mkdtempSync(path.join(tmpdir(), 'opcore-db-')), 'bellhop.db');
  saveInventory(inventoryPath, { domain: 'example.com', hosts: [], guests: [] });
  const deps = {
    ssh,
    inventory: { domain: 'example.com', hosts: [], guests: [] },
    inventoryPath,
    authentik: new FakeAuthentikClient(), cloudflare: new UnconfiguredCloudflareClient(),
  } as OperationDeps;
  return { store, log, runner, deps };
}

function waitForFinished(store: JobStore, id: number): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      const status = store.get(id)?.status;
      if (status && status !== 'queued' && status !== 'running') resolve();
      else setTimeout(check, 10);
    };
    check();
  });
}

test('parseOperationInput names the invalid fields', () => {
  assert.throws(() => parseOperationInput(op, { token: 5 }), /demo-op.*guest/);
});

test('redactSecrets replaces truthy secret values only', () => {
  assert.deepEqual(redactSecrets(op, { guest: 'g', token: 'abc' }), { guest: 'g', token: '[redacted]' });
  assert.deepEqual(redactSecrets(op, { guest: 'g', token: '' }), { guest: 'g', token: '' });
});

test('scrubSecretValues removes secret values from text', () => {
  assert.equal(scrubSecretValues(op, { guest: 'g', token: 'abc' }, 'x abc y abc'), 'x [redacted] y [redacted]');
});

test('previewAndEnqueue logs the preview at the top of the job and stores redacted args', async () => {
  const { store, log, runner, deps } = setup();
  const { jobId, preview } = await previewAndEnqueue(op, { guest: 'g1', token: 'abc' }, deps, runner, {
    triggeredByUsername: 'mcp',
  });
  assert.equal(preview, 'would touch g1 using abc');
  await waitForFinished(store, jobId);
  const row = store.get(jobId)!;
  assert.equal(row.status, 'success');
  assert.equal(row.target, 'g1');
  assert.equal(row.owner, 'mcp:1');
  assert.equal(row.triggeredByUsername, 'mcp');
  assert.deepEqual(JSON.parse(row.argsJson), { guest: 'g1', token: '[redacted]' });
  assert.match(log.read(row.logFile), /----- dry-run preview -----\nwould touch g1/);
  assert.match(log.read(row.logFile), /touched g1/);
});

test('previewAndEnqueue throws before enqueueing when preview fails', async () => {
  const { store, runner, deps } = setup();
  const failing: Operation = { ...op, preview: async () => { throw new Error('nope'); } };
  await assert.rejects(previewAndEnqueue(failing, { guest: 'g' }, deps, runner, {}), /nope/);
  assert.equal(store.list().length, 0);
});

// #16: the job runs later than the enqueueing request's inventory reload, so
// apply must see what is on disk when the job actually starts.
test('a queued job applies against inventory reloaded from disk, not the enqueue-time snapshot', async () => {
  const { store, runner, deps } = setup();
  const inventoryPath = path.join(mkdtempSync(path.join(tmpdir(), 'opcore-inv-')), 'bellhop.db');
  saveInventory(inventoryPath, { domain: 'example.com', hosts: [], guests: [], dnsServer: '192.168.3.53' });
  deps.inventoryPath = inventoryPath;
  let seen: string | undefined = 'unset';
  const probe: Operation = { ...op, apply: async (_i, d) => { seen = d.inventory.dnsServer; } };
  const jobId = enqueueWithoutPreview(probe, { guest: 'g3' }, deps, runner, {});
  await waitForFinished(store, jobId);
  assert.equal(store.get(jobId)!.status, 'success');
  assert.equal(seen, '192.168.3.53');
});

test('enqueueWithoutPreview runs apply without a preview banner', async () => {
  const { store, log, runner, deps } = setup();
  const jobId = enqueueWithoutPreview(op, { guest: 'g2' }, deps, runner, {});
  await waitForFinished(store, jobId);
  const text = log.read(store.get(jobId)!.logFile);
  assert.doesNotMatch(text, /dry-run preview/);
  assert.match(text, /touched g2/);
});

// --- resolvesApp / custom script repository pin-once (issue #11, research R5) ---
// Example values only (constitution Principle I) -- example-user/ProxmoxVED
// on branch my-apps is the same example used throughout this feature's
// specs/tests. `resolvingOp` stands in for install-app: a real
// PROVISIONING_OPERATIONS['install-app'] needs a live host/mid/storage setup
// that's irrelevant to what's under test here -- previewAndEnqueue's own
// pin-once behavior for any operation flagged resolvesApp.

const fixtureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'github');
const HEAD_SHA_RAW = readFileSync(path.join(fixtureDir, 'branch-head-sha.txt'), 'utf8');
const PINNED_SHA = HEAD_SHA_RAW.trim();
const OTHER_SHA = '0'.repeat(40);
const HEAD_SHA_URL = 'https://api.github.com/repos/example-user/ProxmoxVED/commits/my-apps';
const CT_URL = `https://raw.githubusercontent.com/example-user/ProxmoxVED/${PINNED_SHA}/ct/myapp.sh`;
const INSTALL_URL = `https://raw.githubusercontent.com/example-user/ProxmoxVED/${PINNED_SHA}/install/myapp-install.sh`;

const capturedApplySources: unknown[] = [];
const resolvingOp: Operation = {
  id: 'demo-install-app',
  category: 'provisioning',
  description: 'demo install-app-like operation for testing resolvesApp',
  shape: { app: reqStr('App') },
  target: (i) => i.app,
  targetType: 'guest',
  watchForPrompts: true,
  resolvesApp: true,
  preview: async (i) => `would resolve ${i.app} via ${i.appSource?.kind}`,
  apply: async (i) => {
    capturedApplySources.push(i.appSource);
    console.log(`resolved ${i.app}`);
  },
};

test('previewAndEnqueue pins a resolvesApp operation\'s custom-repository resolution once: the head-SHA endpoint is called exactly once, the job applies against that same pinned SHA even if the branch moves afterward, expectedPrompts come from the custom install script, and a caller-supplied appSource in the raw body is overwritten', async () => {
  const { store, runner, deps } = setup();
  const customInventory: Inventory = {
    ...deps.inventory,
    customScriptsRepo: 'example-user/ProxmoxVED',
    customScriptsBranch: 'my-apps',
  };
  deps.inventory = customInventory;
  saveInventory(deps.inventoryPath, customInventory);

  let headShaCalls = 0;
  const fetchImpl = (async (url: unknown) => {
    const href = String(url);
    if (href === HEAD_SHA_URL) {
      headShaCalls++;
      return new Response(HEAD_SHA_RAW, { status: 200 });
    }
    if (href === CT_URL) return new Response('#!/usr/bin/env bash\n', { status: 200 });
    if (href === INSTALL_URL) return new Response('read -rp "Enter something: " x\n', { status: 200 });
    if (href === `${UPSTREAM_STABLE_BASE}/ct/myapp.sh` || href === `${UPSTREAM_DEV_BASE}/ct/myapp.sh`) {
      return new Response(null, { status: 404 });
    }
    // A re-resolution against a moved branch (a different sha in the URL) or
    // any other unrouted call fails loudly rather than silently 404ing --
    // this is what catches apply re-resolving instead of reading the
    // already-pinned source.
    throw new Error(`unexpected fetch: ${href}`);
  }) as unknown as typeof fetch;
  deps.fetchImpl = fetchImpl;

  const { jobId } = await previewAndEnqueue(
    resolvingOp,
    { app: 'myapp', appSource: { kind: 'upstream', slug: 'someone-elses-value', shadows: [] } },
    deps,
    runner,
    {}
  );
  assert.equal(headShaCalls, 1, 'resolveHeadSha should have been called exactly once, by previewAndEnqueue itself');

  const row = store.get(jobId)!;
  assert.deepEqual(JSON.parse(row.expectedPromptsJson!), ['Enter something: ']);

  await waitForFinished(store, jobId);
  assert.equal(store.get(jobId)!.status, 'success');
  assert.equal(headShaCalls, 1, "apply must not re-resolve -- it reads previewAndEnqueue's already-pinned appSource");
  assert.equal(capturedApplySources.length, 1);
  const applied = capturedApplySources[0] as { kind: string; custom?: { sha: string } };
  assert.equal(applied.kind, 'custom', 'the caller-supplied raw appSource must have been overwritten by the real resolution');
  assert.equal(applied.custom?.sha, PINNED_SHA);
  assert.notEqual(applied.custom?.sha, OTHER_SHA);
});
