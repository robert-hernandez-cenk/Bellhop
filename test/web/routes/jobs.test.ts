import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { buildApp } from '../../../src/web/app.ts';
import { JobStore, defaultIsPidAlive } from '../../../src/web/jobs/job-store.ts';
import { createJobLog } from '../../../src/web/jobs/job-log.ts';
import type { JobLog } from '../../../src/web/jobs/job-log.ts';
import { JobRunner } from '../../../src/web/jobs/job-runner.ts';
import { FakeSSHClient } from '../../support/fake-ssh-client.ts';
import { FakeAuthentikClient } from '../../support/fake-authentik-client.ts';
import { HangingSSHClient } from '../../support/hanging-ssh-client.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { saveInventory, type Inventory } from '../../../src/lib/inventory.ts';
import http from 'node:http';
import { WebSocket } from 'ws';
import { attachJobsWebSocket, completeUtf8Length } from '../../../src/web/routes/jobs.ts';
import { savePermissionGroup } from '../../../src/lib/permissions.ts';
import type { ImpersonationStore } from '../../../src/web/impersonation.ts';
import Database from 'better-sqlite3';

const inventory: Inventory = { domain: 'example.com', hosts: [], guests: [] };

function seededInventoryPath(): string {
  const dest = path.join(mkdtempSync(path.join(tmpdir(), 'inventory-')), 'bellhop.db');
  saveInventory(dest, inventory);
  return dest;
}

function waitForFinished(store: JobStore, id: number): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      const status = store.get(id)?.status;
      if (status === 'success' || status === 'failed') resolve();
      else setTimeout(check, 5);
    };
    check();
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('GET /api/jobs lists jobs most-recent-first, GET /api/jobs/:id returns detail + log', async () => {
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
  const ssh = new FakeSSHClient(() => ({ stdout: 'done', stderr: '', code: 0 }));
  const jobRunner = new JobRunner(jobStore, jobLog, ssh);
  const app = buildApp({ inventory, baseSsh: ssh, jobStore, jobLog, jobRunner, inventoryPath: seededInventoryPath(), authentik: new FakeAuthentikClient() });

  const id = jobRunner.enqueue({
    command: 'update-all',
    category: 'maintenance',
    argsJson: '{}',
    run: async (s) => {
      await s.exec({ host: 'pve1.local', user: 'root' }, 'echo hi');
    },
  });

  await waitForFinished(jobStore, id);

  const list = await request(app)
    .get('/api/jobs')
    .set('x-authentik-username', 'admin')
    .set('x-authentik-groups', 'bellhop-admins');
  assert.equal(list.status, 200);
  assert.equal(list.body[0].id, id);

  const detail = await request(app)
    .get(`/api/jobs/${id}`)
    .set('x-authentik-username', 'admin')
    .set('x-authentik-groups', 'bellhop-admins');
  assert.equal(detail.status, 200);
  assert.equal(detail.body.job.status, 'success');
  assert.match(detail.body.log, /done/);
});

test('GET /api/jobs/:id 404s for an unknown id', async () => {
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const jobRunner = new JobRunner(jobStore, jobLog, ssh);
  const app = buildApp({ inventory, baseSsh: ssh, jobStore, jobLog, jobRunner, inventoryPath: seededInventoryPath(), authentik: new FakeAuthentikClient() });
  const res = await request(app).get('/api/jobs/999');
  assert.equal(res.status, 404);
});

test('POST /api/jobs/:id/cancel stops a running job and marks it cancelled', async () => {
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
  const ssh = new FakeSSHClient(() => ({ stdout: 'done', stderr: '', code: 0 }));
  const jobRunner = new JobRunner(jobStore, jobLog, ssh);
  const app = buildApp({ inventory, baseSsh: ssh, jobStore, jobLog, jobRunner, inventoryPath: seededInventoryPath(), authentik: new FakeAuthentikClient() });

  // Gate the job on a promise the test controls, rather than a fixed delay
  // raced against the cancel request over real wall-clock time (flaky under
  // load) -- releaseJob() is only called after the cancel response is
  // already in hand, so s.exec() always sees signal.aborted === true.
  let releaseJob!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseJob = resolve;
  });

  const id = jobRunner.enqueue({
    command: 'update-all',
    category: 'maintenance',
    argsJson: '{}',
    run: async (s) => {
      await gate;
      await s.exec({ host: 'pve1.local', user: 'root' }, 'apt-get update');
    },
  });

  const res = await request(app)
    .post(`/api/jobs/${id}/cancel`)
    .set('x-authentik-username', 'admin')
    .set('x-authentik-groups', 'bellhop-admins');
  assert.equal(res.status, 200);
  assert.equal(res.body.cancelled, true);

  releaseJob();

  await new Promise((resolve) => {
    const check = () => {
      const status = jobStore.get(id)?.status;
      if (status === 'success' || status === 'failed' || status === 'cancelled') resolve(undefined);
      else setTimeout(check, 5);
    };
    check();
  });
  assert.equal(jobStore.get(id)?.status, 'cancelled');
});

test('POST /api/jobs/:id/cancel 404s for an unknown id', async () => {
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const jobRunner = new JobRunner(jobStore, jobLog, ssh);
  const app = buildApp({ inventory, baseSsh: ssh, jobStore, jobLog, jobRunner, inventoryPath: seededInventoryPath(), authentik: new FakeAuthentikClient() });
  const res = await request(app).post('/api/jobs/999/cancel');
  assert.equal(res.status, 404);
});

test('POST /api/jobs/:id/cancel 409s for a job that already finished', async () => {
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
  const ssh = new FakeSSHClient(() => ({ stdout: 'done', stderr: '', code: 0 }));
  const jobRunner = new JobRunner(jobStore, jobLog, ssh);
  const app = buildApp({ inventory, baseSsh: ssh, jobStore, jobLog, jobRunner, inventoryPath: seededInventoryPath(), authentik: new FakeAuthentikClient() });

  const id = jobRunner.enqueue({
    command: 'update-all',
    category: 'maintenance',
    argsJson: '{}',
    run: async (s) => {
      await s.exec({ host: 'pve1.local', user: 'root' }, 'echo hi');
    },
  });
  await waitForFinished(jobStore, id);

  const res = await request(app)
    .post(`/api/jobs/${id}/cancel`)
    .set('x-authentik-username', 'admin')
    .set('x-authentik-groups', 'bellhop-admins');
  assert.equal(res.status, 409);
});

function startWsServer(
  jobRunner: JobRunner,
  jobStore: JobStore,
  jobLog: JobLog,
  inventoryPath: string,
  impersonationStore: ImpersonationStore = new Map(),
  options?: { tailIntervalMs?: number; isPidAlive?: (pid: number) => boolean },
  inv: Inventory = inventory
): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer();
  attachJobsWebSocket(server, jobRunner, jobStore, jobLog, inventoryPath, inv, impersonationStore, options);
  return new Promise((resolve) => {
    server.listen(0, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('expected a bound TCP port');
      resolve({ server, port: address.port });
    });
  });
}

