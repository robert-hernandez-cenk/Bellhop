---

description: "Task list for cross-process job streaming and control"
---

# Tasks: Cross-Process Job Streaming and Control

**Input**: Design documents from `specs/007-cross-process-job-control/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/job-control.md, quickstart.md

**Tests**: Required. The constitution (Principle III) requires every behavior change to ship with
tests; write each test first and watch it fail (TDD).

**Organization**: Phase 2 builds the control-request queue both control stories need. US1 (live
view) does not depend on Phase 2 and can be done first or in parallel.

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Setup

No setup: the worktree already has dependencies installed and the baseline suite passes.

---

## Phase 2: Foundational (blocks US2 and US3)

**Purpose**: the durable request queue, the owner-side poller, and the one shared requester
function. See research.md R2 to R4 and data-model.md.

- [x] T001 Write failing tests in `test/web/jobs/job-store.test.ts` for control requests:
  `createControlRequest` returns an id; `pendingControlRequests('mcp:4242')` returns only unhandled
  rows whose job's `COALESCE(owner, 'web')` equals the argument, in id order (a job with null owner
  counts as `'web'`); `markControlRequestHandled(id, 'applied')` sets `handledAt`, `result`, and
  clears `text` to null, and the row no longer appears as pending; the table survives reopening the
  same database file (constructor is idempotent).
- [x] T002 Implement in `src/web/jobs/job-store.ts`: `CREATE TABLE IF NOT EXISTS
  job_control_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id INTEGER NOT NULL, action TEXT
  NOT NULL CHECK (action IN ('cancel', 'answer', 'dismiss')), text TEXT, requested_by_owner TEXT NOT
  NULL, requested_by_username TEXT, created_at TEXT NOT NULL, handled_at TEXT, result TEXT)`;
  exported types `ControlAction = 'cancel' | 'answer' | 'dismiss'`, `ControlRequestRow` (camelCase
  fields), and the methods `createControlRequest({ jobId, action, text?, requestedByOwner,
  requestedByUsername? })`, `pendingControlRequests(owner)`, `markControlRequestHandled(id, result:
  'applied' | 'not-applicable')`. Match the file's comment style (explain why, reference #6).
- [x] T003 Write failing tests in `test/web/jobs/job-runner.test.ts` for
  `processControlRequests()`: with a job this runner owns paused on a prompt (reuse the file's
  existing hanging-exec/prompt helpers), an `answer` request from `mcp:4242` writes `'y\n'` to the
  channel, resumes, marks the request `applied`, and appends `Answer sent from MCP (mcp:4242)` to
  the log, and the log never contains the answer text; a `cancel` request from `web` with username
  `admin` on a running job ends it `cancelled` and logs `Stop requested from web UI by admin`; a
  `dismiss` request logs `Prompt dismissed from web UI by admin`; a request for a job id not active in
  this runner (finished, or created directly in the store) is marked `not-applicable` and changes
  nothing; an `answer` on a running-but-not-paused job is `not-applicable`; requests for another
  owner's jobs are left pending; a runner with no active jobs has no poll timer (assert via an
  injected `controlPollMs` plus a `hasControlPoller()` test accessor, or equivalent) and one is
  running while a job is active and cleared after it finishes.
- [x] T004 Implement in `src/web/jobs/job-runner.ts`: `controlPollMs` option (default 500);
  start an `unref()`'d interval calling `processControlRequests()` in `enqueue` when none is
  running; clear it in `execute`'s `finally` once `controllers` is empty; public
  `processControlRequests()` per research.md R4, including the attribution line helper (source
  `web UI` for owner `web`, `MCP (<owner>)` for `mcp:<pid>`, ` by <user>` only when a username is
  recorded) written with the same `log.append` + `events.emit('chunk', …)` path `emitChunk` uses, so a
  local WebSocket viewer sees it too. `shutdown()` must also clear the interval.
- [x] T005 Write failing tests in `test/web/jobs/job-control.test.ts` for `requestJobControl(deps,
  { job, action, text, requestedByUsername })`: local job → calls the runner method and returns
  `{ kind: 'done' }` on true, or `{ kind: 'refused', message }` with today's exact wording
  (`Job N is already <status> — nothing to cancel`, `Job N is not awaiting input — nothing to
  answer`, `… nothing to dismiss`) on false; foreign job owned by `mcp:<pid>` with an injected
  `isPidAlive` returning false → refused `job N's owning process mcp:<pid> has exited` and no row
  written; foreign terminal job + cancel → refused with the cancel wording; foreign running (not
  paused) job + answer/dismiss → refused with the answer/dismiss wording; foreign queued/running job
  + cancel and foreign paused job + answer/dismiss → a request row is written with
  `requestedByOwner` = the local runner's owner and `{ kind: 'requested', owner }` returned; a
  foreign job owned by `web` is never treated as dead.
