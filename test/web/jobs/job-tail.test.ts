import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JobStore } from '../../../src/web/jobs/job-store.ts';
import { createJobLog } from '../../../src/web/jobs/job-log.ts';
import { createForeignJobTail } from '../../../src/web/jobs/job-tail.ts';

// createForeignJobTail is the polling counterpart to JobRunner's in-memory
// 'chunk'/'status'/'prompt'/'prompt-cleared' events (issue #6) -- used for a
// job owned by another process, where those events never fire in this one.
// tick() is called directly rather than on a timer so these tests are
// deterministic (research.md R7).

function setUp() {
  const jobStore = new JobStore(':memory:');
  const dir = mkdtempSync(path.join(tmpdir(), 'jobtail-'));
  const jobLog = createJobLog(dir);
  const id = jobStore.createJob({ command: 'update-all', category: 'maintenance', argsJson: '{}', owner: 'mcp:4242' });
  jobStore.markRunning(id);
  return { jobStore, jobLog, dir, id };
}

test('a tick after an append sends one chunk with exactly the new text', () => {
  const { jobStore, jobLog, dir, id } = setUp();
  const row = jobStore.get(id)!;
  const messages: any[] = [];
  const tail = createForeignJobTail({
    jobStore,
    jobLog,
    jobId: id,
    initial: { offset: 0, row },
    send: (m) => messages.push(m),
    isPidAlive: () => true,
  });

  jobLog.append(row.logFile, 'hello\n');
  tail.tick();

  assert.deepEqual(
    messages.filter((m) => m.type === 'chunk'),
    [{ type: 'chunk', stream: 'stdout', text: 'hello\n' }]
  );

  rmSync(dir, { recursive: true, force: true });
  jobStore.close();
});

test('a tick with nothing new sends nothing', () => {
  const { jobStore, jobLog, dir, id } = setUp();
  const row = jobStore.get(id)!;
  const messages: any[] = [];
  const tail = createForeignJobTail({
    jobStore,
    jobLog,
    jobId: id,
    initial: { offset: 0, row },
    send: (m) => messages.push(m),
    isPidAlive: () => true,
  });

  tail.tick();
  assert.deepEqual(messages, []);

  rmSync(dir, { recursive: true, force: true });
  jobStore.close();
});

test('a 3-byte UTF-8 character split across two writes arrives intact across two ticks', () => {
  const { jobStore, jobLog, dir, id } = setUp();
  const row = jobStore.get(id)!;
  const messages: any[] = [];
  const tail = createForeignJobTail({
    jobStore,
    jobLog,
    jobId: id,
    initial: { offset: 0, row },
    send: (m) => messages.push(m),
    isPidAlive: () => true,
  });

  const logPath = jobLog.path(row.logFile);
  const bytes = Buffer.from('€', 'utf8'); // e2 82 ac -- a 3-byte UTF-8 sequence
  assert.equal(bytes.length, 3);

  appendFileSync(logPath, bytes.subarray(0, 2)); // incomplete sequence
  tail.tick();
  assert.deepEqual(
    messages.filter((m) => m.type === 'chunk'),
    []
  );

  appendFileSync(logPath, bytes.subarray(2, 3)); // completes the sequence
  tail.tick();
  const chunks = messages.filter((m) => m.type === 'chunk');
  assert.deepEqual(chunks, [{ type: 'chunk', stream: 'stdout', text: '€' }]);
  assert.ok(!chunks.some((m) => m.text.includes('�')));

  rmSync(dir, { recursive: true, force: true });
  jobStore.close();
});

test('stops watching once the owning MCP process has died, after sending remaining output, without inventing a status', () => {
  const { jobStore, jobLog, dir, id } = setUp();
  const row = jobStore.get(id)!;
  assert.equal(row.owner, 'mcp:4242');
  const messages: any[] = [];
  const tail = createForeignJobTail({
    jobStore,
    jobLog,
    jobId: id,
    initial: { offset: 0, row },
    send: (m) => messages.push(m),
    isPidAlive: () => false,
  });

  jobLog.append(row.logFile, 'partial output\n');
  tail.tick();

  assert.deepEqual(messages, [{ type: 'chunk', stream: 'stdout', text: 'partial output\n' }]);
  assert.equal(tail.stopped, true);
  // The row itself is untouched (FR-004: watching never modifies the job) --
  // still 'running', not flipped to some terminal status by the tail.
  assert.equal(jobStore.get(id)!.status, 'running');

  rmSync(dir, { recursive: true, force: true });
  jobStore.close();
});

test('keeps watching while the owning MCP process is still alive', () => {
  const { jobStore, jobLog, dir, id } = setUp();
  const row = jobStore.get(id)!;
  const messages: any[] = [];
  const tail = createForeignJobTail({
    jobStore,
    jobLog,
    jobId: id,
    initial: { offset: 0, row },
    send: (m) => messages.push(m),
    isPidAlive: () => true,
  });

  jobLog.append(row.logFile, 'still going\n');
  tail.tick();

  assert.deepEqual(messages, [{ type: 'chunk', stream: 'stdout', text: 'still going\n' }]);
  assert.equal(tail.stopped, false);

  rmSync(dir, { recursive: true, force: true });
  jobStore.close();
});

test('status changes, a prompt appearing/clearing, and a terminal status flush the log and stop the tail', () => {
  const { jobStore, jobLog, dir, id } = setUp();
  const row = jobStore.get(id)!;
  const messages: any[] = [];
  const tail = createForeignJobTail({
    jobStore,
    jobLog,
    jobId: id,
    initial: { offset: 0, row },
    send: (m) => messages.push(m),
    isPidAlive: () => true,
  });

  // Move to awaiting_input with a prompt -- expects a 'prompt' message with
  // origin defaulted to 'heuristic' (promptOrigin is null on this call).
  jobLog.append(row.logFile, 'Continue? (y/N) ');
  jobStore.markAwaitingInput(id, 'Continue? (y/N) ', 'heuristic', null);
  tail.tick();
  assert.equal(tail.stopped, false);
  assert.deepEqual(messages.filter((m) => m.type === 'chunk').pop(), {
    type: 'chunk',
    stream: 'stdout',
    text: 'Continue? (y/N) ',
  });
  const prompt = messages.find((m) => m.type === 'prompt');
  assert.ok(prompt, 'expected a prompt message');
  assert.equal(prompt.text, 'Continue? (y/N) ');
  assert.equal(prompt.origin, 'heuristic');
  assert.equal(prompt.matchedIndex, null);
  assert.deepEqual(prompt.expectedPrompts, []);
  assert.ok(messages.some((m) => m.type === 'status' && m.status === 'awaiting_input'));

  // Answered -> back to running: prompt clears, status changes back.
  messages.length = 0;
  jobStore.markRunning(id);
  tail.tick();
  assert.ok(messages.some((m) => m.type === 'prompt-cleared'));
  assert.deepEqual(
    messages.filter((m) => m.type === 'status'),
    [{ type: 'status', status: 'running' }]
  );

  // Finishes -- final log line must be flushed before the terminal status,
  // and the tail must stop; a later tick sends nothing more.
  messages.length = 0;
  jobLog.append(row.logFile, 'done\n');
  jobStore.markFinished(id, { status: 'success', exitCode: 0 });
  tail.tick();
  assert.deepEqual(messages, [
    { type: 'chunk', stream: 'stdout', text: 'done\n' },
    { type: 'status', status: 'success' },
  ]);
  assert.equal(tail.stopped, true);

  messages.length = 0;
  tail.tick();
  assert.deepEqual(messages, []);

  rmSync(dir, { recursive: true, force: true });
  jobStore.close();
});