function connect(port: number, headers?: Record<string, string>, jobId = 1): Promise<'open' | 'refused'> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/jobs/${jobId}`, { headers });
    ws.on('open', () => {
      ws.close();
      resolve('open');
    });
    ws.on('error', () => resolve('refused'));
  });
}

// Like connect() above, but keeps the socket open and collects every
// message it receives (backlog/status/prompt/chunk/...) instead of closing
// immediately on open -- needed for the prompt-origin tests below, which
// have to inspect the actual payload rather than just whether the upgrade
// succeeded.
function connectCollectingMessages(
  port: number,
  headers: Record<string, string>,
  jobId: number
): Promise<{ ws: WebSocket; messages: any[] }> {
  return new Promise((resolve, reject) => {
    const messages: any[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/jobs/${jobId}`, { headers });
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
    ws.on('open', () => resolve({ ws, messages }));
    ws.on('error', reject);
  });
}

function waitFor(predicate: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (predicate()) resolve();
      else setTimeout(check, 5);
    };
    check();
  });
}

test('WS /ws/jobs/:id refuses the upgrade with no trusted headers and no WEB_UI_DEV_USER in strict authentik mode', async () => {
  const originalDevUser = process.env.WEB_UI_DEV_USER;
  const originalAuthMode = process.env.WEB_UI_AUTH_MODE;
  delete process.env.WEB_UI_DEV_USER;
  process.env.WEB_UI_AUTH_MODE = 'authentik';
  try {
    const jobStore = new JobStore(':memory:');
    const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
    const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
    const jobRunner = new JobRunner(jobStore, jobLog, ssh);
    const inventoryPath = seededInventoryPath();
    const { server, port } = await startWsServer(jobRunner, jobStore, jobLog, inventoryPath);
    try {
      const outcome = await connect(port);
      assert.equal(outcome, 'refused');
    } finally {
      server.close();
    }
  } finally {
    if (originalDevUser !== undefined) process.env.WEB_UI_DEV_USER = originalDevUser;
    if (originalAuthMode === undefined) delete process.env.WEB_UI_AUTH_MODE;
    else process.env.WEB_UI_AUTH_MODE = originalAuthMode;
  }
});

test('WS /ws/jobs/:id accepts the upgrade with a trusted x-authentik-username header', async () => {
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const jobRunner = new JobRunner(jobStore, jobLog, ssh);
  const inventoryPath = seededInventoryPath();
  const { server, port } = await startWsServer(jobRunner, jobStore, jobLog, inventoryPath);
  try {
    // No job with id 1 exists in this test, so its target resolves to null
    // (fleet-wide) -- only an admin caller is visible for a null target
    // (see isJobVisible), so this connects as admin to keep testing what it
    // always tested: a trusted, authenticated caller can open the socket.
    const outcome = await connect(port, {
      'x-authentik-username': 'alice',
      'x-authentik-groups': 'bellhop-admins',
    });
    assert.equal(outcome, 'open');
  } finally {
    server.close();
  }
});

test('WS /ws/jobs/:id refuses the upgrade for a restricted group blocked from the job target', async () => {
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const jobRunner = new JobRunner(jobStore, jobLog, ssh);
  const inventoryPath = seededInventoryPath();

  const id = jobRunner.enqueue({
    command: 'guest-power',
    category: 'maintenance',
    target: 'stash-lxc',
    argsJson: '{}',
    run: async () => {},
  });
  assert.equal(id, 1);
  savePermissionGroup(inventoryPath, 'family', { mode: 'block-list', resources: [{ type: 'guest', name: 'stash-lxc' }] });

  const { server, port } = await startWsServer(jobRunner, jobStore, jobLog, inventoryPath);
  try {
    const outcome = await connect(port, { 'x-authentik-username': 'kid', 'x-authentik-groups': 'family' }, id);
    assert.equal(outcome, 'refused');
  } finally {
    server.close();
  }
});

test('WS /ws/jobs/:id accepts the upgrade for a restricted group not blocked from the job target', async () => {
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const jobRunner = new JobRunner(jobStore, jobLog, ssh);
  const inventoryPath = seededInventoryPath();

  const id = jobRunner.enqueue({
    command: 'guest-power',
    category: 'maintenance',
    target: 'plex-lxc',
    argsJson: '{}',
    run: async () => {},
  });
  assert.equal(id, 1);
  savePermissionGroup(inventoryPath, 'family', { mode: 'block-list', resources: [{ type: 'guest', name: 'stash-lxc' }] });

  const { server, port } = await startWsServer(jobRunner, jobStore, jobLog, inventoryPath);
  try {
    const outcome = await connect(port, { 'x-authentik-username': 'kid', 'x-authentik-groups': 'family' }, id);
    assert.equal(outcome, 'open');
  } finally {
    server.close();
  }
});

test("WS /ws/jobs/:id reflects the impersonated group's access, not the connecting admin's own", async () => {
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const jobRunner = new JobRunner(jobStore, jobLog, ssh);
  const inventoryPath = seededInventoryPath();

  const id = jobRunner.enqueue({
    command: 'guest-power',
    category: 'maintenance',
    target: 'stash-lxc',
    argsJson: '{}',
    run: async () => {},
  });
  assert.equal(id, 1);
  savePermissionGroup(inventoryPath, 'bellhop-viewers', {
    mode: 'block-list',
    resources: [{ type: 'guest', name: 'stash-lxc' }],
  });

  const impersonationStore: ImpersonationStore = new Map([['admin', 'bellhop-viewers']]);
  const { server, port } = await startWsServer(jobRunner, jobStore, jobLog, inventoryPath, impersonationStore);
  try {
    // The real header identity is a plain admin (would normally bypass
    // every check via isAdmin), but the active impersonation entry
    // overrides that to 'bellhop-viewers', which is blocked from
    // this job's target -- the upgrade must be refused.
    const outcome = await connect(
      port,
      { 'x-authentik-username': 'admin', 'x-authentik-groups': 'bellhop-admins' },
      id
    );
    assert.equal(outcome, 'refused');
  } finally {
    server.close();
  }
});

// The prompt-detection spec (issue #160) commits to origin/matchedIndex
// being present on both the live WebSocket forward and the mid-prompt
// replay path -- these two tests are that commitment.

