import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { saveInventory, type Inventory } from '../../src/lib/inventory.ts';
import {
  completeSetupStep,
  ensurePendingSetup,
  finishSetup,
  loadSetupState,
  setupPhase,
} from '../../src/lib/setup-state.ts';

const HOST = { name: 'pve1', ssh_target: '192.0.2.10', ssh_user: 'root' };

function tempDb(inv: Inventory = { hosts: [], guests: [] }): string {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'setup-state-')), 'bellhop.db');
  saveInventory(dbPath, inv);
  return dbPath;
}

test('setupPhase: no record and no hosts is pending', () => {
  assert.equal(setupPhase(tempDb(), { hosts: [] }), 'pending');
});

test('setupPhase: no record with hosts is not-applicable (an existing deployment)', () => {
  assert.equal(setupPhase(tempDb({ hosts: [HOST], guests: [] }), { hosts: [HOST] }), 'not-applicable');
});

test('setupPhase: a pending record stays pending once hosts exist', () => {
  const dbPath = tempDb();
  ensurePendingSetup(dbPath);
  assert.equal(setupPhase(dbPath, { hosts: [HOST] }), 'pending');
});

test('setupPhase: a finished record is finished even with no hosts', () => {
  const dbPath = tempDb();
  ensurePendingSetup(dbPath);
  finishSetup(dbPath);
  assert.equal(setupPhase(dbPath, { hosts: [] }), 'finished');
});

test('ensurePendingSetup creates the record and a long random token once', () => {
  const dbPath = tempDb();
  assert.equal(loadSetupState(dbPath), undefined);
  const first = ensurePendingSetup(dbPath);
  assert.equal(first.status, 'pending');
  assert.match(first.token ?? '', /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(first.completedSteps, []);
  const again = ensurePendingSetup(dbPath);
  assert.equal(again.token, first.token);
  assert.notEqual(ensurePendingSetup(tempDb()).token, first.token);
});

test('completeSetupStep records each step once', () => {
  const dbPath = tempDb();
  ensurePendingSetup(dbPath);
  completeSetupStep(dbPath, 'proxmox');
  completeSetupStep(dbPath, 'proxmox');
  completeSetupStep(dbPath, 'basics');
  assert.deepEqual(loadSetupState(dbPath)?.completedSteps, ['proxmox', 'basics']);
});

test('finishSetup marks setup finished and drops the token', () => {
  const dbPath = tempDb();
  ensurePendingSetup(dbPath);
  finishSetup(dbPath);
  const state = loadSetupState(dbPath);
  assert.equal(state?.status, 'finished');
  assert.equal(state?.token, null);
  assert.throws(() => ensurePendingSetup(dbPath), /already finished/);
});

test('saveInventory leaves the setup record untouched', () => {
  const dbPath = tempDb();
  const { token } = ensurePendingSetup(dbPath);
  completeSetupStep(dbPath, 'proxmox');
  saveInventory(dbPath, { domain: 'example.com', hosts: [HOST], guests: [] });
  const state = loadSetupState(dbPath);
  assert.equal(state?.token, token);
  assert.deepEqual(state?.completedSteps, ['proxmox']);
});
