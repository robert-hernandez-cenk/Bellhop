# Implementation Plan: Daily App Update Checks

**Branch**: `issue-61-app-update-checks` | **Date**: 2026-10-03 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/061-app-update-checks/spec.md`

## Summary

This plan adds a small scheduled-tasks framework to the web service, plus its first task, `check-app-updates`. A task has a fixed time of day and an enabled flag. Both persist in a new `task_schedules` table in `bellhop.db`. A minute-tick scheduler starts a task when the task's most recent scheduled slot is later than its last start. Each run is an ordinary `JobRunner` job, so it gets a log and a Job History row. An admin-only Tasks page and three `/api/tasks` routes let an admin view and edit schedules, and run a task right away.

The check mirrors community-scripts' own `check_for_gh_release` (in `misc/tools.func`):

1. Parse the first literal call to it in the app's resolved `ct/<slug>.sh`.
2. Read `~/.<name>` (or a single `/opt/*_version.txt`) inside the guest through `runRemote`.
3. Ask GitHub for the latest stable release, once per repository per run.
4. Normalize both versions the way tools.func does, and compare them.

Each guest's outcome is saved in `app_update_status`. `GET /api/app-updates` serves the results, filtered by per-resource permissions, and the Update page shows them as a badge or note. A successful update-app job re-checks its own guest. The CLI `check-app-updates [--guest] [--apply]` uses the same function.

## Technical Context

**Language/Version**: TypeScript (strict), Node (CI matrix versions), run via the repo's existing `node --experimental-strip-types` setup.

**Primary Dependencies**: express, better-sqlite3, zod, commander (CLI), React and react-router (web-client). No new dependencies.

**Storage**: Two new tables in `inventory/bellhop.db`, opened through `openDb` like `script_catalog` and outside `saveInventory`'s wholesale replace: `task_schedules` and `app_update_status`. Job rows stay in `data/jobs.sqlite3`.

**Testing**: `node --test`, with `FakeSSHClient` for guest reads, a stubbed `fetch` with captured, redacted GitHub and community-scripts fixtures for network calls, a temp SQLite file per test, and an injected clock for the scheduler.

**Target Platform**: The Bellhop web service (Windows service in production; any Node host). Guests are Proxmox LXC containers reached through `pct exec`.

**Project Type**: Web service with a React SPA, plus a CLI.

**Performance Goals**: A daily run over up to 50 app guests finishes within a few minutes and uses no more than about 50 GitHub API requests (SC-005).

**Constraints**: Commands sent to guests must be POSIX `sh` (constitution II). The GitHub API allows 60 unauthenticated requests per hour. Only the web service schedules (FR-006). The check is read-only on guests (FR-020).

**Scale/Scope**: A single-operator homelab: tens of guests, a handful of admins, one task now with more to follow.

## Constitution Check

*GATE: checked before Phase 0 research, and re-checked after Phase 1 design.*

| Principle | Assessment |
|---|---|
| I. No real data | Fixtures are captured from public GitHub repositories and community-scripts files, with no operator data, and their shape is preserved. Spec, plan, and tests use example guests (`media`, `web-lxc`) and example hosts (`pve1`). No operator-specific default: 04:00 is a neutral built-in default that can be edited. **Pass** |
| II. Code quality | Remote reads go through `runRemote`. The guest command is POSIX `sh` (research R6). GitHub responses, request bodies, and DB rows are validated with zod. Errors name a fix (e.g. "run the app update once to create ~/.name"). Shared logic lives in `src/lib/` (parse/compare/GitHub, stores) and `src/commands/maintenance/check-app-updates.ts` (one implementation for CLI, task, and post-update re-check). **Pass** |
| III. Testing | Unit tests for the parser, version normalization, comparison, release lookup (captured fixtures), the stores, the scheduler slot logic (injected clock, DST cases), the routes (admin gate, permission filtering), the CLI, and the update-app re-check. Scheduler tests never use wall-clock time. `Ssh2SSHClient` is untouched. **Pass** |
| IV. UX consistency | The CLI defaults to printing only and saves only with `--apply`. Results are filtered per resource, and task routes are admin-gated. The Tasks page uses the `data-label` card layout at ≤640px and themes via `:root[data-theme='dark']`. Desktop and mobile get browser verification. Docs: `docs/web-ui.md`, `docs/commands.md`, README command table, and a CLAUDE.md architecture bullet. Saved results are a read cache, not infrastructure or inventory, but they still follow the dry-run convention on the CLI. Web "Run now" is an explicit apply action, matching update-all's Run button, which also has no preview. **Pass** |

Post-design re-check: no change. No violations, so Complexity Tracking is empty.

## Project Structure

### Documentation (this feature)

```text
specs/061-app-update-checks/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── http-api.md
│   └── cli.md
└── tasks.md            # /speckit-tasks
```

### Source Code (repository root)

```text
src/lib/
├── app-update-check.ts       # NEW: parseReleaseCheck, normalizeVersion, decideOutcome, fetchLatestRelease (per-run cache), version-read script
├── app-update-store.ts       # NEW: app_update_status table: load, replaceAll, upsertOne
├── task-schedules.ts         # NEW: task_schedules table: load, save schedule, record run start
└── app-source.ts             # CHANGED: createAppSourceResolver(): pins custom head SHA + compare once per run, memoized per slug

src/commands/maintenance/
└── check-app-updates.ts      # NEW: runCheckAppUpdates({ guest?, apply }, deps), checkOneGuest, formatCheckAppUpdates

src/operations/maintenance.ts # CHANGED: update-app apply re-checks its guest after exit code 0

src/web/tasks/
├── registry.ts               # NEW: TaskDefinition type, TASKS list (check-app-updates)
├── scheduler.ts              # NEW: TaskScheduler (tick, mostRecentSlot, nextSlot, startRun, isRunning)
src/web/routes/
├── tasks.ts                  # NEW: GET /api/tasks, PATCH /api/tasks/:id, POST /api/tasks/:id/run (admin)
└── app-updates.ts            # NEW: GET /api/app-updates (permission-filtered)
src/web/app.ts                # CHANGED: mount routes; AppDeps gains taskScheduler
src/web/server.ts             # CHANGED: construct and start TaskScheduler after reconcileOrphanedJobs
src/cli.ts                    # CHANGED: check-app-updates command

web-client/src/
├── pages/TasksPage.tsx       # NEW
├── pages/UpdatePage.tsx      # CHANGED: badge/note + emphasized button
├── components/AppUpdateBadge.tsx  # NEW
├── lib/app-update-display.ts # NEW (framework-free): outcome -> badge view model
├── lib/task-display.ts       # NEW (framework-free): time validation, next/last run text
├── lib/admin-nav.ts          # CHANGED: Tasks link
├── App.tsx, api/types.ts, index.css  # CHANGED

scripts/demo/                 # CHANGED: seed app update results so screenshots show the badge
docs/                         # web-ui.md, commands.md (+ README command table, CLAUDE.md)

test/lib/app-update-check.test.ts, app-update-store.test.ts, task-schedules.test.ts, app-source.test.ts (resolver)
test/commands/check-app-updates.test.ts
test/web/tasks/scheduler.test.ts, test/web/routes/tasks.test.ts, test/web/routes/app-updates.test.ts
test/operations/maintenance (update-app re-check), test/web-client/ (display helpers, admin-nav)
test/fixtures/github-releases/, test/fixtures/community-scripts/  # captured
```

**Structure Decision**: This follows the existing layout. Infrastructure helpers and DB tables live in `src/lib/`. The check is a command in `src/commands/maintenance/`, shared by the CLI, the task, and the update-app operation. Scheduling and HTTP are web-only, under `src/web/`. Framework-free UI logic lives in `web-client/src/lib/` so plain `node --test` can test it.

## Complexity Tracking

None.