test('WS /ws/jobs/:id forwards a live prompt event carrying origin and matchedIndex', async () => {
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
  const ssh = new HangingSSHClient();
  let fireCheck: (() => void) | undefined;
  const jobRunner = new JobRunner(jobStore, jobLog, ssh, {
    promptScheduleCheck: (fn) => {
      fireCheck = fn;
      return { cancel: () => { fireCheck = undefined; } };
    },
  });
  const inventoryPath = seededInventoryPath();

  const id = jobRunner.enqueue({
    command: 'install-app',
    category: 'provisioning',
    argsJson: '{}',
    watchForPrompts: true,
    // HangingSSHClient emits 'Add Adminer? (y/N) ', which matches this hint
    // at tier 0 -- one fire, tagged 'expected' rather than 'heuristic'.
    expectedPrompts: ['Add Adminer?'],
    run: async (jobSsh) => {
      await jobSsh.exec({ host: 'pve1.local', user: 'root' }, 'bash install.sh');
    },
  });

  const { server, port } = await startWsServer(jobRunner, jobStore, jobLog, inventoryPath);
  try {
    const { ws, messages } = await connectCollectingMessages(
      port,
      { 'x-authentik-username': 'admin', 'x-authentik-groups': 'bellhop-admins' },
      id
    );

    await delay(10);
    fireCheck?.();

    await waitFor(() => messages.some((m) => m.type === 'prompt'));

    const promptMsg = messages.find((m) => m.type === 'prompt');
    assert.equal(promptMsg.text, 'Add Adminer? (y/N) ');
    assert.equal(promptMsg.origin, 'expected');
    assert.equal(promptMsg.matchedIndex, 0);
    assert.deepEqual(promptMsg.expectedPrompts, ['Add Adminer?']);

    ws.close();
    ssh.finish({ stdout: 'installed', stderr: '', code: 0 });
    await waitForFinished(jobStore, id);
  } finally {
    server.close();
  }
});

test("WS /ws/jobs/:id replays a mid-prompt job's origin and matchedIndex to a client connecting after the fact", async () => {
  const jobStore = new JobStore(':memory:');
  const dir = mkdtempSync(path.join(tmpdir(), 'jobs-'));
  const jobLog: JobLog = createJobLog(dir);
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const jobRunner = new JobRunner(jobStore, jobLog, ssh);
  const inventoryPath = seededInventoryPath();

  // No jobRunner.enqueue() at all -- the upgrade handler's replay branch
  // reads the row straight from JobStore, so a job left awaiting_input by a
  // prior process (or, here, just seeded directly) exercises exactly the
  // same code path.
  const id = jobStore.createJob({ command: 'install-app', category: 'provisioning', argsJson: '{}' });
  jobStore.markAwaitingInput(id, '   Enter the Cloudflare API token: ', 'expected', 0);

  const { server, port } = await startWsServer(jobRunner, jobStore, jobLog, inventoryPath);
  try {
    const { ws, messages } = await connectCollectingMessages(
      port,
      { 'x-authentik-username': 'admin', 'x-authentik-groups': 'bellhop-admins' },
      id
    );

    await waitFor(() => messages.some((m) => m.type === 'prompt'));

    const promptMsg = messages.find((m) => m.type === 'prompt');
    assert.equal(promptMsg.text, '   Enter the Cloudflare API token: ');
    assert.equal(promptMsg.origin, 'expected');
    assert.equal(promptMsg.matchedIndex, 0);

    ws.close();
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
    jobStore.close();
  }
});

test('POST /api/jobs/:id/answer writes the answer and resumes an awaiting_input job', async () => {
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
  const ssh = new HangingSSHClient();
  let fireCheck: (() => void) | undefined;
  const jobRunner = new JobRunner(jobStore, jobLog, ssh, {
    promptScheduleCheck: (fn) => {
      fireCheck = fn;
      return { cancel: () => { fireCheck = undefined; } };
    },
  });
  const app = buildApp({ inventory, baseSsh: ssh, jobStore, jobLog, jobRunner, inventoryPath: seededInventoryPath(), authentik: new FakeAuthentikClient() });

  const id = jobRunner.enqueue({
    command: 'install-app',
    category: 'provisioning',
    argsJson: '{}',
    watchForPrompts: true,
    run: async (jobSsh) => {
      await jobSsh.exec({ host: 'pve1.local', user: 'root' }, 'bash install.sh');
    },
  });

  await delay(10);
  // Two fires: tier 0 (expected hints only -- none are configured here)
  // finds nothing and arms tier 1, which is where the (y/N) heuristic
  // lives. See job-ssh-client.ts's tiers (this.tiers, a private instance field, not a module constant).
  fireCheck?.();
  fireCheck?.();
  assert.equal(jobStore.get(id)?.status, 'awaiting_input');

  const res = await request(app)
    .post(`/api/jobs/${id}/answer`)
    .set('x-authentik-username', 'admin')
    .set('x-authentik-groups', 'bellhop-admins')
    .send({ text: 'y' });
  assert.equal(res.status, 200);
  assert.equal(res.body.answered, true);
  assert.deepEqual(ssh.writes, ['y\n']);
  assert.equal(jobStore.get(id)?.status, 'running');

  ssh.finish({ stdout: 'installed', stderr: '', code: 0 });
  await waitForFinished(jobStore, id);
  assert.equal(jobStore.get(id)?.status, 'success');
});

test('POST /api/jobs/:id/answer 404s for an unknown id', async () => {
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const jobRunner = new JobRunner(jobStore, jobLog, ssh);
  const app = buildApp({ inventory, baseSsh: ssh, jobStore, jobLog, jobRunner, inventoryPath: seededInventoryPath(), authentik: new FakeAuthentikClient() });
  const res = await request(app).post('/api/jobs/999/answer').send({ text: 'y' });
  assert.equal(res.status, 404);
});

test('POST /api/jobs/:id/answer 409s for a job that is not awaiting input', async () => {
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
  const ssh = new FakeSSHClient(() => ({ stdout: 'done', stderr: '', code: 0 }));
  const jobRunner = new JobRunner(jobStore, jobLog, ssh);
  const app = buildApp({ inventory, baseSsh: ssh, jobStore, jobLog, jobRunner, inventoryPath: seededInventoryPath(), authentik: new FakeAuthentikClient() });
  const id = jobRunner.enqueue({
    command: 'update-all',
    category: 'maintenance',
    argsJson: '{}',
    run: async (s) => {
      await s.exec({ host: 'pve1.local', user: 'root' }, 'echo hi');
    },
  });
  await waitForFinished(jobStore, id);
  const res = await request(app)
    .post(`/api/jobs/${id}/answer`)
    .set('x-authentik-username', 'admin')
    .set('x-authentik-groups', 'bellhop-admins')
    .send({ text: 'y' });
  assert.equal(res.status, 409);
});

