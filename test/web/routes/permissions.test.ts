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
import { saveInventory, type Inventory } from '../../../src/lib/inventory.ts';

const inventory: Inventory = { domain: 'example.com', hosts: [], guests: [] };

function testApp() {
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const jobRunner = new JobRunner(jobStore, jobLog, ssh);
  const inventoryPath = path.join(mkdtempSync(path.join(tmpdir(), 'inventory-')), 'bellhop.db');
  saveInventory(inventoryPath, inventory);
  return buildApp({
    inventory,
    baseSsh: ssh,
    jobStore,
    jobLog,
    jobRunner,
    inventoryPath,
    authentik: new FakeAuthentikClient(),
  });
}

function asAdmin(req: request.Test): request.Test {
  return req.set('x-authentik-username', 'admin').set('x-authentik-groups', 'bellhop-admins');
}

test('GET /api/permissions returns 403 for a non-admin', async () => {
  const app = testApp();
  const res = await request(app)
    .get('/api/permissions')
    .set('x-authentik-username', 'someone')
    .set('x-authentik-groups', 'family');
  assert.equal(res.status, 403);
});

test('GET /api/permissions returns an empty list when no group is configured', async () => {
  const app = testApp();
  const res = await asAdmin(request(app).get('/api/permissions'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, []);
});

test('PUT /api/permissions/:group creates a rule, GET reflects it', async () => {
  const app = testApp();
  const putRes = await asAdmin(request(app).put('/api/permissions/family')).send({
    mode: 'block-list',
    resources: [{ type: 'guest', name: 'stash-lxc' }],
  });
  assert.equal(putRes.status, 200);
  assert.deepEqual(putRes.body, {
    groupName: 'family',
    mode: 'block-list',
    resources: [{ type: 'guest', name: 'stash-lxc' }],
  });

  const listRes = await asAdmin(request(app).get('/api/permissions'));
  assert.equal(listRes.status, 200);
  assert.deepEqual(listRes.body, [
    { groupName: 'family', mode: 'block-list', resources: [{ type: 'guest', name: 'stash-lxc' }] },
  ]);
});

test('PUT /api/permissions/:group rejects an invalid mode', async () => {
  const app = testApp();
  const res = await asAdmin(request(app).put('/api/permissions/family')).send({ mode: 'nope', resources: [] });
  assert.equal(res.status, 400);
});

test('PUT /api/permissions/:group rejects malformed resources', async () => {
  const app = testApp();
  const res = await asAdmin(request(app).put('/api/permissions/family')).send({
    mode: 'allow-list',
    resources: [{ type: 'nope', name: 'x' }],
  });
  assert.equal(res.status, 400);
});

test('PUT /api/permissions/:group rejects duplicate resource entries', async () => {
  const app = testApp();
  const res = await asAdmin(request(app).put('/api/permissions/family')).send({
    mode: 'block-list',
    resources: [
      { type: 'guest', name: 'stash-lxc' },
      { type: 'guest', name: 'stash-lxc' },
    ],
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /duplicate/i);

  // Verify that no permission rule was created as a side effect
  const listRes = await asAdmin(request(app).get('/api/permissions'));
  assert.deepEqual(listRes.body, []);
});

test('PUT /api/permissions/:group returns 403 for a non-admin', async () => {
  const app = testApp();
  const res = await request(app)
    .put('/api/permissions/family')
    .set('x-authentik-username', 'someone')
    .set('x-authentik-groups', 'family')
    .send({ mode: 'block-list', resources: [] });
  assert.equal(res.status, 403);
});

test("DELETE /api/permissions/:group clears a configured rule", async () => {
  const app = testApp();
  await asAdmin(request(app).put('/api/permissions/family')).send({ mode: 'allow-list', resources: [] });
  const delRes = await asAdmin(request(app).delete('/api/permissions/family'));
  assert.equal(delRes.status, 204);

  const listRes = await asAdmin(request(app).get('/api/permissions'));
  assert.deepEqual(listRes.body, []);
});
