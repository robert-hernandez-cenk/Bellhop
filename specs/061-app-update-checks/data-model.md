# Data Model: Daily App Update Checks

Both tables live in `inventory/bellhop.db`. Each is opened through `openDb` with its own `CREATE TABLE IF NOT EXISTS` schema, and neither is touched by `saveInventory` (same precedent as `script_catalog`, `permission_groups`).

## task_schedules (`src/lib/task-schedules.ts`)

| Column | Type | Rules |
|---|---|---|
| `task_id` | TEXT PRIMARY KEY | A registered task id (`check-app-updates`). Rows for unknown ids are ignored on read. |
| `time_of_day` | TEXT NOT NULL | `HH:MM`, 24-hour, matching `^([01]\d|2[0-3]):[0-5]\d$`. |
| `enabled` | INTEGER NOT NULL | 0/1. |
| `last_run_started_at` | TEXT NULL | ISO-8601 instant, set when a run is enqueued. |
| `last_job_id` | INTEGER NULL | Id of that run's row in `data/jobs.sqlite3`. |

A missing row means "never configured": `time_of_day = task.defaultTime`, `enabled = true`, never run (FR-002). Saving a schedule upserts `time_of_day` and `enabled` and leaves the run columns alone. Recording a run upserts the run columns, inserting defaults for the schedule when no row exists yet.

**TaskView** (API shape, derived): `{ id, label, description, timeOfDay, enabled, defaultTime, lastRun: { startedAt, jobId, status } | null, nextRun, running }`. `status` comes from `JobStore.get(lastJobId)?.status`, or `null` if that job row is gone. `running` is true when `status` is `queued`, `running`, or `awaiting_input`.

State flow for one task: idle → (slot passes, or Run now) → run recorded and job queued → job running → job finished (success, failed, cancelled, or interrupted) → idle. A second start while the job is queued or running is refused.

## app_update_status (`src/lib/app-update-store.ts`)

| Column | Type | Rules |
|---|---|---|
| `guest` | TEXT PRIMARY KEY | Inventory guest name. |
| `app` | TEXT NOT NULL | The guest's `app` slug when checked. |
| `status` | TEXT NOT NULL | CHECK IN (`update-available`, `up-to-date`, `unsupported`, `not-checked`, `error`). |
| `installed_version` | TEXT NULL | Normalized (leading `v` + digit stripped). Set for `update-available` and `up-to-date`. |
| `latest_version` | TEXT NULL | Normalized target: the pin if pinned, else the latest stable. Set for `update-available` and `up-to-date`. |
| `repo` | TEXT NULL | `owner/repo` when a release check was parsed. |
| `message` | TEXT NULL | Reason for `unsupported`, `not-checked`, or `error`. |
| `checked_at` | TEXT NOT NULL | ISO-8601 instant. |

**AppUpdateResult** (TypeScript and API shape): `{ guest, app, status, installedVersion?, latestVersion?, repo?, message?, checkedAt }`.

Writes:

- `replaceAppUpdateResults(dbPath, results)`: one transaction, `DELETE` all then insert. Used by a full run (FR-021).
- `upsertAppUpdateResult(dbPath, result)`: used by `--guest` and the post-update re-check.

Reads: `loadAppUpdateResults(dbPath)` returns every row ordered by guest. The API layer then drops rows whose guest is not currently an eligible LXC app guest, or is not visible to the caller.

## In-memory types (`src/lib/app-update-check.ts`)

- **ReleaseCheck**: `{ name: string /* app_lc */, repo: string, pin?: string, prefix?: string }`. `parseReleaseCheck(script)` returns `{ ok: true, check }` or `{ ok: false, reason }`.
- **LatestRelease**: `{ tag: string /* raw */, version: string /* normalized */ }`, or a thrown `Error` with an actionable message.
- **ReleaseCache**: a `Map<string, Promise<LatestRelease>>` keyed by `repo|pin|prefix`, living for one run.
- `decideOutcome(installed, check, latest)` returns `update-available` or `up-to-date` per research R1.

## TaskDefinition (`src/web/tasks/registry.ts`)

`{ id: 'check-app-updates', label: 'App update check', description, defaultTime: '04:00', command: 'check-app-updates', run: (ctx: TaskRunContext) => Promise<void> }`. `TaskRunContext` carries `{ ssh, inventory, inventoryPath, fetchImpl?, now }`.