test('POST /api/jobs/:id/dismiss-prompt clears an awaiting_input job without writing to its exec channel', async () => {
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
  const ssh = new HangingSSHClient();
  let fireCheck: (() => void) | undefined;
  const jobRunner = new JobRunner(jobStore, jobLog, ssh, {
    promptScheduleCheck: (fn) => {
      fireCheck = fn;
      return { cancel: () => { fireCheck = undefined; } };
    },
  });
  const app = buildApp({ inventory, baseSsh: ssh, jobStore, jobLog, jobRunner, inventoryPath: seededInventoryPath(), authentik: new FakeAuthentikClient() });

  const id = jobRunner.enqueue({
    command: 'install-app',
    category: 'provisioning',
    argsJson: '{}',
    watchForPrompts: true,
    run: async (jobSsh) => {
      await jobSsh.exec({ host: 'pve1.local', user: 'root' }, 'bash install.sh');
    },
  });

  await delay(10);
  // Two fires: tier 0 (expected hints only -- none are configured here)
  // finds nothing and arms tier 1, which is where the (y/N) heuristic
  // lives. See job-ssh-client.ts's tiers (this.tiers, a private instance field, not a module constant).
  fireCheck?.();
  fireCheck?.();

  const res = await request(app)
    .post(`/api/jobs/${id}/dismiss-prompt`)
    .set('x-authentik-username', 'admin')
    .set('x-authentik-groups', 'bellhop-admins');
  assert.equal(res.status, 200);
  assert.equal(res.body.dismissed, true);
  assert.deepEqual(ssh.writes, []);
  assert.equal(jobStore.get(id)?.status, 'running');

  // Drain the job so it actually finishes (and settles the module-level
  // withCapturedConsole chain in src/web/console-capture.ts, shared across
  // every JobRunner in this process) -- otherwise this job stays "running"
  // forever and its unresolved run() promise permanently blocks every job
  // any later test in this file tries to run, matching the equivalent
  // cleanup in test/web/jobs/job-runner.test.ts's own dismissPrompt test.
  ssh.finish({ stdout: 'installed', stderr: '', code: 0 });
  await waitForFinished(jobStore, id);
});

test('POST /api/jobs/:id/dismiss-prompt 404s for an unknown id', async () => {
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const jobRunner = new JobRunner(jobStore, jobLog, ssh);
  const app = buildApp({ inventory, baseSsh: ssh, jobStore, jobLog, jobRunner, inventoryPath: seededInventoryPath(), authentik: new FakeAuthentikClient() });
  const res = await request(app).post('/api/jobs/999/dismiss-prompt');
  assert.equal(res.status, 404);
});

test('POST /api/jobs/:id/dismiss-prompt 409s for a job that is not awaiting input', async () => {
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
  const ssh = new FakeSSHClient(() => ({ stdout: 'done', stderr: '', code: 0 }));
  const jobRunner = new JobRunner(jobStore, jobLog, ssh);
  const app = buildApp({ inventory, baseSsh: ssh, jobStore, jobLog, jobRunner, inventoryPath: seededInventoryPath(), authentik: new FakeAuthentikClient() });
  const id = jobRunner.enqueue({
    command: 'update-all',
    category: 'maintenance',
    argsJson: '{}',
    run: async (s) => {
      await s.exec({ host: 'pve1.local', user: 'root' }, 'echo hi');
    },
  });
  await waitForFinished(jobStore, id);
  const res = await request(app)
    .post(`/api/jobs/${id}/dismiss-prompt`)
    .set('x-authentik-username', 'admin')
    .set('x-authentik-groups', 'bellhop-admins');
  assert.equal(res.status, 409);
});

test('GET /api/jobs omits jobs whose target a restricted group cannot access', async () => {
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const jobRunner = new JobRunner(jobStore, jobLog, ssh);
  const inventoryPath = seededInventoryPath();
  const app = buildApp({ inventory, baseSsh: ssh, jobStore, jobLog, jobRunner, inventoryPath, authentik: new FakeAuthentikClient() });

  jobRunner.enqueue({
    command: 'guest-power',
    category: 'maintenance',
    target: 'stash-lxc',
    argsJson: '{}',
    run: async () => {},
  });
  jobRunner.enqueue({
    command: 'guest-power',
    category: 'maintenance',
    target: 'plex-lxc',
    argsJson: '{}',
    run: async () => {},
  });

  await request(app)
    .put('/api/permissions/family')
    .set('x-authentik-username', 'admin')
    .set('x-authentik-groups', 'bellhop-admins')
    .send({ mode: 'block-list', resources: [{ type: 'guest', name: 'stash-lxc' }] });

  const res = await request(app)
    .get('/api/jobs')
    .set('x-authentik-username', 'kid')
    .set('x-authentik-groups', 'family');
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.body.map((j: any) => j.target),
    ['plex-lxc']
  );
});

test('GET /api/jobs omits untargeted (fleet-wide) jobs for a restricted group', async () => {
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const jobRunner = new JobRunner(jobStore, jobLog, ssh);
  const inventoryPath = seededInventoryPath();
  const app = buildApp({ inventory, baseSsh: ssh, jobStore, jobLog, jobRunner, inventoryPath, authentik: new FakeAuthentikClient() });

  jobRunner.enqueue({ command: 'sync-inventory', category: 'maintenance', argsJson: '{}', run: async () => {} });

  const res = await request(app)
    .get('/api/jobs')
    .set('x-authentik-username', 'kid')
    .set('x-authentik-groups', 'family');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, []);
});

test('GET /api/jobs/:id 404s (not 403) for a restricted group targeting a job it cannot see', async () => {
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const jobRunner = new JobRunner(jobStore, jobLog, ssh);
  const inventoryPath = seededInventoryPath();
  const app = buildApp({ inventory, baseSsh: ssh, jobStore, jobLog, jobRunner, inventoryPath, authentik: new FakeAuthentikClient() });

  const id = jobRunner.enqueue({
    command: 'guest-power',
    category: 'maintenance',
    target: 'stash-lxc',
    argsJson: '{}',
    run: async () => {},
  });
  await request(app)
    .put('/api/permissions/family')
    .set('x-authentik-username', 'admin')
    .set('x-authentik-groups', 'bellhop-admins')
    .send({ mode: 'block-list', resources: [{ type: 'guest', name: 'stash-lxc' }] });

  const res = await request(app)
    .get(`/api/jobs/${id}`)
    .set('x-authentik-username', 'kid')
    .set('x-authentik-groups', 'family');
  assert.equal(res.status, 404);
});

test('POST /api/jobs/:id/cancel 404s for a restricted group targeting a job it cannot see', async () => {
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const jobRunner = new JobRunner(jobStore, jobLog, ssh);
  const inventoryPath = seededInventoryPath();
  const app = buildApp({ inventory, baseSsh: ssh, jobStore, jobLog, jobRunner, inventoryPath, authentik: new FakeAuthentikClient() });

  const id = jobRunner.enqueue({ command: 'sync-inventory', category: 'maintenance', argsJson: '{}', run: async () => {} });

  const res = await request(app)
    .post(`/api/jobs/${id}/cancel`)
    .set('x-authentik-username', 'kid')
    .set('x-authentik-groups', 'family');
  assert.equal(res.status, 404);
});

test('GET /api/jobs shows only jobs whose target is on an allow-list group\'s resource list', async () => {
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const jobRunner = new JobRunner(jobStore, jobLog, ssh);
  const inventoryPath = seededInventoryPath();
  const app = buildApp({ inventory, baseSsh: ssh, jobStore, jobLog, jobRunner, inventoryPath, authentik: new FakeAuthentikClient() });

  jobRunner.enqueue({
    command: 'guest-power',
    category: 'maintenance',
    target: 'plex-lxc',
    argsJson: '{}',
    run: async () => {},
  });
  jobRunner.enqueue({
    command: 'guest-power',
    category: 'maintenance',
    target: 'stash-lxc',
    argsJson: '{}',
    run: async () => {},
  });

  await request(app)
    .put('/api/permissions/family')
    .set('x-authentik-username', 'admin')
    .set('x-authentik-groups', 'bellhop-admins')
    .send({ mode: 'allow-list', resources: [{ type: 'guest', name: 'plex-lxc' }] });

  const res = await request(app)
    .get('/api/jobs')
    .set('x-authentik-username', 'kid')
    .set('x-authentik-groups', 'family');
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.body.map((j: any) => j.target),
    ['plex-lxc']
  );
});

