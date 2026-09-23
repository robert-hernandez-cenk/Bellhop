import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { buildApp } from '../../../src/web/app.ts';
import { JobStore } from '../../../src/web/jobs/job-store.ts';
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
import { attachJobsWebSocket } from '../../../src/web/routes/jobs.ts';
import { savePermissionGroup } from '../../../src/lib/permissions.ts';
import type { ImpersonationStore } from '../../../src/web/impersonation.ts';

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
  impersonationStore: ImpersonationStore = new Map()
): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer();
  attachJobsWebSocket(server, jobRunner, jobStore, jobLog, inventoryPath, impersonationStore);
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

// Issue #16: a job owned by another process (an MCP server) can't be
// controlled from this web process's JobRunner -- say so, instead of the
// misleading "already running — nothing to cancel".
for (const action of ['cancel', 'answer', 'dismiss-prompt'] as const) {
  test(`POST /api/jobs/:id/${action} 409s naming the owner for a job owned by another process`, async () => {
    const jobStore = new JobStore(':memory:');
    const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
    const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
    const jobRunner = new JobRunner(jobStore, jobLog, ssh);
    const app = buildApp({ inventory, baseSsh: ssh, jobStore, jobLog, jobRunner, inventoryPath: seededInventoryPath(), authentik: new FakeAuthentikClient() });

    const id = jobStore.createJob({ command: 'update-all', category: 'maintenance', argsJson: '{}', owner: 'mcp:123' });

    const res = await request(app)
      .post(`/api/jobs/${id}/${action}`)
      .send({ text: 'y' })
      .set('x-authentik-username', 'admin')
      .set('x-authentik-groups', 'bellhop-admins');
    assert.equal(res.status, 409);
    assert.equal(res.body.error, `job ${id} is owned by mcp:123; control it from there`);
  });
}
