import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JobStore, type JobRow } from '../../../src/web/jobs/job-store.ts';
import { requestJobControl } from '../../../src/web/jobs/job-control.ts';

// requestJobControl (#6) is the one function both the web routes and the
// MCP tools call -- see research.md R3 and src/web/jobs/job-control.ts's
// own comments for the state checks it applies before ever writing a row.

function makeJob(
  store: JobStore,
  overrides: { owner?: string | null; status?: JobRow['status'] } = {}
): JobRow {
  const id = store.createJob({
    command: 'install-app',
    category: 'provisioning',
    argsJson: '{}',
    owner: overrides.owner ?? undefined,
  });
  if (overrides.status === 'running' || overrides.status === 'awaiting_input') {
    store.markRunning(id);
  }
  if (overrides.status === 'awaiting_input') {
    store.markAwaitingInput(id, 'Add Adminer? (y/N) ', 'heuristic', null);
  }
  if (overrides.status === 'success') {
    store.markFinished(id, { status: 'success', exitCode: 0 });
  }
  return store.get(id)!;
}

// A minimal stand-in for the Pick<JobRunner, 'owner' | 'cancel' |
// 'answerPrompt' | 'dismissPrompt'> requestJobControl's deps take -- avoids
// spinning up a real JobRunner (with its SSH client, log dir, etc.) just to
// assert which method was called and what it returned.
function fakeRunner(owner: string, results: { cancel?: boolean; answer?: boolean; dismiss?: boolean } = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    owner,
    cancel(id: number) {
      calls.push({ method: 'cancel', args: [id] });
      return results.cancel ?? false;
    },
    answerPrompt(id: number, text: string) {
      calls.push({ method: 'answerPrompt', args: [id, text] });
      return results.answer ?? false;
    },
    dismissPrompt(id: number) {
      calls.push({ method: 'dismissPrompt', args: [id] });
      return results.dismiss ?? false;
    },
    calls,
  };
}

test('requestJobControl on a local job calls the runner method and returns done on success', () => {
  const store = new JobStore(':memory:');
  const job = makeJob(store, { owner: 'web', status: 'running' });
  const runner = fakeRunner('web', { cancel: true });

  const result = requestJobControl({ jobStore: store, jobRunner: runner }, { job, action: 'cancel' });

  assert.deepEqual(result, { kind: 'done' });
  assert.deepEqual(runner.calls, [{ method: 'cancel', args: [job.id] }]);
  store.close();
});

test("requestJobControl on a local job returns refused with today's exact wording when the runner method returns false", () => {
  const store = new JobStore(':memory:');
  const job = makeJob(store, { owner: 'web', status: 'success' });
  const runner = fakeRunner('web', { cancel: false });

  const result = requestJobControl({ jobStore: store, jobRunner: runner }, { job, action: 'cancel' });

  assert.deepEqual(result, { kind: 'refused', message: `Job ${job.id} is already success — nothing to cancel` });
  store.close();
});

test("requestJobControl refuses answer/dismiss on a local job with today's exact wording", () => {
  const store = new JobStore(':memory:');
  const job = makeJob(store, { owner: 'web', status: 'running' });
  const runner = fakeRunner('web', { answer: false, dismiss: false });
  const deps = { jobStore: store, jobRunner: runner };

  assert.deepEqual(requestJobControl(deps, { job, action: 'answer', text: 'y' }), {
    kind: 'refused',
    message: `Job ${job.id} is not awaiting input — nothing to answer`,
  });
  assert.deepEqual(requestJobControl(deps, { job, action: 'dismiss' }), {
    kind: 'refused',
    message: `Job ${job.id} is not awaiting input — nothing to dismiss`,
  });
  store.close();
});

test('requestJobControl refuses a foreign job whose owning mcp process has exited, and writes no row', () => {
  const store = new JobStore(':memory:');
  const job = makeJob(store, { owner: 'mcp:4242', status: 'running' });
  const runner = fakeRunner('web');

  const result = requestJobControl(
    { jobStore: store, jobRunner: runner, isPidAlive: () => false },
    { job, action: 'cancel' }
  );

  assert.deepEqual(result, { kind: 'refused', message: `job ${job.id}'s owning process mcp:4242 has exited` });
  assert.deepEqual(store.pendingControlRequests('mcp:4242'), []);
  store.close();
});

