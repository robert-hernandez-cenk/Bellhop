import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { saveInventory, type Inventory } from '../../../src/lib/inventory.ts';
import { loadTaskSchedules, recordTaskRun, saveTaskSchedule, TIME_OF_DAY_ERROR } from '../../../src/lib/task-schedules.ts';
import { loadAppUpdateResults } from '../../../src/lib/app-update-store.ts';
import type { JobDefinition, JobRunner } from '../../../src/web/jobs/job-runner.ts';
import type { JobRow, JobStatus, JobStore } from '../../../src/web/jobs/job-store.ts';
import { TaskScheduler, UnknownTaskError, mostRecentSlot, nextSlot, type Ticker } from '../../../src/web/tasks/scheduler.ts';
import { TASKS } from '../../../src/web/tasks/registry.ts';
import { FakeSSHClient } from '../../support/fake-ssh-client.ts';

// Every date in this file is built with the local-time `new Date(y, m, d,
// hh, mm)` constructor -- the same one the scheduler itself uses -- so each
// assertion holds in whatever TZ the suite runs in, DST rules included.

const TASK_ID = 'check-app-updates';

function tempDbPath(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'task-scheduler-')), 'bellhop.db');
}

// Records every enqueued definition and hands out sequential ids; statuses
// live in the paired FakeJobStore so a test can move a job through its
// lifecycle without a real JobRunner.
class FakeJobs {
  defs: JobDefinition[] = [];
  statuses = new Map<number, JobStatus>();
  private nextId = 100;

  runner = {
    enqueue: (def: JobDefinition): number => {
      const id = this.nextId++;
      this.defs.push(def);
      this.statuses.set(id, 'queued');
      return id;
    },
  } as unknown as JobRunner;

  store = {
    get: (id: number): JobRow | undefined => {
      const status = this.statuses.get(id);
      return status ? ({ id, status } as JobRow) : undefined;
    },
  } as unknown as JobStore;
}

// A manual ticker: start() records the callback instead of arming a real
// timer, and fire() runs it on demand.
class ManualTicker implements Ticker {
  fn: (() => void) | undefined;
  ms: number | undefined;
  stopped = 0;
  start(fn: () => void, ms: number): unknown {
    this.fn = fn;
    this.ms = ms;
    return 'handle';
  }
  stop(handle: unknown): void {
    assert.equal(handle, 'handle');
    this.fn = undefined;
    this.stopped++;
  }
  fire(): void {
    this.fn?.();
  }
}

function setup(start: Date) {
  const dbPath = tempDbPath();
  const inventory: Inventory = { domain: 'example.com', hosts: [], guests: [] };
  saveInventory(dbPath, inventory);
  const jobs = new FakeJobs();
  const ticker = new ManualTicker();
  let current = start;
  const scheduler = new TaskScheduler({
    inventory,
    inventoryPath: dbPath,
    jobRunner: jobs.runner,
    jobStore: jobs.store,
    now: () => current,
    ticker,
  });
  return {
    dbPath,
    jobs,
    ticker,
    scheduler,
    setNow: (d: Date) => {
      current = d;
    },
  };
}

// --- slot math ---

test('mostRecentSlot is today once the time has passed, yesterday before it', () => {
  assert.deepEqual(mostRecentSlot(new Date(2026, 9, 3, 3, 59), '04:00'), new Date(2026, 9, 2, 4, 0));
  assert.deepEqual(mostRecentSlot(new Date(2026, 9, 3, 4, 0), '04:00'), new Date(2026, 9, 3, 4, 0));
  assert.deepEqual(mostRecentSlot(new Date(2026, 9, 3, 18, 0), '04:00'), new Date(2026, 9, 3, 4, 0));
  // Across a month boundary.
  assert.deepEqual(mostRecentSlot(new Date(2026, 10, 1, 1, 0), '04:00'), new Date(2026, 9, 31, 4, 0));
});

test('nextSlot is the first slot strictly after the given instant', () => {
  assert.deepEqual(nextSlot(new Date(2026, 9, 3, 3, 59), '04:00'), new Date(2026, 9, 3, 4, 0));
  assert.deepEqual(nextSlot(new Date(2026, 9, 3, 4, 0), '04:00'), new Date(2026, 9, 4, 4, 0));
  assert.deepEqual(nextSlot(new Date(2026, 9, 3, 18, 0), '04:00'), new Date(2026, 9, 4, 4, 0));
  assert.deepEqual(nextSlot(new Date(2026, 11, 31, 5, 0), '04:00'), new Date(2027, 0, 1, 4, 0));
});

