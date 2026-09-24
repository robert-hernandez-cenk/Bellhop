# Implementation Plan: Custom Script Repository — Only the Apps the Branch Changes

**Branch**: `issue-15-changed-apps-only` | **Date**: 2026-09-24 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/004-changed-apps-only/spec.md`

## Summary

Narrow issue #11's custom-first resolution to the apps the configured fork branch actually
changes. One GitHub compare call (upstream ProxmoxVED `main` against the branch's pinned head
commit) yields the changed-app set, the merge base and how far behind the branch is. Changed
apps resolve to the fork as today; everything else resolves exactly as with the feature off,
except a fork-only app, which still installs from the fork. For a changed app on a branch that
is behind, the app's two scripts are compared at the merge base and on upstream `main`
through raw content (no API quota, no 300-file cap); a difference is a conflict, reported as a
rebase warning that doesn't block. The catalog's custom group shrinks to the changed set and
tags conflicts.

## Technical Context

**Language/Version**: TypeScript (strict), Node ≥ 24; web client React + Vite

**Primary Dependencies**: existing only (`zod`, global `fetch`, Express, MCP SDK). No new dependencies.

**Storage**: none new. Catalog custom group stays in process memory (5-minute TTL).

**Testing**: `node --test`; `fetch` stubs replaying captured, redacted compare responses in
`test/fixtures/github/`; existing `FakeSSHClient` for install/update command tests

**Target Platform**: Bellhop host (CLI, web service, MCP stdio)

**Project Type**: CLI + web service + MCP server sharing `src/lib` and `src/operations`

**Performance Goals**: at most 2 rate-limited GitHub requests per resolution (head SHA +
compare); raw requests: 2 upstream probes, up to 1 fork probe, up to 4 conflict reads

**Constraints**: unauthenticated GitHub API (60/h); feature-off byte-identical; preview == apply

**Scale/Scope**: one operator, one custom repository, a handful of changed apps

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | How |
| --- | --- | --- |
| I. No real operational data | PASS | Fixtures are live captures redacted to `example-user`, `Example User`/`user@example.com`, fake SHAs and `demo-*` app slugs, shape and array lengths preserved. The upstream repo `community-scripts/ProxmoxVED` is a public constant already in code, not operator data. |
| II. Code quality | PASS | All GitHub logic stays in `src/lib/app-source.ts`, shared by install/update/app-check/catalog/operations. Compare response validated with `zod`. Every compare failure is a named error pointing at `set-config` (no silent fallback). No remote-execution change. |
| III. Testing | PASS | Every rule gets `node --test` coverage with fetch stubs built from the two captured fixtures; no network; time injected for catalog TTL. |
| IV. UX consistency | PASS | One resolver for CLI/web/MCP; notice is the first line in all three. No new flags. Warning names the fix (rebase the branch). README and CLAUDE.md updated. Web change verified at desktop and ≤640px. |
| Workflow | PASS | Worktree `issue-15-changed-apps-only`, PR to `main`. Single-operator assumption recorded: the upstream base is fixed to `community-scripts/ProxmoxVED@main` (as #11 already assumed a VED-shaped fork). |

Post-design re-check: PASS. The design adds no persisted state, no dependency and no
operator-specific default.

## Project Structure

### Documentation (this feature)

```text
specs/004-changed-apps-only/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/interfaces.md
├── checklists/requirements.md
└── tasks.md            # /speckit-tasks
```

### Source Code (repository root)

```text
src/lib/app-source.ts                 # compareBranch, changedSlugsFromFiles, detectConflict,
                                      # resolveAppSource rules, formatSourceNotice
src/lib/script-catalog.ts             # custom group = changed set + conflicts
src/commands/provisioning/install-app.ts   # notice via formatSourceNotice
src/commands/maintenance/update-app.ts     # notice via formatSourceNotice
src/operations/app-check.ts           # conflict flag in check response
src/mcp/build-server.ts               # tool descriptions mention changed-only + conflict
web-client/src/components/AppCheckInput.tsx   # conflict tag + conflict warning
web-client/src/api/types.ts           # conflict field
web-client/src/index.css              # conflict tag style (light/dark)
test/fixtures/github/compare-ahead-3-apps.json
test/fixtures/github/compare-diverged-conflict.json
test/lib/app-source.test.ts
test/lib/script-catalog.test.ts
test/commands/install-app.test.ts, test/commands/update-app.test.ts
test/operations/core.test.ts, test/operations/provisioning.test.ts,
test/mcp/build-server.test.ts, test/web/routes/provisioning.test.ts
                                      # wherever the old override wording/listing is asserted
README.md, CLAUDE.md
```

**Structure Decision**: existing single-project layout; the change is concentrated in
`src/lib/app-source.ts`, with thin updates at each consumer.

## Complexity Tracking

No constitution violations.
