---

description: "Task list for #78: accept a second action while a job is running"
---

# Tasks: Accept a second action while a job is running

**Input**: Design documents from `specs/078-job-queue-capture/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/console-capture.md, quickstart.md

**Tests**: Required. The constitution (Principle III) requires a failing-first test for every behavior change, and the issue lists the tests. Every test is deterministic: gates are promises the test resolves, never wall-clock waits.

**Organization**: Story order is chosen for safety, not by spec order. US2 (the explicit serial queue) lands first. While the console chain still exists, the queue changes nothing. Once US3 removes the chain, the queue is what keeps jobs one at a time. US1 is the end-to-end proof and needs both.

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Setup

Already done in Stage 1: worktree, `npm install`, baseline `npm run typecheck` and `npm test` green (2780 pass, 2 skipped).

---

## Phase 2: User Story 2 - Jobs still run one at a time (Priority: P1)

**Goal**: `JobRunner` serializes its own `execute` calls, independent of console capture (research R6).

**Independent Test**: Queue two jobs whose first blocks on a test-controlled promise. The second stays `queued` until the first is released, and a cancelled queued job never runs.

### Tests for User Story 2

- [x] T001 [US2] In `test/web/jobs/job-runner.test.ts`, add a test: job A's `run` awaits a test-controlled gate promise; job B is enqueued while A runs. Assert B's row is `queued` and B's `run` has not been called; resolve the gate; assert B then runs and both end `success`. Use a gate, not `delay`.
- [x] T002 [US2] In `test/web/jobs/job-runner.test.ts`, add a test: A blocks on a gate, B and C are queued, B is cancelled while queued. Assert B ends `cancelled` with its `run` never called and its log contains "Job cancelled by operator"; release A; assert C runs and ends `success` (a cancelled queued job does not hold up the next one).
- [x] T003 [US2] In `test/web/jobs/job-runner.test.ts`, add a test that a job whose `run` throws ends `failed` and the job queued after it still starts and ends `success` (FR-005).

### Implementation for User Story 2

- [x] T005 [US2] In `src/web/jobs/job-runner.ts`, add `private queue: Promise<void> = Promise.resolve()` and change `enqueue` to `this.queue = this.queue.then(() => this.execute(id, logFile, def, controller)).catch(() => {})` (replacing `void this.execute(...)`), with a comment saying this is what keeps jobs one at a time per runner (FR-003) now that console capture no longer serializes anything. Keep the `controllers.set`/`ensureControlPoller` calls in `enqueue` before the chain link so cancel and the poller work while queued.
- [x] T006 [US2] In `src/web/jobs/job-runner.ts` `execute()`, move the `if (controller.signal.aborted) throw new Error('Job cancelled')` check out of the `withCapturedConsole` callback to the top of the `try`, before `withCapturedConsole` is called, and reword its comment: a job cancelled while waiting its turn in this runner's queue is skipped without being marked `running`. T001-T003 pass.

**Checkpoint**: Commit `Run jobs one at a time through JobRunner's own queue (#78, US2)`.

---

## Phase 3: User Story 3 - Every job's log holds its own output, and only its own (Priority: P2)

**Goal**: `withCapturedConsole` isolates captures by async context and stops serializing (research R2-R5, contracts/console-capture.md).

**Independent Test**: Concurrent and nested captures each see only their own lines; a capture doesn't wait on another; lines from callbacks reach the right capture; the pre-capture console is the fallback and is restored.

### Tests for User Story 3