// Walks a whole year slot by slot: whichever days are DST transitions in
// this process's TZ (spring-forward, where 02:30 doesn't exist; fall-back,
// where 01:30 happens twice), each calendar day still yields exactly one
// slot, equal to what the local constructor gives for that day.
for (const time of ['02:30', '01:30', '04:00', '00:00', '23:59']) {
  test(`every calendar day of a year yields exactly one ${time} slot, DST days included`, () => {
    const [hh, mm] = time.split(':').map(Number);
    let slot = nextSlot(new Date(2026, 11, 31, hh, mm), time);
    for (let day = 1; day <= 365; day++) {
      const expected = new Date(2027, 0, day, hh, mm);
      assert.deepEqual(slot, expected, `day ${day}`);
      // The most recent slot as seen from just after this slot is this slot.
      assert.deepEqual(mostRecentSlot(new Date(slot.getTime() + 60_000), time), expected, `day ${day} (mostRecent)`);
      slot = nextSlot(slot, time);
    }
    assert.deepEqual(slot, new Date(2028, 0, 1, hh, mm));
  });
}

test('US spring-forward and fall-back days each yield one slot (TZ-independent expectations)', () => {
  // 2026-03-08 and 2026-11-01 are the US transitions; elsewhere they are
  // ordinary days, and the assertions hold either way.
  assert.deepEqual(mostRecentSlot(new Date(2026, 2, 8, 12, 0), '02:30'), new Date(2026, 2, 8, 2, 30));
  assert.deepEqual(nextSlot(new Date(2026, 2, 7, 12, 0), '02:30'), new Date(2026, 2, 8, 2, 30));
  assert.deepEqual(mostRecentSlot(new Date(2026, 10, 1, 12, 0), '01:30'), new Date(2026, 10, 1, 1, 30));
  assert.deepEqual(nextSlot(new Date(2026, 9, 31, 12, 0), '01:30'), new Date(2026, 10, 1, 1, 30));
  assert.deepEqual(nextSlot(new Date(2026, 10, 1, 1, 30), '01:30'), new Date(2026, 10, 2, 1, 30));
});

// --- tick behavior ---

test('the first tick on a fresh database starts a run', () => {
  const { scheduler, jobs } = setup(new Date(2026, 9, 3, 10, 0));
  scheduler.tick();
  assert.equal(jobs.defs.length, 1);
});

test('start() ticks once immediately and arms a 60s ticker', () => {
  const { scheduler, jobs, ticker } = setup(new Date(2026, 9, 3, 10, 0));
  scheduler.start();
  assert.equal(jobs.defs.length, 1);
  assert.equal(ticker.ms, 60_000);
  assert.ok(ticker.fn);
});

test('last run yesterday 04:00 -> runs at today 04:00, not at 03:59', () => {
  const { scheduler, jobs, ticker, dbPath, setNow } = setup(new Date(2026, 9, 3, 3, 59));
  recordTaskRun(dbPath, TASK_ID, { startedAt: new Date(2026, 9, 2, 4, 0, 5).toISOString(), jobId: 1 }, '04:00');
  jobs.statuses.set(1, 'success');
  scheduler.start();
  assert.equal(jobs.defs.length, 0);
  setNow(new Date(2026, 9, 3, 4, 0));
  ticker.fire();
  assert.equal(jobs.defs.length, 1);
  // The next minute's tick sees today's run recorded and does nothing.
  jobs.statuses.set(100, 'success');
  setNow(new Date(2026, 9, 3, 4, 1));
  ticker.fire();
  assert.equal(jobs.defs.length, 1);
});

test('an outage across 04:00 -> one catch-up run on start()', () => {
  const { scheduler, jobs, ticker, dbPath, setNow } = setup(new Date(2026, 9, 3, 6, 0));
  recordTaskRun(dbPath, TASK_ID, { startedAt: new Date(2026, 9, 2, 4, 0, 5).toISOString(), jobId: 1 }, '04:00');
  jobs.statuses.set(1, 'success');
  scheduler.start();
  assert.equal(jobs.defs.length, 1);
  jobs.statuses.set(100, 'success');
  setNow(new Date(2026, 9, 3, 6, 1));
  ticker.fire();
  assert.equal(jobs.defs.length, 1);
});

