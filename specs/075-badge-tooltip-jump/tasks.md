---

description: "Task list for the anchored app-update badge explanation (#75)"
---

# Tasks: App update badge explanation that stays put

**Input**: Design documents from `specs/075-badge-tooltip-jump/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/field-help-placement.md, quickstart.md

**Tests**: Required. Constitution Principle III says a bug fix ships with a
test that fails without the fix.

## Phase 1: Setup

None. This is an existing project, and the worktree already has its
dependencies installed.

## Phase 2: Foundational

- [ ] T001 [P] Write failing unit tests for the pure placement module in `test/web-client/popover-position.test.ts`. Import `placePopover`, `popoverMaxWidth`, `POPOVER_GAP`, `POPOVER_GUTTER` and `POPOVER_MAX_WIDTH` from `../../web-client/src/lib/popover-position.ts`. Cover:
  - `popoverMaxWidth`: `max(0, min(320, viewportWidth - 32))` at 1280, at 390, at 340 and at 20 (the last gives 0)
  - placement below: `top = anchor.bottom + 2`
  - flip above when the space below is less than the height and less than the space above: `top = anchor.top - 2 - height`
  - stay below when neither side fits but below has more room
  - `left` clamped to `[16, viewport.width - 16 - width]` on both the right edge and the left edge
  - `left = 16` when the popover is wider than `viewport.width - 32`
- [ ] T002 Implement `web-client/src/lib/popover-position.ts`: framework-free exports `POPOVER_GAP = 2`, `POPOVER_GUTTER = 16`, `POPOVER_MAX_WIDTH = 320`, `popoverMaxWidth(viewportWidth)` and `placePopover(anchor, size, viewport)` returning `{ top, left, side: 'below' | 'above' }`, exactly per data-model.md. T001 then passes.

## Phase 3: User Story 1 - Read an update result's details without the page moving (P1) 🎯 MVP

**Goal**: The badge's explanation opens next to its ⓘ, fits its content up to the maximum width, stays inside the viewport, and never scrolls or resizes the page.

**Independent test**: quickstart.md steps 2–3.

- [ ] T003 [P] [US1] Write a failing CSS test in `test/web-client/field-help-css.test.ts`. Read `web-client/src/index.css` and check:
  - a `.field-help-popover-anchored` rule exists with `position: fixed`, `width: max-content`, `right: auto` and a `max-width`
  - the `.field-help-popover` rule still has `position: absolute`, `left: 0` and `right: 0` (the modal layout is unchanged)
- [ ] T004 [US1] Add the `.field-help-popover-anchored` rule right after `.field-help-popover` in `web-client/src/index.css`: `position: fixed; top: 0; left: 0; right: auto; width: max-content; max-width: min(320px, calc(100vw - 32px)); margin-top: 0;`, with a comment naming issue #75. T003 then passes.
- [ ] T005 [US1] Add `placement?: 'row' | 'anchored'` (default `'row'`) to `web-client/src/components/FieldHelp.tsx` per contracts/field-help-placement.md:
  - for `'anchored'`, add the `field-help-popover-anchored` class
  - skip `scrollIntoView` unless the placement is `'row'`
  - add a `useLayoutEffect`, keyed on `open` and `placement`, that sets `maxWidth = popoverMaxWidth(clientWidth)`, measures the popover, then sets `top`/`left` from `placePopover(buttonRect, size, { width: clientWidth, height: clientHeight })`
  - re-run that positioning on window `scroll` (capture, passive) and `resize`, throttled through `requestAnimationFrame`, and clean up the listeners and any pending frame on close and on unmount
  - row mode must render exactly as before
- [ ] T006 [US1] Pass `placement="anchored"` from `web-client/src/components/AppUpdateBadge.tsx` and update its header comment to say why.
- [ ] T007 [US1] Run `npm run typecheck`, `npm test` and `npm run web:build`. Then browser-verify quickstart.md steps 2–3 on the demo instance: desktop and 390 px wide, light and dark themes. Record scroll position and height before and after opening.

## Phase 4: User Story 2 - Advanced modal explanations unchanged (P2)

**Goal**: The Advanced modal's field explanations look and behave as before.

**Independent test**: quickstart.md step 4.

- [ ] T008 [US2] Browser-verify quickstart.md step 4: the Advanced modal at desktop and at a short phone viewport. Explanations span their row, and a bottom row's explanation scrolls into view inside the modal.

## Phase 5: Polish & cross-cutting

- [ ] T009 [P] Update the badge paragraph in `docs/web-ui.md` to say the explanation opens beside the badge, without moving the page.
- [ ] T010 [P] Update the FieldHelp sentence in `CLAUDE.md` (the "Web UI responsiveness/theming" bullet) to describe `placement` (`'row'` default for the Advanced modal, `'anchored'` fixed-position next to the ⓘ for the Update page's badge) and the `web-client/src/lib/popover-position.ts` module.
- [ ] T011 Check whether `docs/images/` holds an Update-page screenshot that changes (the popover is closed in screenshots, so expect none). Regenerate only if it changed.

## Dependencies

- T001 → T002 → T005
- T003 → T004
- T004 and T005 → T006 → T007 → T008
- T009, T010 and T011 are independent and run after T006.

## Parallel examples

- T001 and T003 (different test files).
- T009 and T010 (different docs).

## Implementation strategy

There is one deliverable. US1 is the fix, and US2 is a regression check on
the same change, so both land in one commit, followed by a docs commit.
