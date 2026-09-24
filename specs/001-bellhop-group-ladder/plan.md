# Implementation Plan: Rename the Default Group Ladder to Bellhop Names

**Branch**: `issue-8-bellhop-group-ladder` | **Date**: 2026-09-23 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/001-bellhop-group-ladder/spec.md`

## Summary

Change the default Authentik group ladder from `homelab-app-users-open,homelab-app-users,homelab-users,authentik Admins` to `bellhop-app-users-open,bellhop-app-users,bellhop-users,authentik Admins`. The default is one constant in `src/lib/authentik-config.ts`; every consumer reads it through `authentikConfig()`. Stored `authGroup` values are not migrated. Operators on the old default either set `AUTHENTIK_GROUP_LADDER` to the old names or re-tier their apps, and the existing off-ladder handling in `sync-authentik` keeps the skipped-step case safe and visible. Tests and docs follow the new default, and two new tests pin the default and the off-ladder upgrade behavior.

## Technical Context

**Language/Version**: TypeScript (strict), Node.js LTS versions in CI

**Primary Dependencies**: none added; existing `zod`, `better-sqlite3`, `dotenv`

**Storage**: `inventory/bellhop.db` (SQLite); no schema or data change

**Testing**: Node's built-in test runner (`npm test`), `npm run typecheck`, `npm run web:build`

**Target Platform**: Windows service host plus CLI and MCP server; unchanged

**Project Type**: CLI + web service + MCP server

**Performance Goals**: N/A (a constant change)

**Constraints**: no stored-data migration (issue #8); explicit `AUTHENTIK_GROUP_LADDER` values keep their exact current behavior

**Scale/Scope**: 1 source constant and its comment, 8 test files (37 occurrences), 2 new tests, README and CLAUDE.md passages

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Check | Status |
| --- | --- | --- |
| I. No real operational data | Spec, plan, and tests use only product-named groups and Authentik's built-in group. The change removes a default whose own comment says it "names one deployment's own Authentik groups", which is the kind of operator-specific default Principle I forbids. | Pass (improves compliance) |
| II. Code quality | One constant in its single existing home; no new fallback or silent behavior. Off-ladder entries keep today's explicit report. | Pass |
| III. Testing | Behavior change ships with a default-ladder test and an off-ladder upgrade test; fixtures move to the new default; no network, no real inventory. | Pass |
| IV. UX consistency | CLI, web UI, and MCP all read the same `authentikConfig()`, so all three change together. README (user-visible default) and CLAUDE.md (conventions) updated in the same change. | Pass |
| Workflow: single-operator assumptions | The source comment recording the operator-specific default is rewritten in this branch. | Pass |

Post-design re-check: no change. Research added no new component or dependency.

## Project Structure

### Documentation (this feature)

```text
specs/001-bellhop-group-ladder/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── configuration.md
├── checklists/
│   └── requirements.md
└── tasks.md             # created by /speckit-tasks
```

### Source Code (repository root)

```text
src/lib/authentik-config.ts          # DEFAULT_GROUP_LADDER and its comment
test/lib/authentik-config.test.ts    # default-ladder assertion (new/updated)
test/commands/sync-authentik.test.ts # off-ladder upgrade test (new)
test/commands/sync-caddy.test.ts     # fixture rung names
test/lib/inventory.test.ts           # fixture rung names
test/operations/edit-guest.test.ts   # fixture rung names
test/web/caddy-sync.test.ts          # fixture rung names
test/web/routes/auth-groups.test.ts  # fixture rung names
test/web/routes/dashboard.test.ts    # fixture rung names
test/web/routes/provisioning.test.ts # fixture rung names
README.md                            # AUTHENTIK_GROUP_LADDER entry + upgrade note
CLAUDE.md                            # sync-authentik bullet, requires_auth migration paragraph
```

**Structure Decision**: Existing single-repository layout; no new modules. The off-ladder test goes in the existing `sync-authentik` test file if one exists, otherwise alongside the other `test/commands/` tests.

## Complexity Tracking

No constitution violations to justify.
