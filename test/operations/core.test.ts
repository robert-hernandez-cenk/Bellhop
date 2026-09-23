import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JobStore } from '../../src/web/jobs/job-store.ts';
import { createJobLog } from '../../src/web/jobs/job-log.ts';
import { JobRunner } from '../../src/web/jobs/job-runner.ts';
import { FakeSSHClient, defaultResponder } from '../support/fake-ssh-client.ts';
import { UnconfiguredCloudflareClient } from '../../src/lib/cloudflare-client.ts';
import { FakeAuthentikClient } from '../support/fake-authentik-client.ts';
import type { Operation, OperationDeps } from '../../src/operations/types.ts';
import { saveInventory } from '../../src/lib/inventory.ts';
import { reqStr, optStr } from '../../src/operations/fields.ts';
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
