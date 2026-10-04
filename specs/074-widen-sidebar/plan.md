# Implementation Plan: Widen the desktop sidebar so nav links stay on one line

**Branch**: `issue-74-widen-sidebar` | **Date**: 2026-10-04 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/074-widen-sidebar/spec.md`

## Summary

The desktop sidebar is 200px wide and its links may wrap. "Deploy VPN Gateway" fits only while no scroll bar shows; once the nav scrolls, the scroll bar narrows the column, the label wraps, and the list grows. The fix is two CSS rules in `web-client/src/index.css`: widen the desktop `.sidebar` to 220px (and stop it shrinking in the flex row), and give `.sidebar a` `white-space: nowrap` with an ellipsis for overflow. The mobile drawer rule inside the 640px media query already sets its own 240px width and is unchanged. The CLAUDE.md note describing the "static 200px column" and the docs screenshots that show the sidebar are updated to match.

## Technical Context

**Language/Version**: CSS (web client built with Vite; React + TypeScript components untouched)

**Primary Dependencies**: none new

**Storage**: N/A

**Testing**: no automated CSS layout tests exist; verification is a browser check (quickstart.md) at desktop and mobile widths, plus the existing `npm run typecheck`, `npm test`, `npm run web:build` as regression checks

**Target Platform**: desktop and mobile browsers

**Project Type**: web application (web-client front end)

**Performance Goals**: N/A

**Constraints**: mobile drawer (≤640px) unchanged; no horizontal page scroll at 1280px and wider

**Scale/Scope**: one stylesheet, one CLAUDE.md sentence, regenerated docs screenshots

## Constitution Check

| Principle | Status | Notes |
|---|---|---|
| I. No real operational data | PASS | No data touched. Screenshots are regenerated from the demo instance (example data only) and checked by eye. |
| II. Code quality | PASS | CSS only; follows existing stylesheet conventions. |
| III. Testing standards | PASS | Browser verification at desktop and ≤640px viewports, as the constitution requires for a web UI change. No logic to unit-test. |
| Docs in sync | PASS | CLAUDE.md "static 200px column" updated; screenshots regenerated per the demo-instance workflow convention. |

Post-design re-check: unchanged, PASS.

## Project Structure

### Documentation (this feature)

```text
specs/074-widen-sidebar/
├── spec.md
├── plan.md
├── research.md
├── quickstart.md
├── checklists/requirements.md
└── tasks.md
```

No `data-model.md` or `contracts/`: the change has no entities and no interfaces.

### Source Code (repository root)

```text
web-client/src/index.css   # .sidebar width + flex-shrink; .sidebar a nowrap/ellipsis
CLAUDE.md                  # "static 200px column" -> 220px
docs/images/*.png          # regenerated with npm run docs:screenshots
```

**Structure Decision**: single stylesheet edit in the existing web client.

## Complexity Tracking

None.