- [x] T006 Implement `src/web/jobs/job-control.ts` exporting `requestJobControl` and its result
  type; reuse `defaultIsPidAlive` from `job-store.ts` as the default `isPidAlive`. The refusal
  strings are defined once here.

**Checkpoint**: `npm --prefix <worktree> test` passes; nothing user-visible has changed yet.

---

## Phase 3: User Story 1 - Watch an MCP-started job live in the web UI (Priority: P1)

**Goal**: a foreign job's WebSocket keeps streaming output, status and prompt changes.

**Independent Test**: open `/ws/jobs/:id` for a job owned by `mcp:4242`, append to its log and change
its row from the test, and receive `chunk`/`status`/`prompt`/`prompt-cleared` messages.

- [ ] T007 [P] [US1] Write failing test in `test/web/jobs/job-log.test.ts`: `readBytes(name, offset)`
  returns the bytes from `offset`, an empty buffer for a missing file or an offset at/after the end.
- [ ] T008 [P] [US1] Implement `readBytes` on `JobLog` in `src/web/jobs/job-log.ts`.
- [ ] T009 [US1] Write failing tests in `test/web/jobs/job-tail.test.ts` for
  `createForeignJobTail({ jobStore, jobLog, jobId, initial: { offset, row }, send })` returning
  `{ tick, stop, stopped }`: a tick after an append sends one `chunk` (`stream: 'stdout'`) with
  exactly the new text; a tick with nothing new sends nothing; a 3-byte UTF-8 character appended as
  two separate writes split mid-character arrives intact across two ticks with no U+FFFD; a status
  change sends `status`; a row moving to `awaiting_input` with prompt text sends `prompt` with
  `text`, parsed `expectedPrompts`, `origin` (default `'heuristic'` when null) and `matchedIndex`; a
  prompt going away sends `prompt-cleared`; a row becoming terminal flushes remaining log output
  before the final `status` and sets `stopped`, and later ticks send nothing.
- [ ] T010 [US1] Implement `src/web/jobs/job-tail.ts` per research.md R1 (row read first, then log;
  `StringDecoder('utf8')`); the interval itself lives in the caller so `tick` is testable directly.
- [ ] T011 [US1] Write failing WebSocket test in `test/web/routes/jobs.test.ts` using the existing
  `startWsServer`/`connectCollectingMessages`/`waitFor` helpers and a new optional `tailIntervalMs`
  argument: a job created with `owner: 'mcp:4242'`, marked running, with an initial log line →
  client gets `backlog` with that line and `status: running`; the test then appends a line and marks
  the job awaiting input, then running, then finished → client receives the `chunk`, `prompt`,
  `prompt-cleared` and final `status: success` messages in that order; a foreign job the user's
  group cannot see is still refused (reuse an existing visibility fixture).
- [ ] T012 [US1] Update `attachJobsWebSocket` in `src/web/routes/jobs.ts`: accept an optional
  trailing `options: { tailIntervalMs?: number }` (default 1000); for a job whose `owner ?? 'web'`
  differs from `jobRunner.owner`, read the backlog via `readBytes` (send its decoded text), send the
  same initial status/prompt messages as today, then, unless the job is already terminal, run
  `createForeignJobTail` on a `setInterval` that is cleared on socket close or when the tail stops;
  do not register the `jobRunner.events` listeners for such a job. Local jobs keep today's path.

**Checkpoint**: US1 works on its own; control actions still 409 for foreign jobs.

---

## Phase 4: User Story 2 - Stop, answer or dismiss an MCP-owned job from the web UI (Priority: P1)

**Goal**: the three web control routes work on a job another process owns.

**Independent Test**: POST cancel/answer/dismiss for a foreign job returns 202 and writes a
request; state refusals and dead-owner refusal return 409; a second runner owning the job applies it.

