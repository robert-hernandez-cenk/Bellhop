---
description: "Task list for daily app update checks (#61)"
---

# Tasks: Daily App Update Checks

**Input**: Design documents from `specs/061-app-update-checks/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/http-api.md, contracts/cli.md, quickstart.md

**Tests**: Required. Constitution Principle III says every behavior change ships with tests, and this run uses TDD per task: write the failing test first, then the code.

**Organization**: Phases follow the spec's user stories. The check engine itself is foundational, since every story reads its results.

## Format: `[ID] [P?] [Story] Description`

Paths are relative to the worktree root, `C:\Users\rcher\Dev\Bellhop-Worktrees\issue-61-app-update-checks`.

---

## Phase 1: Setup

- [x] T001 Capture fixtures from live public responses into `test/fixtures/github-releases/` (`releases-latest.json` from `GET https://api.github.com/repos/<small-public-repo>/releases/latest`, and `releases-list.json` from `.../releases?per_page=100` for a repository whose list includes at least one pre-release and one draft-free stable release). Also capture into `test/fixtures/community-scripts/` one real upstream `ct/*.sh` with a plain `check_for_gh_release "<name>" "<owner/repo>"` call, and one with a `"${RELEASE}"` pin plus its literal `RELEASE="..."` assignment. Store them exactly as captured (research R12). Add a short `README.md` in each fixture directory naming the source URL and the capture date (2026-10-03).

---

## Phase 2: Foundational (check engine; blocks all stories)

- [x] T002 [P] Write `test/lib/app-update-check.test.ts` covering research R1–R3:
  - `parseReleaseCheck`: plain call; call behind `[[ -d x ]] && if`; single-quoted and bare args; `"${RELEASE}"` resolved from `RELEASE="v3.2.4"`; `"$VAR"` resolved from `VAR="${VAR:-1.23.0}"`; unresolvable variable → `{ ok: false }`; `$` in name or repo → unsupported; no call → unsupported with reason `no check_for_gh_release call in ct/<slug>.sh`; 5th-arg prefix; name lowercased with spaces removed; name/repo validation regexes.
  - `normalizeVersion`: `v1.2`→`1.2`, `vault-1` unchanged.
  - `decideOutcome`: pinned versus unpinned inequality semantics.
  - `fetchLatestRelease`, with a stubbed fetch serving the T001 fixtures: `/latest` used when there's no pin or prefix; fallback to `?per_page=100` on a non-200 `/latest`; drafts and pre-releases skipped; prefix filter; pinned version tried via `/releases/tags/<pin>` and must exist; 403/429 → `GitHub API rate limit reached; the next scheduled check will retry`; other status → message names the repo and status; the `ReleaseCache` issues one request per `repo|pin|prefix` across repeated calls.
  - `buildInstalledVersionScript(name)`: emits exactly the POSIX script in research R6.
- [x] T003 Implement `src/lib/app-update-check.ts` to pass T002, with zod schemas for the release JSON (`tag_name`, `draft`, `prerelease`), a 15s `AbortSignal.timeout`, and the `Accept: application/vnd.github+json` and `X-GitHub-Api-Version: 2022-11-28` headers.
- [x] T004 [P] Write `test/lib/app-update-store.test.ts`:
  - Temp db in a `mkdtempSync` directory.
  - `replaceAppUpdateResults` deletes rows absent from the new set.
  - `upsertAppUpdateResult` replaces one row.
  - `loadAppUpdateResults` round-trips every field and orders by guest.
  - The `status` CHECK rejects other values.
  - `saveInventory` on the same file leaves the table intact.
- [x] T005 Implement `src/lib/app-update-store.ts` per data-model.md's `app_update_status` table, via `openDb`, with status "CHECK IN (`update-available`, `up-to-date`, `unsupported`, `not-checked`, `error`)".
- [x] T006 [P] Add tests to `test/lib/app-source.test.ts` for `createAppSourceResolver`:
  - With custom settings, resolving three slugs makes exactly one head-SHA request and one compare request.
  - The same slug twice is memoized.
  - With no custom settings, no network.
  - Existing `resolveAppSource` tests still pass unchanged.
