---

description: "Task list for field explanations in the guest Advanced modal"
---

# Tasks: Field Explanations in the Guest Advanced Modal

**Input**: Design documents from `specs/011-advanced-field-help/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/field-help.md, quickstart.md

**Tests**: included. The constitution (Principle III) requires tests for every behavior change. Tests are framework-free `node:test` files under `test/web-client/`. There is no DOM test harness in this repo, so component interaction is covered by the browser check in the Polish phase.

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Setup

None. The existing `web-client/` app and test layout are used as they are.

---

## Phase 2: Foundational (Blocking Prerequisites)

- [x] T001 Create `test/web-client/advanced-field-help.test.ts` (`node:test`, `node:assert/strict`, importing `ADVANCED_FIELD_HELP` from `../../web-client/src/lib/advanced-field-help.ts`, like `test/web-client/prompt-banner.test.ts`). Tests:
  - (a) the map equals the 15 label → text entries in `specs/011-advanced-field-help/contracts/field-help.md`, verbatim;
  - (b) every value is non-empty and has one or two sentences: split on `/[.!?](\s|$)/` after trimming, and count the non-empty parts;
  - (c) the FR-003 facts appear:
    - `read-only proxy` mentions `hand-written`, `managed section` and `Authentik gating still applies`;
    - `insecure backend tls` mentions `automatically`;
    - `unauthenticated paths` mentions `No effect unless` and `forward-auth`;
    - `callback urls` mentions `No effect unless` and `OIDC mode`.

  Confirm the tests fail because the module is missing.
- [x] T002 Create `web-client/src/lib/advanced-field-help.ts`.
  - Keep it framework-free: no React/DOM imports, and a header comment giving the same rationale as `web-client/src/lib/prompt-banner.ts`, plus a note that the modal's labels must match these keys.
  - Export `ADVANCED_FIELD_HELP: Readonly<Record<string, string>>` with the 15 entries from the contract, verbatim, in modal order.
  - Run `npm test`; T001 passes.

**Checkpoint**: the explanation text exists in one place and is pinned by tests.

---

## Phase 3: User Story 1 - Understand a field before changing it (Priority: P1) MVP

**Goal**: every label in the Advanced modal has an ⓘ that shows its explanation on mouse hover and stays open on click.

**Independent Test**: open Advanced on a guest at desktop width. Hover and click each ⓘ.

- [x] T003 [US1] In `test/web-client/advanced-field-help.test.ts`, add a test that reads `web-client/src/components/AdvancedGuestModal.tsx` as text (like `test/web-client/mobile-overflow-css.test.ts` reads CSS).
  - It collects every `field="…"` attribute passed to `<FieldHelp`, and also every remaining `<div className="form-row-label">…</div>` whose text is not wrapped by FieldHelp.
  - It asserts: the set of `field=` values equals `Object.keys(ADVANCED_FIELD_HELP)`; the collected list has no duplicates; there are zero bare labels (SC-005).

  Confirm the test fails.
- [x] T004 [US1] Create `web-client/src/components/FieldHelp.tsx`.
  - Props: `{ field: string; text: string; open: boolean; pinned: boolean; onHover(open: boolean): void; onToggle(): void; onClose(): void }`.
  - Render the label text `field`, then a `<button type="button" className="field-help-button" aria-label={`About ${field}`} aria-expanded={open} aria-controls={id}>ⓘ</button>`, where `id` comes from `useId()`.
  - When open, render `<div id={id} className="field-help-popover">{text}</div>`.
  - Hover: `onPointerEnter`/`onPointerLeave` call `onHover(true/false)` only when `e.pointerType === 'mouse'` (research R1).
  - Activation: `onClick` calls `onToggle()`.
  - Keep it generic, with no Advanced-modal-specific imports, so other pages can reuse it.
- [x] T005 [US1] In `web-client/src/components/AdvancedGuestModal.tsx`:
  - Add `const [help, setHelp] = useState<{ field: string; pinned: boolean } | null>(null)`.
  - Add a helper `helpFor(field)` returning FieldHelp props per the transitions in `specs/011-advanced-field-help/data-model.md`:
    - hover-in opens unpinned only when nothing is pinned;
    - hover-out closes only an unpinned open state for that field;
    - toggle flips pinned for that field and replaces any other;
    - close → `null`.
  - Replace the text of every `<div className="form-row-label">` (all 15, including `oidc client`) with `<FieldHelp field="<label>" text={ADVANCED_FIELD_HELP['<label>']} {...helpFor('<label>')} />`.
  - Leave every `Editable*` component untouched (FR-010). Run `npm test`; T003 passes.
- [x] T006 [US1] In `web-client/src/index.css`, next to the existing `.form-row` rules:
  - Give `.form-row` `position: relative`.
  - Make `.form-row-label` `display: flex; align-items: center; gap: 4px`.
  - Add `.field-help-button` as a borderless, transparent, `color: var(--text-secondary)`, `font: inherit`, `line-height: 1` inline button, with `min-width: 24px; min-height: 24px`, `cursor: pointer`, `padding: 0` and `border-radius: 50%`. Add a `:hover`/`:focus-visible` state using `color: var(--accent)` and a visible focus outline.
  - Add `.field-help-popover`:
    - `position: absolute; top: 100%; left: 0; right: 0; z-index: 10; margin-top: 2px`;
    - `background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 6px`;
    - `color: var(--text-primary); font-size: 12px; line-height: 1.4; padding: 8px 10px`;
    - `box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2); white-space: normal; overflow-wrap: anywhere`.
  - The label column is `width: 110px`, so check that `insecure backend tls` and `unauthenticated paths` still fit with the ⓘ (widen to `128px` only if they wrap badly).
  - Run `npm run typecheck` and `npm run web:build`.

**Checkpoint**: at desktop width, hovering or clicking any ⓘ shows the right explanation with no row moving.

---

## Phase 4: User Story 2 - Reach explanations on a phone (Priority: P1)

**Goal**: tap toggles; tapping elsewhere closes; nothing overflows at ≤640px.

**Independent Test**: at 375px, tap each ⓘ, then tap outside.

- [ ] T007 [US2] In `web-client/src/components/FieldHelp.tsx`, while `open`, register a `document` `pointerdown` listener in a `useEffect` (with cleanup). It calls `onClose()` when the event target is outside both the button and the popover, using refs on a wrapping `<span className="field-help">` that contains both. Clicking inside the popover must not close it. The listener must not use capture ordering that would swallow the modal backdrop's own click, which still closes the modal.
- [ ] T008 [US2] In `web-client/src/index.css`, confirm inside `@media (max-width: 640px)` that nothing overrides `.form-row`/`.form-row-label` in a way that breaks the popover's row-width anchoring. Add a mobile rule only if the browser check in T012 shows a problem.

**Checkpoint**: on a phone-width viewport, every explanation opens by tap, fits the modal and closes by tap.

---

## Phase 5: User Story 3 - Reach explanations by keyboard (Priority: P2)

**Goal**: Tab reaches each ⓘ; Enter/Space toggles; Escape closes; focus leaving closes.

**Independent Test**: keyboard only, open and close each explanation.

- [ ] T009 [US3] In `web-client/src/components/FieldHelp.tsx`:
  - An `onKeyDown` on the button handles `Escape` while open: call `onClose()` and `e.stopPropagation()`, and leave focus on the button (research R4).
  - An `onBlur` on the button calls `onClose()` when `pinned`, unless `e.relatedTarget` is inside the popover.
  - Enter/Space already toggle through the native button's `click`.

**Checkpoint**: all three input methods work.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [ ] T010 [P] Update `README.md` where the Dashboard's Advanced modal is described (search for "Advanced"): each field now has an ⓘ explanation you can reach by hover, tap or keyboard. If README doesn't describe the modal, add one sentence to the Dashboard section.
- [ ] T011 [P] Update `CLAUDE.md`'s "Web UI responsiveness/theming" bullet with one sentence:
  - the Advanced modal's field explanations live in `web-client/src/lib/advanced-field-help.ts` (issue #34), keyed by label and pinned by a test against the modal source;
  - `FieldHelp` (`web-client/src/components/FieldHelp.tsx`) is the reusable ⓘ disclosure, used instead of a hover-only `title` because `title` never shows on touch.

  Check `CONTRIBUTING.md` restates nothing affected.
- [ ] T012 Follow `specs/011-advanced-field-help/quickstart.md` in a browser at 1280×800 and 375×812, in light and dark themes, including an OIDC-mode guest's `oidc client` row and the last (`app`) row. Save screenshots for the PR.
- [ ] T013 Run `npm run typecheck`, `npm test` and `npm run web:build`; all must pass.

---

## Dependencies & Execution Order

- T001 → T002 (foundational) → US1 (T003 → T004 → T005 → T006) → US2 (T007, T008) and US3 (T009). US2 and US3 each touch `FieldHelp.tsx`, so run them sequentially.
- Polish runs after all stories. T010 and T011 are parallel (different files). T012 runs before T013.

## Parallel Opportunities

- T010 ∥ T011.
- Otherwise the work is small and mostly sequential through `FieldHelp.tsx` and `AdvancedGuestModal.tsx`.

## Implementation Strategy

MVP = Phases 2–3: explanations exist and work by mouse. Phases 4 and 5 add touch
and keyboard, which the issue's acceptance criteria require, so all phases ship
in one PR.
