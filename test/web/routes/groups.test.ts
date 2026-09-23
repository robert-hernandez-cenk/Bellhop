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
import { UnconfiguredAuthentikClient } from '../../../src/lib/authentik-client.ts';
import type { AuthentikClient, AuthentikGroup } from '../../../src/lib/authentik-client.ts';
import { saveInventory, type Inventory } from '../../../src/lib/inventory.ts';

const inventory: Inventory = { domain: 'example.com', hosts: [], guests: [] };

// `authentik` lets a test inject UnconfiguredAuthentikClient instead of the
// default FakeAuthentikClient(seed), to exercise the capability gate without
// touching process.env.
function testApp(seed: { groups?: AuthentikGroup[]; authentik?: AuthentikClient } = {}) {
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const jobRunner = new JobRunner(jobStore, jobLog, ssh);
  const authentik = seed.authentik ?? new FakeAuthentikClient(seed);
  const inventoryPath = path.join(mkdtempSync(path.join(tmpdir(), 'inventory-')), 'bellhop.db');
  saveInventory(inventoryPath, inventory);
  const app = buildApp({
    inventory,
    baseSsh: ssh,
    jobStore,
    jobLog,
    jobRunner,
    inventoryPath,
    authentik,
  });
  return { app, authentik };
}

function asAdmin(req: request.Test): request.Test {
  return req.set('x-authentik-username', 'admin').set('x-authentik-groups', 'bellhop-admins');
}

test('GET /api/groups returns 403 for a non-admin', async () => {
  const { app } = testApp();
  const res = await request(app)
    .get('/api/groups')
    .set('x-authentik-username', 'someone')
    .set('x-authentik-groups', 'homelab');
  assert.equal(res.status, 403);
});

test('GET /api/groups lists groups for an admin', async () => {
  const { app } = testApp({ groups: [{ id: '1', name: 'admins', userIds: [] }] });
  const res = await asAdmin(request(app).get('/api/groups'));
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].name, 'admins');
});

test('POST /api/groups creates a group', async () => {
  const { app } = testApp();
  const res = await asAdmin(request(app).post('/api/groups')).send({ name: 'homelab' });
  assert.equal(res.status, 201);
  assert.equal(res.body.name, 'homelab');
  assert.deepEqual(res.body.userIds, []);
});

test('POST /api/groups rejects a missing name', async () => {
  const { app } = testApp();
  const res = await asAdmin(request(app).post('/api/groups')).send({});
  assert.equal(res.status, 400);
});

test('PATCH /api/groups/:id renames a group and sets membership', async () => {
  const { app } = testApp({ groups: [{ id: '1', name: 'old', userIds: [] }] });
  const res = await asAdmin(request(app).patch('/api/groups/1')).send({ name: 'new', userIds: ['5', '6'] });
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'new');
  assert.deepEqual(res.body.userIds, ['5', '6']);
});

test('GET /api/groups returns 503 with a clear message when Authentik is not configured', async () => {
  const { app } = testApp({ authentik: new UnconfiguredAuthentikClient() });
  const res = await asAdmin(request(app).get('/api/groups'));
  assert.equal(res.status, 503);
  assert.match(res.body.error, /not configured/);
});

test('DELETE /api/groups/:id deletes a group', async () => {
  const { app, authentik } = testApp({ groups: [{ id: '1', name: 'old', userIds: [] }] });
  const res = await asAdmin(request(app).delete('/api/groups/1'));
  assert.equal(res.status, 204);
  assert.deepEqual(await authentik.listGroups(), []);
});
