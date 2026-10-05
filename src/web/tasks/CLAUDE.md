# Scheduled tasks (web service)

A general "run this once a day" framework in the web service (#61), plus its first and only task. `check-app-updates` is that task; see `src/commands/maintenance/CLAUDE.md` (`check-app-updates`) for what it does.

## Registry

`registry.ts`'s `TASKS` is the static registry: one `TaskDefinition` per task (`id`, `label`, `description`, `defaultTime`, `command` for its Job History entries, and a `run(ctx)` that does the work). Adding a second task is registering a second entry here, nothing else.

## Scheduler

`scheduler.ts`'s `TaskScheduler` is the only thing that ever starts a run on a schedule; the CLI and MCP server construct nothing like it.

- It ticks once a minute (an injected `Ticker`, default `setInterval(...).unref()`, so the timer is never why the process stays alive) and once immediately on `start()`, so a run missed while the service was down starts within seconds of the next startup.
- Each task has exactly one configured local time of day (`HH:MM`; no cron expressions, no more than one scheduled run per day). `mostRecentSlot`/`nextSlot` build each day's slot with the local-time `new Date(y, m, d, hh, mm)` constructor, so a DST jump or fold still yields exactly one slot per calendar day with nothing to special-case.
- **Catch-up rule** (`slotIsDue`): start a run when the task is enabled and its most recent slot is later than `lastRunStartedAt` *and* on a later local calendar day than it (or there has never been a run: a fresh install runs every task on its first tick), unless a run is already active. The calendar-day half is a final-review ruling: any run started on a day, scheduled or Run now, uses up that day, so moving the time later after today's run, or a Run now just before today's slot, waits for tomorrow's slot instead of running twice. A catch-up after an outage still runs exactly once.
- "Active" means the schedule's last recorded job id is still `queued`/`running`/`awaiting_input` in `JobStore`. `reconcileOrphanedJobs()` already marked a previous process's stuck rows interrupted before the scheduler starts, so a crash can't wedge a task as permanently active.
- `startRun(taskId, attribution)` is the one path both the schedule and the Tasks page's "Run now" button go through. It enqueues the job and records `lastRunStartedAt`/`lastJobId` in the same synchronous call, so nothing can slip a second start in between. It also keeps that last start/job id per task in memory, set right after the enqueue and overlaid on the database row by every read, so a failed `task_schedules` write (only `logWarn`ed) can't make every later tick enqueue a duplicate within the same process.
- **Cancellation**: a cancelled run stops and saves nothing. `JobDefinition.run` receives the job's `AbortSignal` as its second argument, the scheduler hands it to the task as `TaskRunContext.signal`, and `runCheckAppUpdates` checks it between guests and before saving; otherwise the cancel's aborted SSH calls would come back as per-guest errors and overwrite every saved result.
- A task's run is an ordinary **targetless** job (`target: undefined`, admin-only in Job History, like any fleet-wide job), attributed to `triggeredByUsername: 'scheduler'` for a scheduled run or `resolveTriggeredBy(req)` for a manual one. There is no separate "task run" record; the job is the record, and the schedule just remembers which job id was last started.

## `task_schedules` table

`src/lib/task-schedules.ts`'s `task_schedules` table (one row per task id: `time_of_day`, `enabled`, `last_run_started_at`, `last_job_id`) lives in `bellhop.db` outside `saveInventory`'s delete-and-reinsert list, same precedent as `script_catalog`/`permission_groups`.

- A row for an id no longer registered is silently ignored, and a missing row reads as the task's own `defaultTime`, enabled, never run. A fresh install needs no seeding, and a task removed from the registry leaves no cleanup to do.
- Changing the time of day never resets `last_run_started_at`, so moving it, earlier or later, on a day that already ran can't trigger a second run that day.

## Tasks route

`src/web/routes/tasks.ts` is a thin admin-only (`requireAdminGroup`) adapter over the scheduler's own `listTasks`/`updateSchedule`/`startRun`. It answers 503 in any process with no scheduler wired (every test that doesn't care) rather than throwing.
