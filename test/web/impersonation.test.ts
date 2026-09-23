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
import type { ImpersonationStore } from '../../src/web/impersonation.ts';

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
