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
import { authentikConfig } from '../../../src/lib/authentik-config.ts';
import { saveInventory, type Inventory } from '../../../src/lib/inventory.ts';

const LADDER = authentikConfig().groupLadder;

const inventory: Inventory = {
  domain: 'example.com',
  hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
  guests: [{ name: 'plex-lxc', type: 'lxc', vmid: 4003, host: 'pve1' }],
};

function testApp(authentik: AuthentikClient = new FakeAuthentikClient()) {
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const jobRunner = new JobRunner(jobStore, jobLog, ssh);
  const inventoryPath = path.join(mkdtempSync(path.join(tmpdir(), 'inventory-')), 'bellhop.db');
  saveInventory(inventoryPath, inventory);
  return buildApp({ inventory, baseSsh: ssh, jobStore, jobLog, jobRunner, inventoryPath, authentik });
}

function asAdmin(req: request.Test): request.Test {
  return req.set('x-authentik-username', 'admin').set('x-authentik-groups', 'bellhop-admins');
}

function asUser(req: request.Test): request.Test {
  return req.set('x-authentik-username', 'someone').set('x-authentik-groups', 'homelab-app-users');
}

test('GET /api/auth-groups returns every ladder rung in order, marking which exist in Authentik', async () => {
  const authentik = new FakeAuthentikClient();
  await authentik.createGroup(LADDER[0]);
  const res = await asAdmin(request(testApp(authentik)).get('/api/auth-groups'));
  assert.equal(res.status, 200);
  assert.equal(res.body.configured, true);
  assert.deepEqual(res.body.rungs.map((r: { name: string }) => r.name), LADDER);
  assert.equal(res.body.rungs[0].exists, true);
  assert.equal(res.body.rungs[1].exists, false);
});

test('GET /api/auth-groups reports canLower true for an admin and false for a non-admin', async () => {
  const app = testApp();
  assert.equal((await asAdmin(request(app).get('/api/auth-groups'))).body.canLower, true);
  assert.equal((await asUser(request(app).get('/api/auth-groups'))).body.canLower, false);
});

test('GET /api/auth-groups is reachable by a non-admin', async () => {
  const res = await asUser(request(testApp()).get('/api/auth-groups'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.rungs.map((r: { name: string }) => r.name), LADDER);
});

test('GET /api/auth-groups reports configured false with null existence when Authentik is unconfigured', async () => {
  const res = await asAdmin(request(testApp(new UnconfiguredAuthentikClient())).get('/api/auth-groups'));
  assert.equal(res.status, 200);
  assert.equal(res.body.configured, false);
  assert.deepEqual(res.body.rungs.map((r: { name: string }) => r.name), LADDER);
  assert.equal(res.body.rungs[0].exists, null);
});

// UnconfiguredAuthentikClient won't exercise this path -- its isConfigured()
// is false, so the route takes the earlier branch and never calls
// listGroups() at all. This needs a client that reports configured but
// still fails the live call, e.g. Authentik being unreachable.
class FailingListGroupsClient extends FakeAuthentikClient {
  async listGroups(): Promise<AuthentikGroup[]> {
    throw new Error('Authentik unreachable');
  }
}

test('GET /api/auth-groups returns 503 when listGroups() rejects on a configured client', async () => {
  const res = await asAdmin(request(testApp(new FailingListGroupsClient())).get('/api/auth-groups'));
  assert.equal(res.status, 503);
  assert.match(res.body.error, /Authentik unreachable/);
});
