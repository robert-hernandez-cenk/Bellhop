---

description: "Task list for the wrap-not-overflow layout fix (issue #5)"
---

# Tasks: Long values wrap instead of overflowing on phone-width screens

**Input**: Design documents from `specs/008-mobile-overflow-wrap/`

**Prerequisites**: plan.md, spec.md, research.md, quickstart.md

**Tests**: Required by the constitution (Principle III: a bug fix ships with a test that fails without it). Per research R4 the test is a static assertion on the style declarations; the browser measurement in quickstart.md is the behavioral check.

**Organization**: Grouped by user story. All paths are relative to the repository root.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Setup

**Purpose**: None needed. There are no new dependencies or modules, and the worktree already has `node_modules` and a passing baseline (1453 tests, clean typecheck).

---

## Phase 2: Foundational

**Purpose**: Create the test file that both stories extend.

- [x] T001 Create `test/web-client/mobile-overflow-css.test.ts` with a small helper that reads `web-client/src/index.css` and returns the declarations of a named rule. It takes an optional `@media (max-width: 640px)` scope and matches the selector text exactly as written in the file. Use `node:test` and `node:assert/strict`, like `test/web-client/admin-nav.test.ts`, and resolve paths from `import.meta.url`.

**Checkpoint**: the helper exists; story tests can be added.

---

## Phase 3: User Story 1 - Answer or stop a job from a phone (Priority: P1) MVP

**Goal**: the job detail header fits the screen at any width down to 320px. The title wraps, the status and Stop group moves below it when needed, and the badge stays on one line.

**Independent Test**: at 390px and 320px, `/jobs/<id>` for a job with target `examplelongguestnamewithoutanyhyphenslxc` has `.content` scrollWidth equal to the viewport, and the badge and Stop are fully visible (quickstart.md).

### Tests for User Story 1

- [x] T002 [US1] In `test/web-client/mobile-overflow-css.test.ts`, add failing tests asserting that:
  - `.job-header` declares `flex-wrap: wrap`
  - `.job-header-main` declares `min-width: 0` and `overflow-wrap: anywhere`
  - `.job-status-badge` declares `white-space: nowrap`
  - `web-client/src/pages/JobView.tsx` contains `className="job-header-main"`

  Run `npm test` and confirm these fail before implementing.

### Implementation for User Story 1

- [x] T003 [US1] In `web-client/src/index.css`:
  - add `flex-wrap: wrap; gap: 8px 12px;` to `.job-header`
  - add a `.job-header-main { min-width: 0; overflow-wrap: anywhere; }` rule after it, with a short comment explaining why (issue #5: an unbreakable target name otherwise widens the page)
  - add `white-space: nowrap;` to `.job-status-badge`
- [x] T004 [US1] In `web-client/src/pages/JobView.tsx`, give the header's title/subtitle wrapper `<div>` (the first child of `.job-header`) `className="job-header-main"`. Run `npm test` and `npm run typecheck`, and confirm the T002 tests pass.

**Checkpoint**: US1 is complete and testable on its own.

---

## Phase 4: User Story 2 - Read job history on a phone (Priority: P2)

**Goal**: mobile card values wrap within the card and stay right-aligned.

**Independent Test**: at 320px, `/jobs` has `.content` scrollWidth equal to the viewport, and a long single-word target is fully visible and right-aligned (quickstart.md).

### Tests for User Story 2

- [ ] T005 [US2] In `test/web-client/mobile-overflow-css.test.ts`, add failing tests asserting that the `.data-table tbody td` rule inside `@media (max-width: 640px)` declares `overflow-wrap: anywhere` and `text-align: right`. Confirm they fail.

### Implementation for User Story 2

- [ ] T006 [US2] In `web-client/src/index.css`, add `overflow-wrap: anywhere; text-align: right;` to the existing `.data-table tbody td` rule inside `@media (max-width: 640px)`, with a short comment citing issue #5 and research R2 (`anywhere` lowers min-content; `break-word` doesn't). Run `npm test` and confirm T005 passes.

**Checkpoint**: US1 and US2 both work.

---

## Phase 5: User Story 3 - Other card tables stay intact (Priority: P3)

**Goal**: the shared card-cell change doesn't regress other card tables at 390px or desktop.

**Independent Test**: the Dashboard at 390px, 320px and 1280px shows no overflow and usable inline controls (quickstart.md).

- [ ] T007 [US3] Following `specs/008-mobile-overflow-wrap/quickstart.md`, build the client (`npm run web:build`) and measure `/` (Dashboard) at 390px, 320px and 1280px in headless Chrome against the example inventory. Look for any cell whose control (input, select, button, badge) became unusable or misaligned because of `text-align: right` or the wrapping. If one did, scope a fix in `web-client/src/index.css` to that cell, following the existing `.data-table td[data-label="vpn"] .field-input` precedent.

**Checkpoint**: all stories verified.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [ ] T008 [P] Update the "Web UI responsiveness/theming" bullet in `CLAUDE.md` with one sentence: mobile card cells wrap long values (`overflow-wrap: anywhere`, right-aligned) rather than truncating, and a flex row holding a user-supplied name needs `min-width: 0` plus `overflow-wrap: anywhere` on the shrinking item (see `.job-header-main`). Check whether `CONTRIBUTING.md` restates this convention; update it only if it does.
- [ ] T009 Run the full quickstart.md measurement for `/jobs`, `/jobs/<long-target id>`, `/jobs/<hyphenated id>` and `/` at 390px, 320px and 1280px. Record the scrollWidth and viewport numbers and save screenshots for the PR.
- [ ] T010 Run `npm run typecheck`, `npm test` and `npm run web:build`, and confirm all pass.

---

## Dependencies & Execution Order

- T001 comes before T002 and T005.
- US1 (T002-T004) and US2 (T005-T006) touch different rules in the same two files. Run them in order (US1, then US2) to avoid edit conflicts; neither depends on the other functionally.
- US3 (T007) depends on T006, since it checks the shared card rule.
- Polish: T008 can run any time after T006; T009 and T010 run last.

## Parallel Opportunities

- T008 (CLAUDE.md) can run alongside T007.
- Everything else edits `index.css` or the same test file, so it runs sequentially.

## Implementation Strategy

1. MVP: T001-T004 fix the job page, which is the blocking symptom (an unreachable Stop control).
2. Add US2 (T005-T006) for the history cards.
3. Verify US3 and polish (T007-T010).
