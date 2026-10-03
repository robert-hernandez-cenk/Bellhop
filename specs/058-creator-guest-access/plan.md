# Implementation Plan: Creator access to guests

**Branch**: `issue-58-creator-guest-access` | **Date**: 2026-10-03 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `specs/058-creator-guest-access/spec.md`

## Summary

Record who created each guest (`creator: { uid?, username }` on the guest's
inventory row) when a real signed-in person creates it from the web UI, and
let that person through allow-list group rules for that guest — but never past
an explicit block-list entry, and never while an admin is impersonating. One
pure decision function in `src/lib/permissions.ts` feeds every web check
(inventory/status filtering, guest-scoped routes, job visibility and control,
the job WebSocket). A one-time CLI `backfill-guest-creators` attributes
existing guests from job history, resolving login names against Authentik
(with operator-supplied `--map old=new` pairs for renamed users). The guest
Advanced dialog shows a read-only "Created by". See [research.md](research.md).

## Technical Context

**Language/Version**: TypeScript (strict), Node 22+ (`--experimental-strip-types` via the repo's runner)
**Primary Dependencies**: Express, `better-sqlite3`, `zod`, `commander`, React (web-client)
**Storage**: `inventory/bellhop.db` (`guests` gains `created_by_uid`, `created_by_username`); reads `data/jobs.sqlite3` (backfill only)
**Testing**: `node --test` under `test/`, temp SQLite fixtures, `FakeAuthentikClient`; captured+redacted Authentik users fixture for the `uid` mapping
**Target Platform**: Windows-hosted web service + CLI, Proxmox hosts over SSH (untouched by this feature)
**Project Type**: CLI + web service + React SPA + MCP server (single repo)
**Performance Goals**: no measurable change; access checks stay synchronous over in-memory inventory
**Constraints**: authorization correctness for restricted co-users (constitution II); no real data in tracked files (I)
**Scale/Scope**: a handful of users, tens of guests

## Constitution Check

| Principle | Status |
| --- | --- |
| I. No real operational data | PASS — all spec/test values are examples; the real `--map` pairs live only in operator notes. The new users fixture is captured live and redacted. |
| II. Code quality | PASS — one decision function (`isGuestCreator` + `isAllowed`) shared by every check; Authentik response validated; explicit errors (bad `--map`, Authentik unconfigured). |
| III. Testing | PASS — every behavior gets tests: pure rules, routes, WS, operations, inventory round trip, backfill. No real infrastructure. |
| IV. UX consistency | PASS — backfill is dry-run by default with `--apply`; CLI-only one-time migration (precedent: `import-yaml-inventory`, `convert-caddyfile`), so no `Operation` is required. Docs: new `docs/permissions.md`, `docs/commands.md` entry, CLAUDE.md bullet. UI change verified at desktop and ≤640px; demo screenshots regenerated if the Advanced dialog's screenshot changes. |
| Workflow | PASS — worktree branch, PR to `main`. No single-operator assumption introduced (research R10). |

Post-design re-check: unchanged, PASS.

## Project Structure

### Documentation (this feature)

```text
specs/058-creator-guest-access/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── backfill-guest-creators.md
│   └── web-access.md
└── tasks.md            # /speckit-tasks
```

### Source Code (repository root)

```text
src/lib/inventory.ts                  # GuestCreatorSchema, guests columns, load/save
src/lib/permissions.ts                # isGuestCreator, isAllowed({ isCreator })
src/lib/pve-acl.ts                    # Actor.uid
src/lib/authentik-client.ts           # AuthentikUser.uid
src/web/auth.ts                       # AuthUser.uid from x-authentik-uid
src/web/impersonation.ts              # resolveActor copies uid
src/web/access.ts                     # caller-based checks, creator lookup from inventory
src/web/routes/dashboard.ts           # filter + PATCH pass caller/inventory
src/web/routes/maintenance.ts         # caller-based checks
src/web/routes/networking.ts          # caller-based checks
src/web/routes/provisioning.ts        # caller-based checks
src/web/routes/jobs.ts                # isJobVisible(rules, caller, target, creators); WS caller
src/web/app.ts                        # pass inventory to route factories where newly needed
src/operations/provisioning.ts        # record creator; upsert keeps existing creator
src/commands/provisioning/deploy-vpn-gateway.ts  # creator option
src/commands/maintenance/backfill-guest-creators.ts  # new CLI command
src/cli.ts                            # register backfill-guest-creators
web-client/src/components/AdvancedGuestModal.tsx  # read-only "Created by"
web-client/src/lib/advanced-field-help.ts         # help text
scripts/demo/demo-inventory.ts        # example creator on a demo guest
docs/permissions.md (new), docs/commands.md, README.md (docs index), CLAUDE.md
test/...                              # see quickstart.md
```

**Structure Decision**: existing single-repo layout; no new modules beyond the
backfill command file.

## Implementation notes

- **Order**: data model (US2 foundation) → recording at creation + access
  rules (US1) → display (US3) → backfill (US4) → docs.
- **`requireResourceAccess` signature**: becomes
  `requireResourceAccess(inventoryPath, inventory, resolveRef)`; callers pass
  the shared inventory they already hold. `isResourceAllowed(inventoryPath,
  inventory, caller, ref)` and `filterInventoryForUser(inventoryPath, caller,
  inventory)` take the `AuthUser` (or a `{ username, uid?, groups,
  impersonating? }` subset) instead of `groups`.
- **Impersonation on non-Express paths**: the WS handler constructs
  `{ ...user, groups: [impersonatedGroup], impersonating: impersonatedGroup }`
  when an impersonation is active, mirroring `applyImpersonation`.
- **Job visibility**: unchanged name-only matching of group rules; the
  creator lift applies when `target` names a guest whose creator is the
  caller (creators map from inventory).
- **Backfill writes** go through `refreshInventory` + `saveInventory` in one
  pass, the same pattern `recordProvisionedGuest` uses.
- **Fixture**: capture `GET /api/v3/core/users/` live, redact to example
  values (preserve shape and array length), store under
  `test/fixtures/authentik/core-users.json`, and test `listUsers` mapping of
  `uid` with a stubbed fetch.

## Complexity Tracking

None.
