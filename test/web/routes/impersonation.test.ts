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
import type { AuthentikClient } from '../../../src/lib/authentik-client.ts';
import { saveInventory, type Inventory } from '../../../src/lib/inventory.ts';
import type { ImpersonationStore } from '../../../src/web/impersonation.ts';

const inventory: Inventory = { domain: 'example.com', hosts: [], guests: [] };

function testApp(
  impersonationStore: ImpersonationStore,
  authentik: AuthentikClient = new FakeAuthentikClient({
    groups: [{ id: '1', name: 'bellhop-viewers', userIds: [] }],
  })
) {
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
    authentik,
    impersonationStore,
  });
}

function asAdmin(req: request.Test): request.Test {
  return req.set('x-authentik-username', 'admin').set('x-authentik-groups', 'bellhop-admins');
}

test('POST /api/impersonate rejects a non-admin', async () => {
  const app = testApp(new Map());
  const res = await request(app)
    .post('/api/impersonate')
    .set('x-authentik-username', 'someone')
    .set('x-authentik-groups', 'family')
    .send({ group: 'bellhop-viewers' });
  assert.equal(res.status, 403);
});

test('POST /api/impersonate rejects an unknown group', async () => {
  const app = testApp(new Map());
  const res = await asAdmin(request(app).post('/api/impersonate')).send({ group: 'no-such-group' });
  assert.equal(res.status, 400);
});

test('POST /api/impersonate rejects impersonating an admin group', async () => {
  const app = testApp(new Map());
  const res = await asAdmin(request(app).post('/api/impersonate')).send({ group: 'bellhop-admins' });
  assert.equal(res.status, 400);
});

test('POST /api/impersonate accepts a valid group and whoami reflects it on the next request', async () => {
  const store: ImpersonationStore = new Map();
  const app = testApp(store);
  const postRes = await asAdmin(request(app).post('/api/impersonate')).send({ group: 'bellhop-viewers' });
  assert.equal(postRes.status, 200);
  assert.deepEqual(postRes.body, { group: 'bellhop-viewers' });

  const whoami = await asAdmin(request(app).get('/api/whoami'));
  assert.equal(whoami.status, 200);
  assert.deepEqual(whoami.body, {
    username: 'admin',
    groups: ['bellhop-viewers'],
    impersonating: 'bellhop-viewers',
    localOperator: false,
    // isAdmin is computed from req.user.groups, i.e. the overlaid groups
    // during an active impersonation -- an admin impersonating a non-admin
    // group must see isAdmin: false, since this is what the Sidebar's own
    // nav gating depends on.
    isAdmin: false,
    adminGroups: { app: 'bellhop-admins', authentikBuiltin: 'authentik Admins' },
    capabilities: { userDirectory: true },
  });
});

test('DELETE /api/impersonate clears an active impersonation even though the caller now looks non-admin', async () => {
  // Seeded already-active, same as a second request from an admin who's
  // mid-impersonation -- this is the lock-out regression check: without
  // requireRealAdminGroup reading req.realUser, requireAdminGroup would see
  // only the overlaid 'bellhop-viewers' group and 403 this call,
  // leaving the admin stuck impersonating until a server restart.
  const store: ImpersonationStore = new Map([['admin', 'bellhop-viewers']]);
  const app = testApp(store);

  const del = await asAdmin(request(app).delete('/api/impersonate'));
  assert.equal(del.status, 204);

  const whoami = await asAdmin(request(app).get('/api/whoami'));
  assert.deepEqual(whoami.body, {
    username: 'admin',
    groups: ['bellhop-admins'],
    localOperator: false,
    isAdmin: true,
    adminGroups: { app: 'bellhop-admins', authentikBuiltin: 'authentik Admins' },
    capabilities: { userDirectory: true },
  });
});

test('POST /api/impersonate returns 503 without the Authentik API, but DELETE still works', async () => {
  // Pre-seeded, as if an impersonation had started while the API was still
  // available -- this is the lock-out regression check for the capability
  // gate itself: DELETE must stay reachable so an admin isn't stranded in
  // that view until a server restart.
  const store: ImpersonationStore = new Map([['admin', 'bellhop-viewers']]);
  const app = testApp(store, new UnconfiguredAuthentikClient());

  const post = await asAdmin(request(app).post('/api/impersonate')).send({ group: 'bellhop-viewers' });
  assert.equal(post.status, 503);

  const del = await asAdmin(request(app).delete('/api/impersonate'));
  assert.equal(del.status, 204);
  assert.equal(store.get('admin'), undefined);
});
