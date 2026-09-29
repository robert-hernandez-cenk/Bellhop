# Implementation Plan: Long values wrap instead of overflowing on phone-width screens

**Branch**: `issue-5-mobile-overflow` | **Date**: 2026-09-28 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/008-mobile-overflow-wrap/spec.md`

## Summary

At phone widths the job detail header (`.job-header`) and every mobile card-layout table cell (`.data-table tbody td` below the 640px breakpoint) are flex rows whose items keep the default automatic minimum width. That minimum is the item's longest unbreakable word, so a guest name with no hyphens makes the row wider than the screen. The job header pushes its status badge and Stop button off-screen, and card values run past the card edge.

The fix is styling only, in `web-client/src/index.css`, plus one class name in `JobView.tsx`:

- **Job header:** the row may wrap. The title block gets a class that lets it shrink and break long words. The status badge never breaks.
- **Mobile card cells:** long values break (`overflow-wrap: anywhere`, which also lowers the minimum width) and wrapped values stay right-aligned.

A unit test pins the rules the fix depends on. A browser measurement at 390px, 320px and 1280px is the acceptance check.

## Technical Context

**Language/Version**: TypeScript 5.x (React web client built with Vite); plain CSS in `web-client/src/index.css`

**Primary Dependencies**: None added

**Storage**: N/A

**Testing**: Node's built-in test runner (`npm test`, `test/**/*.test.ts`); manual browser verification in headless Chrome at explicit viewport sizes

**Target Platform**: Evergreen desktop and mobile browsers

**Project Type**: Web application (Express API + React client) inside a CLI toolkit

**Performance Goals**: N/A (static styling)

**Constraints**: The single 640px breakpoint stays the only breakpoint (spec FR-009). The desktop appearance must not change for ordinary values (FR-008). Values must never be truncated (FR-007).

**Scale/Scope**: Two style rule groups (job header; mobile card cells), one JSX class name, one test file, one CLAUDE.md sentence

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Assessment |
| --- | --- |
| I. No real operational data | Pass. Specs, test and verification fixtures use example names only (`examplelongguestnamewithoutanyhyphenslxc`, `administrator@example.com`, the `hosts.yaml.example` inventory). |
| II. Code quality | Pass. No TypeScript logic changes. The CSS follows the file's existing one-line-rule style and comments explain why a rule exists, as neighbouring rules do. |
| III. Testing standards | Pass, with a note. "A bug fix MUST include a test that fails without the fix": layout can't be exercised under Node's test runner (no DOM/layout engine, and the constitution forbids network or browser-dependent tests). The test reads `index.css` and `JobView.tsx` and asserts the specific declarations the fix depends on. It fails without the fix, and it stops someone deleting a rule without noticing. The real behavioral proof is the browser measurement in `quickstart.md`, recorded in the PR. See research R4. |
| IV. UX consistency | Pass. Verified at desktop (1280px) and at 390px and 320px, which is the rule for a web UI change. Tables keep the `data-label` card convention. No themed colors change. The CLAUDE.md "Web UI responsiveness/theming" bullet gains one sentence so future tables inherit the convention. README describes no mobile layout details, so no README change is needed. |

**Post-design re-check**: unchanged; no violations, no Complexity Tracking entries.

## Project Structure

### Documentation (this feature)

```text
specs/008-mobile-overflow-wrap/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── quickstart.md        # Phase 1 output: browser verification procedure
├── checklists/
│   └── requirements.md  # Spec quality checklist
└── tasks.md             # Phase 2 output (/speckit-tasks)
```

No `data-model.md`: the feature has no data. No `contracts/`: no API, CLI, or MCP interface changes; the only surface is visual layout, fully described by the spec's acceptance scenarios.

### Source Code (repository root)

```text
web-client/src/
├── index.css                 # .job-header wrap, .job-header-main, .job-status-badge nowrap,
│                             # mobile .data-table tbody td wrapping + right alignment
└── pages/
    └── JobView.tsx           # className="job-header-main" on the header's title block

test/web-client/
└── mobile-overflow-css.test.ts   # pins the declarations above

CLAUDE.md                     # one sentence in "Web UI responsiveness/theming"
```

**Structure Decision**: existing web-client layout; no new modules.

## Complexity Tracking

No violations to justify.