test('already ran today -> no run after a restart', () => {
  const { scheduler, jobs, dbPath } = setup(new Date(2026, 9, 3, 10, 0));
  recordTaskRun(dbPath, TASK_ID, { startedAt: new Date(2026, 9, 3, 4, 0, 5).toISOString(), jobId: 1 }, '04:00');
  jobs.statuses.set(1, 'success');
  scheduler.start();
  assert.equal(jobs.defs.length, 0);
});

test('disabled -> no run', () => {
  const { scheduler, jobs, dbPath } = setup(new Date(2026, 9, 3, 10, 0));
  saveTaskSchedule(dbPath, TASK_ID, { timeOfDay: '04:00', enabled: false });
  scheduler.start();
  assert.equal(jobs.defs.length, 0);
});

for (const status of ['queued', 'running', 'awaiting_input'] as const) {
  test(`an active (${status}) job -> no second run`, () => {
    const { scheduler, jobs, dbPath } = setup(new Date(2026, 9, 3, 10, 0));
    // Last started yesterday, so the slot is due -- only the active job blocks it.
    recordTaskRun(dbPath, TASK_ID, { startedAt: new Date(2026, 9, 2, 4, 0).toISOString(), jobId: 1 }, '04:00');
    jobs.statuses.set(1, status);
    scheduler.tick();
    assert.equal(jobs.defs.length, 0);
    assert.deepEqual(scheduler.startRun(TASK_ID, { triggeredByUsername: 'admin' }), { alreadyRunning: 1 });
    assert.equal(jobs.defs.length, 0);
  });
}

for (const status of ['success', 'failed', 'cancelled', 'interrupted'] as const) {
  test(`a finished (${status}) job -> eligible again`, () => {
    const { scheduler, jobs, dbPath } = setup(new Date(2026, 9, 3, 10, 0));
    recordTaskRun(dbPath, TASK_ID, { startedAt: new Date(2026, 9, 2, 4, 0).toISOString(), jobId: 1 }, '04:00');
    jobs.statuses.set(1, status);
    scheduler.tick();
    assert.equal(jobs.defs.length, 1);
  });
}

test('a recorded job whose row is gone does not count as active', () => {
  const { scheduler, jobs, dbPath } = setup(new Date(2026, 9, 3, 10, 0));
  recordTaskRun(dbPath, TASK_ID, { startedAt: new Date(2026, 9, 2, 4, 0).toISOString(), jobId: 1 }, '04:00');
  scheduler.tick();
  assert.equal(jobs.defs.length, 1);
});

test('startRun records lastRunStartedAt and lastJobId', () => {
  const now = new Date(2026, 9, 3, 10, 0);
  const { scheduler, dbPath } = setup(now);
  assert.deepEqual(scheduler.startRun(TASK_ID, { triggeredByUsername: 'admin' }), { jobId: 100 });
  const schedule = loadTaskSchedules(dbPath, TASKS).get(TASK_ID)!;
  assert.equal(schedule.lastRunStartedAt, now.toISOString());
  assert.equal(schedule.lastJobId, 100);
});

test('startRun works while the task is disabled (Run now), and passes manual attribution through', () => {
  const { scheduler, jobs, dbPath } = setup(new Date(2026, 9, 3, 10, 0));
  saveTaskSchedule(dbPath, TASK_ID, { timeOfDay: '04:00', enabled: false });
  scheduler.startRun(TASK_ID, { triggeredByUsername: 'admin', triggeredByImpersonating: 'viewers' });
  assert.equal(jobs.defs[0].triggeredByUsername, 'admin');
  assert.equal(jobs.defs[0].triggeredByImpersonating, 'viewers');
});

test("the scheduled job is check-app-updates, targetless, triggered by 'scheduler'", () => {
  const { scheduler, jobs } = setup(new Date(2026, 9, 3, 10, 0));
  scheduler.tick();
  const def = jobs.defs[0];
  assert.equal(def.command, 'check-app-updates');
  assert.equal(def.category, 'maintenance');
  assert.equal(def.target, undefined);
  assert.equal(def.argsJson, '{}');
  assert.equal(def.triggeredByUsername, 'scheduler');
  assert.equal(def.triggeredByImpersonating, undefined);
});

