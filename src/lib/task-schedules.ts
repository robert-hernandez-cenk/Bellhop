import Database from 'better-sqlite3';
import { openDb } from './sqlite.ts';

// One scheduled task's persisted state (data-model.md's task_schedules
// row). `lastRunStartedAt`/`lastJobId` are null until the first run is
// enqueued -- a missing row reads as the task's default time, enabled,
// never run (FR-002), so a fresh install needs no seeding step.
export interface TaskSchedule {
  timeOfDay: string;
  enabled: boolean;
  lastRunStartedAt: string | null;
  lastJobId: number | null;
}

// The one HH:MM rule every writer shares -- saveTaskSchedule below and the
// scheduler's updateSchedule (and so the PATCH /api/tasks/:id route), so a
// value rejected by one is rejected identically by the others.
const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
export const TIME_OF_DAY_ERROR = 'timeOfDay must be HH:MM in 24-hour time, e.g. 04:00';

export function isValidTimeOfDay(value: string): boolean {
  return TIME_OF_DAY_PATTERN.test(value);
}

// Lives in bellhop.db beside the inventory, outside saveInventory's
// delete-and-reinsert list -- same precedent as app_update_status/
// script_catalog/permission_groups. SQLite has no built-in REGEXP, so the
// CHECK is the GLOB shape plus a string upper bound: with exactly two
// digits each side, '24:00' and above sort after '23:59'.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS task_schedules (
    task_id TEXT PRIMARY KEY,
    time_of_day TEXT NOT NULL CHECK (time_of_day GLOB '[0-2][0-9]:[0-5][0-9]' AND time_of_day <= '23:59'),
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    last_run_started_at TEXT,
    last_job_id INTEGER
  );
`;

function openTaskDb(dbPath: string): Database.Database {
  return openDb(dbPath, SCHEMA);
}

interface TaskScheduleRow {
  task_id: string;
  time_of_day: string;
  enabled: number;
  last_run_started_at: string | null;
  last_job_id: number | null;
}

// Every known task's schedule, keyed by id, in `tasks` order. A row for an
// id not in `tasks` (a task since removed from the registry) is ignored
// rather than surfaced or deleted -- harmless, and it comes back into use
// unchanged if the id is ever registered again.
export function loadTaskSchedules(
  dbPath: string,
  tasks: readonly { id: string; defaultTime: string }[]
): Map<string, TaskSchedule> {
  const db = openTaskDb(dbPath);
  let rows: TaskScheduleRow[];
  try {
    rows = db.prepare('SELECT * FROM task_schedules').all() as TaskScheduleRow[];
  } finally {
    db.close();
  }
  const byId = new Map(rows.map((r) => [r.task_id, r]));
  const result = new Map<string, TaskSchedule>();
  for (const task of tasks) {
    const row = byId.get(task.id);
    result.set(
      task.id,
      row
        ? {
            timeOfDay: row.time_of_day,
            enabled: row.enabled === 1,
            lastRunStartedAt: row.last_run_started_at,
            lastJobId: row.last_job_id,
          }
        : { timeOfDay: task.defaultTime, enabled: true, lastRunStartedAt: null, lastJobId: null }
    );
  }
  return result;
}

// Upserts only the schedule columns. A changed time deliberately leaves
// last_run_started_at alone (research R8): moving the time earlier on a day
// that already ran must not trigger a second run.
export function saveTaskSchedule(dbPath: string, taskId: string, schedule: { timeOfDay: string; enabled: boolean }): void {
  if (!isValidTimeOfDay(schedule.timeOfDay)) throw new Error(TIME_OF_DAY_ERROR);
  const db = openTaskDb(dbPath);
  try {
    db.prepare(
      `INSERT INTO task_schedules (task_id, time_of_day, enabled) VALUES (?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET time_of_day = excluded.time_of_day, enabled = excluded.enabled`
    ).run(taskId, schedule.timeOfDay, schedule.enabled ? 1 : 0);
  } finally {
    db.close();
  }
}

// Upserts only the run columns. With no row yet, the schedule columns get
// the task's defaults (`defaultTime`, enabled) -- the same values a missing
// row already reads as, so recording a run never changes the schedule.
export function recordTaskRun(dbPath: string, taskId: string, run: { startedAt: string; jobId: number }, defaultTime: string): void {
  const db = openTaskDb(dbPath);
  try {
    db.prepare(
      `INSERT INTO task_schedules (task_id, time_of_day, enabled, last_run_started_at, last_job_id) VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET last_run_started_at = excluded.last_run_started_at, last_job_id = excluded.last_job_id`
    ).run(taskId, defaultTime, run.startedAt, run.jobId);
  } finally {
    db.close();
  }
}
