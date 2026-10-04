import type { Inventory } from '../../lib/inventory.ts';
import { logWarn } from '../../lib/log.ts';
import {
  loadTaskSchedules,
  recordTaskRun,
  saveTaskSchedule,
  isValidTimeOfDay,
  TIME_OF_DAY_ERROR,
  type TaskSchedule,
} from '../../lib/task-schedules.ts';
import type { JobRunner } from '../jobs/job-runner.ts';
import type { JobStatus, JobStore } from '../jobs/job-store.ts';
import { TASKS, type TaskDefinition } from './registry.ts';

// --- slot math (research R8) ---
//
// Slots are built with the local-time `new Date(y, m, d, hh, mm)`
// constructor. JS normalizes a nonexistent spring-forward time forward and
// resolves an ambiguous fall-back time to one instant, so every calendar
// day yields exactly one slot.

function parseTime(hhmm: string): [number, number] {
  const [hh, mm] = hhmm.split(':').map(Number);
  return [hh, mm];
}

function slotOn(day: Date, hhmm: string, dayOffset: number): Date {
  const [hh, mm] = parseTime(hhmm);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + dayOffset, hh, mm);
}

// Today's slot if it has come (inclusive), else yesterday's.
export function mostRecentSlot(now: Date, hhmm: string): Date {
  const today = slotOn(now, hhmm, 0);
  return today.getTime() <= now.getTime() ? today : slotOn(now, hhmm, -1);
}

// The first slot strictly after `after`.
export function nextSlot(after: Date, hhmm: string): Date {
  const today = slotOn(after, hhmm, 0);
  return today.getTime() > after.getTime() ? today : slotOn(after, hhmm, 1);
}

// True when `a` falls on an earlier local calendar day than `b`.
function isEarlierLocalDay(a: Date, b: Date): boolean {
  const day = (d: Date) => d.getFullYear() * 10_000 + d.getMonth() * 100 + d.getDate();
  return day(a) < day(b);
}

// Whether a slot is still owed a run, given when the last run (scheduled or
// Run now) started. Two rules, both required (research R8): the slot came
// after the last start, and the last start was on an earlier local calendar
// day than the slot. The second is what keeps the schedule to one run per
// day when the time is moved later after today's run already happened, or
// when Run now ran shortly before today's slot.
export function slotIsDue(slot: Date, lastRunStartedAt: Date | null): boolean {
  if (!lastRunStartedAt) return true;
  return slot.getTime() > lastRunStartedAt.getTime() && isEarlierLocalDay(lastRunStartedAt, slot);
}

// --- scheduler ---

const ACTIVE_STATUSES: readonly JobStatus[] = ['queued', 'running', 'awaiting_input'];
const DEFAULT_TICK_MS = 60_000;

// Thrown by getTask/startRun/updateSchedule for an id no registered task
// has. The route layer maps `instanceof UnknownTaskError` to 404; the
// message is already the contract's `Unknown task: <id>` body.
export class UnknownTaskError extends Error {
  constructor(id: string) {
    super(`Unknown task: ${id}`);
    this.name = 'UnknownTaskError';
  }
}

// setInterval/clearInterval-shaped, injected so tests drive ticks by hand
// instead of waiting on a real timer.
export interface Ticker {
  start(fn: () => void, ms: number): unknown;
  stop(handle: unknown): void;
}

const realTicker: Ticker = {
  start(fn, ms) {
    const timer = setInterval(fn, ms);
    // Never the reason the process stays alive -- the HTTP server is.
    timer.unref();
    return timer;
  },
  stop(handle) {
    clearInterval(handle as NodeJS.Timeout);
  },
};

// data-model.md's TaskView: the GET /api/tasks shape.
export interface TaskView {
  id: string;
  label: string;
  description: string;
  timeOfDay: string;
  defaultTime: string;
  enabled: boolean;
  running: boolean;
  lastRun: { startedAt: string; jobId: number; status: JobStatus | null } | null;
  nextRun: string | null;
}

export interface TaskAttribution {
  triggeredByUsername?: string;
  triggeredByImpersonating?: string;
}

export type StartRunResult = { jobId: number } | { alreadyRunning: number };

