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
import { TaskScheduler } from '../../../src/web/tasks/scheduler.ts';
import type { TaskDefinition } from '../../../src/web/tasks/registry.ts';
import type { ImpersonationStore } from '../../../src/web/impersonation.ts';
import { newTestSessions, sessionCookie } from '../../support/web-session.ts';

// #69: one web-login session service for the file, passed to every
// buildApp; sessionCookie() mints a signed-in Cookie header on it.
const sessions = newTestSessions();

function baseInventory(): Inventory {
  return {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
    guests: [],
  };
}

// A single fake task, independent of the real check-app-updates task, so
// these tests don't depend on that task's own run() behaving a particular
// way -- only the scheduler/route plumbing is under test here. Its run()
// resolves instantly by default, but a test that needs the job to still be
// "active" when a second request arrives (the already-running case) can
// swap in a run() that blocks until released.
let pendingRun: { release: () => void } | undefined;
const FAKE_TASK: TaskDefinition = {
  id: 'fake-task',
  label: 'Fake task',
  description: 'A fake task for route tests.',
  defaultTime: '04:00',
  command: 'fake-task',
  run: () => new Promise<void>((resolve) => {
    pendingRun = { release: resolve };
  }),
};

function testApp(opts: { withScheduler?: boolean; inv?: Inventory; impersonationStore?: ImpersonationStore } = {}) {
  const inv = opts.inv ?? baseInventory();
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const jobRunner = new JobRunner(jobStore, jobLog, ssh);
  const inventoryPath = path.join(mkdtempSync(path.join(tmpdir(), 'inventory-')), 'bellhop.db');
  saveInventory(inventoryPath, inv);
  const withScheduler = opts.withScheduler ?? true;
  const taskScheduler = withScheduler
    ? new TaskScheduler({
        inventory: inv,
        inventoryPath,
        jobRunner,
        jobStore,
        tasks: [FAKE_TASK],
        now: () => new Date('2026-10-03T12:00:00.000Z'),
      })
    : undefined;
  const app = buildApp({
    sessions,
    inventory: inv,
    baseSsh: ssh,
    jobStore,
    jobLog,
    jobRunner,
    inventoryPath,
    authentik: new FakeAuthentikClient(),
    taskScheduler,
    impersonationStore: opts.impersonationStore,
  });
  return { app, inventoryPath, jobStore };
}

function asAdmin(req: request.Test): request.Test {
  return req.set('Cookie', sessionCookie(sessions, { username: 'admin', groups: ['bellhop-admins'] }));
}

function asNonAdmin(req: request.Test): request.Test {
  return req.set('Cookie', sessionCookie(sessions, { username: 'someone', groups: ['family'] }));
}

test('GET /api/tasks returns the registered tasks in the contract shape', async () => {
  const { app } = testApp();
  const res = await asAdmin(request(app).get('/api/tasks'));
  assert.equal(res.status, 200);
  assert.equal(res.body.tasks.length, 1);
  const task = res.body.tasks[0];
  assert.equal(task.id, 'fake-task');
  assert.equal(task.label, 'Fake task');
  assert.equal(task.description, 'A fake task for route tests.');
  assert.equal(task.timeOfDay, '04:00');
  assert.equal(task.defaultTime, '04:00');
  assert.equal(task.enabled, true);
  assert.equal(task.running, false);
  assert.equal(task.lastRun, null);
  assert.ok(task.nextRun);
});

