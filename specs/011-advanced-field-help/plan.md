# Implementation Plan: Field Explanations in the Guest Advanced Modal

**Branch**: `issue-34-advanced-modal-tooltips` | **Date**: 2026-09-29 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/011-advanced-field-help/spec.md`

## Summary

Give each of the 15 field labels in the Dashboard's guest Advanced modal a small ⓘ
button that reveals a one-to-two-sentence explanation. All text lives in one
framework-free module, `web-client/src/lib/advanced-field-help.ts`, keyed by the
modal's own label strings. A new reusable `FieldHelp` component renders the button
and an absolutely positioned popover spanning the field's row, so opening it never
shifts other rows and never overflows the modal at ≤640px. The modal owns one
"which explanation is open, and is it pinned" state, so at most one is open at a
time. Hover shows an explanation transiently; click, tap, Enter or Space pins it;
Escape, a click outside, or focus leaving the button closes it. No `Editable*`
component and no server code changes.

## Technical Context

**Language/Version**: TypeScript 6 (web-client), React 19

**Primary Dependencies**: React only; no new dependency

**Storage**: N/A

**Testing**: Node's built-in test runner (`npm test`), tests under `test/web-client/`
importing framework-free `web-client/src/lib/*.ts` modules directly (same pattern as
`prompt-banner.test.ts`, `admin-nav.test.ts`), plus a source-reading check of
`AdvancedGuestModal.tsx` (same technique as `mobile-overflow-css.test.ts`)

**Target Platform**: Web UI in desktop and mobile browsers

**Project Type**: Web application (Express server + Vite React client); client-only change

**Performance Goals**: N/A (static text)

**Constraints**: works by mouse, keyboard and touch; no layout shift; no horizontal
overflow at ≤640px; light and dark themes via existing CSS variables

**Scale/Scope**: 1 modal, 15 fields, 1 new component, 1 new lib module, CSS additions

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. No real operational data | Pass | Explanation text is generic; no hostnames, IPs or credentials. |
| II. Code quality | Pass | One small component and one data module; no duplication of text in `Editable*` components. |
| III. Testing standards | Pass | Tests pin the help map (coverage of every modal label, no stale entries, ≤2 sentences, required facts) and the modal wiring; deterministic, no network. No third-party fixtures. |
| IV. UX consistency | Pass | Browser check at desktop and ≤640px is a task; themed styles use the existing variables, which already switch under `:root[data-theme='dark']`. README gains a line (user-visible change). No CLI/MCP surface involved. |

Post-design re-check: unchanged, all pass.

## Project Structure

### Documentation (this feature)

```text
specs/011-advanced-field-help/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── field-help.md     # exact explanation text + interaction contract
└── tasks.md              # /speckit-tasks
```

### Source Code (repository root)

```text
web-client/src/
├── lib/advanced-field-help.ts          # NEW: label -> explanation map
├── components/FieldHelp.tsx            # NEW: ⓘ button + popover
├── components/AdvancedGuestModal.tsx   # labels render FieldHelp; owns open state
└── index.css                           # .field-help* styles, .form-row positioning

test/web-client/
└── advanced-field-help.test.ts         # NEW
```

**Structure Decision**: client-only change inside the existing `web-client/` app;
tests live beside the other framework-free web-client tests in `test/web-client/`.

## Complexity Tracking

None.
