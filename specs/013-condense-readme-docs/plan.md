# Implementation Plan: Condense the README into a docs/ folder

**Branch**: `issue-41-condense-readme-docs` | **Date**: 2026-09-29 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/013-condense-readme-docs/spec.md`

## Summary

`README.md` is cut from 1,166 lines to 200 or fewer: intro, prerequisites, quickstart, a commands table and a documentation index. Everything else moves, mostly verbatim, into ten pages under `docs/`, including a `docs/reverse-proxy/` folder with one page per driver. Seams become relative links. A new `test/docs/links.test.ts` keeps every relative link and anchor resolving and the README within budget. Pointers to old README sections are updated: one error hint, three comments, CLAUDE.md, CONTRIBUTING.md, the pull request template and the constitution (PATCH amendment 1.1.1).

## Technical Context

**Language/Version**: Markdown (GitHub-flavored). TypeScript 5 on Node 24+ for the one test file.

**Primary Dependencies**: none new. The test uses `node:test`, `node:fs` and `node:path`.

**Storage**: N/A

**Testing**: Node's built-in test runner via `npm test` (`test/**/*.test.ts`).

**Target Platform**: GitHub's Markdown renderer (the docs); Node 24/26 in CI (the test).

**Project Type**: documentation restructure in a CLI + web-service repository.

**Performance Goals**: N/A. The test reads about 11 files.

**Constraints**: README ≤ 200 lines; no content lost; rewording limited to seams; Principle I (example values only). The moved text already uses example values.

**Scale/Scope**: about 1,166 lines redistributed across 11 Markdown files; 1 new test; 1 string change; about 8 pointer edits.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|---|---|---|
| I. No real operational data | PASS | The content moves as-is and already uses example values. The new text (quickstart, table, caddy.md connective text) uses example values only. The diff gets reviewed before the PR. |
| II. Code quality | PASS | The test matches existing test style. The one string change keeps the error actionable. |
| III. Testing standards | PASS | The behavior change (the error hint wording) updates its existing test. The link check is deterministic and offline, and runs under `node:test`. |
| IV. UX consistency | PASS, with an amendment | The "update README.md" rule is restated to include `docs/` (PATCH 1.1.1). The error hint still tells the user where to look. No web UI change, so no viewport check is needed. |
| Workflow gates | PASS | Worktree branch, PR to main, CI's three checks. |

Post-design re-check: unchanged, all pass. No Complexity Tracking entries.

## Project Structure

### Documentation (this feature)

```text
specs/013-condense-readme-docs/
├── plan.md
├── research.md
├── data-model.md        # section-by-section content map
├── quickstart.md
├── contracts/
│   ├── docs-layout.md
│   └── link-check.md
└── tasks.md             # /speckit-tasks
```

### Source Code (repository root)

```text
README.md                          # condensed
docs/
├── commands.md
├── configuration.md
├── environment-variables.md
├── web-ui.md
├── mcp-server.md
├── authentik.md
├── troubleshooting.md
└── reverse-proxy/
    ├── README.md
    ├── caddy.md
    └── nginx.md
test/docs/links.test.ts            # new
src/commands/networking/sync-authentik.ts   # hint string + comment
src/web/auth.ts                    # comment
test/commands/sync-authentik-mobile-consent.test.ts
inventory/hosts.yaml.example       # comment
CLAUDE.md, CONTRIBUTING.md, .github/pull_request_template.md,
.specify/memory/constitution.md    # pointers / rule wording
```

**Structure Decision**: a flat `docs/` folder with one subfolder for proxy drivers, since that is the only topic expected to grow page by page (#26, #31, #32, #35).

## Implementation order

1. Write the link-check test first. It fails against `main` (README over budget, and `docs/` missing).
2. Create the `docs/` pages from the content map (data-model.md), fixing the seams as each page is written.
3. Rewrite `README.md` to the layout contract. The test now passes.
4. Update the pointers outside the README, including the error hint and its test.
5. Verify, following quickstart.md.

## Complexity Tracking

None.
