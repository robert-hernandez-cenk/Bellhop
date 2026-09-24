# Implementation Plan: Native OIDC Gating as an Alternative to Forward-Auth

**Branch**: `issue-1-native-oidc-gating` | **Date**: 2026-09-24 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/002-native-oidc-gating/spec.md`

## Summary

Add an opt-in per-entry auth mode. In `oidc` mode, `sync-authentik` gives an entry's Authentik
Application an OAuth2/OpenID provider (confidential, explicit grant types, signing key, scope
mappings, strict callback URLs) instead of a proxy provider, binds it with the unchanged group-ladder
rule, and verifies the issuer's discovery document after apply. `sync-caddy` emits a plain reverse
proxy for these entries. Bellhop never stores the client secret: admins read it from Authentik on
demand through the Dashboard or a CLI command, and the MCP server shows only the issuer and client
ID. Ownership of an OAuth2-backed Application is marked with `meta_publisher = bellhop`, which lets
an admin adopt a hand-made client explicitly without rotating its credentials. Mode switches swap
the provider under the same Application, so bindings survive. Edits that delete an OpenID client
need explicit confirmation in every front end.

## Technical Context

**Language/Version**: TypeScript (strict), Node 24 and 26 (CI matrix), run through `tsx`

**Primary Dependencies**: `zod`, `better-sqlite3`, `express`, `commander`, `@modelcontextprotocol/sdk`, React (web-client); Authentik REST API v3 (verified against 2026.8)

**Storage**: `inventory/bellhop.db` (two new nullable columns per entry table); nothing new in `data/jobs.sqlite3`

**Testing**: Node built-in test runner, `FakeAuthentikClient`, temporary SQLite inventories; manual verification of `RealAuthentikClient` against a live Authentik

**Target Platform**: Windows service (web UI), CLI and stdio MCP server on the operator's machine

**Project Type**: CLI + web service + MCP server sharing `src/lib` and `src/operations`

**Performance Goals**: A Dashboard save that triggers the sync adds at most the new provider/mapping list calls plus one discovery fetch per changed OIDC entry, each bounded by a 10 s timeout

**Constraints**: No secret in `bellhop.db`, jobs DB, logs or MCP output; forward-auth output byte-identical; no forward-only DB migration

**Scale/Scope**: Tens of inventory entries, single operator plus restricted co-users

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | How this plan complies |
|---|---|
| I. No real data | Spec, plan, fixtures and docs use `example.com` names. Live Authentik was read only to confirm API shapes; no value from it is recorded. |
| II. Code quality | All Authentik I/O stays in `authentik-client.ts`; raw responses mapped through typed `Raw*` interfaces as today; new inputs validated by zod in the inventory schema and edit shape; every failure names its fix (`AUTHENTIK_OIDC_SIGNING_KEY_NAME`, `oidcRedirectUris`, `sync-authentik --apply`). |
| III. Testing | Every behavior ships with tests using `FakeAuthentikClient` and temp inventories. `RealAuthentikClient` changes are verified manually per quickstart §3, recorded in the PR. No new third-party fixture files: tests exercise the fake client's domain types, the same approach existing `sync-authentik` tests use. |
| IV. UX consistency | Sync keeps dry-run-by-default; adoption is one shared `Operation` for web/MCP plus a CLI command with `--apply`; same edit rules for web and MCP; secret never persisted or logged; web UI verified at desktop and ≤640px; README, CLAUDE.md and CONTRIBUTING.md (if a restated rule changes) updated in the same branch. |
| Workflow | Worktree branch per issue, PR to `main`. Single-operator assumption recorded: the default signing-key name matches a stock Authentik install and is overridable. |

Result: **pass**, no violations. Re-checked after Phase 1: still pass.

## Project Structure

### Documentation (this feature)

```text
specs/002-native-oidc-gating/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/interfaces.md
├── checklists/requirements.md
└── tasks.md             # /speckit-tasks
```

### Source Code (repository root)

```text
src/lib/
├── inventory.ts             # authMode, oidcRedirectUris, effectiveAuth, parse helpers, columns
├── authentik-config.ts      # oidcSigningKeyName
└── authentik-client.ts      # OAuth2 provider, application update, key/scope lookups
src/commands/networking/
├── sync-caddy.ts            # skip forward_auth for oidc entries
├── sync-authentik.ts        # OIDC reconcile, mode switches, ownership, discovery
├── oidc-credentials.ts      # new: read credentials for one entry
└── adopt-oidc-client.ts     # new: adoption preview/apply
src/operations/
├── edit-guest.ts            # new fields, confirmation rule
└── networking.ts            # adopt-oidc-client operation
src/web/
├── caddy-sync.ts            # surface discovery failures
└── routes/{dashboard.ts,oidc.ts}
src/mcp/build-server.ts      # get_oidc_client, edit_guest fields
src/cli.ts                   # oidc-credentials, adopt-oidc-client, exit codes
web-client/src/components/
├── EditableAuthMode.tsx     # new: mode + callback URLs
├── OidcCredentials.tsx      # new: reveal + copy
└── AdvancedGuestModal.tsx   # wire both in
test/                        # matching suites, see quickstart §1
```

**Structure Decision**: Existing single-repo layout. New command modules sit next to
`sync-authentik.ts`; web endpoints get their own `oidc.ts` route module so the admin-only surface is
easy to audit.

## Implementation phases (for /speckit-tasks)

1. **Inventory**: schema fields, columns, `effectiveAuth`, parse helpers, `validateInventory`
   narrowing, example YAML.
2. **Caddy**: `buildCaddyBlock` uses `effectiveAuth`.
3. **Authentik client**: new methods on the interface, real client, unconfigured client, fake client.
4. **Sync**: OIDC create/update/delete, mode switches, ownership marker, skips, discovery; CLI output
   and exit codes.
5. **Credentials and adoption**: command modules, CLI commands, shared operation, web routes, MCP
   tool.
6. **Edit path**: edit shape, confirmation rule, admin checks, discovery warnings in the response.
7. **Web UI**: mode/callback editor, credential reveal, confirmation modal, adopt action in the
   conflict banner; desktop and mobile verification.
8. **Docs and verification**: README, CLAUDE.md, manual live check, PR.

## Complexity Tracking

No constitution violations to justify.
