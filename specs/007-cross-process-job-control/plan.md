# Implementation Plan: Cross-Process Job Streaming and Control

**Branch**: `issue-6-mcp-job-web-control` | **Date**: 2026-09-26 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/007-cross-process-job-control/spec.md`

## Summary

Let the web UI follow and control jobs that another Bellhop process (an MCP server) owns, and let
the MCP control tools act on jobs the web service owns. Following works by tailing the shared job
log file and re-reading the shared job row once a second for a foreign job's WebSocket connection,
emitting the existing message types. Control works through a new `job_control_requests` queue table
in the shared jobs database: a non-owner checks the job row, records the request and returns at
once, and the owning `JobRunner` polls for its requests while it has active jobs and applies them
through its existing cancel/answer/dismiss methods. See [research.md](./research.md).

## Technical Context

**Language/Version**: TypeScript (strict), Node.js (versions in CI matrix)

**Primary Dependencies**: `better-sqlite3` (jobs DB), `ws` (job WebSocket), `express`,
`@modelcontextprotocol/sdk`; Node's `string_decoder` for UTF-8-safe tailing

**Storage**: `data/jobs.sqlite3` (shared, WAL) gains `job_control_requests`; job logs under
`data/job-logs/` (shared, read-only for the tailer)

**Testing**: `node --test` under `test/`, in-memory `JobStore`, `FakeSSHClient`, supertest for
routes, real `ws` client against an ephemeral `http.Server`

**Target Platform**: the web service (Windows service or `npm run web:dev`) and stdio MCP server
processes on the same machine, sharing one checkout's `data/`

**Project Type**: web service + MCP server + React web client (client unchanged)

**Performance Goals**: live view reflects changes within ~1s (SC-001 allows 2s); remote control
applied within ~0.5s poll (SC-002 allows 2s); requester returns immediately

**Constraints**: no new cross-process transport; WebSocket protocol unchanged; no owner work while
idle; answer text never persisted past handling

**Scale/Scope**: single operator, a handful of concurrent jobs and open job pages

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Assessment |
| --- | --- |
| I. No real operational data | Pass. Specs, tests and fixtures use example owners (`mcp:4242`), users (`admin`, `test-user`) and commands only. |
| II. Code quality | Pass. Strict TS; no remote-execution change (control reuses `JobRunner` methods, which reuse `JobSSHClient`); shared request logic lives once in `src/web/jobs/job-control.ts`, used by web routes and MCP tools; explicit refusal messages name the reason. Request bodies are already validated at the route/tool layer (`zod` in MCP; text coerced to string in the web route, unchanged). |
| III. Testing | Pass. Every behavior ships with tests; tailer and control polling are driven by direct `tick()`/`processControlRequests()` calls, not wall-clock; no real infrastructure. No third-party API fixtures involved. |
| IV. UX consistency | Pass. The same action gives the same refusal wording from web and MCP; secrets: answer text is not logged and is cleared from the request row once handled; README and CLAUDE.md updated in the same change. Web UI verification at desktop and ≤640px is in quickstart (client code unchanged, but the behavior is user-visible). |

Post-design re-check: unchanged, all pass. No Complexity Tracking entries.

## Project Structure

### Documentation (this feature)

```text
specs/007-cross-process-job-control/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/job-control.md
└── tasks.md             # /speckit-tasks
```

### Source Code (repository root)

```text
src/web/jobs/
├── job-store.ts         # + job_control_requests table and three methods
├── job-log.ts           # + readBytes(name, offset)
├── job-runner.ts        # + control-request polling, processControlRequests(), attribution line
├── job-control.ts       # NEW: requestJobControl() shared by web routes and MCP tools
└── job-tail.ts          # NEW: createForeignJobTail() for a foreign job's WebSocket
src/web/routes/jobs.ts   # routes use requestJobControl; WS uses the tailer for foreign jobs
src/mcp/build-server.ts  # cancel/answer/dismiss tools use requestJobControl
src/mcp/job-helpers.ts   # requireOwned comment updated (still used by wait_for_job)

test/web/jobs/{job-store,job-log,job-runner,job-control,job-tail}.test.ts
test/web/routes/jobs.test.ts
test/mcp/build-server.test.ts

README.md, CLAUDE.md     # MCP / job docs
```

**Structure Decision**: extend the existing `src/web/jobs/` module, which both the web service and
the MCP server already import; no new top-level directories.

## Complexity Tracking

None.