test('GET /api/jobs/:id exposes the prompt origin and matched index for an awaiting_input job', async () => {
  const jobStore = new JobStore(':memory:');
  const dir = mkdtempSync(path.join(tmpdir(), 'jobs-'));
  const jobLog: JobLog = createJobLog(dir);
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const jobRunner = new JobRunner(jobStore, jobLog, ssh);
  const app = buildApp({
    inventory,
    baseSsh: ssh,
    jobStore,
    jobLog,
    jobRunner,
    inventoryPath: seededInventoryPath(),
    authentik: new FakeAuthentikClient(),
  });

  const id = jobStore.createJob({ command: 'install-app', category: 'provisioning', argsJson: '{}' });
  jobStore.markAwaitingInput(id, '   Enter the Cloudflare API token: ', 'expected', 0);

  const res = await request(app)
    .get(`/api/jobs/${id}`)
    .set('x-authentik-username', 'admin')
    .set('x-authentik-groups', 'bellhop-admins');

  assert.equal(res.status, 200);
  assert.equal(res.body.job.promptOrigin, 'expected');
  assert.equal(res.body.job.promptMatchedIndex, 0);

  rmSync(dir, { recursive: true, force: true });
  jobStore.close();
});

// Issue #6 (US1): a job owned by another process (an MCP server) still
// streams live over this process's WebSocket -- it just can't come from
// jobRunner.events (those never fire for a job this process didn't start).
// attachJobsWebSocket instead runs a foreign-job tailer (job-tail.ts) that
// polls the shared job row and log file on a short interval. The rows are
// seeded directly rather than run through a real JobRunner/FakeSSHClient job
// (see G4-brief.md): a paused job's 15-minute abandon timer belongs to
// whichever JobRunner owns it, and this job is deliberately owned by
// 'mcp:4242', not this test's own jobRunner.
test('WS /ws/jobs/:id streams a job owned by another process via polling, not jobRunner.events', async () => {
  const jobStore = new JobStore(':memory:');
  const dir = mkdtempSync(path.join(tmpdir(), 'jobs-'));
  const jobLog: JobLog = createJobLog(dir);
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const jobRunner = new JobRunner(jobStore, jobLog, ssh);
  const inventoryPath = seededInventoryPath();

  const id = jobStore.createJob({ command: 'update-all', category: 'maintenance', argsJson: '{}', owner: 'mcp:4242' });
  jobLog.append(jobStore.get(id)!.logFile, 'starting\n');
  jobStore.markRunning(id);

  const { server, port } = await startWsServer(jobRunner, jobStore, jobLog, inventoryPath, new Map(), { tailIntervalMs: 20, isPidAlive: () => true });
  try {
    const { ws, messages } = await connectCollectingMessages(
      port,
      { 'x-authentik-username': 'admin', 'x-authentik-groups': 'bellhop-admins' },
      id
    );

    await waitFor(() => messages.some((m) => m.type === 'backlog'));
    assert.equal(messages.find((m) => m.type === 'backlog').text, 'starting\n');
    assert.ok(messages.some((m) => m.type === 'status' && m.status === 'running'));

    jobLog.append(jobStore.get(id)!.logFile, 'more output\n');
    jobStore.markAwaitingInput(id, 'Continue? (y/N) ', 'heuristic', null);
    await waitFor(() => messages.some((m) => m.type === 'prompt'));
    assert.ok(messages.some((m) => m.type === 'chunk' && m.text === 'more output\n'));
    const prompt = messages.find((m) => m.type === 'prompt');
    assert.equal(prompt.text, 'Continue? (y/N) ');
    assert.equal(prompt.origin, 'heuristic');

    jobStore.markRunning(id);
    await waitFor(() => messages.some((m) => m.type === 'prompt-cleared'));

    jobStore.markFinished(id, { status: 'success', exitCode: 0 });
    await waitFor(() => messages.some((m) => m.type === 'status' && m.status === 'success'));

    // jobRunner never touched this job at all -- it was never enqueued
    // through it, so there is nothing in jobRunner.events for this test to
    // have relied on; the assertions above are only satisfiable through the
    // polling tail.
    ws.close();
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
    jobStore.close();
  }
});

test('WS /ws/jobs/:id still refuses a foreign job a restricted group cannot see', async () => {
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const jobRunner = new JobRunner(jobStore, jobLog, ssh);
  const inventoryPath = seededInventoryPath();

  const id = jobStore.createJob({
    command: 'guest-power',
    category: 'maintenance',
    target: 'stash-lxc',
    argsJson: '{}',
    owner: 'mcp:4242',
  });
  jobStore.markRunning(id);
  savePermissionGroup(inventoryPath, 'family', { mode: 'block-list', resources: [{ type: 'guest', name: 'stash-lxc' }] });

  const { server, port } = await startWsServer(jobRunner, jobStore, jobLog, inventoryPath, new Map(), { tailIntervalMs: 20, isPidAlive: () => true });
  try {
    const outcome = await connect(port, { 'x-authentik-username': 'kid', 'x-authentik-groups': 'family' }, id);
    assert.equal(outcome, 'refused');
  } finally {
    server.close();
  }
});

// Fix wave (M2): the foreign-job tailer's setInterval used to clearInterval
// on a stopped tail but leave the socket itself open. The client's own
// useJobStream only falls back to HTTP polling on the socket's 'close'/
// 'error' event, so a tail that stopped for a non-terminal reason (a
// throwing tick, a vanished row) left the client stuck watching a socket
// that would never send anything again. Both cases -- and the ordinary
// terminal-status case -- must now close the socket once the tail stops.
test('WS /ws/jobs/:id closes the socket when the foreign job tail stops from a throwing tick', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jobstore-'));
  const dbPath = path.join(dir, 'jobs.sqlite3');
  const jobStore = new JobStore(dbPath);
  const logDir = mkdtempSync(path.join(tmpdir(), 'joblog-'));
  const jobLog = createJobLog(logDir);
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const jobRunner = new JobRunner(jobStore, jobLog, ssh);
  const inventoryPath = seededInventoryPath();

  const id = jobStore.createJob({ command: 'update-all', category: 'maintenance', argsJson: '{}', owner: 'mcp:4242' });
  jobLog.append(jobStore.get(id)!.logFile, 'starting\n');
  jobStore.markRunning(id);

  const { server, port } = await startWsServer(jobRunner, jobStore, jobLog, inventoryPath, new Map(), { tailIntervalMs: 20, isPidAlive: () => true });
  try {
    const { ws, messages } = await connectCollectingMessages(
      port,
      { 'x-authentik-username': 'admin', 'x-authentik-groups': 'bellhop-admins' },
      id
    );
    await waitFor(() => messages.some((m) => m.type === 'status' && m.status === 'running'));

    // Directly corrupt expected_prompts_json (not writable through any
    // JobStore method -- createJob is the only place it's ever set) via a
    // second connection to the same file, then flip the row into
    // awaiting_input in the same statement so the tail's next tick sees a
    // genuine prompt-state change and actually attempts to JSON.parse the
    // corrupted column, throwing inside tick()'s try/catch.
    const raw = new Database(dbPath);
    raw
      .prepare(
        `UPDATE jobs SET status = 'awaiting_input', prompt_text = ?, prompt_origin = ?, prompt_matched_index = NULL, expected_prompts_json = ? WHERE id = ?`
      )
      .run('Continue? (y/N) ', 'heuristic', 'not valid json', id);
    raw.close();

    // The tail's throwing tick sets stopped = true; the interval callback
    // must then close the socket rather than leaving it open forever.
    await waitFor(() => ws.readyState === WebSocket.CLOSED);
  } finally {
    server.close();
    jobStore.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(logDir, { recursive: true, force: true });
  }
});

