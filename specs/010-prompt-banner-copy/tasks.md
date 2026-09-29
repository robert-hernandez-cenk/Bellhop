---

description: "Task list for prompt banner copy per detection origin"
---

# Tasks: Prompt banner copy per detection origin

**Input**: Design documents from `specs/010-prompt-banner-copy/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/banner-copy.md, quickstart.md

**Tests**: Included. The constitution requires every behavior change to ship with tests, and this feature follows TDD: each story's test is written and seen failing before its implementation.

**Organization**: Phase 2 moves today's banner behavior, unchanged, behind the new helper, so each story afterwards is a small, independently testable change to one row of the table.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)

## Phase 1: Setup

None. No new dependencies or project structure.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: One place for per-origin banner choices, with today's behavior preserved exactly, so the story phases change copy rather than structure.

- [x] T001 Create `test/web-client/prompt-banner.test.ts` (`node:test`, `node:assert/strict`, importing `../../web-client/src/lib/prompt-banner.ts`, like `test/web-client/admin-nav.test.ts`) with tests pinning **today's** behavior of `promptBannerView(origin, matchedIndex, expectedCount)`: `expected` with index 0 of 4 → hint `Question 1 of up to 4 — matches a known prompt in this app's install script.`, `hintStrong: false`; `expected` with `matchedIndex: null` → hint `Matches a known prompt in this app's install script.`; `expected` with `expectedCount: 0` → the same fallback hint; `stall` → today's stall hint text verbatim from `web-client/src/pages/JobView.tsx`, `hintStrong: true`, `quiet: 'answers'`; `heuristic` and `null` → `hint: null`, `quiet: null`. Confirm they fail (module missing).
- [x] T002 Create `web-client/src/lib/prompt-banner.ts`: framework-free (no React/DOM imports; header comment giving the same rationale as `web-client/src/lib/settings-display.ts`), `import type { PromptOrigin } from '../api/types.ts'`. Export `interface PromptBannerView { hint: string | null; hintStrong: boolean; dismissLabel: string; quiet: 'answers' | 'dismiss' | null }` and `promptBannerView(origin: PromptOrigin | null, matchedIndex: number | null, expectedCount: number): PromptBannerView`, built on a `Record<PromptOrigin | 'none', …>` table (each entry a function of `matchedIndex`/`expectedCount`) so a new origin without copy fails to compile. `null` origin looks up `'none'`. For now every entry's `dismissLabel` is `Not stuck — keep waiting` and every value reproduces today's behavior. Run `npm test` and confirm T001 passes.
- [x] T003 In `web-client/src/index.css`, replace the two positional `.prompt-banner-actions-stall > .button:not(:last-child), .prompt-banner-actions-stall .prompt-banner-freetext .button` rules (and their `:hover` twin) with a single `.prompt-banner .button.prompt-banner-quiet` rule and its `:hover:not(:disabled)` rule carrying the identical declarations (`background: transparent; color: #1d1d1f; border: 1px solid rgba(0, 0, 0, 0.35)`; hover `background: rgba(0, 0, 0, 0.08)`). Update the explanatory comment above `.prompt-banner-hint-stall`: emphasis is now a per-button class chosen per origin by `promptBannerView()`, not a last-child selector (research R5).
- [x] T004 In `web-client/src/pages/JobView.tsx`, compute `const view = promptBannerView(promptOrigin, promptMatchedIndex, expectedPrompts.length)` and render the banner from it: one hint `<div>` when `view.hint` is non-null, with class `prompt-banner-hint` plus `prompt-banner-hint-stall` when `view.hintStrong`; drop the `prompt-banner-actions-stall` class from the actions row; add `prompt-banner-quiet` to Yes, No and Submit when `view.quiet === 'answers'` and to the dismiss button when `view.quiet === 'dismiss'`; dismiss button text is `view.dismissLabel`. Run `npm run typecheck`, `npm test`, `npm run web:build`.

**Checkpoint**: Banner looks and reads exactly as before, now driven by one table.

---

## Phase 3: User Story 1 - Answer a confirmed question without being steered away from it (Priority: P1) MVP

**Goal**: A confirmed (`expected`) prompt's dismiss control reads "Ignore — keep waiting" and is visually quiet.

**Independent Test**: `promptBannerView('expected', …)` returns `dismissLabel: 'Ignore — keep waiting'`, `quiet: 'dismiss'`; the browser shows an outline-styled "Ignore — keep waiting" beside normal Yes/No/Submit.

