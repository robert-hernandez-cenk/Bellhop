// Seeds one finished check-app-updates job and a task_schedules row
// pointing at it (issue #61), so the Tasks page's Last run/Next run columns
// have something real to show without the demo ever running the real
// TaskScheduler on a timer -- see demo-server.ts, which constructs a
// TaskScheduler for the Tasks page's routes but never calls start() on it.
// Deliberately separate from demo-jobs.ts's seedDemoJobs/DEMO_JOB_DEFS
// (not a fifth entry there) so that file's own "four expected jobs" tests
// stay unchanged.
import Database from 'better-sqlite3';
import type { JobStore } from '../../src/web/jobs/job-store.ts';
import type { JobLog } from '../../src/web/jobs/job-log.ts';
import { recordTaskRun } from '../../src/lib/task-schedules.ts';
import { TASKS } from '../../src/web/tasks/registry.ts';

// Same guests/outcomes demo-app-updates.ts seeds into app_update_status, so
// this job's log reads as the run that produced those results.
export const DEMO_CHECK_APP_UPDATES_LOG = [
  "Checking each LXC guest's community-scripts app for a newer release...",
  '  jellyfin: installed 10.8.13, latest 10.9.0 -- update available',
  '  homeassistant: installed 2026.9.0 -- up to date',
  '  paperless-ngx: GitHub API rate limit reached; the next scheduled check will retry',
  '  grafana: guest is stopped -- not checked',
  'check-app-updates completed successfully.',
].join('\n');

// Matches demo-app-updates.ts's CHECKED_AT -- the seeded app_update_status
// rows read as the output of this exact run.
const STARTED_AT = '2026-09-14T04:00:00.000Z';
const FINISHED_AT = '2026-09-14T04:00:41.000Z';

export function seedDemoTaskSchedule(
  store: JobStore,
  jobLog: JobLog,
  jobsDbPath: string,
  inventoryPath: string,
  owner: string
): void {
  const task = TASKS.find((t) => t.id === 'check-app-updates');
  if (!task) throw new Error('seedDemoTaskSchedule: check-app-updates is not a registered task');

  // 'scheduler' is the exact triggeredByUsername TaskScheduler.tick() itself
  // uses for a real scheduled run -- not a fake person, so it's outside the
  // demo's EXAMPLE_USERNAMES allowlist by design.
  const id = store.createJob({
    command: task.command,
    category: 'maintenance',
    argsJson: '{}',
    triggeredByUsername: 'scheduler',
    owner,
  });
  const row = store.get(id);
  if (!row) throw new Error(`seedDemoTaskSchedule: could not read back job ${id} right after creating it`);
  jobLog.append(row.logFile, `${DEMO_CHECK_APP_UPDATES_LOG}\n`);
  // Same real status transitions seedDemoJobs walks its own jobs through.
  store.markRunning(id);
  store.markFinished(id, { status: 'success', exitCode: 0 });

  // JobStore always stamps started_at/finished_at from the wall clock, so
  // overwrite them the same way seedDemoJobs does, for a reproducible date.
  const db = new Database(jobsDbPath);
  try {
    db.prepare('UPDATE jobs SET started_at = ?, finished_at = ? WHERE id = ?').run(STARTED_AT, FINISHED_AT, id);
  } finally {
    db.close();
  }

  recordTaskRun(inventoryPath, task.id, { startedAt: STARTED_AT, jobId: id }, task.defaultTime);
}
