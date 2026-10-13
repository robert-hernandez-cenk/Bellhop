# Implementation Plan: Follow community-scripts' rename of ProxmoxVED to DevScripts

**Branch**: `issue-101-devscripts-rename` | **Date**: 2026-10-11 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/101-devscripts-rename/spec.md`

## Summary

community-scripts renamed `community-scripts/ProxmoxVED` to `community-scripts/DevScripts`. Bellhop names the old repository in three request paths (raw base URL, `ct/` catalog listing, compare/fork-network upstream), in the `ShadowedRepo` name reported by app checks, and in operator-facing strings. The fix is a mechanical rename of each of these to `DevScripts`, plus the tests, fixtures, docs, demo and screenshot that mention it. Behavior and resolution order do not change (research R1–R3).

## Technical Context

**Language/Version**: TypeScript on Node.js (server, CLI, MCP); React + Vite (web client)

**Primary Dependencies**: none added. The existing `fetch` calls to `raw.githubusercontent.com` and `api.github.com` are kept.

**Storage**: N/A. No persisted value contains the repository name (research R3).

**Testing**: `npm test` (node test runner) with fetch stubs keyed by URL, plus `npm run typecheck`

**Target Platform**: Bellhop web service / CLI on Linux or Windows

**Project Type**: CLI + web service + web client (single repo)

**Performance Goals**: N/A (unchanged request count)

**Constraints**: example data only in tracked files (constitution Principle I). No compatibility alias (spec FR-006).

**Scale/Scope**: ~10 source files, ~20 test files, 2 fixtures, 4 docs pages, 1 screenshot

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|---|---|---|
| I. No real operational data | PASS | `community-scripts/DevScripts` is a public upstream repo name. The custom-fork examples become `example-user/DevScripts`. The regenerated screenshot comes from the demo instance's example data. |
| II. Code quality | PASS | The rename stays within existing constants. No new code paths, and the remote path is unchanged. |
| III. Testing standards | PASS | Existing fetch-stub tests are retargeted to DevScripts URLs. Because the stubs answer only the URLs they are keyed by, any leftover old-name request fails a test (SC-001). |
| IV. UX consistency | PASS | The label changes in the web UI, CLI/job log messages and MCP descriptions together. The screenshot is regenerated and checked at desktop and mobile widths. |

Post-design re-check: unchanged, PASS.

## Project Structure

### Documentation (this feature)

```text
specs/101-devscripts-rename/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/interfaces.md
└── tasks.md             # /speckit-tasks
```

### Source Code (repository root)

```text
src/lib/app-source.ts               # UPSTREAM_DEV_BASE, COMPARE_UPSTREAM, ShadowedRepo, messages
src/lib/script-catalog.ts           # DEV_REPO, shadowedBy name
src/lib/inventory.ts                # comments only
src/commands/provisioning/install-app.ts  # comments only
src/commands/provisioning/CLAUDE.md # nested guidance mentions
src/mcp/build-server.ts             # tool description
web-client/src/components/AppCheckInput.tsx  # group label, notices
web-client/src/api/types.ts         # comments
web-client/src/pages/SettingsPage.tsx        # help text
scripts/demo/demo-fetch.ts          # DEV_REPO
test/**                             # URLs, examples, assertions
test/fixtures/github/compare-*.json # captured compare responses' URLs
docs/commands.md, docs/configuration.md, docs/web-ui.md, docs/images/install-app-catalog.png
```

**Structure Decision**: existing layout. Every change edits a file in place.

## Complexity Tracking

None.
