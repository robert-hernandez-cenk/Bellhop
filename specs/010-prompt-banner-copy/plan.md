# Implementation Plan: Prompt banner copy per detection origin

**Branch**: `issue-4-prompt-banner-copy` | **Date**: 2026-09-29 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/010-prompt-banner-copy/spec.md`

## Summary

`JobView.tsx`'s prompt banner picks its hint with two inline
`promptOrigin === ...` branches and always labels the dismiss button "Not stuck
— keep waiting". The fix moves every per-origin choice into one
framework-free lookup, `promptBannerView()` in
`web-client/src/lib/prompt-banner.ts`, keyed by a
`Record<PromptOrigin | 'none', …>` table so the compiler rejects a missing
origin. `JobView` renders whatever it returns: the hint text (or none), whether
the hint uses the strong stall styling, the dismiss label, and which controls
are de-emphasised.

Emphasis becomes a per-button class, `.prompt-banner-quiet`, instead of the
positional `.prompt-banner-actions-stall > .button:not(:last-child)` selector
that hard-codes "the last button is dismiss". Stall puts it on Yes/No/Submit (as
today); expected puts it on the dismiss button; heuristic and unrecorded put it
on nothing.

## Technical Context

**Language/Version**: TypeScript 5.x (React web client built with Vite); plain CSS in `web-client/src/index.css`

**Primary Dependencies**: None added

**Storage**: N/A

**Testing**: Node's built-in test runner (`npm test`), `test/web-client/prompt-banner.test.ts` imports the framework-free helper directly, like `admin-nav.test.ts`; browser check at desktop and ≤640px with seeded `awaiting_input` job rows

**Target Platform**: Evergreen desktop and mobile browsers

**Project Type**: Web application (Express API + React client) inside a CLI toolkit

**Performance Goals**: N/A

**Constraints**: Presentation only (FR-010): no server, API, detection, or MCP change. The existing stall emphasis must look the same as today (FR-007).

**Scale/Scope**: One new ~60-line helper, one test file, `JobView.tsx` banner block, three CSS rules, one CLAUDE.md sentence

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Assessment |
| --- | --- |
| I. No real operational data | Pass. Test fixtures are prompt counts and origins only; the quickstart seeds rows with example app names (`demo-app`) into a throwaway jobs database. |
| II. Code quality | Pass. The helper follows `admin-nav.ts`/`settings-display.ts`: framework-free, `.ts` imports of `../api/types.ts`, compiles under the root config. Per-origin copy lives in exactly one place. |
| III. Testing standards | Pass. The helper's output for every origin (and both heuristic variants, both expected variants) is pinned by deterministic unit tests that fail on today's code (the helper doesn't exist; the old labels would fail the assertions). Rendering is verified in the browser per quickstart. |
| IV. UX consistency | Pass. Verified at 1280px and 390px, light and dark theme. README does not describe the banner's labels, so it needs no change; CLAUDE.md's `install-app` bullet (which already describes how `JobView` numbers a known prompt and flags a stall) gains one sentence pointing at the helper. The MCP dialog's wording is untouched, and "Not a question — keep waiting" deliberately mirrors its "Not a real prompt — resume". |

**Post-design re-check**: unchanged; no violations, no Complexity Tracking entries.

## Project Structure

### Documentation (this feature)

```text
specs/010-prompt-banner-copy/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1: the view shape promptBannerView() returns
├── quickstart.md        # Phase 1: seeded-row browser verification
├── contracts/
│   └── banner-copy.md   # Exact per-origin strings and emphasis (the UI contract)
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 output (/speckit-tasks)
```

### Source Code (repository root)

```text
web-client/src/
├── lib/prompt-banner.ts   # NEW: promptBannerView() + per-origin table
├── pages/JobView.tsx      # banner renders from promptBannerView()
└── index.css              # .prompt-banner-quiet replaces the positional stall selectors

test/web-client/
└── prompt-banner.test.ts  # NEW

CLAUDE.md                  # one sentence in the install-app prompt-relay paragraph
```

**Structure Decision**: Existing web-client layout; the helper sits beside the other framework-free `lib/` modules so it is testable under plain `node --test`.

## Complexity Tracking

None.