test('WS /ws/jobs/:id closes the socket after a foreign job reaches a terminal status', async () => {
  const jobStore = new JobStore(':memory:');
  const dir = mkdtempSync(path.join(tmpdir(), 'jobs-'));
  const jobLog: JobLog = createJobLog(dir);
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const jobRunner = new JobRunner(jobStore, jobLog, ssh);
  const inventoryPath = seededInventoryPath();

  const id = jobStore.createJob({ command: 'update-all', category: 'maintenance', argsJson: '{}', owner: 'mcp:4242' });
  jobLog.append(jobStore.get(id)!.logFile, 'starting\n');
  jobStore.markRunning(id);

  const { server, port } = await startWsServer(jobRunner, jobStore, jobLog, inventoryPath, new Map(), { tailIntervalMs: 20, isPidAlive: () => true });
  try {
    const { ws, messages } = await connectCollectingMessages(
      port,
      { 'x-authentik-username': 'admin', 'x-authentik-groups': 'bellhop-admins' },
      id
    );
    await waitFor(() => messages.some((m) => m.type === 'status' && m.status === 'running'));

    jobStore.markFinished(id, { status: 'success', exitCode: 0 });
    await waitFor(() => messages.some((m) => m.type === 'status' && m.status === 'success'));

    await waitFor(() => ws.readyState === WebSocket.CLOSED);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
    jobStore.close();
  }
});

// Fix wave (this file's dead-owner counterpart to job-tail.test.ts's own
// unit-level coverage): the foreign-job tailer must also stop -- and this
// socket must close -- once the owning MCP process has crashed, rather than
// polling a stuck row forever. isPidAlive: () => false stands in for a real
// dead pid so this is deterministic.
test("WS /ws/jobs/:id closes the socket once the foreign job's owning MCP process has died", async () => {
  const jobStore = new JobStore(':memory:');
  const dir = mkdtempSync(path.join(tmpdir(), 'jobs-'));
  const jobLog: JobLog = createJobLog(dir);
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const jobRunner = new JobRunner(jobStore, jobLog, ssh);
  const inventoryPath = seededInventoryPath();

  const id = jobStore.createJob({ command: 'update-all', category: 'maintenance', argsJson: '{}', owner: 'mcp:4242' });
  jobLog.append(jobStore.get(id)!.logFile, 'starting\n');
  jobStore.markRunning(id);

  const { server, port } = await startWsServer(jobRunner, jobStore, jobLog, inventoryPath, new Map(), { tailIntervalMs: 20, isPidAlive: () => false });
  try {
    const { ws, messages } = await connectCollectingMessages(
      port,
      { 'x-authentik-username': 'admin', 'x-authentik-groups': 'bellhop-admins' },
      id
    );

    await waitFor(() => ws.readyState === WebSocket.CLOSED);

    // The row itself was never touched (FR-004) -- still 'running', not
    // flipped to some invented terminal status, and no 'status' message
    // beyond the initial backlog-time one was ever sent for it.
    assert.equal(jobStore.get(id)!.status, 'running');
    assert.deepEqual(
      messages.filter((m) => m.type === 'status'),
      [{ type: 'status', status: 'running' }]
    );
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
    jobStore.close();
  }
});

// Issue #6 (US2): a job owned by another live process is no longer a flat
// 409 "control it from there" -- the requester writes a control-request row
// the owning process polls for and applies asynchronously through its own
// JobRunner methods (requestJobControl, research.md R3). The route itself
// can't tell whether that async apply will actually succeed (it never
// touches the job), so it only ever previews the *synchronous* refusal
// cases requestJobControl decides up front: a dead-pid owner, or a job
// whose current status rules the action out entirely.
for (const action of ['cancel', 'answer', 'dismiss-prompt'] as const) {
  const controlAction = action === 'dismiss-prompt' ? 'dismiss' : action;

  test(`POST /api/jobs/:id/${action} 202s and records a control request for a job owned by another live process`, async () => {
    const jobStore = new JobStore(':memory:');
    const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
    const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
    const jobRunner = new JobRunner(jobStore, jobLog, ssh);
    const app = buildApp({ inventory, baseSsh: ssh, jobStore, jobLog, jobRunner, inventoryPath: seededInventoryPath(), authentik: new FakeAuthentikClient() });

    const owner = `mcp:${process.pid}`;
    const id = jobStore.createJob({ command: 'update-all', category: 'maintenance', argsJson: '{}', owner });
    if (action === 'cancel') jobStore.markRunning(id);
    else jobStore.markAwaitingInput(id, 'Continue? (y/N) ', 'heuristic', null);

    const res = await request(app)
      .post(`/api/jobs/${id}/${action}`)
      .send({ text: 'y' })
      .set('x-authentik-username', 'admin')
      .set('x-authentik-groups', 'bellhop-admins');

    assert.equal(res.status, 202);
    assert.deepEqual(res.body, { requested: true, owner });

    const pending = jobStore.pendingControlRequests(owner);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].jobId, id);
    assert.equal(pending[0].action, controlAction);
    assert.equal(pending[0].requestedByOwner, 'web');
    assert.equal(pending[0].requestedByUsername, 'admin');
  });

  test(`POST /api/jobs/:id/${action} 409s naming the exited owner for a job owned by a dead process`, async () => {
    const jobStore = new JobStore(':memory:');
    const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
    const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
    const jobRunner = new JobRunner(jobStore, jobLog, ssh);
    const app = buildApp({ inventory, baseSsh: ssh, jobStore, jobLog, jobRunner, inventoryPath: seededInventoryPath(), authentik: new FakeAuthentikClient() });

    const deadPid = 2147483646;
    assert.equal(defaultIsPidAlive(deadPid), false, 'test assumes this pid is not a real running process');
    const owner = `mcp:${deadPid}`;
    const id = jobStore.createJob({ command: 'update-all', category: 'maintenance', argsJson: '{}', owner });
    if (action === 'cancel') jobStore.markRunning(id);
    else jobStore.markAwaitingInput(id, 'Continue? (y/N) ', 'heuristic', null);

    const res = await request(app)
      .post(`/api/jobs/${id}/${action}`)
      .send({ text: 'y' })
      .set('x-authentik-username', 'admin')
      .set('x-authentik-groups', 'bellhop-admins');

    assert.equal(res.status, 409);
    assert.equal(res.body.error, `job ${id}'s owning process ${owner} has exited`);
    assert.deepEqual(jobStore.pendingControlRequests(owner), []);
  });
}