- [x] T007 Implement `createAppSourceResolver(inventory, fetchImpl)` in `src/lib/app-source.ts`, refactoring `resolveAppSource` onto the shared internals (research R4) without changing its behavior.
- [x] T008 Write `test/commands/check-app-updates.test.ts`, using `FakeSSHClient`, a temp inventory, and a stubbed fetch:
  - Only `lxc` guests with `app` are checked.
  - A stopped guest (from the `pvesh` status responder) → `not-checked` "Guest is stopped", with no `pct exec` to it.
  - A host whose status query fails → its guests are still attempted.
  - Version-read exit 3 → error message suggesting running the update once.
  - Other exit codes → the error names the code.
  - The upstream script is fetched from stable, with a dev fallback on 404.
  - A custom source uses `ctUrl`.
  - Unparseable script → `unsupported`.
  - Release error → `error` for that guest only.
  - Two guests sharing a repository → one release request.
  - `apply: false` saves nothing; `apply: true` replaces all rows.
  - `--guest` mode skips the status query, upserts one row, and rejects an unknown guest, a non-lxc guest, or a guest with no app, using the messages in `contracts/cli.md`.
  - `formatCheckAppUpdates` output matches the contract's line layout.
- [x] T009 Implement `src/commands/maintenance/check-app-updates.ts`: `runCheckAppUpdates({ guest?, apply }, { ssh, inventory, inventoryPath, fetchImpl?, now? })`, the exported `checkOneGuest(guestName, ctx)` used by the re-check, and `formatCheckAppUpdates(result)`. Guest reads go only through `runRemote`.

**Checkpoint**: the check runs end to end against fakes and saves results.

---

## Phase 3: User Story 1 - See which apps have an update waiting (P1) 🎯 MVP

**Goal**: the Update page shows each LXC app guest's saved result.

**Independent Test**: seed `app_update_status` rows, open `/update`, and see the badge, the emphasized button, and the quiet notes. A restricted user sees no row for a blocked guest.

- [x] T010 [P] [US1] Write `test/web/routes/app-updates.test.ts`:
  - `GET /api/app-updates` returns saved rows in the `contracts/http-api.md` shape, with null fields omitted.
  - Drops rows for guests that are no longer `lxc`+`app` in inventory.
  - Drops rows for guests a block-list or allow-list group can't see.
  - An admin sees all.
  - Impersonating a restricted group filters.
- [x] T011 [US1] Implement `src/web/routes/app-updates.ts` and mount it at `/api/app-updates` in `src/web/app.ts`, reusing `isResourceAllowed` from `src/web/access.ts` and the permission rules loading used by `dashboardRoutes`.
- [x] T012 [P] [US1] Write `test/web-client/app-update-display.test.ts` for `appUpdateView(result, formatTime)` (research R11): available → tone `available`, text `Update available 1.2.3 → 1.3.0`; up-to-date → `Up to date (1.2.3)`; error → `Update check failed`, with the message in the details; not-checked → `Not checked: guest stopped`; unsupported → `null`. The details always include `Checked <time>`.
- [x] T013 [US1] Implement `web-client/src/lib/app-update-display.ts` (framework-free), and add the `AppUpdateResult` type to `web-client/src/api/types.ts`.
- [x] T014 [US1] Create `web-client/src/components/AppUpdateBadge.tsx`: a badge or quiet note with a tap/click disclosure revealing the details (not hover-only `title`; reuse the `FieldHelp` pattern). Wire it into `web-client/src/pages/UpdatePage.tsx`: fetch `/app-updates`, show the badge next to the app, add the `button-attention` class to the app update button when `update-available`, and update the `PageDescription` text to mention the daily check. Add styles in `web-client/src/index.css`, with dark-mode overrides under `:root[data-theme='dark']`.
- [x] T015 [US1] Seed example app update results in the demo instance (`scripts/demo/`): one available, one up to date, one error, one not checked, all on example guests. Keep `test/scripts/demo/demo-inventory.test.ts` passing.

**Checkpoint**: the MVP shows results, whichever way they were saved.

---

## Phase 4: User Story 2 - The check runs by itself every day (P1)

