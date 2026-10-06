# Implementation Plan: Audience-Named Default Group Ladder

**Branch**: `issue-97-audience-group-ladder` | **Date**: 2026-10-05 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/097-audience-group-ladder/spec.md`

## Summary

Change `DEFAULT_GROUP_LADDER` in `src/lib/authentik-config.ts` to `bellhop-public-readonly,bellhop-public,bellhop-friends-family,bellhop-admin-family,authentik Admins`, and add a self-idempotent migration to `openInventoryDb` (`src/lib/inventory.ts`) that renames stored `auth_group` values on `hosts`, `guests` and `external_sites` from the previous default names to their successors. Each rename pair applies only when the effective ladder — resolved off the opening handle exactly as the #158 migration does (`effectiveValue('authentikGroupLadder', storedRow, process.env)` → `parseGroupLadder`) — lacks the old name and contains its successor. Docs, Settings page help, demo inventory and tests move to the new names.

## Technical Context

**Language/Version**: TypeScript (Node 22+, `strict`), run via Node's type stripping

**Primary Dependencies**: `better-sqlite3` (inventory DB), zod (settings validation) — no new dependencies

**Storage**: `inventory/bellhop.db` (SQLite); `auth_group TEXT` columns on `hosts`, `guests`, `external_sites`; ladder setting in `meta` key `authentikGroupLadder`

**Testing**: `node --test` over `test/**/*.test.ts`; DB fixtures via `mkdtempSync` + raw SQL for legacy rows

**Target Platform**: Linux/Windows host running the Bellhop CLI and web service

**Project Type**: CLI + web service + React client (single repo)

**Performance Goals**: The migration adds at most three `UPDATE ... WHERE auth_group = ?` statements per table per open, after one cheap guard query; no measurable cost.

**Constraints**: Must run safely on every `openInventoryDb` caller (load and save), mid-open, without the config accessor (which would open a second connection).

**Scale/Scope**: One constant, one migration function, ~30 test files touched by a name substitution, five docs/UI text locations.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Check | Status |
|---|---|---|
| I. No real operational data | New names are product defaults, not operator values; tests use example inventories. The live deployment's DB is only read, never committed. | Pass |
| II. Code quality | Migration lives next to the other `openInventoryDb` migrations, reuses `parseGroupLadder`/`effectiveValue`; ladder parsing stays defined only in `authentik-config.ts`. No operator-specific default (the new names are generic product names). | Pass |
| III. Testing | New tests for the default ladder, each migration condition (default, pinned-old, pinned-new, partial, idempotent, untouched values, logging); existing tests updated. | Pass |
| IV. UX consistency | Settings help/placeholder and docs state the same default and the same upgrade path. | Pass |
| Single-operator assumptions | None introduced; the migration is driven by the effective ladder, not by this deployment's state. | Pass |

Post-design re-check: unchanged — Pass.

## Project Structure

### Documentation (this feature)

```text
specs/097-audience-group-ladder/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── configuration.md
└── tasks.md            # /speckit-tasks
```

### Source Code (repository root)

```text
src/lib/authentik-config.ts        # DEFAULT_GROUP_LADDER, tier-audience comment, exported rename pairs
src/lib/inventory.ts               # migrateDefaultLadderRenames in openInventoryDb
src/commands/networking/CLAUDE.md  # default ladder statement
web-client/src/pages/SettingsPage.tsx  # placeholder + help for authentikGroupLadder
docs/configuration.md              # settings table default
docs/environment-variables.md      # "Group ladder upgrades" section
docs/authentik.md                  # tier audiences (short section)
scripts/demo/demo-inventory.ts     # example tiers
test/lib/authentik-config.test.ts  # default ladder assertions
test/lib/inventory.test.ts         # migration tests
test/**                            # old-name substitutions
```

**Structure Decision**: Existing single-repo layout; no new modules. The rename pairs are exported from `authentik-config.ts` (the one place ladder names are defined) and consumed by the migration in `inventory.ts`.

## Complexity Tracking

None.