test('PATCH /api/tasks/:id with a valid time and enabled flag returns 200 with the new nextRun', async () => {
  const { app } = testApp();
  const before = await asAdmin(request(app).get('/api/tasks'));
  const firstNextRun = before.body.tasks[0].nextRun;

  const res = await asAdmin(request(app).patch('/api/tasks/fake-task')).send({ timeOfDay: '05:30', enabled: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.timeOfDay, '05:30');
  assert.equal(res.body.enabled, true);
  assert.ok(res.body.nextRun);
  assert.notEqual(res.body.nextRun, firstNextRun);
});

test('PATCH /api/tasks/:id with 25:00 returns 400 with the expected message and saves nothing', async () => {
  const { app } = testApp();
  const res = await asAdmin(request(app).patch('/api/tasks/fake-task')).send({ timeOfDay: '25:00' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'timeOfDay must be HH:MM in 24-hour time, e.g. 04:00');

  const after = await asAdmin(request(app).get('/api/tasks'));
  assert.equal(after.body.tasks[0].timeOfDay, '04:00');
});

test('PATCH /api/tasks/:id with an empty body returns 400', async () => {
  const { app } = testApp();
  const res = await asAdmin(request(app).patch('/api/tasks/fake-task')).send({});
  assert.equal(res.status, 400);
});

test('PATCH /api/tasks/:id for an unknown id returns 404', async () => {
  const { app } = testApp();
  const res = await asAdmin(request(app).patch('/api/tasks/no-such-task')).send({ enabled: false });
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'Unknown task: no-such-task');
});

// Fix round 1: only the malformed-timeOfDay case is a 400 -- an unrelated
// failure inside the scheduler (here, an inventoryPath that can't be
// opened as a database at all -- a directory, not a file) must surface as
// a 500, never be folded into the same 400 a validation error gets.
test('PATCH /api/tasks/:id surfaces a non-timeOfDay scheduler failure as 500', async () => {
  const inv = baseInventory();
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const jobRunner = new JobRunner(jobStore, jobLog, ssh);
  const badInventoryPath = mkdtempSync(path.join(tmpdir(), 'bad-inventory-'));
  const taskScheduler = new TaskScheduler({
    inventory: inv,
    inventoryPath: badInventoryPath,
    jobRunner,
    jobStore,
    tasks: [FAKE_TASK],
  });
  const app = buildApp({
    sessions,
    inventory: inv,
    baseSsh: ssh,
    jobStore,
    jobLog,
    jobRunner,
    inventoryPath: badInventoryPath,
    authentik: new FakeAuthentikClient(),
    taskScheduler,
  });

  const res = await asAdmin(request(app).patch('/api/tasks/fake-task')).send({ enabled: false });
  assert.equal(res.status, 500);
});

test('POST /api/tasks/:id/run returns 200 with a jobId attributed to the caller', async () => {
  const { app, jobStore } = testApp();
  const res = await asAdmin(request(app).post('/api/tasks/fake-task/run'));
  assert.equal(res.status, 200);
  assert.ok(typeof res.body.jobId === 'number');
  const row = jobStore.get(res.body.jobId);
  assert.equal(row?.triggeredByUsername, 'admin');
  pendingRun?.release();
});

test('POST /api/tasks/:id/run a second time while active returns 409 with the expected message', async () => {
  const { app } = testApp();
  const first = await asAdmin(request(app).post('/api/tasks/fake-task/run'));
  assert.equal(first.status, 200);

  // The fake task's run() blocks until released, so the job the first
  // request started is still queued/running here.
  const second = await asAdmin(request(app).post('/api/tasks/fake-task/run'));
  assert.equal(second.status, 409);
  assert.equal(second.body.error, `Fake task is already running (job #${first.body.jobId})`);
  pendingRun?.release();
});

test('POST /api/tasks/:id/run for an unknown id returns 404', async () => {
  const { app } = testApp();
  const res = await asAdmin(request(app).post('/api/tasks/no-such-task/run'));
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'Unknown task: no-such-task');
});

test('every /api/tasks route returns 403 for a non-admin', async () => {
  const { app } = testApp();
  const get = await asNonAdmin(request(app).get('/api/tasks'));
  assert.equal(get.status, 403);
  const patch = await asNonAdmin(request(app).patch('/api/tasks/fake-task')).send({ enabled: false });
  assert.equal(patch.status, 403);
  const run = await asNonAdmin(request(app).post('/api/tasks/fake-task/run'));
  assert.equal(run.status, 403);
});

test('every /api/tasks route returns 403 for an admin impersonating a non-admin group', async () => {
  // The impersonation store is keyed by the real, trusted username (see
  // app-updates.test.ts for the identical pattern) -- 'admin' is overlaid
  // to the 'family' group for every request below.
  const store: ImpersonationStore = new Map([['admin', 'family']]);
  const { app } = testApp({ impersonationStore: store });

  const get = await asAdmin(request(app).get('/api/tasks'));
  assert.equal(get.status, 403);
  const patch = await asAdmin(request(app).patch('/api/tasks/fake-task')).send({ enabled: false });
  assert.equal(patch.status, 403);
  const run = await asAdmin(request(app).post('/api/tasks/fake-task/run'));
  assert.equal(run.status, 403);
});

test('every /api/tasks route returns 503 when no scheduler is wired', async () => {
  const { app } = testApp({ withScheduler: false });
  const get = await asAdmin(request(app).get('/api/tasks'));
  assert.equal(get.status, 503);
  assert.equal(get.body.error, 'Task scheduler is not running in this process');

  const patch = await asAdmin(request(app).patch('/api/tasks/fake-task')).send({ enabled: false });
  assert.equal(patch.status, 503);

  const run = await asAdmin(request(app).post('/api/tasks/fake-task/run'));
  assert.equal(run.status, 503);
});
