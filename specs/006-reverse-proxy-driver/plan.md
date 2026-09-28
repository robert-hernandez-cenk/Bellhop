# Implementation Plan: Reverse-Proxy Driver Interface

**Branch**: `issue-10-reverse-proxy-driver` | **Date**: 2026-09-26 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/006-reverse-proxy-driver/spec.md`

## Summary

Split today's `sync-caddy` into three layers. `buildRoutes(inventory)`
turns inventory into proxy-neutral `ProxyRoute[]` (the filtering and
cross-entry rules `buildCaddyBlock` does today). A `ReverseProxyDriver`
(`plan`/`apply`/`snapshot` plus declared `capabilities`) turns routes into
live configuration. `checkCapabilities` stands between the two so an auth
mode the driver cannot enforce is refused rather than dropped. File-based
drivers are built with a shared `fileDriver(...)` helper (back up, write,
validate in place, restore on failure, reload); the only driver this round
is Caddy, whose rendered managed block must stay byte-identical, proven by
a characterization test written against the current code first.

Everything Caddy-named outside the driver is renamed: `caddy`/
`caddyManual` → `proxy`/`proxyManual` (schema, SQLite columns, YAML import,
web/MCP inputs, UI), `sync-caddy` → `sync-proxy` on every front end,
`syncCaddyLive` → `syncProxyLive`, `CADDYFILE_PATH` → a `proxyConfigPath`
setting alongside a new `proxyDriver` setting. Existing databases are
upgraded by a self-idempotent on-open migration in the #158 style.

## Technical Context

**Language/Version**: TypeScript (strict), Node ≥ 24 (CI: 24 and 26); web client React 19 + Vite

**Primary Dependencies**: existing only — `zod`, `better-sqlite3`, `commander`, `express`, `@modelcontextprotocol/sdk`. No new dependencies.

**Storage**: `inventory/bellhop.db` (SQLite). Column renames in `hosts`/`guests`, `caddy_owner` table replaced by `proxy_owner`, two new `meta` keys.

**Testing**: `node --test` under `test/`; `FakeSSHClient` for command logic; temp SQLite fixtures in `mkdtempSync` dirs; one script-execution test under `sh` for the file-driver restore path (research R6).

**Target Platform**: Bellhop CLI, web service, and MCP server (Windows service host in production; Linux CI); the proxy host runs Caddy on Linux, reached over SSH.

**Project Type**: CLI + web service + MCP server + web client (single repository)

**Performance Goals**: none; the sync is a handful of SSH round trips, unchanged.

**Constraints**: rendered Caddy managed block byte-identical to today's (FR-010/SC-001); no compatibility aliases (pre-release); remote script stays POSIX `sh` against the proxy host; preview equals apply (constitution IV).

**Scale/Scope**: ~6 new `src/lib/proxy/` modules, ~25 edited server files, ~10 edited web-client files, docs (README, CLAUDE.md, CONTRIBUTING, `hosts.yaml.example`), ~15 test files new/moved/edited.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | How |
| --- | --- | --- |
| I. No real operational data | PASS | Fixtures and examples use `example.com`, RFC 5737 addresses, generic names (`web-lxc`, `pve1`), and generic exempt paths (`/api/*`, `/health`). The live dry-run comparison (quickstart) is read-only and its output is not committed. |
| II. Code quality | PASS | Remote execution stays in `runRemote` (the file driver builds a script and hands it to `runRemote`, exactly as `sync-caddy` does now). The rules that span entries remain in `validateInventory()`; the capability check is deliberately outside it (FR-013) and is one shared function called from both the sync and the edit paths, not copied. Every new error names the fix (`set-config proxyDriver …`, `authMode: oidc`, `proxy: true`). |
| III. Testing | PASS | Characterization test written and passing before the refactor; `FakeSSHClient` for command logic; temp SQLite fixtures for the migration. The one test that executes a shell script runs the file driver's *generated* script with stub `caddy`/`systemctl` on `PATH`. Principle III forbids mocking `ssh`/`pct`/`qm` on `PATH` to test command logic, and this does not do that: command logic is still tested via `FakeSSHClient`; this test covers the shell script's own backup/restore behavior, which no string assertion can (research R6). Deterministic, no network. |
| IV. UX consistency | PASS | Dry run by default preserved; preview is the rendered text apply sends. `sync-proxy` is one `Operation` shared by web and MCP; the capability check lives in `commitGuestEdit`, shared by Dashboard and MCP. `proxyDriver`/`proxyConfigPath` validated by `SettingsSchema` for both `set-config` and the Settings page. UI changes verified at desktop and ≤640px. README and CLAUDE.md updated in the same change. |
| Workflow | PASS | Own worktree/branch, PR to `main`. Records a changed single-operator assumption: Bellhop is no longer hard-wired to Caddy, and `CADDYFILE_PATH` (previously honored only by the CLI) becomes a setting honored by every front end. The Cloudflare DNS-01 `TLS_BLOCK` stays a single-operator assumption, now contained in the Caddy driver (spec Assumptions). |

Post-design re-check: PASS. No new dependency, no new transport, no new persisted secret. The migration is forward-only, like #158's, which the spec accepts for a pre-release project.

## Project Structure

### Documentation (this feature)

```text
specs/006-reverse-proxy-driver/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── driver-interface.md
│   └── user-surfaces.md
├── checklists/requirements.md
└── tasks.md             # /speckit-tasks
```

### Source Code (repository root)

```text
src/lib/proxy/
├── routes.ts            # NEW  ProxyRoute, PathPattern, ProxyContext, buildRoutes, buildProxyContext, parsePathPattern
├── driver.ts            # NEW  ReverseProxyDriver, ProxyPlan, DriverDeps, checkCapabilities
├── file-driver.ts       # NEW  fileDriver(), FileSpec, buildFileDriverScript
├── index.ts             # NEW  PROXY_DRIVER_IDS, getDriver(), driver registry
└── drivers/caddy.ts     # NEW  caddyDriver (moved from buildCaddyBlock/TLS_BLOCK/EXTERNAL_PORT)
src/lib/hostname.ts      # NEW  publicHostname(sub, domain)
src/lib/inventory.ts     # proxy/proxyManual schema, SettingsSchema (+proxyDriver, +proxyConfigPath),
                         # unauthenticatedPaths pattern tightening, migrateCaddyToProxy, findProxyEntry,
                         # SQL column/table renames, validateInventory messages
src/commands/networking/
├── sync-proxy.ts        # RENAMED from sync-caddy.ts; orchestration only
├── render-status-page.ts# uses driver.snapshot()
├── sync-authentik.ts    # publicHostname
└── adopt-oidc-client.ts # publicHostname
src/commands/provisioning/migrate-guest.ts   # runSyncProxy
src/cli.ts               # sync-proxy command, caddyfilePath() removed; import-yaml-inventory
                         # picks up proxy:/proxyManual: through InventorySchema
src/web/proxy-sync.ts    # RENAMED from caddy-sync.ts; syncProxyLive, prune gated by capability
src/operations/{networking,maintenance,provisioning,edit-guest,types}.ts
src/web/{commands-meta,app,server}.ts, src/web/routes/{dashboard,maintenance,settings}.ts
src/mcp/build-server.ts, src/cli.ts, scripts/windows-service.ts
web-client/src/components/EditableProxyManual.tsx   # RENAMED from EditableCaddyManual.tsx
web-client/src/{api/types.ts, pages/Dashboard.tsx, pages/SettingsPage.tsx, components/AdvancedGuestModal.tsx, ...}
inventory/hosts.yaml.example
README.md, CLAUDE.md, CONTRIBUTING.md

test/lib/proxy/{routes,driver,file-driver,index}.test.ts          # NEW
test/lib/proxy/drivers/caddy.test.ts                               # NEW (characterization + moved sync-caddy block tests)
test/commands/sync-proxy.test.ts                                   # RENAMED from sync-caddy.test.ts
test/web/proxy-sync.test.ts                                        # RENAMED from caddy-sync.test.ts
test/lib/inventory.test.ts                                         # migration + schema
test/{commands,operations,web/routes,mcp}/...                      # renames
```

**Structure Decision**: proxy code gets its own `src/lib/proxy/` directory,
since it is infrastructure shared by the CLI, web, and MCP paths
(constitution II: shared infrastructure helpers live in `src/lib/`).
`sync-proxy.ts` stays under `src/commands/networking/` as the command
entry point, as `sync-caddy.ts` was. The characterization test lives with
the Caddy driver's tests because that is the code it pins.

## Implementation order

1. **Characterization test** against current `buildCaddyBlock`
   (data-model "Characterization fixture"). Commit green before any
   refactor.
2. **Route model**: `routes.ts`, `publicHostname`, path-pattern parsing and
   schema tightening.
3. **Driver layer**: `driver.ts`, `file-driver.ts`, `drivers/caddy.ts`,
   `index.ts`; the characterization test now targets the Caddy driver.
4. **Command and callers**: `sync-proxy.ts`, `syncProxyLive`,
   `render-status-page`, `migrate-guest`, `sync-authentik`/`adopt-oidc-client`,
   capability check in `commitGuestEdit`.
5. **Rename and migration**: schema, SQL, migration, settings, YAML
   import, operations/web/MCP ids and fields, windows-service.
6. **Web client**: `EditableProxyManual`, Dashboard column, Settings page.
7. **Docs** and the follow-up issue.
8. **Verification**: full suite, `web:build`, live read-only dry-run
   comparison, browser check at both widths.

Steps 2–4 keep inventory field names unchanged so each step is a pure
refactor that the characterization test guards; step 5 then renames in one
sweep.

## Complexity Tracking

No constitution violations to justify.