export interface TaskSchedulerDeps {
  inventory: Inventory;
  // bellhop.db -- task_schedules lives beside the inventory tables.
  inventoryPath: string;
  jobRunner: Pick<JobRunner, 'enqueue'>;
  jobStore: Pick<JobStore, 'get'>;
  tasks?: readonly TaskDefinition[];
  now?: () => Date;
  ticker?: Ticker;
  tickMs?: number;
  fetchImpl?: typeof fetch;
  // Test hook: replaces the task_schedules write startRun makes after
  // enqueueing, so a test can make it throw.
  recordRun?: typeof recordTaskRun;
}

// The last run this process started for one task. Consulted alongside the
// task_schedules row, so a run whose DB record failed to save still counts
// as started -- otherwise every tick would enqueue a duplicate.
interface StartedRun {
  startedAt: string;
  jobId: number;
}

// Only src/web/server.ts constructs one (FR-006) -- the MCP server and CLI
// never run tasks on a schedule. Every read goes straight to the database
// (a handful of rows, once a minute), so a schedule edited by any route or
// a direct DB edit takes effect on the next tick with no cache to go stale.
export class TaskScheduler {
  private readonly tasks: readonly TaskDefinition[];
  private readonly now: () => Date;
  private readonly ticker: Ticker;
  private readonly tickMs: number;
  private readonly recordRun: typeof recordTaskRun;
  private readonly startedRuns = new Map<string, StartedRun>();
  private deps: TaskSchedulerDeps;
  private handle: unknown;
  private started = false;

  constructor(deps: TaskSchedulerDeps) {
    this.deps = deps;
    this.recordRun = deps.recordRun ?? recordTaskRun;
    this.tasks = deps.tasks ?? TASKS;
    this.now = deps.now ?? (() => new Date());
    this.ticker = deps.ticker ?? realTicker;
    this.tickMs = deps.tickMs ?? DEFAULT_TICK_MS;
  }

  // Arms the minute ticker and ticks once right away, so a run missed while
  // the service was down starts within seconds of startup (FR-003, SC-003).
  // Must run after JobRunner.reconcileOrphanedJobs(), so a previous
  // process's still-"running" row is already interrupted and can't block
  // the catch-up run as "active". Idempotent.
  start(): void {
    if (this.started) return;
    this.started = true;
    this.handle = this.ticker.start(() => this.tick(), this.tickMs);
    this.tick();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.ticker.stop(this.handle);
    this.handle = undefined;
  }

  // Starts every enabled task whose most recent slot is still due (see
  // slotIsDue), unless a run is still active. Runs from a timer callback,
  // where a throw would be an uncaughtException -- so nothing escapes; a
  // failure is logged and the next tick tries again.
  tick(): void {
    let schedules: Map<string, TaskSchedule>;
    try {
      schedules = this.loadSchedules();
    } catch (err) {
      logWarn(`Task scheduler tick failed to read schedules: ${errMsg(err)}`);
      return;
    }
    const now = this.now();
    for (const task of this.tasks) {
      try {
        const schedule = schedules.get(task.id)!;
        if (!schedule.enabled) continue;
        const slot = mostRecentSlot(now, schedule.timeOfDay);
        const last = schedule.lastRunStartedAt ? new Date(schedule.lastRunStartedAt) : null;
        if (!slotIsDue(slot, last)) continue;
        this.startRun(task.id, { triggeredByUsername: 'scheduler' });
      } catch (err) {
        logWarn(`Task scheduler failed to start ${task.id}: ${errMsg(err)}`);
      }
    }
  }

  // The one way a run starts, scheduled or "Run now" (FR-004): refuses while
  // the last recorded run is still active, otherwise enqueues the job and
  // records it in the same synchronous call, so no second start can slip in
  // between. Runs regardless of `enabled` -- disabling only stops the
  // schedule, not a manual run. The in-memory record is set before the DB
  // write, so a failed write is only logged: this process still knows the
  // run started and won't enqueue it again.
  startRun(taskId: string, attribution: TaskAttribution): StartRunResult {
    const task = this.findTask(taskId);
    const schedule = this.loadSchedules().get(task.id)!;
    const activeJob = this.activeJobId(schedule);
    if (activeJob !== null) return { alreadyRunning: activeJob };

    const { inventory, inventoryPath, fetchImpl } = this.deps;
    const now = this.now;
    const jobId = this.deps.jobRunner.enqueue({
      command: task.command,
      category: 'maintenance',
      target: undefined,
      argsJson: '{}',
      triggeredByUsername: attribution.triggeredByUsername,
      triggeredByImpersonating: attribution.triggeredByImpersonating,
      run: (ssh, signal) => task.run({ ssh, inventory, inventoryPath, fetchImpl, now, signal }),
    });
    const run = { startedAt: this.now().toISOString(), jobId };
    this.startedRuns.set(task.id, run);
    try {
      this.recordRun(inventoryPath, task.id, run, task.defaultTime);
    } catch (err) {
      logWarn(`Task scheduler could not record the run of ${task.id} (job ${jobId}): ${errMsg(err)}`);
    }
    return { jobId };
  }

