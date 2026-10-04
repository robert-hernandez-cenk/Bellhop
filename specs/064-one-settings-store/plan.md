# Implementation Plan: One settings store, with write-only secrets

**Branch**: `issue-64-one-settings-store` | **Date**: 2026-10-04 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/064-one-settings-store/spec.md`

## Summary

Every value Bellhop reads from `data/*.env` becomes a setting in `bellhop.db`. Non-secret values
join the existing `SettingsSchema` (and so the `meta` table, the Settings page, `set-config` and the
MCP tool) with no new mechanism. Secrets go into a new `secret_settings` table that is never part of
`Inventory`, so they can't reach the status page or any serialized inventory. All consumers read
through one accessor, `configValue()`, with precedence environment, then stored, then default. It
keeps a 2-second snapshot that every web request and every in-process write invalidate, so changes
apply without a restart. A one-time import copies `data/*.env` values into the store at startup.
The web UI auth mode becomes a guarded setting. A GitHub token is sent on every `api.github.com`
request when one is set.

## Technical Context

**Language/Version**: TypeScript (strict) on Node 22+, run via `tsx`; React + Vite web client

**Primary Dependencies**: better-sqlite3, zod, express, commander, dotenv (only for loading/parsing
the files during transition), @modelcontextprotocol/sdk

**Storage**: SQLite `inventory/bellhop.db` -- `meta` (existing) + new `secret_settings`

**Testing**: `node --test` via `npm test`; temp SQLite fixtures (`mkdtempSync`); `FakeSSHClient`;
stubbed `fetch` for GitHub call sites

**Target Platform**: Windows service host (web), any Node host (CLI/MCP); browsers at desktop and
<=640px

**Project Type**: CLI + web service + web client + MCP server (single repo)

**Performance Goals**: config reads add no more than one ~7 ms SQLite read per web request
(research R3)

**Constraints**: secret values never leave the store except to the client that uses them; no
startup-only reads of moved keys; existing env-param tests keep working

**Scale/Scope**: 16 setting keys (12 non-secret, 4 secret), ~6 consumer modules, 4 entry points,
1 page

## Constitution Check

| Principle | Status |
| --- | --- |
| I. No real data | Pass -- specs/tests/demo use example values only; real values stay in gitignored `bellhop.db`. Captured-fixture rule: GitHub's 401 is status-only (verified live, research R6), no body parsed. |
| II. Code quality | Pass -- zod validation for every setting at write and read; one accessor (`src/lib/config.ts`), one GitHub header helper, one live-client helper; errors name key + fix via `settingFix`. The `Proxy`-based live client needs one documented cast. |
| III. Testing | Pass -- every behaviour change gets tests; temp DB fixtures; no network (stubbed fetch). |
| IV. UX consistency | Pass -- dry-run/`--apply` kept for `set-config`; same schema across web/CLI/MCP; secrets masked on input and never logged; mobile + dark verification planned; README/docs/CLAUDE.md/CONTRIBUTING.md updated. |

Deliberate deviations recorded (not violations): web refuses env-pinned writes while CLI warns
(R9); MCP `set_config` excludes secrets (FR-012).

Post-design re-check: still passes.

## Project Structure

### Documentation (this feature)

```text
specs/064-one-settings-store/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/ (settings-api.md, cli.md, config-accessor.md)
└── tasks.md
```

### Source Code

```text
src/lib/settings-defs.ts        NEW  moved/secret schemas + metadata (leaf module)
src/lib/config.ts               NEW  accessor, snapshot, secret writes
src/lib/config-import.ts        NEW  one-time data/*.env import
src/lib/github.ts               NEW  githubApiHeaders(), 401 error
src/lib/live-client.ts          NEW  Proxy-based per-call client resolution
src/lib/inventory.ts            spread new schemas; secret_settings table; migration via effectiveValue; invalidate on save
src/lib/authentik-config.ts     read through accessor
src/lib/authentik-client.ts     live buildAuthentikClient
src/lib/cloudflare-client.ts    live buildCloudflareClient
src/lib/npm-client.ts           accessor; messages via settingFix
src/lib/settings-hint.ts        accept secret keys
src/lib/app-source.ts, app-update-check.ts, script-catalog.ts   use githubApiHeaders
src/web/auth.ts                 authMode via accessor; viaForwardAuth
src/web/app.ts                  invalidate snapshot per /api request
src/web/routes/settings.ts      sources/environment/secrets; secret writes; guards
src/commands/maintenance/set-config.ts   secrets, --stdin, env warning
src/cli.ts, src/web/server.ts, src/mcp/server.ts, scripts/windows-service.ts   import + useConfigStore
scripts/demo/demo-server.ts, demo-inventory.ts   example values incl. "set" secrets
web-client/src/pages/SettingsPage.tsx, lib/settings-display.ts, api/types.ts, index.css   tabs, secret field, env read-only, confirmations
docs/*.md, README.md, CLAUDE.md, CONTRIBUTING.md
test/...                        matching tests
```

**Structure Decision**: existing single-repo layout; new logic lives in `src/lib/` per the
constitution.

## Phasing (maps to user stories)

1. **Foundation** -- `settings-defs.ts`, `config.ts`, `secret_settings` table, migration via
   `effectiveValue`, snapshot invalidation.
2. **US1 + US5** -- consumers read through the accessor (authentik-config, auth mode, clients);
   live clients; settings API `sources`/`environment`; env-pinned refusal; CLI warning.
3. **US2** -- secret writes/reads in API and CLI (`--stdin`, prompt, argv refusal), MCP exclusion,
   leak test.
4. **US6** -- admin-group and auth-mode guards (server) + confirmations (client).
5. **US3** -- GitHub helper and the three call sites.
6. **US4** -- import + entry-point wiring.
7. **Web client** -- tabs, secret field, env read-only, confirmations; desktop/mobile/dark checks.
8. **Demo + docs** -- demo seeding, docs/README/CLAUDE.md/CONTRIBUTING.md.

## Complexity Tracking

None.