- [x] T005 [US1] In `test/web-client/prompt-banner.test.ts`, change the `expected` tests to also assert `dismissLabel === 'Ignore — keep waiting'` and `quiet === 'dismiss'` (both hint variants unchanged, FR-002). Confirm they fail.
- [x] T006 [US1] In `web-client/src/lib/prompt-banner.ts`, set the `expected` entry's `dismissLabel` to `Ignore — keep waiting` and `quiet` to `'dismiss'`. Run `npm test`; T005 passes.

  **Post-review update**: the label above was originally "Skip this question". Code review found dismiss sends nothing to the installer (`JobSSHClient.resume()` only clears the pause and re-arms the watch timer), so "Skip" implied the installer moves on when it actually keeps waiting on its question. The operator chose "Ignore — keep waiting" instead, matching R2/R3 in research.md.

**Checkpoint**: US1 complete and testable alone.

---

## Phase 4: User Story 2 - Understand that a heuristic pause is a guess (Priority: P2)

**Goal**: A `heuristic` pause explains that it's a guess, with the right variant when there were no known prompts, and a dismiss control that says "Not a question — keep waiting".

**Independent Test**: `promptBannerView('heuristic', null, 2)` and `promptBannerView('heuristic', null, 0)` return the two contract hints, `hintStrong: false`, `quiet: null`, `dismissLabel: 'Not a question — keep waiting'`.

- [x] T007 [US2] In `test/web-client/prompt-banner.test.ts`, replace the `heuristic` tests with: `expectedCount > 0` → hint `Looks like a question, but it doesn't match any prompt in this app's install script — it may not be one.`; `expectedCount === 0` → hint `Looks like a question, but there were no known prompts for this app to check it against — it may not be one.`; both `hintStrong: false`, `quiet: null`, `dismissLabel: 'Not a question — keep waiting'`. Confirm they fail.
- [x] T008 [US2] In `web-client/src/lib/prompt-banner.ts`, implement the `heuristic` entry per `contracts/banner-copy.md`. Run `npm test`; T007 passes.

**Checkpoint**: US2 complete and testable alone.

---

## Phase 5: User Story 3 - Follow the stall explanation to the right control (Priority: P3)

**Goal**: The stall hint names the dismiss control by its exact label, and that label is "Not a question — keep waiting" for stall and for unrecorded pauses.

**Independent Test**: `promptBannerView('stall', …)`'s `hint` contains `"${dismissLabel}"` and `dismissLabel === 'Not a question — keep waiting'`; `promptBannerView(null, …)` has the same label and no hint.

- [x] T009 [US3] In `test/web-client/prompt-banner.test.ts`, change the `stall` test to the contract's new hint text and assert `dismissLabel === 'Not a question — keep waiting'`, `hintStrong: true`, `quiet: 'answers'`, and that `hint.includes(\`"${dismissLabel}"\`)`; change the `null` test to assert the same label with `hint: null`, `quiet: null`. Add one test over all four keys (`'expected'`, `'heuristic'`, `'stall'`, `null`) asserting no `dismissLabel` equals `Not stuck — keep waiting` (SC-002) and that any hint naming a control in quotes names that view's own `dismissLabel` (SC-003). Confirm they fail.
- [x] T010 [US3] In `web-client/src/lib/prompt-banner.ts`, set the `stall` and `none` labels, and build the stall hint from a shared `NOT_A_QUESTION_LABEL` constant so the hint and the button can't drift. Run `npm test`; T009 passes.

**Checkpoint**: All three stories complete.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [x] T011 [P] In `CLAUDE.md`'s `install-app` prompt-relay paragraph, after the sentence ending "flag a stall as a guess rather than a detected question.", add one sentence: the banner's hint, dismiss label and button emphasis per origin all come from one `Record<PromptOrigin | 'none', …>` table, `promptBannerView()` in `web-client/src/lib/prompt-banner.ts` (issue #4), so a new origin can't ship without copy. Confirm `README.md` and `CONTRIBUTING.md` don't restate the banner's labels (update only if they do).
- [x] T012 Follow `specs/010-prompt-banner-copy/quickstart.md`: seed the five paused rows and check each at 1280px and 390px, light and dark, against `contracts/banner-copy.md`. Save screenshots for the PR.
- [x] T013 Run `npm run typecheck`, `npm test`, `npm run web:build`; all pass.

---

## Dependencies & Execution Order

- Phase 2 (T001→T002, then T003 and T004) blocks every story.
- US1 (T005→T006), US2 (T007→T008), US3 (T009→T010) each touch the same two files, so run them in sequence (P1, P2, P3), but each is independently testable.
- T011 can run any time after Phase 2; T012–T013 run last.

## Parallel Opportunities

- T003 (CSS) and T001/T002 (helper + test) touch different files.
- T011 (docs) alongside any story phase.

## Implementation Strategy

MVP is Phase 2 + US1: the misleading "Not stuck" on confirmed questions is gone. US2 and US3 then add the heuristic hint and align the stall hint with the button, each a one-entry change to the table.
