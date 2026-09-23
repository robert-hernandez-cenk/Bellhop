import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from '../../src/web/app.ts';
import { JobStore } from '../../src/web/jobs/job-store.ts';
import { createJobLog } from '../../src/web/jobs/job-log.ts';
import { JobRunner } from '../../src/web/jobs/job-runner.ts';
import { FakeSSHClient } from '../support/fake-ssh-client.ts';
import { FakeAuthentikClient } from '../support/fake-authentik-client.ts';
import { saveInventory, type Inventory } from '../../src/lib/inventory.ts';

test('GET /api/inventory reflects a DB write made by another process, with no app restart', async () => {
  const initial: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' } }],
    guests: [{ name: 'plex-lxc', type: 'lxc', vmid: 4003, host: 'pve1' }],
  };
  const inventoryPath = path.join(mkdtempSync(path.join(tmpdir(), 'inventory-')), 'bellhop.db');
  saveInventory(inventoryPath, initial);

  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const jobRunner = new JobRunner(jobStore, jobLog, ssh);
  const app = buildApp({
    inventory: initial,
    baseSsh: ssh,
    jobStore,
    jobLog,
    jobRunner,
    inventoryPath,
    authentik: new FakeAuthentikClient(),
  });

  const before = await request(app).get('/api/inventory');
  assert.equal(before.status, 200);
  assert.equal(before.body.guests.length, 1);
  assert.equal(before.body.guests[0].app, undefined);

  // Simulate an external writer (a CLI command, a direct DB edit) -- this
  // app instance never sees this write through its own routes.
  const updated: Inventory = {
    domain: 'example.com',
    hosts: initial.hosts,
    guests: [{ name: 'plex-lxc', type: 'lxc', vmid: 4003, host: 'pve1', app: 'plex' }],
  };
  saveInventory(inventoryPath, updated);

  const after = await request(app).get('/api/inventory');
  assert.equal(after.status, 200);
  assert.equal(after.body.guests.length, 1);
  assert.equal(after.body.guests[0].app, 'plex');
});