test('stop() clears the ticker, and a second start() after stop re-arms it', () => {
  const { scheduler, ticker } = setup(new Date(2026, 9, 3, 10, 0));
  scheduler.start();
  scheduler.start(); // idempotent: no second interval
  scheduler.stop();
  assert.equal(ticker.stopped, 1);
  assert.equal(ticker.fn, undefined);
  scheduler.stop(); // no-op once stopped
  assert.equal(ticker.stopped, 1);
});

test('a throwing tick is logged, not thrown (it runs from a timer callback)', () => {
  const { scheduler, ticker } = setup(new Date(2026, 9, 3, 10, 0));
  // Point the scheduler at a path that can't be opened as a database.
  (scheduler as unknown as { deps: { inventoryPath: string } }).deps.inventoryPath = mkdtempSync(path.join(tmpdir(), 'not-a-db-'));
  scheduler.start();
  assert.doesNotThrow(() => ticker.fire());
});

// --- views and schedule edits ---

test('listTasks returns the TaskView shape for a never-run task', () => {
  const { scheduler } = setup(new Date(2026, 9, 3, 10, 0));
  const [view] = scheduler.listTasks();
  assert.deepEqual(view, {
    id: 'check-app-updates',
    label: 'App update check',
    description: "Checks each LXC guest's community-scripts app for a newer upstream release.",
    timeOfDay: '04:00',
    defaultTime: '04:00',
    enabled: true,
    running: false,
    lastRun: null,
    nextRun: new Date(2026, 9, 4, 4, 0).toISOString(),
  });
});

test('listTasks reports the last run, its live status, and running', () => {
  const { scheduler, jobs } = setup(new Date(2026, 9, 3, 10, 0));
  scheduler.tick();
  let view = scheduler.getTask(TASK_ID);
  assert.deepEqual(view.lastRun, { startedAt: new Date(2026, 9, 3, 10, 0).toISOString(), jobId: 100, status: 'queued' });
  assert.equal(view.running, true);
  jobs.statuses.set(100, 'success');
  view = scheduler.getTask(TASK_ID);
  assert.equal(view.lastRun!.status, 'success');
  assert.equal(view.running, false);
  jobs.statuses.delete(100);
  assert.equal(scheduler.getTask(TASK_ID).lastRun!.status, null);
});

test('nextRun is the next slot after max(now, lastRunStartedAt), and null when disabled', () => {
  const { scheduler, dbPath, setNow } = setup(new Date(2026, 9, 3, 3, 0));
  assert.equal(scheduler.getTask(TASK_ID).nextRun, new Date(2026, 9, 3, 4, 0).toISOString());
  setNow(new Date(2026, 9, 3, 10, 0));
  assert.equal(scheduler.getTask(TASK_ID).nextRun, new Date(2026, 9, 4, 4, 0).toISOString());
  saveTaskSchedule(dbPath, TASK_ID, { timeOfDay: '04:00', enabled: false });
  assert.equal(scheduler.getTask(TASK_ID).nextRun, null);
});

test('updateSchedule saves, returns the recomputed view, and keeps the run columns', () => {
  const { scheduler, dbPath } = setup(new Date(2026, 9, 3, 10, 0));
  recordTaskRun(dbPath, TASK_ID, { startedAt: new Date(2026, 9, 3, 4, 0).toISOString(), jobId: 1 }, '04:00');
  const view = scheduler.updateSchedule(TASK_ID, { timeOfDay: '18:30' });
  assert.equal(view.timeOfDay, '18:30');
  assert.equal(view.enabled, true);
  // Today already ran at 04:00, so today's 18:30 slot is skipped (research R8).
  assert.equal(view.nextRun, new Date(2026, 9, 4, 18, 30).toISOString());
  assert.equal(view.lastRun!.jobId, 1);
  const disabled = scheduler.updateSchedule(TASK_ID, { enabled: false });
  assert.equal(disabled.timeOfDay, '18:30');
  assert.equal(disabled.nextRun, null);
});

test('updateSchedule rejects a malformed time with the exact message and saves nothing', () => {
  const { scheduler, dbPath } = setup(new Date(2026, 9, 3, 10, 0));
  assert.throws(() => scheduler.updateSchedule(TASK_ID, { timeOfDay: '4:00', enabled: false }), { message: TIME_OF_DAY_ERROR });
  assert.deepEqual(loadTaskSchedules(dbPath, TASKS).get(TASK_ID)!.enabled, true);
});