**Goal**: the scheduler runs `check-app-updates` daily at its configured time, as a job, with catch-up.

**Independent Test**: with an injected clock, advancing past 04:00 starts exactly one job triggered by `scheduler`.

- [x] T016 [P] [US2] Write `test/lib/task-schedules.test.ts`:
  - A missing row reads as `{ timeOfDay: default, enabled: true, lastRunStartedAt: null, lastJobId: null }`.
  - `saveTaskSchedule` upserts `time_of_day`/`enabled` without touching the run columns.
  - `recordTaskRun` upserts the run columns and keeps the schedule.
  - `time_of_day` must match "`^([01]\d|2[0-3]):[0-5]\d$`".
  - Rows for unknown task ids are ignored.
- [x] T017 [US2] Implement `src/lib/task-schedules.ts` per data-model.md's `task_schedules` table, via `openDb`.
- [x] T018 [P] [US2] Write `test/web/tasks/scheduler.test.ts`, with an injected `now`, a manual ticker, a temp db, and a fake `JobRunner`/`JobStore`:
  - `mostRecentSlot`/`nextSlot` for before and after the time of day.
  - DST spring-forward and fall-back days each yield one slot. Use a TZ-independent assertion style, i.e. compute expectations with the same local `Date` constructor.
  - First tick on a fresh db starts a run.
  - Last run yesterday 04:00 → run at today 04:00, not at 03:59.
  - Outage across 04:00 → one catch-up run on `start()`.
  - Already ran today → no run after a restart.
  - Disabled → no run.
  - Active job (queued, running, or awaiting_input) → no second run.
  - Finished/interrupted job → eligible again.
  - `startRun` records `lastRunStartedAt` and `lastJobId`.
  - The enqueued job has `command: 'check-app-updates'`, `target` undefined, and `triggeredByUsername: 'scheduler'`.
  - `stop()` clears the ticker.
- [x] T019 [US2] Implement `src/web/tasks/registry.ts` (`TaskDefinition`, `TASKS` with `check-app-updates`, default `04:00`). Its `run` refreshes inventory, calls `runCheckAppUpdates({ apply: true }, ...)` with the job's ssh, and logs `formatCheckAppUpdates`. Also implement `src/web/tasks/scheduler.ts` (`TaskScheduler`: `start`, `stop`, `tick`, `startRun(taskId, attribution)` returning `{ jobId } | { alreadyRunning: jobId }`, and `listTasks()` returning the TaskView shape from data-model.md).
- [x] T020 [US2] Construct and `start()` the scheduler in `src/web/server.ts` after `jobRunner.reconcileOrphanedJobs()`, and stop it on shutdown. Add an optional `taskScheduler` to `AppDeps` in `src/web/app.ts`. Confirm `src/mcp/server.ts` and `src/cli.ts` never construct one.

**Checkpoint**: results refresh daily with no operator action.

---

## Phase 5: User Story 3 - Manage tasks from the Tasks page (P2)

**Goal**: admins view, edit, and run tasks.

**Independent Test**: an admin changes the time and presses Run now; a non-admin is refused and sees no nav link.

- [x] T021 [P] [US3] Write `test/web/routes/tasks.test.ts`:
  - `GET /api/tasks` shape per `contracts/http-api.md`.
  - `PATCH` valid time/enabled → 200 with the new `nextRun`.
  - `25:00` → 400 `timeOfDay must be HH:MM in 24-hour time, e.g. 04:00`, nothing saved.
  - Empty body → 400.
  - Unknown id → 404.
  - `POST .../run` → 200 `{ jobId }` attributed to the caller.
  - A second run while active → 409 `App update check is already running (job #N)`.
  - Every route → 403 for a non-admin, and for an admin impersonating a non-admin group.
  - No scheduler wired → 503.
