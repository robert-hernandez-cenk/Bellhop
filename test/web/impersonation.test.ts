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
import { savePermissionGroup } from '../../src/lib/permissions.ts';
import { applyImpersonation, resolveActor, type ImpersonationStore } from '../../src/web/impersonation.ts';
import type { Request } from 'express';

const inventory: Inventory = {
  domain: 'example.com',
  hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' } }],
  guests: [],
};

function newInventoryPath(): string {
  const p = path.join(mkdtempSync(path.join(tmpdir(), 'inventory-')), 'bellhop.db');
  saveInventory(p, inventory);
  return p;
}

function testApp(impersonationStore: ImpersonationStore, inventoryPath: string) {
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const jobRunner = new JobRunner(jobStore, jobLog, ssh);
  return buildApp({
    inventory,
    baseSsh: ssh,
    jobStore,
    jobLog,
    jobRunner,
    inventoryPath,
    authentik: new FakeAuthentikClient(),
    impersonationStore,
  });
}

test('an admin with an active impersonation entry sees whoami overlaid with the impersonated group', async () => {
  const store: ImpersonationStore = new Map([['admin', 'bellhop-viewers']]);
  const app = testApp(store, newInventoryPath());
  const res = await request(app)
    .get('/api/whoami')
    .set('x-authentik-username', 'admin')
    .set('x-authentik-groups', 'bellhop-admins');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
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

test('a user with no impersonation entry is unaffected', async () => {
  const app = testApp(new Map(), newInventoryPath());
  const res = await request(app)
    .get('/api/whoami')
    .set('x-authentik-username', 'admin')
    .set('x-authentik-groups', 'bellhop-admins');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    username: 'admin',
    groups: ['bellhop-admins'],
    localOperator: false,
    isAdmin: true,
    adminGroups: { app: 'bellhop-admins', authentikBuiltin: 'authentik Admins' },
    capabilities: { userDirectory: true },
  });
});

test('impersonation overlay drives downstream permission checks, not just whoami', async () => {
  const inventoryPath = newInventoryPath();
  savePermissionGroup(inventoryPath, 'bellhop-viewers', {
    mode: 'block-list',
    resources: [{ type: 'host', name: 'pve1' }],
  });

  const blockedApp = testApp(new Map([['admin', 'bellhop-viewers']]), inventoryPath);
  const blocked = await request(blockedApp)
    .get('/api/inventory')
    .set('x-authentik-username', 'admin')
    .set('x-authentik-groups', 'bellhop-admins');
  assert.equal(blocked.status, 200);
  assert.deepEqual(blocked.body.hosts, []);

  const adminApp = testApp(new Map(), inventoryPath);
  const unblocked = await request(adminApp)
    .get('/api/inventory')
    .set('x-authentik-username', 'admin')
    .set('x-authentik-groups', 'bellhop-admins');
  assert.equal(unblocked.status, 200);
  assert.equal(unblocked.body.hosts.length, 1);
});

// --- resolveActor (issue #53, controller review) ---

test('resolveActor returns the real, non-impersonated identity when req.user and req.realUser differ', () => {
  const req = {
    user: {
      username: 'bellhop-viewers-view',
      email: 'viewer@example.com',
      groups: ['bellhop-viewers'],
      impersonating: 'bellhop-viewers',
    },
    realUser: { username: 'admin', email: 'admin@example.com', groups: ['bellhop-admins'] },
  } as unknown as Request;
  assert.deepEqual(resolveActor(req), { username: 'admin', email: 'admin@example.com' });
});

test('resolveActor returns undefined for the synthetic local operator', () => {
  const req = {
    user: { username: 'local', groups: [], localOperator: true },
  } as unknown as Request;
  assert.equal(resolveActor(req), undefined);
});

// issue #58 (unit U1): resolveActor copies uid from the real identity, the
// same real-user rule it already applies to username/email -- an admin
// impersonating a group still grants as themselves, uid included.
test('resolveActor copies uid from req.user when not impersonating', () => {
  const req = {
    user: { username: 'test-user', groups: ['bellhop-admins'], uid: 'uid-test-user' },
  } as unknown as Request;
  assert.deepEqual(resolveActor(req), { username: 'test-user', uid: 'uid-test-user' });
});

test('resolveActor copies uid from req.realUser while impersonating, not from the overlaid req.user', () => {
  const req = {
    user: {
      username: 'bellhop-viewers-view',
      groups: ['bellhop-viewers'],
      impersonating: 'bellhop-viewers',
    },
    realUser: { username: 'admin', groups: ['bellhop-admins'], uid: 'uid-admin' },
  } as unknown as Request;
  assert.deepEqual(resolveActor(req), { username: 'admin', uid: 'uid-admin' });
});

test('resolveActor omits uid entirely when the real identity has none', () => {
  const req = {
    user: { username: 'test-user', groups: ['bellhop-admins'] },
  } as unknown as Request;
  const actor = resolveActor(req);
  assert.ok(actor && !('uid' in actor), 'a real identity with no uid must round-trip without a uid key at all');
});

// --- viaForwardAuth survives the overlay (issue #64) ---

test('applyImpersonation keeps viaForwardAuth on both the overlaid req.user and req.realUser', () => {
  const req = {
    user: { username: 'admin', groups: ['bellhop-admins'], viaForwardAuth: true as const },
  } as unknown as Request; // only the fields applyImpersonation reads
  let nextCalled = false;
  applyImpersonation(new Map([['admin', 'bellhop-viewers']]))(req, {} as never, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
  assert.equal(req.user?.impersonating, 'bellhop-viewers');
  assert.equal(req.user?.viaForwardAuth, true);
  assert.equal(req.realUser?.viaForwardAuth, true);
});

test('whoami does not expose viaForwardAuth', async () => {
  const app = testApp(new Map(), newInventoryPath());
  const res = await request(app).get('/api/whoami').set('x-authentik-username', 'admin').set('x-authentik-groups', 'bellhop-admins');
  assert.equal(res.status, 200);
  assert.equal('viaForwardAuth' in res.body, false);
});
