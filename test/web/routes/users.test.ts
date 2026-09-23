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
import type { AuthentikClient, AuthentikGroup, AuthentikUser } from '../../../src/lib/authentik-client.ts';
import { saveInventory, type Inventory } from '../../../src/lib/inventory.ts';

const inventory: Inventory = { domain: 'example.com', hosts: [], guests: [] };

// `authentik` lets a test inject UnconfiguredAuthentikClient instead of the
// default FakeAuthentikClient(seed), to exercise the capability gate without
// touching process.env.
function testApp(seed: { users?: AuthentikUser[]; groups?: AuthentikGroup[]; authentik?: AuthentikClient } = {}) {
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

test('GET /api/users returns 403 for an authenticated user who is not an admin', async () => {
  const { app } = testApp();
  const res = await request(app)
    .get('/api/users')
    .set('x-authentik-username', 'someone')
    .set('x-authentik-groups', 'homelab');
  assert.equal(res.status, 403);
});

test('GET /api/users lists users for an admin', async () => {
  const { app } = testApp({
    users: [{ id: '1', username: 'alice', email: 'a@example.com', isActive: true, groupIds: [] }],
  });
  const res = await asAdmin(request(app).get('/api/users'));
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].username, 'alice');
});

test('POST /api/users creates a user and returns a recovery link', async () => {
  const { app } = testApp();
  const res = await asAdmin(request(app).post('/api/users')).send({
    username: 'bob',
    email: 'bob@example.com',
    groupIds: [],
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.user.username, 'bob');
  assert.match(res.body.recoveryLink, /^https:\/\/fake-authentik/);
  assert.equal(res.body.recoveryLinkError, undefined);
});

test('POST /api/users still returns 201 with the created user when recovery-link generation fails', async () => {
  const { app, authentik } = testApp();
  authentik.getRecoveryLink = async () => {
    throw new Error('recovery flow not configured');
  };
  const res = await asAdmin(request(app).post('/api/users')).send({
    username: 'bob',
    email: 'bob@example.com',
    groupIds: [],
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.user.username, 'bob');
  assert.equal(res.body.recoveryLink, null);
  assert.match(res.body.recoveryLinkError, /recovery flow not configured/);

  const users = await authentik.listUsers();
  assert.equal(users.length, 1);
  assert.equal(users[0].username, 'bob');
});

test('POST /api/users rejects a request missing username', async () => {
  const { app } = testApp();
  const res = await asAdmin(request(app).post('/api/users')).send({ email: 'bob@example.com' });
  assert.equal(res.status, 400);
});

test('POST /api/users rejects a request missing email', async () => {
  const { app } = testApp();
  const res = await asAdmin(request(app).post('/api/users')).send({ username: 'bob' });
  assert.equal(res.status, 400);
});

test('PATCH /api/users/:id edits an existing user', async () => {
  const { app } = testApp({
    users: [{ id: '1', username: 'alice', email: 'a@example.com', isActive: true, groupIds: [] }],
  });
  const res = await asAdmin(request(app).patch('/api/users/1')).send({ email: 'alice2@example.com' });
  assert.equal(res.status, 200);
  assert.equal(res.body.email, 'alice2@example.com');
});

test('GET /api/users returns 503 with a clear message when Authentik is not configured', async () => {
  const { app } = testApp({ authentik: new UnconfiguredAuthentikClient() });
  const res = await asAdmin(request(app).get('/api/users'));
  assert.equal(res.status, 503);
  assert.match(res.body.error, /not configured/);
});

test('POST /api/users/:id/deactivate deactivates another user', async () => {
  const { app } = testApp({
    users: [{ id: '1', username: 'alice', email: 'a@example.com', isActive: true, groupIds: [] }],
  });
  const res = await asAdmin(request(app).post('/api/users/1/deactivate')).send({});
  assert.equal(res.status, 200);
  assert.equal(res.body.isActive, false);
});

test('POST /api/users/:id/deactivate rejects deactivating your own account', async () => {
  const { app } = testApp({
    users: [{ id: '1', username: 'admin', email: 'admin@example.com', isActive: true, groupIds: [] }],
  });
  const res = await asAdmin(request(app).post('/api/users/1/deactivate')).send({});
  assert.equal(res.status, 400);
});

test('POST /api/users/:id/reactivate reactivates a deactivated user', async () => {
  const { app } = testApp({
    users: [{ id: '1', username: 'alice', email: 'a@example.com', isActive: false, groupIds: [] }],
  });
  const res = await asAdmin(request(app).post('/api/users/1/reactivate')).send({});
  assert.equal(res.status, 200);
  assert.equal(res.body.isActive, true);
});

test('POST /api/users/:id/recovery-link returns a fresh link', async () => {
  const { app } = testApp({
    users: [{ id: '1', username: 'alice', email: 'a@example.com', isActive: true, groupIds: [] }],
  });
  const res = await asAdmin(request(app).post('/api/users/1/recovery-link')).send({});
  assert.equal(res.status, 200);
  assert.match(res.body.recoveryLink, /^https:\/\/fake-authentik/);
});

test('DELETE /api/users/:id deletes another user', async () => {
  const { app, authentik } = testApp({
    users: [{ id: '1', username: 'alice', email: 'a@example.com', isActive: true, groupIds: [] }],
  });
  const res = await asAdmin(request(app).delete('/api/users/1'));
  assert.equal(res.status, 204);
  assert.deepEqual(await authentik.listUsers(), []);
});

test('DELETE /api/users/:id rejects deleting your own account', async () => {
  const { app } = testApp({
    users: [{ id: '1', username: 'admin', email: 'admin@example.com', isActive: true, groupIds: [] }],
  });
  const res = await asAdmin(request(app).delete('/api/users/1'));
  assert.equal(res.status, 400);
});
