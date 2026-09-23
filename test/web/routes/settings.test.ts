import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from '../../../src/web/app.ts';
import { JobStore } from '../../../src/web/jobs/job-store.ts';
import { createJobLog } from '../../../src/web/jobs/job-log.ts';
import { JobRunner } from '../../../src/web/jobs/job-runner.ts';
import { FakeSSHClient } from '../../support/fake-ssh-client.ts';
import { FakeAuthentikClient } from '../../support/fake-authentik-client.ts';
import { loadInventory, saveInventory, type Inventory } from '../../../src/lib/inventory.ts';

function baseInventory(): Inventory {
  return {
    domain: 'example.com',
    hosts: [
      {
        name: 'pve1',
        ssh_target: 'pve1.local',
        ssh_user: 'root',
        midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '10.0.0.1' },
      },
    ],
    guests: [{ name: 'proxy', type: 'lxc', vmid: 110, host: 'pve1', ip: '10.0.0.2', caddy: true }],
  };
}

function testApp(inv: Inventory = baseInventory()) {
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const jobRunner = new JobRunner(jobStore, jobLog, ssh);
  const inventoryPath = path.join(mkdtempSync(path.join(tmpdir(), 'inventory-')), 'bellhop.db');
  saveInventory(inventoryPath, inv);
  const app = buildApp({
    inventory: inv,
    baseSsh: ssh,
    jobStore,
    jobLog,
    jobRunner,
    inventoryPath,
    authentik: new FakeAuthentikClient(),
  });
  return { app, inventoryPath };
}

function asAdmin(req: request.Test): request.Test {
  return req.set('x-authentik-username', 'admin').set('x-authentik-groups', 'bellhop-admins');
}

test('GET /api/settings returns 403 for a non-admin', async () => {
  const { app } = testApp();
  const res = await request(app)
    .get('/api/settings')
    .set('x-authentik-username', 'someone')
    .set('x-authentik-groups', 'family');
  assert.equal(res.status, 403);
});

test('GET /api/settings returns current and derived values', async () => {
  const { app } = testApp({ ...baseInventory(), dnsServer: '10.0.0.53' });
  const res = await asAdmin(request(app).get('/api/settings'));
  assert.equal(res.status, 200);
  assert.equal(res.body.settings.dnsServer, '10.0.0.53');
  assert.equal(res.body.settings.nfsServer, undefined);
  assert.deepEqual(res.body.derived.lanGateways, [{ host: 'pve1', gateway: '10.0.0.1' }]);
  assert.deepEqual(res.body.derived.caddy, { name: 'proxy', ip: '10.0.0.2' });
});

test('PATCH /api/settings writes a value', async () => {
  const { app, inventoryPath } = testApp();
  const res = await asAdmin(request(app).patch('/api/settings')).send({ nfsServer: '10.0.0.5' });
  assert.equal(res.status, 200);
  assert.equal(res.body.settings.nfsServer, '10.0.0.5');
  assert.equal(loadInventory(inventoryPath).nfsServer, '10.0.0.5');
});

test('PATCH /api/settings clears a value sent as null', async () => {
  const { app, inventoryPath } = testApp({ ...baseInventory(), nfsServer: '10.0.0.5' });
  await asAdmin(request(app).patch('/api/settings')).send({ nfsServer: null });
  assert.equal(loadInventory(inventoryPath).nfsServer, undefined);

  // Regression coverage (issue #124): the disk read above passes even if
  // the shared in-memory `inventory` object never actually got the clear
  // applied to it. Exercise the same live request path a real client
  // would use next -- a follow-up GET against the same app instance --
  // to prove the clear is visible through the shared in-memory object,
  // not just on disk.
  const res = await asAdmin(request(app).get('/api/settings'));
  assert.equal(res.status, 200);
  assert.equal(res.body.settings.nfsServer, undefined);
});

test('PATCH /api/settings rejects an unknown key', async () => {
  const { app } = testApp();
  const res = await asAdmin(request(app).patch('/api/settings')).send({ domain: 'other.com' });
  assert.equal(res.status, 400);
});

test('PATCH /api/settings rejects a relative statusPagePath', async () => {
  const { app } = testApp();
  const res = await asAdmin(request(app).patch('/api/settings')).send({ statusPagePath: 'relative.html' });
  assert.equal(res.status, 400);
});

test('PATCH /api/settings returns 403 for a non-admin', async () => {
  const { app } = testApp();
  const res = await request(app)
    .patch('/api/settings')
    .set('x-authentik-username', 'someone')
    .set('x-authentik-groups', 'family')
    .send({ nfsServer: '10.0.0.5' });
  assert.equal(res.status, 403);
});
