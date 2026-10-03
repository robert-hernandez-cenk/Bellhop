# Implementation Plan: Prompts Hidden Behind a Redrawing Spinner

**Branch**: `issue-52-spinner-hides-prompts` | **Date**: 2026-10-03 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/052-spinner-hides-prompts/spec.md`

## Summary

`JobSSHClient`'s prompt detection treats every output chunk as activity, so a
spinner that redraws its line every ~100 ms keeps its three silence tiers from
ever firing (issue #52). This change adds a small pure module,
`src/web/jobs/output-activity.ts`, that splits the stream into lines on `\r`
and `\n`. It classifies each line as meaningful or as a redraw, by comparing
a normalized key against the recent meaningful lines, and keeps a bounded
transcript of meaningful output only. `JobSSHClient` re-arms its tiers only
when that module reports new meaningful output. It reads the prompt candidate
and stall text from the module instead of the raw buffer. A stall pause also
clears itself when meaningful output arrives (FR-012). Redraws still go to
the job log unchanged.

## Technical Context

**Language/Version**: TypeScript (strict), Node 22+ (repository's supported versions)

**Primary Dependencies**: none new

**Storage**: N/A (in-memory, per exec call)

**Testing**: `node --test` via `npm test`; deterministic fake scheduler already used by `test/web/jobs/job-ssh-client.test.ts`

**Target Platform**: Bellhop web service and MCP server (both run `JobRunner`)

**Project Type**: web service + CLI toolkit (single project, `src/` + `test/`)

**Performance Goals**: classification is O(chunk length) per chunk; tier checks no longer re-strip a multi-megabyte buffer

**Constraints**: retained detection text bounded (16 KiB transcript, 16 recent keys)

**Scale/Scope**: one new module (~150 lines), edits to `job-ssh-client.ts`, tests, CLAUDE.md paragraph

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. No real operational data**: tests and docs use example output only
  (spinner text and example prompt strings). Pass.
- **II. Code quality**: strict TypeScript; no new remote execution; logic in
  one module, not duplicated (the existing `ANSI_ESCAPE` export is reused).
  Pass.
- **III. Testing**: bug fix ships with failing-first tests (the mariadb-shaped
  replay, spinner-only stall, stall auto-clear); deterministic, using the
  existing fake scheduler, no wall-clock. Pass.
- **IV. UX consistency**: there is no new front-end surface. Web and MCP share
  `JobRunner`/`JobSSHClient`, so both get the fix. CLAUDE.md's #160 paragraph
  is updated in the same change. No README or docs page describes the tier
  internals (checked `docs/`), so none needs an update. Pass.

Post-design re-check: unchanged, pass.

## Project Structure

### Documentation (this feature)

```text
specs/052-spinner-hides-prompts/
├── plan.md
├── research.md
├── quickstart.md
├── contracts/
│   └── output-activity.md
├── checklists/requirements.md
└── tasks.md            # /speckit-tasks
```

### Source Code (repository root)

```text
src/web/jobs/
├── output-activity.ts     # NEW: line classification + bounded transcript
└── job-ssh-client.ts      # uses OutputActivity instead of a raw buffer

test/web/jobs/
├── output-activity.test.ts   # NEW: unit tests for classification
└── job-ssh-client.test.ts    # + spinner replay, spinner stall, stall auto-clear
```

**Structure Decision**: a single project, with the new module beside
`prompt-matcher.ts`. It is extracted the same way that file was, so the
logic can be unit-tested apart from timers.

## Complexity Tracking

No constitution violations.