test('POST /api/jobs/:id/cancel 409s "nothing to cancel" for a terminal job owned by another live process', async () => {
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const jobRunner = new JobRunner(jobStore, jobLog, ssh);
  const app = buildApp({ inventory, baseSsh: ssh, jobStore, jobLog, jobRunner, inventoryPath: seededInventoryPath(), authentik: new FakeAuthentikClient() });

  const owner = `mcp:${process.pid}`;
  const id = jobStore.createJob({ command: 'update-all', category: 'maintenance', argsJson: '{}', owner });
  jobStore.markFinished(id, { status: 'success', exitCode: 0 });

  const res = await request(app)
    .post(`/api/jobs/${id}/cancel`)
    .set('x-authentik-username', 'admin')
    .set('x-authentik-groups', 'bellhop-admins');

  assert.equal(res.status, 409);
  assert.equal(res.body.error, `Job ${id} is already success — nothing to cancel`);
  assert.deepEqual(jobStore.pendingControlRequests(owner), []);
});

for (const action of ['answer', 'dismiss-prompt'] as const) {
  const verb = action === 'dismiss-prompt' ? 'dismiss' : 'answer';

  test(`POST /api/jobs/:id/${action} 409s "nothing to ${verb}" for a running (not awaiting-input) job owned by another live process`, async () => {
    const jobStore = new JobStore(':memory:');
    const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
    const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
    const jobRunner = new JobRunner(jobStore, jobLog, ssh);
    const app = buildApp({ inventory, baseSsh: ssh, jobStore, jobLog, jobRunner, inventoryPath: seededInventoryPath(), authentik: new FakeAuthentikClient() });

    const owner = `mcp:${process.pid}`;
    const id = jobStore.createJob({ command: 'update-all', category: 'maintenance', argsJson: '{}', owner });
    jobStore.markRunning(id);

    const res = await request(app)
      .post(`/api/jobs/${id}/${action}`)
      .send({ text: 'y' })
      .set('x-authentik-username', 'admin')
      .set('x-authentik-groups', 'bellhop-admins');

    assert.equal(res.status, 409);
    assert.equal(res.body.error, `Job ${id} is not awaiting input — nothing to ${verb}`);
    assert.deepEqual(jobStore.pendingControlRequests(owner), []);
  });
}

// End-to-end (T013): a second JobRunner standing in for a real MCP server
// process, sharing this JobStore/JobLog. The web app's cancel route can't
// touch this job directly (different owner) -- it only writes a control
// request; the owning runner's own processControlRequests() is what
// actually cancels it and appends the attribution line, exactly as it
// would on its own poll timer.
test('POST /api/jobs/:id/cancel on a job owned by a second JobRunner ends it cancelled once that runner polls', async () => {
  const jobStore = new JobStore(':memory:');
  const dir = mkdtempSync(path.join(tmpdir(), 'joblog-'));
  const jobLog = createJobLog(dir);
  const webSsh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const webRunner = new JobRunner(jobStore, jobLog, webSsh);
  const app = buildApp({
    inventory,
    baseSsh: webSsh,
    jobStore,
    jobLog,
    jobRunner: webRunner,
    inventoryPath: seededInventoryPath(),
    authentik: new FakeAuthentikClient(),
  });

  const owner = `mcp:${process.pid}`;
  const mcpSsh = new HangingSSHClient();
  const secondRunner = new JobRunner(jobStore, jobLog, mcpSsh, { owner });

  const id = secondRunner.enqueue({
    command: 'update-all',
    category: 'maintenance',
    argsJson: '{}',
    run: async (s) => {
      await s.exec({ host: 'pve1.local', user: 'root' }, 'apt-get update');
    },
  });

  await waitFor(() => jobStore.get(id)?.status === 'running');

  const res = await request(app)
    .post(`/api/jobs/${id}/cancel`)
    .set('x-authentik-username', 'admin')
    .set('x-authentik-groups', 'bellhop-admins');

  assert.equal(res.status, 202);
  assert.deepEqual(res.body, { requested: true, owner });

  secondRunner.processControlRequests();

  await waitFor(() => jobStore.get(id)?.status === 'cancelled');
  assert.match(jobLog.read(jobStore.get(id)!.logFile), /Stop requested from web UI by admin/);

  rmSync(dir, { recursive: true, force: true });
  jobStore.close();
});

// completeUtf8Length (T, fix wave): a log file another process is actively
// appending to can be read mid-write, so a byte chunk handed to the backlog
// send can end with a torn multi-byte UTF-8 character. This is the table of
// cases the function's own comment promises to handle.
test('completeUtf8Length excludes only a torn trailing multi-byte character, never a complete one', () => {
  const euroComplete = Buffer.from('ab€'); // 'ab' + complete 3-byte €
  const euroTorn2of3 = euroComplete.subarray(0, euroComplete.length - 1); // 'ab' + first 2 of €'s 3 bytes
  const euroTorn1of3 = euroComplete.subarray(0, euroComplete.length - 2); // 'ab' + first 1 of €'s 3 bytes
  const emoji4byte = Buffer.from('ab\u{1f600}', 'utf8'); // 'ab' + complete 4-byte emoji
  const emojiTorn1of4 = Buffer.concat([Buffer.from('ab'), emoji4byte.subarray(2, 3)]); // 'ab' + emoji's first byte only
  const allContinuation = Buffer.from([0x80, 0x81, 0x82]); // no lead byte at all

  const cases: { name: string; buffer: Buffer; expected: number }[] = [
    { name: 'empty buffer', buffer: Buffer.alloc(0), expected: 0 },
    { name: 'plain ASCII ending', buffer: Buffer.from('hello'), expected: 5 },
    { name: 'complete 3-byte character (€) ending', buffer: euroComplete, expected: euroComplete.length },
    // Torn 2-of-3 bytes of €: the lead byte and one continuation byte
    // are present but the sequence is incomplete, so both are excluded --
    // the returned length stops right before the lead byte ('ab'.length).
    { name: 'torn 2-of-3 bytes of € excludes both torn bytes', buffer: euroTorn2of3, expected: 2 },
    // Torn 1-of-3 bytes: only the lead byte is present, no continuation
    // bytes at all -- still excluded the same way.
    { name: 'torn 1-of-3 bytes of € (lead byte only) excludes it', buffer: euroTorn1of3, expected: 2 },
    { name: 'complete 4-byte emoji ending', buffer: emoji4byte, expected: emoji4byte.length },
    // Torn 1-of-4 bytes of a 4-byte emoji: just its first (lead) byte,
    // with no continuation bytes following -- excluded the same way.
    { name: "torn 1-of-4 bytes of a 4-byte emoji (lead byte only) excludes it", buffer: emojiTorn1of4, expected: 2 },
    // All-continuation-bytes buffer: the backward scan never finds a lead
    // byte, so i goes negative and the function returns 0 -- as implemented,
    // this treats the whole buffer as incomplete rather than throwing or
    // returning some partial length.
    { name: 'buffer of only continuation bytes returns 0', buffer: allContinuation, expected: 0 },
  ];

  for (const { name, buffer, expected } of cases) {
    assert.equal(completeUtf8Length(buffer), expected, name);
  }
});