  listTasks(): TaskView[] {
    const schedules = this.loadSchedules();
    return this.tasks.map((task) => this.view(task, schedules.get(task.id)!));
  }

  getTask(taskId: string): TaskView {
    const task = this.findTask(taskId);
    return this.view(task, this.loadSchedules().get(task.id)!);
  }

  // PATCH /api/tasks/:id's write: merges the given fields over the current
  // schedule and returns the recomputed view. Leaves the run columns alone,
  // so moving the time earlier on a day that already ran doesn't trigger a
  // second run (research R8). Throws TIME_OF_DAY_ERROR on a malformed time
  // before anything is saved.
  updateSchedule(taskId: string, patch: { timeOfDay?: string; enabled?: boolean }): TaskView {
    const task = this.findTask(taskId);
    if (patch.timeOfDay !== undefined && !isValidTimeOfDay(patch.timeOfDay)) throw new Error(TIME_OF_DAY_ERROR);
    const current = this.loadSchedules().get(task.id)!;
    saveTaskSchedule(this.deps.inventoryPath, task.id, {
      timeOfDay: patch.timeOfDay ?? current.timeOfDay,
      enabled: patch.enabled ?? current.enabled,
    });
    return this.getTask(task.id);
  }

  private findTask(taskId: string): TaskDefinition {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task) throw new UnknownTaskError(taskId);
    return task;
  }

  // The DB rows, each overlaid with this process's own record of the task's
  // last start when that one is newer (a failed recordRun, see startRun).
  private loadSchedules(): Map<string, TaskSchedule> {
    const schedules = loadTaskSchedules(this.deps.inventoryPath, this.tasks);
    for (const [taskId, run] of this.startedRuns) {
      const schedule = schedules.get(taskId);
      if (!schedule) continue;
      if (schedule.lastRunStartedAt === null || run.startedAt > schedule.lastRunStartedAt) {
        schedules.set(taskId, { ...schedule, lastRunStartedAt: run.startedAt, lastJobId: run.jobId });
      }
    }
    return schedules;
  }

  // "Active" is the last recorded job's live row status. A job row that no
  // longer exists, or a previous process's row reconcileOrphanedJobs already
  // marked interrupted, never blocks a new run.
  private activeJobId(schedule: TaskSchedule): number | null {
    if (schedule.lastJobId === null) return null;
    const status = this.deps.jobStore.get(schedule.lastJobId)?.status;
    return status && ACTIVE_STATUSES.includes(status) ? schedule.lastJobId : null;
  }

  private view(task: TaskDefinition, schedule: TaskSchedule): TaskView {
    const status =
      schedule.lastJobId !== null ? (this.deps.jobStore.get(schedule.lastJobId)?.status ?? null) : null;
    const lastRun =
      schedule.lastRunStartedAt !== null && schedule.lastJobId !== null
        ? { startedAt: schedule.lastRunStartedAt, jobId: schedule.lastJobId, status }
        : null;
    let nextRun: string | null = null;
    if (schedule.enabled) {
      const now = this.now();
      const last = schedule.lastRunStartedAt ? new Date(schedule.lastRunStartedAt) : null;
      const after = last && last.getTime() > now.getTime() ? last : now;
      let next = nextSlot(after, schedule.timeOfDay);
      // A slot on the same day as the last run is skipped (slotIsDue).
      while (!slotIsDue(next, last)) next = nextSlot(next, schedule.timeOfDay);
      nextRun = next.toISOString();
    }
    return {
      id: task.id,
      label: task.label,
      description: task.description,
      timeOfDay: schedule.timeOfDay,
      defaultTime: task.defaultTime,
      enabled: schedule.enabled,
      running: status !== null && ACTIVE_STATUSES.includes(status),
      lastRun,
      nextRun,
    };
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
