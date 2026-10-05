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
import { replaceAppUpdateResults, type AppUpdateResult } from '../../../src/lib/app-update-store.ts';
import type { ImpersonationStore } from '../../../src/web/impersonation.ts';
import { newTestSessions, sessionCookie } from '../../support/web-session.ts';

// #69: one web-login session service for the file, passed to every
// buildApp; sessionCookie() mints a signed-in Cookie header on it.
const sessions = newTestSessions();

function baseInventory(): Inventory {
  return {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
    guests: [
      { name: 'media', type: 'lxc', vmid: 101, host: 'pve1', app: 'jellyseerr' },
      { name: 'web-lxc', type: 'lxc', vmid: 102, host: 'pve1', app: 'homepage' },
      // Not an eligible app guest: lxc but no `app` set.
      { name: 'bare-lxc', type: 'lxc', vmid: 103, host: 'pve1' },
    ],
  };
}

function testApp(inv: Inventory = baseInventory(), impersonationStore?: ImpersonationStore) {
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const jobRunner = new JobRunner(jobStore, jobLog, ssh);
  const inventoryPath = path.join(mkdtempSync(path.join(tmpdir(), 'inventory-')), 'bellhop.db');
  saveInventory(inventoryPath, inv);
  const app = buildApp({
    sessions,
    inventory: inv,
    baseSsh: ssh,
    jobStore,
    jobLog,
    jobRunner,
    inventoryPath,
    authentik: new FakeAuthentikClient(),
    impersonationStore,
  });
  return { app, inventoryPath };
}

function asAdmin(req: request.Test): request.Test {
  return req.set('Cookie', sessionCookie(sessions, { username: 'admin', groups: ['bellhop-admins'] }));
}