test('moving the time earlier on a day that already ran does not trigger another run', () => {
  const { scheduler, jobs, dbPath } = setup(new Date(2026, 9, 3, 10, 0));
  recordTaskRun(dbPath, TASK_ID, { startedAt: new Date(2026, 9, 3, 9, 0).toISOString(), jobId: 1 }, '09:00');
  jobs.statuses.set(1, 'success');
  scheduler.updateSchedule(TASK_ID, { timeOfDay: '08:00' });
  scheduler.tick();
  assert.equal(jobs.defs.length, 0);
  // ...and neither does moving it later than the last run (and past now):
  // today already had its run (research R8's same-day rule).
  scheduler.updateSchedule(TASK_ID, { timeOfDay: '09:30' });
  scheduler.tick();
  assert.equal(jobs.defs.length, 0);
});

// --- one run per local calendar day (final review RULING, research R8) ---

test('ran at 04:00, time moved to 06:00 at 05:00 -> no run at 06:00 today, one at 06:00 tomorrow', () => {
  const { scheduler, jobs, ticker, setNow } = setup(new Date(2026, 9, 2, 12, 0));
  // Today's 04:00 run.
  setNow(new Date(2026, 9, 3, 4, 0));
  scheduler.start();
  assert.equal(jobs.defs.length, 1);
  jobs.statuses.set(100, 'success');
  setNow(new Date(2026, 9, 3, 5, 0));
  const view = scheduler.updateSchedule(TASK_ID, { timeOfDay: '06:00' });
  assert.equal(view.nextRun, new Date(2026, 9, 4, 6, 0).toISOString());
  setNow(new Date(2026, 9, 3, 6, 0));
  ticker.fire();
  setNow(new Date(2026, 9, 3, 23, 59));
  ticker.fire();
  assert.equal(jobs.defs.length, 1);
  setNow(new Date(2026, 9, 4, 5, 59));
  ticker.fire();
  assert.equal(jobs.defs.length, 1);
  setNow(new Date(2026, 9, 4, 6, 0));
  ticker.fire();
  assert.equal(jobs.defs.length, 2);
});

test('Run now at 03:00 with a 04:00 schedule -> no 04:00 run that day', () => {
  const { scheduler, jobs, ticker, dbPath, setNow } = setup(new Date(2026, 9, 3, 3, 0));
  recordTaskRun(dbPath, TASK_ID, { startedAt: new Date(2026, 9, 2, 4, 0).toISOString(), jobId: 1 }, '04:00');
  jobs.statuses.set(1, 'success');
  scheduler.start();
  assert.equal(jobs.defs.length, 0);
  assert.deepEqual(scheduler.startRun(TASK_ID, { triggeredByUsername: 'admin' }), { jobId: 100 });
  jobs.statuses.set(100, 'success');
  assert.equal(scheduler.getTask(TASK_ID).nextRun, new Date(2026, 9, 4, 4, 0).toISOString());
  setNow(new Date(2026, 9, 3, 4, 0));
  ticker.fire();
  assert.equal(jobs.defs.length, 1);
  setNow(new Date(2026, 9, 4, 4, 0));
  ticker.fire();
  assert.equal(jobs.defs.length, 2);
});

test('a multi-day outage still catches up with exactly one run', () => {
  const { scheduler, jobs, ticker, dbPath, setNow } = setup(new Date(2026, 9, 5, 10, 0));
  recordTaskRun(dbPath, TASK_ID, { startedAt: new Date(2026, 9, 2, 4, 0).toISOString(), jobId: 1 }, '04:00');
  jobs.statuses.set(1, 'success');
  scheduler.start();
  assert.equal(jobs.defs.length, 1);
  jobs.statuses.set(100, 'success');
  setNow(new Date(2026, 9, 5, 10, 1));
  ticker.fire();
  setNow(new Date(2026, 9, 5, 23, 59));
  ticker.fire();
  assert.equal(jobs.defs.length, 1);
});

// --- a failed run record (final review) ---