- [ ] T013 [US2] Replace the `for (const action of ['cancel', 'answer', 'dismiss-prompt'])` 409
  test near the end of `test/web/routes/jobs.test.ts` with failing tests: for a job owned by
  `mcp:<process.pid>` (alive), running and, for answer/dismiss, marked awaiting input, each route
  returns 202 `{ requested: true, owner }` and a pending request exists with the right action,
  `requestedByOwner: 'web'` and `requestedByUsername: 'admin'`; for a job owned by an `mcp:<pid>`
  whose pid is dead (pick a pid the test proves is unused, or inject via deps if the route accepts
  it) each route returns 409 naming the exited owner; a terminal foreign job's cancel and a running
  foreign job's answer/dismiss return the 409 "nothing to …" wording; an end-to-end test with a
  second `JobRunner` (owner `mcp:<process.pid>`) sharing the store and log runs a hanging job, the
  web app's cancel route returns 202, the second runner's `processControlRequests()` is invoked,
  and the job ends `cancelled` with `Stop requested from web UI by admin` in its log.
- [ ] T014 [US2] Update the three control routes in `src/web/routes/jobs.ts` to call
  `requestJobControl` with `requestedByUsername` from `(req.realUser ?? req.user)?.username`; map
  `done` → today's 200 body, `requested` → 202 `{ requested: true, owner }`, `refused` → 409
  `{ error: message }`; remove `rejectForeignOwner`. Keep the visibility check first.

**Checkpoint**: US1 + US2 deliver issue #6 as written.

---

## Phase 5: User Story 3 - Control any job from the MCP tools (Priority: P2)

**Goal**: MCP `cancel_job`/`answer_job_prompt`/`dismiss_job_prompt` work on web-owned jobs.

**Independent Test**: call `cancel_job` via the MCP test client on a job owned by `web` and get
`requested`; `wait_for_job` on it is still refused.

- [ ] T015 [US3] In `test/mcp/build-server.test.ts`, replace "job control on another process's job
  is refused with the owner named" with failing tests: `cancel_job` on a running web-owned job
  returns `{ requested: true, owner: 'web', note }` and a pending request with `requestedByOwner` =
  the server runner's owner; `answer_job_prompt` on a web-owned running (not paused) job is an error
  with the "nothing to answer" wording; `wait_for_job` on a web-owned job still errors with
  `owned by web` (keep `test/mcp/wait-for-job.test.ts`'s existing assertion passing).
- [ ] T016 [US3] Update the three tools in `src/mcp/build-server.ts` to use `requestJobControl`
  (no username); `done` → today's JSON; `requested` → `{ requested: true, owner, note: 'The owning
  process applies this within about a second; check get_job for the result.' }`; `refused` → throw
  `Error(message)`. Update tool descriptions to say they work on any process's job. Update the
  `requireOwned` comment in `src/mcp/job-helpers.ts` to say it now guards only `wait_for_job`.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [ ] T017 [P] Update `CLAUDE.md` MCP server bullet: replace "Cancel/answer/dismiss only work from
  the process that owns the job … without live streaming or controls there (issue #165)" with the
  new behavior (foreign-job tailing in the WS handler, `job_control_requests` queue polled by the
  owner while it has active jobs, requester does not wait, dead-MCP-owner refusal, a stopped web
  service's pending requests become not-applicable after restart, `wait_for_job` still owner-only);
  mention the new files `job-control.ts`/`job-tail.ts`.
- [ ] T018 [P] Update `README.md` "MCP server" section with one short paragraph: jobs the MCP server
  starts appear in the web UI's Job History with live output and working Stop/answer controls, and
  the MCP control tools can act on web-started jobs.
- [ ] T019 Run `npm --prefix <worktree> run typecheck`, `npm --prefix <worktree> test`,
  `npm --prefix <worktree> run web:build`; all pass.
- [ ] T020 Manual quickstart (`quickstart.md` "Manual" section) against the real web service and MCP
  server where available, including desktop and ≤640px viewports; record anything not verifiable.

---

## Dependencies & Execution Order

- Phase 2 (T001 to T006) blocks US2 and US3.
- US1 (T007 to T012) depends on nothing but existing code; T007/T008 can run alongside Phase 2.
- US2 (T013 to T014) depends on Phase 2. US3 (T015 to T016) depends on Phase 2; independent of US2.
- Polish after all stories.
- Within each pair, the test task precedes its implementation task.

## Parallel Opportunities

- T007/T008 (job-log) are independent of Phase 2's files.
- T017/T018 (docs) are independent of each other.
- US2 and US3 touch different files (`routes/jobs.ts` vs `mcp/build-server.ts`) once Phase 2 lands.

## Implementation Strategy

MVP is US1 (watching). Delivered order: Phase 2 → US1 → US2 → US3 → Polish, with a commit per
phase/story.