test('GET /api/app-updates returns saved rows in the contract shape, with optional fields omitted when unset', async () => {
  const { app, inventoryPath } = testApp();
  const results: AppUpdateResult[] = [
    {
      guest: 'media',
      app: 'jellyseerr',
      status: 'update-available',
      installedVersion: '1.2.3',
      latestVersion: '1.3.0',
      repo: 'example-owner/example-app',
      checkedAt: '2026-10-03T04:00:41.000Z',
    },
    {
      guest: 'web-lxc',
      app: 'homepage',
      status: 'error',
      message: 'GitHub API rate limit reached; the next scheduled check will retry',
      checkedAt: '2026-10-03T04:00:42.000Z',
    },
  ];
  replaceAppUpdateResults(inventoryPath, results);

  const res = await asAdmin(request(app).get('/api/app-updates'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.results, [
    {
      guest: 'media',
      app: 'jellyseerr',
      status: 'update-available',
      installedVersion: '1.2.3',
      latestVersion: '1.3.0',
      repo: 'example-owner/example-app',
      checkedAt: '2026-10-03T04:00:41.000Z',
    },
    {
      guest: 'web-lxc',
      app: 'homepage',
      status: 'error',
      message: 'GitHub API rate limit reached; the next scheduled check will retry',
      checkedAt: '2026-10-03T04:00:42.000Z',
    },
  ]);
  // Optional fields absent on the second row must not come back as
  // explicit nulls/empty strings -- they must be missing keys entirely.
  assert.equal('installedVersion' in res.body.results[1], false);
  assert.equal('latestVersion' in res.body.results[1], false);
  assert.equal('repo' in res.body.results[1], false);
});

test('GET /api/app-updates drops a row for a guest that is no longer an lxc+app guest in inventory', async () => {
  const { app, inventoryPath } = testApp();
  replaceAppUpdateResults(inventoryPath, [
    { guest: 'media', app: 'jellyseerr', status: 'up-to-date', installedVersion: '1.2.3', checkedAt: '2026-10-03T04:00:41.000Z' },
    // bare-lxc exists but has no `app` set -- no longer eligible.
    { guest: 'bare-lxc', app: 'some-app', status: 'up-to-date', installedVersion: '1.0.0', checkedAt: '2026-10-03T04:00:42.000Z' },
    // removed-guest no longer exists in inventory at all.
    { guest: 'removed-guest', app: 'ghost', status: 'up-to-date', installedVersion: '1.0.0', checkedAt: '2026-10-03T04:00:43.000Z' },
  ]);

  const res = await asAdmin(request(app).get('/api/app-updates'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.results.map((r: AppUpdateResult) => r.guest), ['media']);
});

test('GET /api/app-updates drops a row for a guest a block-list group cannot see', async () => {
  const { app, inventoryPath } = testApp();
  replaceAppUpdateResults(inventoryPath, [
    { guest: 'media', app: 'jellyseerr', status: 'up-to-date', installedVersion: '1.2.3', checkedAt: '2026-10-03T04:00:41.000Z' },
    { guest: 'web-lxc', app: 'homepage', status: 'up-to-date', installedVersion: '2.0.0', checkedAt: '2026-10-03T04:00:42.000Z' },
  ]);
  await asAdmin(request(app).put('/api/permissions/family')).send({
    mode: 'block-list',
    resources: [{ type: 'guest', name: 'media' }],
  });

  const res = await request(app).get('/api/app-updates').set('Cookie', sessionCookie(sessions, { username: 'kid', groups: ['family'] }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.results.map((r: AppUpdateResult) => r.guest), ['web-lxc']);
});

test('GET /api/app-updates drops a row for a guest an allow-list group cannot see', async () => {
  const { app, inventoryPath } = testApp();
  replaceAppUpdateResults(inventoryPath, [
    { guest: 'media', app: 'jellyseerr', status: 'up-to-date', installedVersion: '1.2.3', checkedAt: '2026-10-03T04:00:41.000Z' },
    { guest: 'web-lxc', app: 'homepage', status: 'up-to-date', installedVersion: '2.0.0', checkedAt: '2026-10-03T04:00:42.000Z' },
  ]);
  await asAdmin(request(app).put('/api/permissions/family')).send({
    mode: 'allow-list',
    resources: [{ type: 'guest', name: 'web-lxc' }],
  });

  const res = await request(app).get('/api/app-updates').set('Cookie', sessionCookie(sessions, { username: 'kid', groups: ['family'] }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.results.map((r: AppUpdateResult) => r.guest), ['web-lxc']);
});

test('GET /api/app-updates lets an admin see every row despite a block-list rule', async () => {
  const { app, inventoryPath } = testApp();
  replaceAppUpdateResults(inventoryPath, [
    { guest: 'media', app: 'jellyseerr', status: 'up-to-date', installedVersion: '1.2.3', checkedAt: '2026-10-03T04:00:41.000Z' },
    { guest: 'web-lxc', app: 'homepage', status: 'up-to-date', installedVersion: '2.0.0', checkedAt: '2026-10-03T04:00:42.000Z' },
  ]);
  await asAdmin(request(app).put('/api/permissions/family')).send({
    mode: 'block-list',
    resources: [{ type: 'guest', name: 'media' }],
  });

  const res = await asAdmin(request(app).get('/api/app-updates'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.results.map((r: AppUpdateResult) => r.guest).sort(), ['media', 'web-lxc']);
});

test('GET /api/app-updates filters by the impersonated group, not the real admin identity', async () => {
  // The impersonation store is keyed by the real, trusted username -- only
  // 'admin' is overlaid to the 'family' group here. The permissions setup
  // call below uses a distinct admin identity ('setup-admin') precisely so
  // that call itself isn't also caught by the overlay (applyImpersonation
  // is global middleware, so it would otherwise 403 the admin-only
  // permissions PUT too).
  const store: ImpersonationStore = new Map([['admin', 'family']]);
  const { app, inventoryPath } = testApp(baseInventory(), store);
  replaceAppUpdateResults(inventoryPath, [
    { guest: 'media', app: 'jellyseerr', status: 'up-to-date', installedVersion: '1.2.3', checkedAt: '2026-10-03T04:00:41.000Z' },
    { guest: 'web-lxc', app: 'homepage', status: 'up-to-date', installedVersion: '2.0.0', checkedAt: '2026-10-03T04:00:42.000Z' },
  ]);
  await request(app)
    .put('/api/permissions/family')
    .set('Cookie', sessionCookie(sessions, { username: 'setup-admin', groups: ['bellhop-admins'] }))
    .send({ mode: 'block-list', resources: [{ type: 'guest', name: 'media' }] });

  const res = await asAdmin(request(app).get('/api/app-updates'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.results.map((r: AppUpdateResult) => r.guest), ['web-lxc']);
});

// issue #58 creator access (fix round 1): an allow-list group that names
// only the host -- never the guest itself -- still surfaces that guest's
// result to the user recorded as its creator, the same lift
// isResourceAllowed already grants for /api/inventory and
// /api/guests/status (see dashboard.test.ts's creatorInventory/creatorApp
// for the identical pattern this mirrors).
function creatorInventory(): Inventory {
  return {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
    guests: [
      { name: 'web-lxc', type: 'lxc', vmid: 102, host: 'pve1', app: 'homepage', creator: { username: 'test-user' } },
      { name: 'media', type: 'lxc', vmid: 101, host: 'pve1', app: 'jellyseerr' },
    ],
  };
}

test('GET /api/app-updates includes a guest\'s result for its creator even though the allow-list group omits that guest', async () => {
  const { app, inventoryPath } = testApp(creatorInventory());
  replaceAppUpdateResults(inventoryPath, [
    { guest: 'web-lxc', app: 'homepage', status: 'up-to-date', installedVersion: '2.0.0', checkedAt: '2026-10-03T04:00:41.000Z' },
    { guest: 'media', app: 'jellyseerr', status: 'up-to-date', installedVersion: '1.2.3', checkedAt: '2026-10-03T04:00:42.000Z' },
  ]);
  // app-users is a host-only allow-list -- it never names web-lxc (or
  // media) directly, so only the creator lift can surface web-lxc here.
  await asAdmin(request(app).put('/api/permissions/app-users')).send({
    mode: 'allow-list',
    resources: [{ type: 'host', name: 'pve1' }],
  });

  const creator = await request(app).get('/api/app-updates').set('Cookie', sessionCookie(sessions, { username: 'test-user', groups: ['app-users'] }));
  assert.equal(creator.status, 200);
  assert.deepEqual(creator.body.results.map((r: AppUpdateResult) => r.guest), ['web-lxc']);

  // Another user in the same group, not the creator, sees neither row.
  const other = await request(app).get('/api/app-updates').set('Cookie', sessionCookie(sessions, { username: 'other-user', groups: ['app-users'] }));
  assert.equal(other.status, 200);
  assert.deepEqual(other.body.results, []);
});

// Final review: a guest repurposed to a different app since the last check
// must not show the old app's result -- the stored row's `app` no longer
// matches what the inventory says is installed.
test('GET /api/app-updates drops a row whose app no longer matches the guest\'s recorded app', async () => {
  const { app, inventoryPath } = testApp();
  replaceAppUpdateResults(inventoryPath, [
    { guest: 'media', app: 'old-app', status: 'update-available', installedVersion: '1.0.0', latestVersion: '2.0.0', checkedAt: '2026-10-03T04:00:41.000Z' },
    { guest: 'web-lxc', app: 'homepage', status: 'up-to-date', installedVersion: '2.0.0', checkedAt: '2026-10-03T04:00:42.000Z' },
  ]);

  const res = await asAdmin(request(app).get('/api/app-updates'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.results.map((r: AppUpdateResult) => r.guest), ['web-lxc']);
});