test("requestJobControl refuses cancel on a foreign terminal job with today's exact wording", () => {
  const store = new JobStore(':memory:');
  const job = makeJob(store, { owner: 'mcp:4242', status: 'success' });
  const runner = fakeRunner('web');

  const result = requestJobControl(
    { jobStore: store, jobRunner: runner, isPidAlive: () => true },
    { job, action: 'cancel' }
  );

  assert.deepEqual(result, { kind: 'refused', message: `Job ${job.id} is already success — nothing to cancel` });
  assert.deepEqual(store.pendingControlRequests('mcp:4242'), []);
  store.close();
});

test('requestJobControl refuses answer/dismiss on a foreign running (not paused) job', () => {
  const store = new JobStore(':memory:');
  const job = makeJob(store, { owner: 'mcp:4242', status: 'running' });
  const runner = fakeRunner('web');
  const deps = { jobStore: store, jobRunner: runner, isPidAlive: () => true };

  assert.deepEqual(requestJobControl(deps, { job, action: 'answer', text: 'y' }), {
    kind: 'refused',
    message: `Job ${job.id} is not awaiting input — nothing to answer`,
  });
  assert.deepEqual(requestJobControl(deps, { job, action: 'dismiss' }), {
    kind: 'refused',
    message: `Job ${job.id} is not awaiting input — nothing to dismiss`,
  });
  assert.deepEqual(store.pendingControlRequests('mcp:4242'), []);
  store.close();
});

test('requestJobControl writes a request row for a foreign queued/running job cancel and returns requested', () => {
  const store = new JobStore(':memory:');
  const queuedJob = makeJob(store, { owner: 'mcp:4242', status: 'queued' });
  const runningJob = makeJob(store, { owner: 'mcp:4242', status: 'running' });
  const runner = fakeRunner('web');
  const deps = { jobStore: store, jobRunner: runner, isPidAlive: () => true };

  const r1 = requestJobControl(deps, { job: queuedJob, action: 'cancel', requestedByUsername: 'admin' });
  const r2 = requestJobControl(deps, { job: runningJob, action: 'cancel' });

  assert.deepEqual(r1, { kind: 'requested', owner: 'mcp:4242' });
  assert.deepEqual(r2, { kind: 'requested', owner: 'mcp:4242' });

  const pending = store.pendingControlRequests('mcp:4242');
  assert.equal(pending.length, 2);
  assert.equal(pending[0].jobId, queuedJob.id);
  assert.equal(pending[0].action, 'cancel');
  assert.equal(pending[0].requestedByOwner, 'web');
  assert.equal(pending[0].requestedByUsername, 'admin');
  assert.equal(pending[1].jobId, runningJob.id);
  assert.equal(pending[1].requestedByUsername, null);
  store.close();
});

test('requestJobControl writes a request row for a foreign paused job answer/dismiss and returns requested', () => {
  const store = new JobStore(':memory:');
  const job = makeJob(store, { owner: 'mcp:4242', status: 'awaiting_input' });
  const runner = fakeRunner('mcp:9999');
  const deps = { jobStore: store, jobRunner: runner, isPidAlive: () => true };

  const result = requestJobControl(deps, { job, action: 'answer', text: 'y', requestedByUsername: 'admin' });

  assert.deepEqual(result, { kind: 'requested', owner: 'mcp:4242' });
  const pending = store.pendingControlRequests('mcp:4242');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].action, 'answer');
  assert.equal(pending[0].text, 'y');
  // requestedByOwner is the *requester's own* runner's owner, not the
  // foreign job's owner.
  assert.equal(pending[0].requestedByOwner, 'mcp:9999');
  store.close();
});

test('requestJobControl never treats a foreign job owned by web as dead', () => {
  const store = new JobStore(':memory:');
  const job = makeJob(store, { owner: 'web', status: 'running' });
  const runner = fakeRunner('mcp:123');
  let calledIsPidAlive = false;

  const result = requestJobControl(
    {
      jobStore: store,
      jobRunner: runner,
      isPidAlive: () => {
        calledIsPidAlive = true;
        return false;
      },
    },
    { job, action: 'cancel' }
  );

  assert.deepEqual(result, { kind: 'requested', owner: 'web' });
  assert.equal(calledIsPidAlive, false, 'isPidAlive must never be called for a web-owned job -- "web" carries no pid');
  store.close();
});
