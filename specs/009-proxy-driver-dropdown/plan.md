# Implementation Plan: Proxy driver dropdown with a "no proxy" option

**Branch**: `issue-33-proxy-driver-dropdown` | **Date**: 2026-09-28 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `specs/009-proxy-driver-dropdown/spec.md`

## Summary

Add a second registered proxy driver, `none` ("No proxy"), meaning Bellhop manages no reverse proxy. Every driver gains display metadata (`label`, `defaultConfigPath: string | null`, `statusPage: { suggestedPath } | null`). The places that touch the proxy host short-circuit on a driver that manages nothing: `runSyncProxy` returns a "nothing to write" result without resolving a proxy host, and `runRenderStatusPage` throws a named error. The two automated callers, `syncProxyLive` and `migrate-guest`, skip the status page with a log line. `GET/PATCH /api/settings` return the driver list, and the Settings page renders the driver as a `<select>`. Dependent fields show or hide and change placeholder based on the selection, through a pure helper in `web-client/src/lib/settings-display.ts`.

## Technical Context

**Language/Version**: TypeScript (strict), Node 22+ (tsx runtime); React 18 + Vite for `web-client`
**Primary Dependencies**: zod, express, better-sqlite3 (unchanged)
**Storage**: `meta` table in `inventory/bellhop.db` (unchanged shape; `proxyDriver` gains the value `none`)
**Testing**: `node --test` via `npm test`, `FakeSSHClient`, temp SQLite fixtures; `test/web-client/*.test.ts` for framework-free client helpers
**Target Platform**: Windows service / Linux dev host; browser at desktop and ≤640px
**Project Type**: CLI + web service + separately built web client + MCP server
**Performance Goals**: N/A
**Constraints**: Unset/`caddy` behavior byte-identical (SC-003); the web client cannot import from `src/`
**Scale/Scope**: ~10 source files, ~6 test files, README/CLAUDE.md

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. No real data**: Only example values in specs/tests (`/etc/caddy/Caddyfile`, `/usr/share/caddy/index.html` are the software's own defaults, not operator data). PASS.
- **II. Code quality**: One source of driver metadata (the driver objects, served to the client by the API). Errors name the fix through `settingFix('proxyDriver', ...)`. No silent fallback: `none` is an explicit operator choice, and each skip is logged. PASS.
- **III. Testing**: Every behavior change is covered with `FakeSSHClient` and temp fixtures (asserting no SSH history under `none`), plus settings route tests and settings-display helper tests. PASS.
- **IV. UX consistency**: `none` goes through the same `SettingsSchema` enum for CLI, web, and MCP (`set-config` operation). The `sync-proxy` operation is shared, so all three front ends get the same no-op result. The dry run still prints exactly what apply does (nothing). The UI is verified at desktop and mobile widths, and README/CLAUDE.md are updated. PASS.
- **Workflow**: Single-operator assumption change recorded in CLAUDE.md, since not every deployment has a Bellhop-managed proxy. PASS.

Post-design re-check: still PASS; no Complexity Tracking entries.

## Project Structure

### Documentation (this feature)

```text
specs/009-proxy-driver-dropdown/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── settings-api.md
│   └── commands-and-messages.md
└── tasks.md
```

### Source Code (repository root)

```text
src/lib/proxy/
├── ids.ts                 # PROXY_DRIVER_IDS += 'none'
├── driver.ts              # ReverseProxyDriver: label, defaultConfigPath: string|null, statusPage; managesProxy()
├── file-driver.ts         # fileDriver def gains label + statusPage
├── drivers/caddy.ts       # label 'Caddy', statusPage.suggestedPath
├── drivers/none.ts        # NEW: no-op driver
└── index.ts               # register none; DEFAULT_PROXY_DRIVER_ID; listDrivers()
src/commands/networking/
├── sync-proxy.ts          # early no-op result for none; proxyHost: string | null
└── render-status-page.ts  # named error when driver serves no status page; statusPageSkip helper
src/web/proxy-sync.ts      # status page skip under none
src/commands/provisioning/migrate-guest.ts  # same skip
src/cli.ts                 # sync-proxy output for none; set-config description lists all keys
src/operations/maintenance.ts # sync-proxy preview/apply text for none
src/web/routes/settings.ts # response gains proxyDrivers + defaultProxyDriver
web-client/src/api/types.ts
web-client/src/lib/settings-display.ts  # pure field-visibility/placeholder helper
web-client/src/pages/SettingsPage.tsx   # <select>, conditional fields
test/lib/proxy/*.test.ts, test/commands/networking/*.test.ts, test/web/routes/settings.test.ts,
test/web/proxy-sync.test.ts, test/commands/provisioning/migrate-guest.test.ts, test/web-client/settings-display.test.ts
README.md, CLAUDE.md
```

**Structure Decision**: Existing layout; one new file (`src/lib/proxy/drivers/none.ts`).

## Complexity Tracking

None.