- [x] T022 [US3] Implement `src/web/routes/tasks.ts` (`requireAdminGroup`, zod strict body), and mount it at `/api/tasks` in `src/web/app.ts`.
- [x] T023 [P] [US3] Write `test/web-client/task-display.test.ts` (`isValidTimeOfDay`, last-run/next-run text, status labels). Extend `test/web-client/admin-nav.test.ts` (or the existing admin-nav test): admin without a directory → Tasks and Settings; with a directory → Users, Permissions, Tasks, Settings; non-admin → none.
- [x] T024 [US3] Implement `web-client/src/lib/task-display.ts`, add the Tasks link in `web-client/src/lib/admin-nav.ts`, create `web-client/src/pages/TasksPage.tsx` (`.data-table` with `data-label` cells: Task, Schedule (time input, enabled checkbox, Save), Last run (status and link to `/jobs/:id`), Next run, Run now → navigate to the job; inline errors), add the `/tasks` route in `web-client/src/App.tsx`, add the `TaskView` type in `web-client/src/api/types.ts`, and add any styles in `web-client/src/index.css`.

---

## Phase 6: User Story 4 - Indicator stays accurate after updating (P2)

**Independent Test**: a successful update-app job re-checks its guest; a failed one leaves the old row.

- [ ] T025 [US4] Add tests to `test/operations/maintenance.test.ts` (or the existing update-app operation test file):
  - `update-app` apply with exit 0 upserts a fresh result for that guest.
  - Exit non-zero → no re-check and the old row is unchanged.
  - Re-check throws → `logWarn` and apply still resolves.
- [ ] T026 [US4] In `src/operations/maintenance.ts` `update-app.apply`, after `runUpdateApp` returns `result.code === 0`, call `checkOneGuest` and `upsertAppUpdateResult(deps.inventoryPath, ...)`, wrapped in try/catch → `logWarn` (research R10).

---

## Phase 7: User Story 5 - Check from the command line (P3)

- [ ] T027 [US5] Add a `check-app-updates` case to `test/cli.test.ts` (or the existing CLI registration test): options `--guest`, `--apply`.
- [ ] T028 [US5] Register `check-app-updates [--guest <name>] [--apply]` in `src/cli.ts`. It prints `formatCheckAppUpdates` and the `[DRY RUN]` line without `--apply`, per `contracts/cli.md`.

---

## Phase 8: Polish & Cross-Cutting

- [ ] T029 [P] Update docs:
  - `docs/web-ui.md`: Update page badge, Tasks page.
  - `docs/commands.md`: `check-app-updates`.
  - `README.md` main-commands table, if it lists maintenance commands, keeping the README at most 200 lines.
  - `CLAUDE.md`: an architecture bullet for the tasks framework, the check's tools.func mirroring, the tables, the re-check, and the unauthenticated-GitHub single-operator assumption.
  - `CONTRIBUTING.md` only if a restated convention changed.
- [ ] T030 Run `npm run typecheck`, `npm test`, and `npm run web:build`, and fix any failures.
- [ ] T031 Browser-verify `/update` and `/tasks` on the demo instance at desktop width and at a 640px or narrower viewport (no horizontal scroll, cards, light and dark themes). Regenerate affected `docs/images/` with `npm run docs:screenshots`, and inspect them for example-only values.
- [ ] T032 Run the quickstart.md automated section and record manual real-infrastructure steps as unverified for the PR if they can't be run.

---

## Dependencies & Execution Order

- Phase 1 → Phase 2 (T002/T003 need the fixtures). Within Phase 2: T003 needs T002; T005 needs T004; T007 needs T006; T008/T009 need T003, T005, and T007.
- US1 (Phase 3) needs Phase 2 for the store only, and the API/UI can be built against seeded rows.
- US2 (Phase 4) needs Phase 2 (`runCheckAppUpdates`).
- US3 (Phase 5) needs US2's scheduler (T019).
- US4 needs T009 and T005. US5 needs T009.
- Polish comes last.

### Parallel Opportunities

- T002, T004, and T006 (different test files) in parallel. Then T003, T005, and T007 in parallel.
- After Phase 2: US1 (T010–T015), US2 (T016–T020), US4 (T025–T026), and US5 (T027–T028) touch different files and can proceed in parallel. US3 starts after T019.

## Implementation Strategy

MVP = Phases 1–3 (results visible via a seeded or CLI-saved check). Then US2 makes it automatic, US3 makes it manageable, US4 keeps it accurate, and US5 adds the CLI. Commit per phase/story: `<what it delivers> (#61, USn)`.
