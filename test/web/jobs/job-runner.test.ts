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
import { withCapturedConsole } from '../../../src/web/console-capture.ts';
import { gate } from '../../support/gate.ts';
import { captureWarnings } from '../../support/capture-warnings.ts';
import type { ExecResult, SSHClient, SshTarget } from '../../../src/lib/ssh-client.ts';
import Database from 'better-sqlite3';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A test-only SSHClient whose exec() genuinely stays pending (like
// HangingSSHClient) but whose stdin-write callback throws instead of
// recording anything -- simulates a real write() into an exec channel
// that's already closing (fix round 1, finding 1): processControlRequests
// must survive that instead of letting it become an uncaughtException on
// the poller's timer.
class ThrowingWriteSSHClient implements SSHClient {
  private resolveExec: ((result: ExecResult) => void) | undefined;

  exec(
    _target: SshTarget,
    _command: string,
    onChunk?: (chunk: string, stream: 'stdout' | 'stderr') => void,
    signal?: AbortSignal,
    onStdinReady?: (write: (text: string) => void) => void
  ): Promise<ExecResult> {
    onStdinReady?.(() => {
      throw new Error('channel is closing');
    });
    onChunk?.('Add Adminer? (y/N) ', 'stdout');
    return new Promise((resolve, reject) => {
      this.resolveExec = resolve;
      signal?.addEventListener('abort', () => reject(new Error('Job cancelled')));
    });
  }

  finish(result: ExecResult): void {
    this.resolveExec?.(result);
  }

  execInteractive(): Promise<ExecResult> {
    return Promise.reject(new Error('not used in this fixture'));
  }

  putFile(): Promise<void> {
    return Promise.resolve();
  }
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

// Deterministic replacement for a fixed delay() when a test just needs to
// know execute() has actually started running a job (emitted synchronously
// once markRunning()/the 'running' status event fire, before def.run() is
// even called) -- fix round 1, finding 4.
function waitForStatus(runner: JobRunner, id: number, status: string): Promise<void> {
  return new Promise((resolve) => {
    runner.events.on('status', function handler(payload: any) {
      if (payload.jobId === id && payload.status === status) {
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

// Issue #61 final review: a job that turns per-target failures into results
// (the check-app-updates task) needs the signal itself to tell a cancel
// apart from an ordinary failure.
test('run() receives the job signal, which aborts on cancel()', async () => {
  const { store, dir, runner } = makeRunner();
  let seen: AbortSignal | undefined;
  let release: () => void = () => {};
  const id = runner.enqueue({
    command: 'check-app-updates',
    category: 'maintenance',
    argsJson: '{}',
    run: async (_ssh, signal) => {
      seen = signal;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      if (signal.aborted) throw new Error('stopped');
    },
  });

  await waitForStatus(runner, id, 'running');
  assert.ok(seen);
  assert.equal(seen!.aborted, false);
  assert.equal(runner.cancel(id), true);
  assert.equal(seen!.aborted, true);
  release();
  await waitForFinished(runner, id);
  assert.equal(store.get(id)!.status, 'cancelled');
  rmSync(dir, { recursive: true, force: true });
  store.close();
});

test('cancel() skips a job that is still waiting its turn behind another running job', { timeout: 5000 }, async () => {
  const { store, dir, runner } = makeRunner();
  const release = gate();
  let secondRan = false;

  const firstId = runner.enqueue({
    command: 'a',
    category: 'maintenance',
    argsJson: '{}',
    run: async () => {
      await release.promise;
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

  const finished = Promise.all([waitForFinished(runner, firstId), waitForFinished(runner, secondId)]);
  assert.equal(runner.cancel(secondId), true);
  release.open();
  await finished;

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

// Issue #78 US2 (T001): JobRunner runs one job at a time through its own
// queue. A test-controlled gate,
// not delay(), proves B genuinely waits for A rather than merely losing a
// race.
test('a second enqueue while a job runs stays queued until released, then both run and succeed (#78 US2)', async () => {
  const { store, dir, runner } = makeRunner();
  let releaseA!: () => void;
  const gateA = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  let bRunCalled = false;

  const aId = runner.enqueue({
    command: 'a',
    category: 'maintenance',
    argsJson: '{}',
    run: async () => {
      await gateA;
    },
  });
  await waitForStatus(runner, aId, 'running');

  const bId = runner.enqueue({
    command: 'b',
    category: 'maintenance',
    argsJson: '{}',
    run: async () => {
      bRunCalled = true;
    },
  });

  assert.equal(store.get(bId)?.status, 'queued');
  assert.equal(bRunCalled, false);

  releaseA();
  await waitForFinished(runner, bId);

  assert.equal(store.get(aId)?.status, 'success');
  assert.equal(store.get(bId)?.status, 'success');
  assert.equal(bRunCalled, true);
  rmSync(dir, { recursive: true, force: true });
  store.close();
});

// Issue #78 US2 (T002/FR-004): a job cancelled while still queued behind a
// running one is finished as cancelled at once -- not when its turn comes --
// never runs, and does not hold up the job queued after it.
test('a cancelled queued job is marked cancelled immediately, never runs, and does not hold up the next queued job (#78 US2, FR-004)', { timeout: 5000 }, async () => {
  const { store, log, dir, runner } = makeRunner();
  const releaseA = gate();
  let bRunCalled = false;
  let cRunCalled = false;

  const aId = runner.enqueue({
    command: 'a',
    category: 'maintenance',
    argsJson: '{}',
    run: async () => {
      await releaseA.promise;
    },
  });
  await waitForStatus(runner, aId, 'running');

  const bId = runner.enqueue({
    command: 'b',
    category: 'maintenance',
    argsJson: '{}',
    run: async () => {
      bRunCalled = true;
    },
  });
  const cId = runner.enqueue({
    command: 'c',
    category: 'maintenance',
    argsJson: '{}',
    run: async () => {
      cRunCalled = true;
    },
  });

  const bStatuses: string[] = [];
  runner.events.on('status', (payload: any) => {
    if (payload.jobId === bId) bStatuses.push(payload.status);
  });
  const finished = Promise.all([waitForFinished(runner, aId), waitForFinished(runner, cId)]);

  assert.equal(runner.cancel(bId), true);
  // Still before A is released: B is already over.
  assert.equal(store.get(bId)?.status, 'cancelled');
  assert.equal(store.get(bId)?.errorMessage, 'Cancelled by operator');
  assert.deepEqual(bStatuses, ['cancelled']);
  assert.equal(store.get(aId)?.status, 'running');
  assert.equal(runner.cancel(bId), false);

  releaseA.open();
  await finished;

  assert.equal(bRunCalled, false);
  assert.deepEqual(bStatuses, ['cancelled']);
  assert.equal(store.get(bId)?.status, 'cancelled');
  const bLog = log.read(store.get(bId)!.logFile);
  assert.equal(bLog.match(/Job cancelled by operator/g)?.length, 1);
  assert.equal(store.get(aId)?.status, 'success');
  assert.equal(store.get(cId)?.status, 'success');
  assert.equal(cRunCalled, true);
  assert.equal(runner.hasControlPoller(), false);
  rmSync(dir, { recursive: true, force: true });
  store.close();
});

// Issue #78 US2 (T003/FR-005): a job that throws ends failed, and that must
// not stop the job queued after it from starting and succeeding.
test('a job whose run throws ends failed, and the job queued after it still starts and succeeds (#78 US2, FR-005)', async () => {
  const { store, dir, runner } = makeRunner();
  let secondRan = false;

  const firstId = runner.enqueue({
    command: 'a',
    category: 'maintenance',
    argsJson: '{}',
    run: async () => {
      throw new Error('boom');
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

  await waitForFinished(runner, secondId);

  assert.equal(store.get(firstId)?.status, 'failed');
  assert.equal(store.get(secondId)?.status, 'success');
  assert.equal(secondRan, true);
  rmSync(dir, { recursive: true, force: true });
  store.close();
});

// If execute() itself rejects (here: the store cannot record the job's end),
// the queue logs a warning naming the job and still runs the next job.
test('an execute() rejection is logged with the job id and does not stop the queue (#78)', { timeout: 5000 }, async () => {
  const { store, dir, runner } = makeRunner();
  let brokenId = -1;
  const realMarkFinished = store.markFinished.bind(store);
  store.markFinished = (id, result) => {
    if (id === brokenId) throw new Error('store write failed');
    realMarkFinished(id, result);
  };

  const { warnings } = await captureWarnings(async () => {
    brokenId = runner.enqueue({ command: 'a', category: 'maintenance', argsJson: '{}', run: async () => {} });
    const secondId = runner.enqueue({ command: 'b', category: 'maintenance', argsJson: '{}', run: async () => {} });
    await waitForFinished(runner, secondId);
    assert.equal(store.get(secondId)?.status, 'success');
  });

  assert.ok(
    warnings.some((w) => w.includes(`Job ${brokenId}`) && w.includes('store write failed')),
    `expected a warning naming job ${brokenId}, got: ${JSON.stringify(warnings)}`
  );
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

// Issue #52 Unit 2 (US2/FR-012): the stall tier is JobSSHClient's one
// backstop with no actual evidence a question is waiting, so once new
// meaningful output arrives there is nothing left for the pause to be
// guarding against -- it clears itself the same way a dismissal would,
// stopping the abandon countdown that would otherwise cancel a job that is,
// in fact, still working.
test('a stall pause cleared by new output returns the job to running, emits prompt-cleared, and the abandon timeout never fires', async () => {
  const store = new JobStore(':memory:');
  const dir = mkdtempSync(path.join(tmpdir(), 'jobrunner-'));
  const log = createJobLog(dir);
  let onChunkCb: ((chunk: string, stream: 'stdout' | 'stderr') => void) | undefined;
  let resolveExec: ((result: ExecResult) => void) | undefined;
  const ssh: SSHClient = {
    exec: (_target: SshTarget, _command: string, onChunk) => {
      onChunkCb = onChunk;
      return new Promise((resolve) => {
        resolveExec = resolve;
      });
    },
    execInteractive: () => Promise.reject(new Error('not used in this fixture')),
    putFile: () => Promise.resolve(),
  };
  let fireCheck: (() => void) | undefined;
  const runner = new JobRunner(store, log, ssh, {
    // Deliberately short -- long enough for the stall pause to clear and
    // the timer to be cancelled, short enough that the test would observe
    // it firing (a cancelled job) if it somehow stayed armed.
    abandonPromptMs: 20,
    promptScheduleCheck: (fn) => {
      fireCheck = fn;
      return { cancel: () => { fireCheck = undefined; } };
    },
  });

  const clearedEvents: Array<{ jobId: number }> = [];
  runner.events.on('prompt-cleared', (p) => clearedEvents.push(p));
  const statusEvents: Array<{ jobId: number; status: string }> = [];
  runner.events.on('status', (p) => statusEvents.push(p));

  const id = runner.enqueue({
    command: 'install-app',
    category: 'provisioning',
    argsJson: '{}',
    watchForPrompts: true,
    run: async (jobSsh) => {
      await jobSsh.exec({ host: 'pve1.local', user: 'root' }, 'bash install.sh');
    },
  });

  await waitForStatus(runner, id, 'running');
  onChunkCb?.('Configuring the database\n', 'stdout');
  // Three fires walk tier 0 -> tier 1 -> tier 2 (stall): nothing in this
  // text matches an expected hint or either heuristic along the way.
  fireCheck?.();
  fireCheck?.();
  fireCheck?.();

  assert.equal(store.get(id)?.status, 'awaiting_input');
  assert.equal(store.get(id)?.promptOrigin, 'stall');

  const statusEventsBeforeClear = statusEvents.length;

  // New meaningful output arrives while the stall pause is still waiting --
  // FR-012 says this clears the pause exactly like a dismissal, well
  // within the 20ms abandon window configured above.
  onChunkCb?.('Service is now responding\n', 'stdout');

  assert.equal(clearedEvents.length, 1);
  assert.equal(store.get(id)?.status, 'running');
  assert.ok(statusEvents.slice(statusEventsBeforeClear).some((e) => e.jobId === id && e.status === 'running'));

  // Give the (deliberately short) abandon window time to have fired if the
  // pause had somehow stayed armed -- it must not have, since it already
  // cleared above and the clearTimeout in onPromptCleared ran synchronously.
  await delay(40);
  assert.equal(store.get(id)?.status, 'running');
  assert.equal(clearedEvents.length, 1, 'no second prompt-cleared from an abandon timeout that should never have fired');

  resolveExec?.({ stdout: '', stderr: '', code: 0 });
  await waitForFinished(runner, id);
  assert.equal(store.get(id)?.status, 'success');

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

test('reconcileOrphanedJobs closes a leftover pending control request for a job it just interrupted (#6 fix round 1)', () => {
  const { store, dir, runner } = makeRunner();
  // Never enqueued through this runner -- no in-memory controller, so only
  // the reconcile pass (interruptOrphaned) can close it out, the same
  // "stray row" shape shutdown()'s own test below exercises.
  const strayId = store.createJob({ command: 'z', category: 'maintenance', argsJson: '{}' });
  store.markRunning(strayId);
  store.createControlRequest({ jobId: strayId, action: 'cancel', requestedByOwner: 'web' });

  runner.reconcileOrphanedJobs();

  assert.equal(store.get(strayId)?.status, 'interrupted');
  // closeStaleControlRequests runs after interruptOrphaned, so the
  // now-terminal job's own pending request is closed in the same pass --
  // it must never sit there forever with its (here, non-existent) answer
  // text since no process will ever come back to apply it.
  assert.deepEqual(store.pendingControlRequests('web'), []);

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
  // Both waiters are registered before either is awaited: the two runners
  // run concurrently (#78), so b can finish while a is still being awaited.
  await Promise.all([waitForFinished(webRunner, a), waitForFinished(mcpRunner, b)]);
  assert.equal(store.get(a)?.owner, 'web');
  assert.equal(store.get(b)?.owner, 'mcp:42');
  rmSync(dir, { recursive: true, force: true });
  store.close();
});

// Cross-process job control request queue (#6) -- processControlRequests()
// applies a row another process wrote via requestJobControl
// (src/web/jobs/job-control.ts) through this runner's own normal methods.

test('processControlRequests applies an answer request from another process, logging attribution without leaking the answer text', async () => {
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
  fireCheck?.();
  fireCheck?.();
  assert.equal(store.get(id)?.status, 'awaiting_input');

  store.createControlRequest({ jobId: id, action: 'answer', text: 'totally-secret-answer', requestedByOwner: 'mcp:4242' });
  runner.processControlRequests();

  assert.deepEqual(ssh.writes, ['totally-secret-answer\n']);
  assert.equal(store.get(id)?.status, 'running');
  assert.deepEqual(store.pendingControlRequests('mcp:4242'), []);
  const logText = log.read(store.get(id)!.logFile);
  assert.match(logText, /Answer sent from MCP \(mcp:4242\)/);
  assert.ok(!logText.includes('totally-secret-answer'), 'the answer text itself must never appear in the log');

  ssh.finish({ stdout: 'installed', stderr: '', code: 0 });
  await waitForFinished(runner, id);
  rmSync(dir, { recursive: true, force: true });
  store.close();
});

test('processControlRequests applies a cancel request from web with attribution, ending the job cancelled', async () => {
  const store = new JobStore(':memory:');
  const dir = mkdtempSync(path.join(tmpdir(), 'jobrunner-'));
  const log = createJobLog(dir);
  // HangingSSHClient's exec() genuinely stays pending until finish()/abort()
  // -- a deterministic hold, unlike a fixed delay() the job's own run()
  // would race against.
  const ssh = new HangingSSHClient();
  const runner = new JobRunner(store, log, ssh);

  const id = runner.enqueue({
    command: 'update-all',
    category: 'maintenance',
    argsJson: '{}',
    run: async (jobSsh) => {
      await jobSsh.exec({ host: 'pve1.local', user: 'root' }, 'apt-get update');
    },
  });

  await waitForStatus(runner, id, 'running');
  store.createControlRequest({ jobId: id, action: 'cancel', requestedByOwner: 'web', requestedByUsername: 'admin' });
  runner.processControlRequests();
  await waitForFinished(runner, id);

  assert.equal(store.get(id)?.status, 'cancelled');
  assert.match(log.read(store.get(id)!.logFile), /Stop requested from web UI by admin/);
  rmSync(dir, { recursive: true, force: true });
  store.close();
});

test('processControlRequests applies a dismiss request with attribution', async () => {
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
  fireCheck?.();
  fireCheck?.();
  assert.equal(store.get(id)?.status, 'awaiting_input');

  store.createControlRequest({ jobId: id, action: 'dismiss', requestedByOwner: 'web', requestedByUsername: 'admin' });
  runner.processControlRequests();

  assert.deepEqual(ssh.writes, []);
  assert.equal(store.get(id)?.status, 'running');
  assert.match(log.read(store.get(id)!.logFile), /Prompt dismissed from web UI by admin/);

  ssh.finish({ stdout: 'installed', stderr: '', code: 0 });
  await waitForFinished(runner, id);
  rmSync(dir, { recursive: true, force: true });
  store.close();
});

test('processControlRequests marks a request not-applicable and never throws when the apply step itself throws (#6 fix round 1)', async () => {
  const store = new JobStore(':memory:');
  const dir = mkdtempSync(path.join(tmpdir(), 'jobrunner-'));
  const log = createJobLog(dir);
  const ssh = new ThrowingWriteSSHClient();
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
  fireCheck?.();
  fireCheck?.();
  assert.equal(store.get(id)?.status, 'awaiting_input');

  store.createControlRequest({ jobId: id, action: 'answer', text: 'y', requestedByOwner: 'mcp:4242' });

  // answerPrompt() -> pending.write() throws inside the poll pass -- this
  // must never escape processControlRequests() (which a real setInterval
  // callback would otherwise turn into an uncaughtException that kills the
  // whole process), and the request must still end up handled rather than
  // being retried forever every 500ms.
  assert.doesNotThrow(() => runner.processControlRequests());

  assert.deepEqual(store.pendingControlRequests('mcp:4242'), []);
  // The job itself is left exactly as it was -- the throw happened before
  // any state change, and this is a failed *apply*, not a successful one.
  assert.equal(store.get(id)?.status, 'awaiting_input');

  runner.cancel(id);
  await waitForFinished(runner, id);
  rmSync(dir, { recursive: true, force: true });
  store.close();
});

test('processControlRequests marks a request for an inactive job not-applicable and changes nothing', async () => {
  const { store, dir, runner } = makeRunner();

  const finishedId = runner.enqueue({ command: 'a', category: 'maintenance', argsJson: '{}', run: async () => {} });
  await waitForFinished(runner, finishedId);

  // Created directly in the store -- never enqueued through this runner, so
  // it has no in-memory controller even though its row says 'running'.
  const directId = store.createJob({ command: 'b', category: 'maintenance', argsJson: '{}' });
  store.markRunning(directId);

  store.createControlRequest({ jobId: finishedId, action: 'cancel', requestedByOwner: 'web' });
  store.createControlRequest({ jobId: directId, action: 'cancel', requestedByOwner: 'web' });

  runner.processControlRequests();

  assert.deepEqual(store.pendingControlRequests('web'), []);
  assert.equal(store.get(finishedId)?.status, 'success');
  assert.equal(store.get(directId)?.status, 'running');
  rmSync(dir, { recursive: true, force: true });
  store.close();
});

test('processControlRequests marks an answer request not-applicable when the job is running but not paused', async () => {
  const store = new JobStore(':memory:');
  const dir = mkdtempSync(path.join(tmpdir(), 'jobrunner-'));
  const log = createJobLog(dir);
  const ssh = new HangingSSHClient();
  const runner = new JobRunner(store, log, ssh);

  const id = runner.enqueue({
    command: 'update-all',
    category: 'maintenance',
    argsJson: '{}',
    run: async (jobSsh) => {
      await jobSsh.exec({ host: 'pve1.local', user: 'root' }, 'apt-get update');
    },
  });
  await waitForStatus(runner, id, 'running');
  assert.equal(store.get(id)?.status, 'running');

  store.createControlRequest({ jobId: id, action: 'answer', text: 'y', requestedByOwner: 'web' });
  runner.processControlRequests();

  assert.deepEqual(store.pendingControlRequests('web'), []);
  assert.equal(store.get(id)?.status, 'running');

  ssh.finish({ stdout: 'ok', stderr: '', code: 0 });
  await waitForFinished(runner, id);
  rmSync(dir, { recursive: true, force: true });
  store.close();
});

test('processControlRequests leaves another owner\'s pending requests untouched', async () => {
  const store = new JobStore(':memory:');
  const dir = mkdtempSync(path.join(tmpdir(), 'jobrunner-'));
  const log = createJobLog(dir);
  const ssh = new HangingSSHClient();
  const runner = new JobRunner(store, log, ssh); // runner.owner === 'web'

  const id = runner.enqueue({
    command: 'a',
    category: 'maintenance',
    argsJson: '{}',
    run: async (jobSsh) => {
      await jobSsh.exec({ host: 'pve1.local', user: 'root' }, 'apt-get update');
    },
  });
  await waitForStatus(runner, id, 'running');

  // Owned by this test process's own real pid, not an arbitrary made-up
  // one -- closeStaleControlRequests (wired into processControlRequests as
  // of fix round 1) treats a request whose job owner is a *dead* mcp:<pid>
  // as stale regardless of owner, so a fake, guaranteed-dead pid here would
  // make this row disappear for the wrong reason.
  const foreignOwner = `mcp:${process.pid}`;
  const foreignJobId = store.createJob({ command: 'b', category: 'maintenance', argsJson: '{}', owner: foreignOwner });
  const requestId = store.createControlRequest({ jobId: foreignJobId, action: 'cancel', requestedByOwner: 'web' });

  runner.processControlRequests();

  assert.deepEqual(store.pendingControlRequests(foreignOwner).map((r) => r.id), [requestId]);

  runner.cancel(id);
  await waitForFinished(runner, id);
  rmSync(dir, { recursive: true, force: true });
  store.close();
});

test('the control-request poller runs only while a job is active', async () => {
  const store = new JobStore(':memory:');
  const dir = mkdtempSync(path.join(tmpdir(), 'jobrunner-'));
  const log = createJobLog(dir);
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const runner = new JobRunner(store, log, ssh, { controlPollMs: 5 });

  assert.equal(runner.hasControlPoller(), false);

  const id = runner.enqueue({
    command: 'a',
    category: 'maintenance',
    argsJson: '{}',
    run: async () => {
      await delay(20);
    },
  });

  assert.equal(runner.hasControlPoller(), true);

  await waitForFinished(runner, id);
  assert.equal(runner.hasControlPoller(), false);

  rmSync(dir, { recursive: true, force: true });
  store.close();
});

test('the control-request poller restarts for a second enqueue after the first job finished (fix round 1, finding 3)', async () => {
  const store = new JobStore(':memory:');
  const dir = mkdtempSync(path.join(tmpdir(), 'jobrunner-'));
  const log = createJobLog(dir);
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const runner = new JobRunner(store, log, ssh, { controlPollMs: 5 });

  const first = runner.enqueue({ command: 'a', category: 'maintenance', argsJson: '{}', run: async () => {} });
  await waitForFinished(runner, first);
  assert.equal(runner.hasControlPoller(), false);

  const second = runner.enqueue({
    command: 'b',
    category: 'maintenance',
    argsJson: '{}',
    run: async () => {
      await delay(20);
    },
  });
  assert.equal(runner.hasControlPoller(), true);

  await waitForFinished(runner, second);
  assert.equal(runner.hasControlPoller(), false);

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

// Fix wave (M3): a control request can be written in the narrow window
// between a requester's own liveness/status check and this runner's last
// active job actually finishing -- e.g. an answer submitted just as the job
// was wrapping up. Once execute()'s finally block drops the job from
// this.controllers and stops the poller (controllers.size === 0), nothing
// would ever poll pendingControlRequests() again, leaving that row pending
// -- with its answer text still attached -- forever. execute()'s finally
// must therefore sweep closeStaleControlRequests() itself before stopping
// the poller. controlPollMs is set absurdly high so the real poller can
// never tick during this test -- the only thing that can close the request
// here is the finally-block fix itself, not processControlRequests (which
// this test deliberately never calls).
test('execute() finally closes a control request left pending when its job finishes, without the poller ever ticking', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jobrunner-stale-'));
  const dbPath = path.join(dir, 'jobs.sqlite3');
  const store = new JobStore(dbPath);
  const logDir = mkdtempSync(path.join(tmpdir(), 'jobrunner-'));
  const log = createJobLog(logDir);
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const runner = new JobRunner(store, log, ssh, { controlPollMs: 100_000 });

  let releaseJob!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseJob = resolve;
  });
  const id = runner.enqueue({
    command: 'update-all',
    category: 'maintenance',
    argsJson: '{}',
    run: async () => {
      await gate;
    },
  });
  await waitForStatus(runner, id, 'running');

  const requestId = store.createControlRequest({
    jobId: id,
    action: 'answer',
    text: 'a-secret-answer',
    requestedByOwner: 'web',
    requestedByUsername: 'admin',
  });

  releaseJob();
  await waitForFinished(runner, id);

  assert.deepEqual(store.pendingControlRequests('web'), []);

  const raw = new Database(dbPath);
  const row = raw.prepare('SELECT * FROM job_control_requests WHERE id = ?').get(requestId) as any;
  assert.ok(row.handled_at);
  assert.equal(row.result, 'not-applicable');
  assert.equal(row.text, null);
  raw.close();

  store.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(logDir, { recursive: true, force: true });
});

test('two separate JobRunners do not serialize against each other (#78)', { timeout: 5000 }, async () => {
  const one = makeRunner();
  const two = makeRunner();
  const release = gate();
  const id1 = one.runner.enqueue({
    command: 'update-all',
    category: 'maintenance',
    argsJson: '{}',
    run: async () => {
      console.log('runner one waiting');
      await release.promise;
    },
  });
  await waitForStatus(one.runner, id1, 'running');

  const id2 = two.runner.enqueue({
    command: 'update-all',
    category: 'maintenance',
    argsJson: '{}',
    run: async () => {
      console.log('runner two ran');
    },
  });
  await waitForFinished(two.runner, id2);
  assert.equal(two.store.get(id2)!.status, 'success');
  assert.equal(one.store.get(id1)!.status, 'running');

  release.open();
  await waitForFinished(one.runner, id1);
  assert.equal(one.store.get(id1)!.status, 'success');
  assert.match(one.log.read(one.store.get(id1)!.logFile), /runner one waiting/);
  assert.doesNotMatch(one.log.read(one.store.get(id1)!.logFile), /runner two ran/);
  assert.match(two.log.read(two.store.get(id2)!.logFile), /runner two ran/);
  for (const r of [one, two]) {
    rmSync(r.dir, { recursive: true, force: true });
    r.store.close();
  }
});

test('a job\'s SSH and EventEmitter callback lines stay in its log while a preview captures concurrently (#78)', { timeout: 5000 }, async () => {
  const { EventEmitter } = await import('node:events');
  const store = new JobStore(':memory:');
  const dir = mkdtempSync(path.join(tmpdir(), 'jobrunner-'));
  const log = createJobLog(dir);
  const ssh = new FakeSSHClient((_target, _user, command) => {
    console.log(`responder saw ${command}`);
    return { stdout: 'remote output', stderr: '', code: 0 };
  });
  const runner = new JobRunner(store, log, ssh);

  const jobStarted = gate();
  const previewLogged = gate();
  const jobLineLogged = gate();

  const id = runner.enqueue({
    command: 'update-all',
    category: 'maintenance',
    argsJson: '{}',
    run: async (jobSsh) => {
      jobStarted.open();
      await previewLogged.promise;
      await jobSsh.exec({ host: 'pve1.local', user: 'root' }, 'apt-get update');
      const emitter = new EventEmitter();
      emitter.on('done', () => {
        console.log('job emitter line');
        jobLineLogged.open();
      });
      await new Promise<void>((resolve) =>
        setImmediate(() => {
          emitter.emit('done');
          resolve();
        })
      );
    },
  });

  const preview = withCapturedConsole(async () => {
    await jobStarted.promise;
    console.log('preview line');
    previewLogged.open();
    await jobLineLogged.promise;
    console.log('preview after');
  });

  const [{ text }] = await Promise.all([preview, waitForFinished(runner, id)]);
  const row = store.get(id)!;
  assert.equal(row.status, 'success');
  const jobLog = log.read(row.logFile);
  assert.match(jobLog, /job emitter line/);
  assert.match(jobLog, /responder saw apt-get update/);
  assert.doesNotMatch(jobLog, /preview line|preview after/);
  assert.equal(text, 'preview line\npreview after');
  rmSync(dir, { recursive: true, force: true });
  store.close();
});

// #65/#66: the front end travels from enqueue to the stored row.
test('enqueue passes triggeredVia through to the job row', async () => {
  const store = new JobStore(':memory:');
  const runner = new JobRunner(store, createJobLog(mkdtempSync(path.join(tmpdir(), 'via-log-'))), new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 })));
  const id = runner.enqueue({ command: 'noop', category: 'maintenance', argsJson: '{}', triggeredByUsername: 'admin', triggeredVia: 'web', run: async () => {} });
  assert.equal(store.get(id)?.triggeredVia, 'web');
});
