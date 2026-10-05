# Implementation Plan: Accept a second action while a job is running

**Branch**: `issue-78-job-queue-capture` | **Date**: 2026-10-04 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/078-job-queue-capture/spec.md` (GitHub issue #78)

## Summary

A second web-UI or MCP action waits, with no job row, until the running job finishes, because every console capture in the process (job runs and dry-run previews) is serialized on one promise chain. The fix isolates captures by async context (`AsyncLocalStorage`) so they no longer wait on each other, and moves "one job at a time" into `JobRunner` as an explicit serial queue. See [research.md](research.md) for the decisions and [contracts/console-capture.md](contracts/console-capture.md) for the before/after guarantees.

## Technical Context

**Language/Version**: TypeScript (strict), Node.js 24 and 26 (CI matrix; `engines: >=24`)

**Primary Dependencies**: `node:async_hooks` `AsyncLocalStorage` (built in); no new packages

**Storage**: N/A (jobs table and log files unchanged)

**Testing**: `node --test` (`npm test`), `FakeSSHClient` for job-driven tests, temporary `JobStore`/`JobLog` as in `test/web/jobs/job-runner.test.ts`

**Target Platform**: the web service (Windows service) and the stdio MCP server

**Project Type**: CLI + web service + MCP server, single TypeScript project

**Performance Goals**: a second action's request completes in its preview's own time, not the running job's

**Constraints**: jobs stay strictly serial per runner; MCP stdout stays protocol-only; tests deterministic (controlled promises, no wall-clock waits)

**Scale/Scope**: two source files changed (`src/web/console-capture.ts`, `src/web/jobs/job-runner.ts`), one comment (`src/operations/core.ts`), the `src/mcp/server.ts` comment, CLAUDE.md wording

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Check | Status |
|-----------|-------|--------|
| I. No real operational data | No fixtures, hostnames or credentials involved; spec files use none | Pass |
| II. Code quality | Strict TS, no new remote-execution path, no shared logic copied; capture stays in one module | Pass |
| III. Testing | Each behavior change gets a failing-first test; job tests use `FakeSSHClient`; no wall-clock timing (gates are test-controlled promises) | Pass |
| IV. UX consistency | Web and MCP share `previewAndEnqueue`/`JobRunner`, so both get the fix; no UI change (queued status already shown); CLAUDE.md wording updated for the convention change | Pass |

Post-design re-check: unchanged, all pass. No violations to track.

## Project Structure

### Documentation (this feature)

```text
specs/078-job-queue-capture/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/console-capture.md
├── checklists/requirements.md
└── tasks.md            # /speckit-tasks
```

### Source Code (repository root)

```text
src/
├── web/console-capture.ts        # AsyncLocalStorage capture, ref-counted install
├── web/jobs/job-runner.ts        # serial queue of execute() calls
├── operations/core.ts            # comment above previewAndEnqueue
└── mcp/server.ts                 # comment on the stderr redirect
test/
├── web/console-capture.test.ts   # isolation, nesting, fallback, late lines
├── web/jobs/job-runner.test.ts   # serial queue, queued cancel, callback lines
└── operations/core.test.ts       # previewAndEnqueue returns while a job runs
CLAUDE.md                          # "Shared operations layer" wording
```

**Structure Decision**: existing single-project layout; changes stay in the modules that own capture and job execution.

## Complexity Tracking

None.
