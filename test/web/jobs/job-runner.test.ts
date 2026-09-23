import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JobStore } from '../../../src/web/jobs/job-store.ts';
import { createJobLog } from '../../../src/web/jobs/job-log.ts';
import { JobRunner } from '../../../src/web/jobs/job-runner.ts';
import { FakeSSHClient } from '../../support/fake-ssh-client.ts';
import { HangingSSHClient } from '../../support/hanging-ssh-client.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { logInfo } from '../../../src/lib/log.ts';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeRunner() {
  const store = new JobStore(':memory:');
  const dir = mkdtempSync(path.join(tmpdir(), 'jobrunner-'));
  const log = createJobLog(dir);
  const ssh = new FakeSSHClient(() => ({ stdout: 'remote output', stderr: '', code: 0 }));
  const runner = new JobRunner(store, log, ssh);
  return { store, log, dir, runner };
}

function waitForFinished(runner: JobRunner, id: number): Promise<void> {
  return new Promise((resolve) => {
    runner.events.on('status', function handler(payload: any) {
      if (payload.jobId === id && payload.status !== 'running') {
        runner.events.off('status', handler);
        resolve();
      }
    });
  });
}

test('enqueue runs the job, marks it success, and captures remote + console output', async () => {
  const { store, log, dir, runner } = makeRunner();
  const events: Array<{ type: string; payload: any }> = [];
  runner.events.on('status', (payload) => events.push({ type: 'status', payload }));
  runner.events.on('chunk', (payload) => events.push({ type: 'chunk', payload }));

  const id = runner.enqueue({
    command: 'update-all',
    category: 'maintenance',
    argsJson: '{}',
    run: async (ssh) => {
      logInfo('Updating pve1...');
      await ssh.exec({ host: 'pve1.local', user: 'root' }, 'apt-get update');
    },
  });

  await waitForFinished(runner, id);

  const row = store.get(id)!;
  assert.equal(row.status, 'success');
  assert.equal(row.exitCode, 0);
  assert.match(log.read(row.logFile), /remote output/);
  assert.match(log.read(row.logFile), /Updating pve1/);
  assert.ok(events.some((e) => e.type === 'chunk' && e.payload.text.includes('remote output')));
  rmSync(dir, { recursive: true, force: true });
  store.close();
});

test('enqueue forwards triggeredByUsername/triggeredByImpersonating through to the store', async () => {
  const { store, dir, runner } = makeRunner();
  const id = runner.enqueue({
    command: 'guest-power',
    category: 'maintenance',
    argsJson: '{}',
    triggeredByUsername: 'admin',
    triggeredByImpersonating: 'bellhop-viewers',
    run: async () => {},
  });
  await waitForFinished(runner, id);
  const row = store.get(id);
  assert.equal(row?.triggeredByUsername, 'admin');
  assert.equal(row?.triggeredByImpersonating, 'bellhop-viewers');
  rmSync(dir, { recursive: true, force: true });
  store.close();
});

test('enqueue marks the job failed and records the thrown error message', async () => {
  const { store, dir, runner } = makeRunner();
  const id = runner.enqueue({
    command: 'create-lxc',
    category: 'provisioning',
    argsJson: '{}',
    run: async () => {
      throw new Error('resolveMid blew up');
    },
  });

  await waitForFinished(runner, id);

  const row = store.get(id)!;
  assert.equal(row.status, 'failed');
  assert.equal(row.errorMessage, 'resolveMid blew up');
  rmSync(dir, { recursive: true, force: true });
  store.close();
});

test('cancel() aborts a running job: its next ssh.exec call rejects and the job is marked cancelled', async () => {
  const { store, dir, runner } = makeRunner();
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const id = runner.enqueue({
    command: 'update-all',
    category: 'maintenance',
    argsJson: '{}',
    run: async (ssh) => {
      await delay(20);
      await ssh.exec({ host: 'pve1.local', user: 'root' }, 'apt-get update');
    },
  });

  await delay(5);
  assert.equal(runner.cancel(id), true);
  await waitForFinished(runner, id);

  const row = store.get(id)!;
  assert.equal(row.status, 'cancelled');
  rmSync(dir, { recursive: true, force: true });
  store.close();
});

test('cancel() skips a job that is still waiting its turn behind another running job', async () => {
  const { store, dir, runner } = makeRunner();
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  let secondRan = false;

  const firstId = runner.enqueue({
    command: 'a',
    category: 'maintenance',
    argsJson: '{}',
    run: async () => {
      await delay(30);
    },
  });
  const secondId = runner.enqueue({
    command: 'b',
    category: 'maintenance',
    argsJson: '{}',
    run: async () => {
      secondRan = true;
    },
  });

  assert.equal(runner.cancel(secondId), true);
  await waitForFinished(runner, firstId);
  await waitForFinished(runner, secondId);

  assert.equal(store.get(secondId)?.status, 'cancelled');
  assert.equal(secondRan, false);
  rmSync(dir, { recursive: true, force: true });
  store.close();
});

