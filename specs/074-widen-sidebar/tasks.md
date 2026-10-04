---

description: "Task list for #74, widen the desktop sidebar"
---

# Tasks: Widen the desktop sidebar so nav links stay on one line

**Input**: Design documents from `specs/074-widen-sidebar/`

**Prerequisites**: plan.md, spec.md, research.md, quickstart.md

**Tests**: No automated tests are requested. The project has no CSS layout tests; each story is verified in a browser per quickstart.md, and the existing suites are run as regression checks.

## Phase 1: Setup

No setup: the worktree has its dependencies installed and the demo instance (`npm run demo`) is available.

## Phase 2: Foundational

None.

## Phase 3: User Story 1 - Every nav link reads on one line at desktop width (Priority: P1) 🎯 MVP

**Goal**: At desktop width, no sidebar link wraps and, at 1920x1080 with the full admin nav, the sidebar shows no scroll bar.

**Independent Test**: quickstart.md steps 1-4.

- [x] T001 [US1] In `web-client/src/index.css`, change the desktop `.sidebar` rule from `width: 200px` to `width: 220px` and add `flex-shrink: 0` (research R2, R3); leave the 640px media query's `.sidebar` rule untouched
- [x] T002 [US1] In `web-client/src/index.css`, add `white-space: nowrap; overflow: hidden; text-overflow: ellipsis;` to the existing `.sidebar a` rule (research R3)
- [x] T003 [US1] Update the "static 200px column" sentence in the "Web UI responsiveness/theming" bullet of `CLAUDE.md` to describe the 220px column whose links never wrap (truncating with an ellipsis)
- [x] T004 [US1] Rebuild (`npm run web:build`) and run quickstart.md steps 1-4 against `npm run demo` at a 1920x1080 window: sidebar 220px, no link taller than one line, no scroll bar with the admin nav simulated, still one line when the window is short enough to scroll, no horizontal page scroll at 1280px

**Checkpoint**: US1 complete and verified.

## Phase 4: User Story 2 - The mobile drawer is unchanged (Priority: P2)

**Goal**: The ≤640px drawer keeps its 240px width and behavior.

**Independent Test**: quickstart.md step 5.

- [x] T005 [US2] Run quickstart.md step 5 at a 390px-wide viewport against `npm run demo` (built from T001-T002's `web-client/src/index.css`): drawer 240px wide, every link on one line, backdrop tap closes it

## Phase 5: Polish & Cross-Cutting Concerns

- [x] T006 Regenerate the docs screenshots with `npm run docs:screenshots` into `docs/images/` and check each by eye for the wider sidebar and example-only values (constitution Principle I)
- [x] T007 Run `npm run typecheck`, `npm test`, and `npm run web:build`; all pass

## Dependencies & Execution Order

- T001 → T002 (same file) → T004; T003 is independent of the CSS.
- US2 (T005) depends on T001-T002 only, not on US1's verification.
- T006 depends on T001-T002; T007 runs last.

## Parallel Opportunities

- T003 [docs] can be done alongside T001-T002; T004 and T005 are both browser checks against the same demo build and can run back to back in one session.

## Implementation Strategy

MVP is US1 (T001-T004). US2 is a verification-only story confirming no regression. Commit US1 and US2 together since they share the one CSS change, then the screenshots and regression checks.
