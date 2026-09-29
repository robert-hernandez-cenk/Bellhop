# Implementation Plan: OIDC mobile-app redirect URIs, a mobile consent step, and an Access tab

**Branch**: `issue-22-oidc-mobile-redirects` | **Date**: 2026-09-29 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/010-oidc-mobile-redirects/spec.md` (GitHub issue #22)

## Summary

Add an optional `oidcMobileRedirectUris` list to hosts, guests and external sites, accepting custom-scheme callbacks. `sync-authentik` sends web ∪ mobile as the OpenID client's exact callback set. While any OIDC entry has a mobile URI, `sync-authentik` also owns a consent stage, its runtime-evaluated flow binding, an expression policy rendered from the exact mobile URI set, and that policy's binding on the shared authorization flow, so only mobile hand-offs get a consent click. The guest Advanced dialog is split into General and Access tabs, with Access showing only the current auth mode's fields. Research is in [research.md](research.md), data in [data-model.md](data-model.md), interfaces in [contracts/interfaces.md](contracts/interfaces.md).

## Technical Context

**Language/Version**: TypeScript (strict), Node 24 and 26 (CI matrix), React web client (Vite)

**Primary Dependencies**: zod, better-sqlite3, express, @modelcontextprotocol/sdk; Authentik REST API v3 (2026.8)

**Storage**: `inventory/bellhop.db` (SQLite). One new nullable JSON column on `hosts`, `guests`, `external_sites`

**Testing**: `node --test` via `npm test`; `FakeAuthentikClient`; stubbed-fetch tests for `RealAuthentikClient` with redacted live fixtures; `test/web-client/` for framework-free UI helpers

**Target Platform**: Windows service / CLI / stdio MCP server; web UI in desktop and mobile browsers

**Project Type**: CLI + web service + web client (single repo)

**Performance Goals**: Adds at most ~6 REST calls per `sync-authentik` run (stage lookup, policy listing, binding listings) plus writes only on change

**Constraints**: A saved inventory must always load. No new failure mode for deployments without mobile URIs (research R9). Dry run must equal apply.

**Scale/Scope**: Single operator; tens of entries; one authorization flow

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Check | Status |
|---|---|---|
| I. No real operational data | Spec, research, fixtures and examples use `example.com`/`app.example` values; live captures stay in the session scratchpad and are redacted before any fixture is committed. The operator's hand-made objects are described generically, never by real ID. | Pass |
| II. Code quality | Validation predicate shared by schema and parser (R1). Authentik calls only through `AuthentikClient`. The client callback set is decided by one function shared by sync and adoption (R3). Explicit, actionable errors (R9). Write-time rules stay out of `validateInventory` (R2, matching precedent). | Pass |
| III. Testing | TDD per task. `FakeAuthentikClient` extended in-memory. `RealAuthentikClient` request/response mapping pinned with fixtures captured live and redacted. The live Authentik behavior (consent shown on phone, absent in browser) is verified manually and recorded in the PR. | Pass |
| IV. UX consistency | Dry-run parity for the consent step (FR-016). Dashboard and MCP share `applyGuestEdits`/`commitGuestEdit`, so one rule rejects the same value in both. Mobile/desktop browser verification is planned for the tabs. README/CLAUDE.md/hosts.yaml.example updated in the same change. | Pass |
| Single-operator assumptions | Adds none. The flow slug is already configurable; the stage order 10 is a stock-Authentik convention, not a deployment value. | Pass |

Post-design re-check: the Phase 1 artifacts introduce no violations. Complexity Tracking is empty.

## Project Structure

### Documentation (this feature)

```text
specs/010-oidc-mobile-redirects/
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
src/lib/inventory.ts                       # field, schema, column, parse, oidcConfigErrors
src/lib/authentik-client.ts                # stage/policy/flow-binding/cache methods (Real + Unconfigured)
src/commands/networking/sync-authentik.ts  # clientRedirectUris, consent reconcile, expression rendering, format, failed
src/commands/networking/adopt-oidc-client.ts  # uses clientRedirectUris
src/operations/edit-guest.ts               # applyGuestEdits + EDIT_GUEST_SHAPE field
src/web/routes/dashboard.ts                # admin gate covers the mobile list
src/web/proxy-sync.ts                      # logWarn consent conflicts/error
src/mcp/build-server.ts                    # edit_guest description
inventory/hosts.yaml.example               # example field
web-client/src/api/types.ts
web-client/src/lib/oidc.ts                 # accessFieldsFor
web-client/src/components/EditableAuthMode.tsx      # EditableOidcMobileRedirectUris
web-client/src/components/AdvancedGuestModal.tsx    # General/Access tabs
web-client/src/index.css                   # tab strip styles (light/dark, ≤640px)
README.md, CLAUDE.md

test/lib/inventory.test.ts
test/lib/authentik-client.test.ts
test/fixtures/authentik/*.json             # redacted live captures
test/support/fake-authentik-client.ts
test/commands/sync-authentik.test.ts
test/commands/sync-authentik-mobile-consent.test.ts
test/commands/adopt-oidc-client.test.ts
test/commands/import-yaml-inventory.test.ts
test/operations/edit-guest.test.ts
test/web/routes/dashboard.test.ts
test/web/proxy-sync.test.ts
test/mcp/build-server.test.ts
test/web-client/access-fields.test.ts
```

**Structure Decision**: Existing single-repo layout. The consent-step reconcile lives in `sync-authentik.ts` as its own functions (`planMobileConsent`/`applyMobileConsent`), with its tests in a separate file so the already-2000-line `sync-authentik.test.ts` isn't grown further.

## Implementation phases (input to /speckit-tasks)

1. **US1: field and client callback set.** Inventory schema, column, parse, `oidcConfigErrors`; `clientRedirectUris` in `planOidc` and `adopt-oidc-client`; `applyGuestEdits`/`EDIT_GUEST_SHAPE`/dashboard admin gate/MCP description; `hosts.yaml.example`; YAML round-trip test.
2. **US2: consent step.** Client methods (Real with fixtures, Unconfigured, Fake); `pythonStringLiteral`/`renderMobileConsentExpression`; plan/apply reconcile with ownership, conflicts, drift, cache clear, and isolation (R7–R9); result field, formatter, `syncAuthentikFailed`; `syncProxyLive` warnings.
3. **US3: Access tab.** `accessFieldsFor`, `EditableOidcMobileRedirectUris`, tabs, CSS; browser checks at desktop and ≤640px.
4. **Docs and verification.** README "OIDC mode" and token permissions, CLAUDE.md `sync-authentik` bullet and inventory field description; full checks; quickstart §4 left for the operator (live Authentik and a phone).

## Complexity Tracking

No constitution violations to justify.