test('a run whose DB record fails to save is not started again by later ticks', () => {
  const dbPath = tempDbPath();
  const inventory: Inventory = { domain: 'example.com', hosts: [], guests: [] };
  saveInventory(dbPath, inventory);
  const jobs = new FakeJobs();
  const ticker = new ManualTicker();
  let current = new Date(2026, 9, 3, 10, 0);
  let recordCalls = 0;
  const scheduler = new TaskScheduler({
    inventory,
    inventoryPath: dbPath,
    jobRunner: jobs.runner,
    jobStore: jobs.store,
    now: () => current,
    ticker,
    recordRun: () => {
      recordCalls++;
      throw new Error('database is locked');
    },
  });
  const warnings: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => warnings.push(args.join(' '));
  try {
    scheduler.start();
    assert.equal(jobs.defs.length, 1);
    assert.equal(recordCalls, 1);
    assert.match(warnings.join('\n'), /could not record the run of check-app-updates \(job 100\): database is locked/);
    // Still running: the in-memory record makes it active.
    current = new Date(2026, 9, 3, 10, 1);
    ticker.fire();
    assert.equal(jobs.defs.length, 1);
    assert.deepEqual(scheduler.startRun(TASK_ID, { triggeredByUsername: 'admin' }), { alreadyRunning: 100 });
    // Finished: the in-memory start time means today already ran.
    jobs.statuses.set(100, 'success');
    current = new Date(2026, 9, 3, 10, 2);
    ticker.fire();
    assert.equal(jobs.defs.length, 1);
    assert.equal(scheduler.getTask(TASK_ID).lastRun!.jobId, 100);
  } finally {
    console.error = original;
  }
});

test('startRun hands the job signal to the task run', async () => {
  const dbPath = tempDbPath();
  const inventory: Inventory = { domain: 'example.com', hosts: [], guests: [] };
  saveInventory(dbPath, inventory);
  const jobs = new FakeJobs();
  let seen: AbortSignal | undefined;
  const scheduler = new TaskScheduler({
    inventory,
    inventoryPath: dbPath,
    jobRunner: jobs.runner,
    jobStore: jobs.store,
    now: () => new Date(2026, 9, 3, 10, 0),
    ticker: new ManualTicker(),
    tasks: [
      {
        id: 'probe',
        label: 'Probe',
        description: 'Test task',
        defaultTime: '04:00',
        command: 'probe',
        run: async (ctx) => {
          seen = ctx.signal;
        },
      },
    ],
  });
  scheduler.startRun('probe', {});
  const controller = new AbortController();
  await jobs.defs[0].run(new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 })), controller.signal);
  assert.equal(seen, controller.signal);
});

test('unknown task ids throw UnknownTaskError with the contract message', () => {
  const { scheduler } = setup(new Date(2026, 9, 3, 10, 0));
  for (const call of [
    () => scheduler.getTask('nope'),
    () => scheduler.startRun('nope', {}),
    () => scheduler.updateSchedule('nope', { enabled: false }),
  ]) {
    assert.throws(call, (err: unknown) => err instanceof UnknownTaskError && err.message === 'Unknown task: nope');
  }
});

// --- the registered task's own run ---

test("check-app-updates' run refreshes inventory, saves results, and logs the formatted lines", async () => {
  const dbPath = tempDbPath();
  const onDisk: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: '192.0.2.10', ssh_user: 'root' }],
    guests: [{ name: 'media', type: 'lxc', vmid: 101, host: 'pve1', app: 'jellyfin' }],
  };
  saveInventory(dbPath, onDisk);
  // A stale in-memory copy: the run must reload it from disk first.
  const inventory: Inventory = { domain: 'example.com', hosts: [], guests: [] };
  const ssh = new FakeSSHClient((_t, _u, command) => {
    if (command.includes('/lxc ')) return { stdout: JSON.stringify([{ vmid: 101, status: 'stopped' }]), stderr: '', code: 0 };
    return { stdout: '[]', stderr: '', code: 0 };
  });
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(' '));
  try {
    const task = TASKS.find((t) => t.id === TASK_ID)!;
    await task.run({
      ssh,
      inventory,
      inventoryPath: dbPath,
      fetchImpl: (() => {
        throw new Error('no network in tests');
      }) as unknown as typeof fetch,
      now: () => new Date(2026, 9, 3, 4, 0),
    });
  } finally {
    console.log = original;
  }
  assert.equal(inventory.guests.length, 1);
  const saved = loadAppUpdateResults(dbPath);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].status, 'not-checked');
  assert.match(lines.join('\n'), /media\s+jellyfin\s+/);
});
