---
description: "Task list for spinner-proof prompt detection (issue #52)"
---

# Tasks: Prompts Hidden Behind a Redrawing Spinner

**Input**: Design documents from `specs/052-spinner-hides-prompts/`

**Prerequisites**: plan.md, spec.md, research.md, contracts/output-activity.md, quickstart.md

**Tests**: Required. This is a bug fix, so the constitution requires a test that fails without it. Write each test first and watch it fail.

## Phase 1: Setup

No setup needed: no new dependencies or project structure.

## Phase 2: Foundational (blocks every story)

- [x] T001 [P] Write failing unit tests for `OutputActivity` in test/web/jobs/output-activity.test.ts per contracts/output-activity.md: whole spinner frames after a seen line are redraws (`push` returns false, `length` unchanged); a frame split across two chunks is a redraw; a glyph-only frame is a redraw; a check-mark line repeating spinner text is a redraw; new text is activity; digits are significant (`45%` then `46%` are both activity); a prompt followed by `\r\x1b[2K⠋ <seen spinner text>` stays `candidate()`; `line\r\n` (also split as `line\r` | `\n`) gives `candidate() === ''` and `lastLine() === 'line'`; `consume(n)` drops the first n characters and forgets keys (an identical line pushed afterwards is activity again); the transcript stays at or below 16 KiB and `trimmedBy` reports the trimmed amount; candidate and lastLine are capped at 200 characters and ANSI-stripped.
- [x] T002 Implement `OutputActivity` in src/web/jobs/output-activity.ts so T001 passes: split on `\r`/`\n` and treat `\r\n` as one newline ending, even across chunks; normalize keys (strip `ANSI_ESCAPE` from job-ssh-client.ts by moving the export here and re-exporting it, strip leading non-letter and non-digit characters with `/^[^\p{L}\p{N}]+/u`, collapse whitespace, trim); keep the last 16 distinct meaningful keys; an unfinished line counts as a redraw when its key is empty or a prefix of a recent key; keep a meaningful transcript of committed lines with their endings plus the meaningful unfinished line, capped at 16 KiB.

**Checkpoint**: `node --test test/web/jobs/output-activity.test.ts` passes.

## Phase 3: User Story 1 - A question asked under a running spinner is surfaced (P1) 🎯 MVP

**Goal**: an expected or heuristic prompt printed under a running spinner pauses the job.

**Independent Test**: replay spinner, prompt, spinner frames through `JobSSHClient` with the fake scheduler, and confirm a tier-0 `expected` pause showing the prompt text.

- [x] T003 [US1] Add failing tests to test/web/jobs/job-ssh-client.test.ts: (a) the mariadb-shaped sequence (spinner frames for a seen status line, then `Would you like to add PhpMyAdmin? <y/N> `, then more spinner frames, all as separate chunks) fires once, as `expected` with matchedIndex 0, with the prompt as text; spinner chunks after the prompt must not re-arm the tier (assert on the scheduler's pending list); (b) after answering via `resume`, a second pre-scanned prompt under the same spinner fires `expected` with matchedIndex 1; (c) a non-pre-scanned `Continue? (y/n) ` under a spinner fires as `heuristic` at tier 1.
- [x] T004 [US1] Rework src/web/jobs/job-ssh-client.ts to use `OutputActivity`: replace `buffer` with an `OutputActivity` instance (reset in `resetWatchState`); `watchChunk` calls `push()` and re-arms tier 0 only when it returns true; `trailingText()` becomes `activity.candidate()`; `stallText()` uses `activity.lastLine()` with the existing `lastFiredText` fallback; `firedAtLength` records `activity.length` and `resume()` calls `activity.consume(firedAtLength - trimmedSinceFire)`, clamped at 0. Update the comments that describe the raw buffer. Every existing test in job-ssh-client.test.ts and job-runner.test.ts must still pass unchanged.

**Checkpoint**: US1 tests and every existing #160 test pass.

## Phase 4: User Story 2 - A spinner can no longer defeat the stall backstop (P2)

**Goal**: spinner-only output escalates at the stall tier, and a stall pause clears itself on new meaningful output (FR-012).

**Independent Test**: a meaningful line followed only by redraws reaches the stall tier showing that line; new output during a stall pause clears it.

- [ ] T005 [US2] Add failing tests to test/web/jobs/job-ssh-client.test.ts: (a) `Configuring the database\n`, then spinner frames repeating a seen line, with all three tiers fired, gives one `stall` whose text is the last meaningful line; (b) during a stall pause, a new meaningful chunk calls `onPromptCleared` once and re-arms tier 0, while spinner-only chunks during the pause do not; (c) during an `expected` or `heuristic` pause, new meaningful output does NOT clear the pause.
- [ ] T006 [US2] Implement the stall auto-clear in src/web/jobs/job-ssh-client.ts: record the origin of the current pause in `fire()`; in `watchChunk`, when paused with origin `stall` and `push()` returned true, call `this.resume()`. Comment why only stall pauses do this (operator decision, research R6).
- [ ] T007 [US2] Add a JobRunner-level test in test/web/jobs/job-runner.test.ts showing that a stall pause cleared by new output returns the job to `running`, emits `prompt-cleared`, and does not cancel when the abandon timeout would have fired (use the runner's existing test overrides for the stall, abandon, and scheduler timing).

**Checkpoint**: US2 tests pass.

## Phase 5: User Story 3 - Existing detection behaviour is unchanged (P3)

- [ ] T008 [US3] Run the full test/web/jobs suite and MCP wait-for-job tests (`node --test test/web/jobs test/mcp`) and confirm no existing expectation changed; if any did, fix the implementation rather than the test, unless the spec says the behavior changes.

## Phase 6: Polish

- [ ] T009 [P] Update CLAUDE.md's issue #160 detection paragraph (the "Detection runs on one self-re-arming timer..." text in the install-app/update-app bullet) to describe issue #52: redraws count as silence (`src/web/jobs/output-activity.ts`), the candidate is the last meaningful line not ended by a newline, digits are significant, the transcript is bounded, and a stall pause clears itself on new meaningful output.
- [ ] T010 Run `npm run typecheck`, `npm test`, and `npm run web:build` in the worktree and record the results.

## Dependencies

- T001 → T002 → (T003 → T004) → (T005 → T006 → T007) → T008 → T009/T010
- US2 builds on US1's `JobSSHClient` rework (T004).

## Parallel opportunities

- T001 can be written while reading the existing tests; T009 is independent of code once T006 lands.

## Implementation strategy

MVP is Phases 2 and 3: the reported hang is fixed once US1 lands. US2 then restores the stall guarantee and adds the auto-clear safety net, and US3 and the polish phase confirm nothing regressed.