test('cancel() returns false for an unknown job id and for one that already finished', async () => {
  const { store, dir, runner } = makeRunner();
  assert.equal(runner.cancel(999), false);

  const id = runner.enqueue({
    command: 'a',
    category: 'maintenance',
    argsJson: '{}',
    run: async () => {},
  });
  await waitForFinished(runner, id);
  assert.equal(runner.cancel(id), false);

  rmSync(dir, { recursive: true, force: true });
  store.close();
});

test('a second enqueue while one job is running is queued, not run concurrently', async () => {
  const { store, dir, runner } = makeRunner();
  let firstStarted = false;
  let secondStartedBeforeFirstFinished = false;
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const firstId = runner.enqueue({
    command: 'a',
    category: 'maintenance',
    argsJson: '{}',
    run: async () => {
      firstStarted = true;
      await delay(30);
    },
  });
  const secondId = runner.enqueue({
    command: 'b',
    category: 'maintenance',
    argsJson: '{}',
    run: async () => {
      if (firstStarted && store.get(firstId)?.status !== 'success') secondStartedBeforeFirstFinished = true;
    },
  });

  await waitForFinished(runner, secondId);

  assert.equal(secondStartedBeforeFirstFinished, false);
  rmSync(dir, { recursive: true, force: true });
  store.close();
});

test('a watchForPrompts job pauses on a detected prompt, marks awaiting_input, and resumes once answered', async () => {
  const store = new JobStore(':memory:');
  const dir = mkdtempSync(path.join(tmpdir(), 'jobrunner-'));
  const log = createJobLog(dir);
  const ssh = new HangingSSHClient();
  let fireCheck: (() => void) | undefined;
  const runner = new JobRunner(store, log, ssh, {
    promptScheduleCheck: (fn) => {
      fireCheck = fn;
      return { cancel: () => { fireCheck = undefined; } };
    },
  });

  const promptEvents: Array<{ jobId: number; text: string; expectedPrompts: string[] }> = [];
  runner.events.on('prompt', (p) => promptEvents.push(p));
  const clearedEvents: Array<{ jobId: number }> = [];
  runner.events.on('prompt-cleared', (p) => clearedEvents.push(p));
  const statusEvents: Array<{ jobId: number; status: string }> = [];
  runner.events.on('status', (p) => statusEvents.push(p));

  const id = runner.enqueue({
    command: 'install-app',
    category: 'provisioning',
    argsJson: '{}',
    watchForPrompts: true,
    expectedPrompts: ['Add Adminer?'],
    run: async (jobSsh) => {
      await jobSsh.exec({ host: 'pve1.local', user: 'root' }, 'bash install.sh');
    },
  });

  await delay(10);
  fireCheck?.();

  assert.equal(store.get(id)?.status, 'awaiting_input');
  assert.equal(promptEvents.length, 1);
  assert.equal(promptEvents[0].text, 'Add Adminer? (y/N) ');
  assert.deepEqual(promptEvents[0].expectedPrompts, ['Add Adminer?']);
  assert.ok(statusEvents.some((e) => e.jobId === id && e.status === 'awaiting_input'));

  const statusEventsBeforeAnswer = statusEvents.length;

  assert.equal(runner.answerPrompt(id, 'y'), true);
  assert.deepEqual(ssh.writes, ['y\n']);
  assert.equal(clearedEvents.length, 1);
  assert.equal(store.get(id)?.status, 'running');
  assert.ok(
    statusEvents
      .slice(statusEventsBeforeAnswer)
      .some((e) => e.jobId === id && e.status === 'running')
  );

  ssh.finish({ stdout: 'installed', stderr: '', code: 0 });
  await waitForFinished(runner, id);

  assert.equal(store.get(id)?.status, 'success');
  rmSync(dir, { recursive: true, force: true });
  store.close();
});

