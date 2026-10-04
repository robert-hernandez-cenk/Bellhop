# Implementation Plan: App update badge explanation that stays put

**Branch**: `issue-75-badge-tooltip-jump` | **Date**: 2026-10-04 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/075-badge-tooltip-jump/spec.md`

## Summary

`FieldHelp`'s popover is `position: absolute; top: 100%; left: 0; right: 0`.
It relies on the Advanced modal's `.form-row` to be its containing block. On
the Update page, `AppUpdateBadge` has no positioned ancestor, so the popover
is laid out against `<body>`. It spans the full width, sits below the last
card and makes the document taller. FieldHelp's on-open `scrollIntoView`
then scrolls the page.

Fix: give `FieldHelp` an optional `placement` prop.
- `'row'` (the default) is today's markup, CSS and `scrollIntoView`,
  untouched, so the Advanced modal is byte-for-byte unchanged.
- `'anchored'` (used by `AppUpdateBadge`) renders the popover
  `position: fixed`. A layout effect places it beside the ⓘ button using a
  pure `placePopover()` from a new `web-client/src/lib/popover-position.ts`.
  The effect re-runs on scroll and resize while the popover is open, and the
  popover never calls `scrollIntoView`.

A fixed-position box doesn't add to the document's scrollable size, so
opening it can't change page height or scroll position (FR-004).

## Technical Context

**Language/Version**: TypeScript 5 (web client: React 18 + Vite)

**Primary Dependencies**: React only. No new dependency (spec assumption: no tooltip library).

**Storage**: N/A

**Testing**: `node --test` via `npm test` (framework-free modules under `web-client/src/lib/`, tested from `test/web-client/`); manual browser verification on the demo instance

**Target Platform**: Evergreen desktop and mobile browsers

**Project Type**: Web application (Express API + React client); client-only change

**Performance Goals**: Re-positioning on scroll is one `getBoundingClientRect` and two style writes per animation frame, and only while that popover is open

**Constraints**: Must not alter Advanced modal behavior; must hold at ≤640 px and in both themes

**Scale/Scope**: 3 source files (FieldHelp, AppUpdateBadge, index.css) + 1 new lib module + 1 test file + docs line

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status |
|-----------|--------|
| I. No real operational data | Pass. Verification uses the demo instance (example inventory only); no fixtures with real values. |
| II. Code quality | Pass. Pure placement math is isolated in a framework-free module; the component only wires DOM measurement to it. |
| III. Testing | Pass. `placePopover`/`popoverMaxWidth` get `node --test` unit tests that fail against the absence of the module; a CSS test pins that the anchored popover is `position: fixed` and the row popover keeps its absolute layout. No network, no timing. |
| IV. UX consistency | Pass. Verified in a browser at desktop and ≤640 px, light and dark; dark styles (none new) would target `:root[data-theme='dark']`; `docs/web-ui.md` updated to describe where the explanation appears; `CLAUDE.md`'s FieldHelp sentence updated for the new placement option. |

Re-check after Phase 1: unchanged, all pass.

## Project Structure

### Documentation (this feature)

```text
specs/075-badge-tooltip-jump/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── field-help-placement.md
└── tasks.md             # /speckit-tasks
```

### Source Code (repository root)

```text
web-client/src/
├── lib/popover-position.ts        # NEW: pure placement math
├── components/FieldHelp.tsx       # placement prop; anchored positioning effect
├── components/AppUpdateBadge.tsx  # passes placement="anchored"
└── index.css                      # .field-help-popover-anchored rule

test/web-client/
├── popover-position.test.ts       # NEW
└── mobile-overflow-css.test.ts    # (or a new field-help-css test) anchored rule pinned

docs/web-ui.md                     # where the explanation appears
CLAUDE.md                          # FieldHelp sentence
```

**Structure Decision**: Existing web-client layout; the new module follows the
`web-client/src/lib/*.ts` framework-free convention (same as `admin-nav.ts`,
`app-update-display.ts`) so it is testable with plain `node --test`.

## Complexity Tracking

None.