- [x] T007 [P] [US3] In `test/web/console-capture.test.ts`, add a test that capture B completes while capture A is still blocked on a gate (A's `fn` awaits a promise only resolved after B's result has been awaited). This fails today; it would hang, so wrap it with a test `timeout` option.
- [x] T008 [P] [US3] In `test/web/console-capture.test.ts`, add a test that a capture nested inside another receives the inner lines and the outer `text` does not contain them, and the outer still gets its own lines before and after.
- [x] T009 [P] [US3] In `test/web/console-capture.test.ts`, add a test that a line logged from a `setTimeout`/`EventEmitter` callback scheduled inside a capture (and fired while it's still running) lands in that capture, while two concurrent captures each schedule such callbacks and each sees only its own.
- [x] T010 [P] [US3] In `test/web/console-capture.test.ts`, add a test that a line logged from a callback that fires after its capture settled goes to the fallback console, not into the finished capture's `text`/`onLine`, even while a second capture is still active.
- [x] T011 [P] [US3] In `test/web/console-capture.test.ts`, add a test simulating the MCP redirect: set `console.log` to a collector before any capture, run a capture whose concurrent sibling logs outside it (from a context with no capture), and assert that line reaches the collector; after both settle `console.log` is the collector again and `console.error` is the original. Restore both in `finally`.
- [x] T004 [P] [US3] In `test/web/jobs/job-runner.test.ts`, add a test that two separate `JobRunner` instances do not serialize against each other: runner 1's job blocks on a gate, and runner 2's job runs to `success` meanwhile. Give it a test `timeout`, since today the process-wide console chain makes it hang. (Numbered T004 for history; written with the US3 tests.)
- [x] T012 [P] [US3] In `test/web/jobs/job-runner.test.ts`, add a FakeSSHClient-driven test: a job whose `run` calls `ssh.exec` with a responder, then logs from an `EventEmitter` listener emitted inside a `setImmediate`, while a concurrent `withCapturedConsole` capture (a preview) runs; assert the job log has the job's line and not the preview's, and the preview `text` has not the job's.

### Implementation for User Story 3

- [x] T013 [US3] Rewrite `src/web/console-capture.ts` per data-model.md: a module-level `AsyncLocalStorage<CaptureSink>` where `CaptureSink` is `{ lines: string[]; onLine?: (line: string) => void; active: boolean }`; an active-capture count; saved fallback `console.log`/`console.error` captured "at count 0 -> 1, restored at 1 -> 0 if the wrappers are still installed"; wrappers that format `args.map(String).join(' ')` and, when `storage.getStore()` is an active sink, push to `lines` and call `onLine`, otherwise call the fallback with the original args. `withCapturedConsole(fn, onLine?)` keeps its signature, installs on entry, runs `fn` via `storage.run(sink, fn)`, and in `finally` sets `sink.active = false` and uninstalls on the last exit. Remove the promise chain. A header comment explains why reference-counted installation is used (MCP redirect set after imports; tests swapping the console), not module-load patching.
- [x] T014 [US3] Update the comment in `src/mcp/server.ts` above `console.log = console.error` to the new mechanism: the capture saves whatever `console.log` is when the first concurrent capture starts and uses it as the fallback for lines outside any capture, so this redirect still applies.
- [x] T015 [US3] Run `node --test test/web/console-capture.test.ts test/web/jobs/job-runner.test.ts`; T004 and T007-T012 now pass, and the existing three console-capture tests still pass.

**Checkpoint**: Commit `Isolate console captures by async context (#78, US3)`.

---

## Phase 4: User Story 1 - A second action is accepted right away (Priority: P1)

**Goal**: The reported defect is fixed end to end through `previewAndEnqueue`, the path the web routes and MCP apply tools share.

**Independent Test**: With a first job blocked, `previewAndEnqueue` for a second operation resolves with its preview and a `queued` job, and that job runs only after the first is released.

### Tests for User Story 1

- [ ] T016 [US1] In `test/operations/core.test.ts`, add a test: enqueue a first job (via `enqueueWithoutPreview` with an operation whose `apply` awaits a test gate, or `runner.enqueue` directly), then `await previewAndEnqueue(op, …)` for a second operation whose `preview` uses `withCapturedConsole`. Assert it resolves with the preview text while the first job is still `running`, the second job's row is `queued`, then release the gate and assert both end `success` and the second job's log starts with the dry-run preview block.

### Implementation for User Story 1

- [ ] T017 [US1] In `src/operations/core.ts`, replace the deadlock comment above `previewAndEnqueue` with research R7's reason: previews run before enqueue so the preview text is logged at the top of the job log and a bad input fails the request before any job row exists; captures no longer wait on each other, so a preview never waits for a running job.

**Checkpoint**: Commit `Accept a second action while a job is running (#78, US1)`.

---

## Phase 5: Polish & Cross-Cutting Concerns

- [ ] T018 Update `CLAUDE.md`'s "Shared operations layer" bullet: replace "the ordering that avoids the `withCapturedConsole` deadlock" with the current reason (preview logged at the top of the job log), and add one sentence that console captures are isolated by async context while `JobRunner` keeps jobs one at a time with its own queue. Update the `src/web/proxy-sync.ts` comment only if its wording is now wrong (it says provisioning-job callers run inside `withCapturedConsole`, which stays true).
- [ ] T019 Run `npm run typecheck`, `npm test`, and `npm run web:build` in the worktree; paste the summaries.
- [ ] T020 Quickstart manual check (`specs/078-job-queue-capture/quickstart.md`): only if the demo instance has an action slow enough to observe; otherwise record that the automated tests are the evidence.

---

## Dependencies & Execution Order

- Phase 2 (US2) before Phase 3 (US3): removing the console chain without the runner queue would let jobs run concurrently.
- Phase 4 (US1) after both: its test needs the preview not to wait (US3) and the second job to stay queued (US2).
- Within US3, T004 and T007-T012 are separate tests in two files and can be written in parallel; T013 is one file.

## Parallel Example: User Story 3

```text
T007-T011 (console-capture.test.ts) and T004/T012 (job-runner.test.ts) written together, then T013.
```

## Implementation Strategy

MVP is all three phases together: the bug is fixed only when US2 and US3 have both landed, and US1 proves it. Each phase is committed and pushed separately, with the suite green at every commit.