test('dismissPrompt clears awaiting_input without writing to the exec channel', async () => {
  const store = new JobStore(':memory:');
  const dir = mkdtempSync(path.join(tmpdir(), 'jobrunner-'));
  const log = createJobLog(dir);
  const ssh = new HangingSSHClient();
  let fireCheck: (() => void) | undefined;
  const runner = new JobRunner(store, log, ssh, {
    promptScheduleCheck: (fn) => {
      fireCheck = fn;
      return { cancel: () => { fireCheck = undefined; } };
    },
  });

  const id = runner.enqueue({
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
  assert.equal(store.get(id)?.status, 'awaiting_input');

  assert.equal(runner.dismissPrompt(id), true);
  assert.deepEqual(ssh.writes, []);
  assert.equal(store.get(id)?.status, 'running');

  ssh.finish({ stdout: 'installed', stderr: '', code: 0 });
  await waitForFinished(runner, id);
  assert.equal(store.get(id)?.status, 'success');

  rmSync(dir, { recursive: true, force: true });
  store.close();
});

test('an unanswered prompt auto-cancels the job after the configured abandon duration', async () => {
  const store = new JobStore(':memory:');
  const dir = mkdtempSync(path.join(tmpdir(), 'jobrunner-'));
  const log = createJobLog(dir);
  const ssh = new HangingSSHClient();
  let fireCheck: (() => void) | undefined;
  const runner = new JobRunner(store, log, ssh, {
    abandonPromptMs: 20,
    promptScheduleCheck: (fn) => {
      fireCheck = fn;
      return { cancel: () => { fireCheck = undefined; } };
    },
  });

  const id = runner.enqueue({
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
  assert.equal(store.get(id)?.status, 'awaiting_input');

  await waitForFinished(runner, id);

  assert.equal(store.get(id)?.status, 'cancelled');
  assert.match(log.read(store.get(id)!.logFile), /no answer to prompt within 15 minutes/);

  rmSync(dir, { recursive: true, force: true });
  store.close();
});

test('answerPrompt and dismissPrompt return false for an unknown or non-awaiting job id', async () => {
  const { runner } = makeRunner();
  assert.equal(runner.answerPrompt(999, 'y'), false);
  assert.equal(runner.dismissPrompt(999), false);
});

test('reconcileOrphanedJobs interrupts every non-terminal job and appends a note to each one\'s log', () => {
  const { store, log, dir, runner } = makeRunner();
  const queuedId = store.createJob({ command: 'a', category: 'maintenance', argsJson: '{}' });
  const runningId = store.createJob({ command: 'b', category: 'maintenance', argsJson: '{}' });
  store.markRunning(runningId);
  const successId = store.createJob({ command: 'c', category: 'maintenance', argsJson: '{}' });
  store.markRunning(successId);
  store.markFinished(successId, { status: 'success', exitCode: 0 });

  runner.reconcileOrphanedJobs();

  const queuedRow = store.get(queuedId)!;
  assert.equal(queuedRow.status, 'interrupted');
  assert.match(
    log.read(queuedRow.logFile),
    /Interrupted: service restarted before this job started running\. No remote work was performed\./
  );

  const runningRow = store.get(runningId)!;
  assert.equal(runningRow.status, 'interrupted');
  assert.match(
    log.read(runningRow.logFile),
    /Interrupted: service restarted while this job was running\. Remote work may have completed/
  );

  const successRow = store.get(successId)!;
  assert.equal(successRow.status, 'success');
  assert.equal(log.read(successRow.logFile), '');

  rmSync(dir, { recursive: true, force: true });
  store.close();
});

test('a detected prompt emits its origin and matched index, and persists both on the job row', async () => {
  const store = new JobStore(':memory:');
  const dir = mkdtempSync(path.join(tmpdir(), 'jobrunner-'));
  const log = createJobLog(dir);
  const ssh = new HangingSSHClient();
  let fireCheck: (() => void) | undefined;
  const runner = new JobRunner(store, log, ssh, {
    promptScheduleCheck: (fn) => {
      fireCheck = fn;
      return { cancel: () => { fireCheck = undefined; } };
    },
  });

  const promptEvents: Array<{ origin: string; matchedIndex: number | null; expectedPrompts: string[] }> = [];
  runner.events.on('prompt', (p) => promptEvents.push(p));

  const id = runner.enqueue({
    command: 'install-app',
    category: 'provisioning',
    argsJson: '{}',
    watchForPrompts: true,
    // HangingSSHClient emits 'Add Adminer? (y/N) ', so this hint matches at
    // tier 0 -- one fire, and the origin should be 'expected' rather than the
    // 'heuristic' the same output would get with no hints supplied.
    expectedPrompts: ['Would you like to add Adminer?', 'Add Adminer?'],
    run: async (jobSsh) => {
      await jobSsh.exec({ host: 'pve1.local', user: 'root' }, 'bash install.sh');
    },
  });

  await delay(10);
  fireCheck?.();

  assert.equal(promptEvents.length, 1);
  assert.equal(promptEvents[0].origin, 'expected');
  assert.equal(promptEvents[0].matchedIndex, 1, 'the second hint is the one that matches');
  assert.equal(store.get(id)?.promptOrigin, 'expected');
  assert.equal(store.get(id)?.promptMatchedIndex, 1);

  // Answering clears both, the same way it clears promptText.
  assert.equal(runner.answerPrompt(id, 'y'), true);
  assert.equal(store.get(id)?.promptOrigin, null);
  assert.equal(store.get(id)?.promptMatchedIndex, null);

  ssh.finish({ stdout: 'installed', stderr: '', code: 0 });
  await waitForFinished(runner, id);
  rmSync(dir, { recursive: true, force: true });
  store.close();
});

test('a prompt caught only by the heuristics is tagged heuristic with no matched index', async () => {
  const store = new JobStore(':memory:');
  const dir = mkdtempSync(path.join(tmpdir(), 'jobrunner-'));
  const log = createJobLog(dir);
  const ssh = new HangingSSHClient();
  let fireCheck: (() => void) | undefined;
  const runner = new JobRunner(store, log, ssh, {
    promptScheduleCheck: (fn) => {
      fireCheck = fn;
      return { cancel: () => { fireCheck = undefined; } };
    },
  });

  const promptEvents: Array<{ origin: string; matchedIndex: number | null }> = [];
  runner.events.on('prompt', (p) => promptEvents.push(p));

  const id = runner.enqueue({
    command: 'install-app',
    category: 'provisioning',
    argsJson: '{}',
    watchForPrompts: true,
    run: async (jobSsh) => {
      await jobSsh.exec({ host: 'pve1.local', user: 'root' }, 'bash install.sh');
    },
  });

  await delay(10);
  // No expectedPrompts supplied, so tier 0 finds nothing and arms tier 1,
  // where HangingSSHClient's (y/N)-shaped output is caught.
  fireCheck?.();
  assert.equal(promptEvents.length, 0, 'tier 0 tests expected hints only');
  fireCheck?.();

  assert.equal(promptEvents.length, 1);
  assert.equal(promptEvents[0].origin, 'heuristic');
  assert.equal(promptEvents[0].matchedIndex, null);
  assert.equal(store.get(id)?.promptOrigin, 'heuristic');
  assert.equal(store.get(id)?.promptMatchedIndex, null);

  runner.cancel(id);
  await waitForFinished(runner, id);
  rmSync(dir, { recursive: true, force: true });
  store.close();
});

test('enqueue stamps the runner owner on each job, defaulting to web (#16)', async () => {
  const store = new JobStore(':memory:');
  const dir = mkdtempSync(path.join(tmpdir(), 'jobrunner-'));
  const log = createJobLog(dir);
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const webRunner = new JobRunner(store, log, ssh);
  const mcpRunner = new JobRunner(store, log, ssh, { owner: 'mcp:42' });
  const a = webRunner.enqueue({ command: 'x', category: 'maintenance', argsJson: '{}', run: async () => {} });
  const b = mcpRunner.enqueue({ command: 'y', category: 'maintenance', argsJson: '{}', run: async () => {} });
  await waitForFinished(webRunner, a);
  await waitForFinished(mcpRunner, b);
  assert.equal(store.get(a)?.owner, 'web');
  assert.equal(store.get(b)?.owner, 'mcp:42');
  rmSync(dir, { recursive: true, force: true });
  store.close();
});

test('shutdown cancels in-flight jobs and interrupts any own row still non-terminal (#16)', async () => {
  const store = new JobStore(':memory:');
  const dir = mkdtempSync(path.join(tmpdir(), 'jobrunner-'));
  const log = createJobLog(dir);
  const ssh = new HangingSSHClient();
  const runner = new JobRunner(store, log, ssh, { owner: 'mcp:7' });

  const hanging = runner.enqueue({
    command: 'install-app',
    category: 'provisioning',
    argsJson: '{}',
    run: async (jobSsh) => {
      await jobSsh.exec({ host: 'pve1.local', user: 'root' }, 'bash install.sh');
    },
  });
  // A row this process owns that has no in-memory controller (e.g. left
  // behind mid-status-update) -- only the reconcile pass can close it.
  const stray = store.createJob({ command: 'z', category: 'maintenance', argsJson: '{}', owner: 'mcp:7' });
  store.markRunning(stray);
  const othersRow = store.createJob({ command: 'w', category: 'maintenance', argsJson: '{}', owner: 'web' });
  store.markRunning(othersRow);

  await delay(10);
  await runner.shutdown(1000);

  assert.equal(store.get(hanging)?.status, 'cancelled');
  assert.equal(store.get(stray)?.status, 'interrupted');
  assert.equal(store.get(othersRow)?.status, 'running');
  rmSync(dir, { recursive: true, force: true });
  store.close();
});