// issue #58 (US1): a job whose target is a guest the caller created is
// visible and controllable under an allow-list group that doesn't list it.
// app-users names only host pve1; web-lxc was created by test-user.
const creatorInventory: Inventory = {
  domain: 'example.com',
  hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
  guests: [{ name: 'web-lxc', type: 'lxc', vmid: 4005, host: 'pve1', creator: { uid: 'uid-test-user', username: 'test-user' } }],
};

function creatorFixture(impersonationStore: ImpersonationStore = new Map()) {
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const jobRunner = new JobRunner(jobStore, jobLog, ssh);
  const inventoryPath = path.join(mkdtempSync(path.join(tmpdir(), 'inventory-')), 'bellhop.db');
  saveInventory(inventoryPath, creatorInventory);
  savePermissionGroup(inventoryPath, 'app-users', { mode: 'allow-list', resources: [{ type: 'host', name: 'pve1' }] });
  // A fresh copy: buildApp's /api reload mutates this object in place.
  const inv: Inventory = structuredClone(creatorInventory);
  const app = buildApp({
    inventory: inv,
    baseSsh: ssh,
    jobStore,
    jobLog,
    jobRunner,
    inventoryPath,
    authentik: new FakeAuthentikClient(),
    impersonationStore,
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const id = jobRunner.enqueue({
    command: 'guest-power',
    category: 'maintenance',
    target: 'web-lxc',
    argsJson: '{}',
    run: async () => {
      await gate;
    },
  });
  const settle = async () => {
    release();
    await waitFor(() => ['success', 'failed', 'cancelled'].includes(jobStore.get(id)?.status ?? ''));
  };
  return { app, jobStore, jobLog, jobRunner, inventoryPath, inv, id, settle };
}

function asUser(req: request.Test, username: string, groups: string, uid?: string): request.Test {
  req = req.set('x-authentik-username', username).set('x-authentik-groups', groups);
  return uid ? req.set('x-authentik-uid', uid) : req;
}

test('jobs: a job targeting a guest the caller created is listed, readable, and controllable under an allow-list that omits it', async () => {
  const { app, id, settle } = creatorFixture();
  try {
    const list = await asUser(request(app).get('/api/jobs'), 'test-user', 'app-users', 'uid-test-user');
    assert.deepEqual(list.body.map((j: any) => j.id), [id]);

    const detail = await asUser(request(app).get(`/api/jobs/${id}`), 'test-user', 'app-users', 'uid-test-user');
    assert.equal(detail.status, 200);

    // Not awaiting input, so answer/dismiss are refused on their merits
    // (409) -- the point is that they are not hidden (404).
    const answer = await asUser(request(app).post(`/api/jobs/${id}/answer`), 'test-user', 'app-users', 'uid-test-user').send({ text: 'y' });
    assert.equal(answer.status, 409);
    const dismiss = await asUser(request(app).post(`/api/jobs/${id}/dismiss-prompt`), 'test-user', 'app-users', 'uid-test-user');
    assert.equal(dismiss.status, 409);

    const cancel = await asUser(request(app).post(`/api/jobs/${id}/cancel`), 'test-user', 'app-users', 'uid-test-user');
    assert.equal(cancel.status, 200);
  } finally {
    await settle();
  }
});

test('jobs: a job targeting a guest someone else created is hidden from another user in the same group', async () => {
  const { app, jobStore, id, settle } = creatorFixture();
  try {
    const list = await asUser(request(app).get('/api/jobs'), 'other-user', 'app-users', 'uid-other-user');
    assert.deepEqual(list.body, []);
    for (const [method, url] of [
      ['get', `/api/jobs/${id}`],
      ['post', `/api/jobs/${id}/cancel`],
      ['post', `/api/jobs/${id}/answer`],
      ['post', `/api/jobs/${id}/dismiss-prompt`],
    ] as const) {
      const res = await asUser(request(app)[method](url), 'other-user', 'app-users', 'uid-other-user');
      assert.equal(res.status, 404, `${method} ${url}`);
    }
    assert.notEqual(jobStore.get(id)?.status, 'cancelled');
  } finally {
    await settle();
  }
});

test('jobs: an admin who created the guest and is impersonating app-users does not see its job', async () => {
  const { app, id, settle } = creatorFixture(new Map([['test-user', 'app-users']]));
  try {
    const list = await asUser(request(app).get('/api/jobs'), 'test-user', 'bellhop-admins', 'uid-test-user');
    assert.deepEqual(list.body, []);
    const detail = await asUser(request(app).get(`/api/jobs/${id}`), 'test-user', 'bellhop-admins', 'uid-test-user');
    assert.equal(detail.status, 404);
  } finally {
    await settle();
  }
});

test('WS /ws/jobs/:id accepts the creator of the target guest and refuses another user in the same group', async () => {
  const { jobStore, jobLog, jobRunner, inventoryPath, inv, id, settle } = creatorFixture();
  const { server, port } = await startWsServer(jobRunner, jobStore, jobLog, inventoryPath, new Map(), undefined, inv);
  try {
    const creator = await connect(
      port,
      { 'x-authentik-username': 'test-user', 'x-authentik-groups': 'app-users', 'x-authentik-uid': 'uid-test-user' },
      id
    );
    assert.equal(creator, 'open');
    const other = await connect(
      port,
      { 'x-authentik-username': 'other-user', 'x-authentik-groups': 'app-users', 'x-authentik-uid': 'uid-other-user' },
      id
    );
    assert.equal(other, 'refused');
  } finally {
    server.close();
    await settle();
  }
});

test('WS /ws/jobs/:id refuses an admin creator who is impersonating app-users', async () => {
  const impersonationStore: ImpersonationStore = new Map([['test-user', 'app-users']]);
  const { jobStore, jobLog, jobRunner, inventoryPath, inv, id, settle } = creatorFixture(impersonationStore);
  const { server, port } = await startWsServer(jobRunner, jobStore, jobLog, inventoryPath, impersonationStore, undefined, inv);
  try {
    const outcome = await connect(
      port,
      { 'x-authentik-username': 'test-user', 'x-authentik-groups': 'bellhop-admins', 'x-authentik-uid': 'uid-test-user' },
      id
    );
    assert.equal(outcome, 'refused');
  } finally {
    server.close();
    await settle();
  }
});
