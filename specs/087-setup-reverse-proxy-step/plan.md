# Implementation Plan: First-run setup, reverse-proxy step

**Branch**: `issue-87-setup-reverse-proxy-step` | **Date**: 2026-10-05 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/087-setup-reverse-proxy-step/spec.md`

## Summary

Add step 3, `proxy`, to the #86 walkthrough, between `basics` and Finish. The step has three server actions behind the existing setup cookie gate: read the step (`GET /api/setup/proxy`), save the choice (`PUT /api/setup/proxy`) and check it (`POST /api/setup/proxy/check`).

- **Save** validates the driver, the entry and the driver and TLS settings through the same `SettingsSchema` rules as `set-config` and the Settings page, moves the `proxy: true` flag, stores the Cloudflare token and NPM password through `writeSecret`, and clears the step's completion. `none` completes on save.
- **Check** is new: an optional read-only `check(deps)` on `ReverseProxyDriver`. File drivers (Caddy, nginx, HAProxy, Traefik) run a read-only script on the proxy host through `runRemote`. The Caddy admin API driver reuses its read path. NPM signs in and lists proxy hosts. A pass runs `runSyncProxy({ apply: false })`, returns its preview, and marks the step complete.
- **Client**: a `ProxyStep` panel in `SetupPage.tsx` built from the same driver metadata the Settings page uses.

Research: [research.md](research.md). Data: [data-model.md](data-model.md). Contract: [contracts/http-setup-proxy.md](contracts/http-setup-proxy.md). Validation guide: [quickstart.md](quickstart.md).

## Technical Context

**Language/Version**: TypeScript (strict) on Node.js, run via `tsx`; React + react-router in `web-client/`

**Primary Dependencies**: express, better-sqlite3, zod, ssh2 (through `SSHClient`), the existing `NpmClient` (global `fetch`)

**Storage**: `inventory/bellhop.db`: inventory (proxy flag, `proxyDriver` and the other proxy settings), `secret_settings` (Cloudflare token, NPM password) and `setup_state.completed_steps_json`. No schema change.

**Testing**: `node --test` via `npm test`; `FakeSSHClient` for every remote call (assert on `ssh.history`); a fake `fetch` for the NPM client; temp SQLite fixtures; `setupTestApp` (`test/support/setup-app.ts`) for route tests. The Caddy admin read path and per-driver check scripts are covered with captured/redacted command outputs.

**Target Platform**: the Bellhop web service; browsers at desktop and ≤640px

**Project Type**: web service + React client + CLI (single repo)

**Performance Goals**: a check is one remote command (or one API round trip) plus a local dry run; seconds

**Constraints**: check writes nothing to the proxy; secrets never leave the settings store; remote work only through `runRemote`; guest-targeted commands are POSIX `sh`

**Scale/Scope**: one proxy per install

## Constitution Check

*GATE: checked before Phase 0, re-checked after Phase 1.*

| Principle | Check | Status |
|---|---|---|
| I. No real data | Spec, contracts, fixtures and screenshots use `example.com`, RFC 5737 addresses and `pve1`-style names. Command outputs used as fixtures are redacted. | Pass |
| II. Code quality | Remote work goes through `runRemote`; the check scripts for guests are POSIX `sh`; request bodies use zod; settings validate through `SettingsSchema` and `settingFix`-style messages; the check is a driver-interface method rather than driver-specific branches in the route. | Pass |
| III. Testing | Each new module and route has `node --test` coverage with `FakeSSHClient`/fake `fetch`; each driver's check is tested, including that it issues no write, backup, restore or reload command. The client panel is verified in a browser at both viewports. | Pass |
| IV. UX consistency | Dry-run convention: the step only previews (`runSyncProxy` without `--apply`) and writes nothing to the proxy. Same field help and driver/TLS option helpers as the Settings page. Docs and nested CLAUDE.md files are updated in the same change. | Pass |

**Post-design re-check**: no violations; Complexity Tracking is empty.

## Project Structure

### Documentation (this feature)

```text
specs/087-setup-reverse-proxy-step/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/http-setup-proxy.md
└── tasks.md            # /speckit-tasks
```

### Source Code (repository root)

```text
src/lib/proxy/driver.ts             # + optional ReverseProxyDriver.check(deps)
src/lib/proxy/file-driver.ts        # + def.check, check() on the built driver, read-only script builder
src/lib/proxy/drivers/{caddy,nginx,haproxy,traefik}.ts   # supply each driver's check definition
src/lib/proxy/drivers/{caddy-api,nginx-proxy-manager}.ts # check() on the hand-written drivers
src/lib/setup-state.ts              # + uncompleteSetupStep
src/web/setup/service.ts            # 'proxy' in REQUIRED_SETUP_STEPS/labels; uncompleteStep
src/web/setup/proxy.ts              # NEW: step state, save, check (pure of express)
src/web/routes/setup.ts             # + three routes
src/web/routes/settings.ts          # export proxyDriversInfo for reuse
web-client/src/api/setup.ts         # + proxy types and calls
web-client/src/pages/SetupPage.tsx  # + ProxyStep
test/lib/proxy/**, test/web/setup/proxy.test.ts          # NEW/extended tests
docs/setup.md, src/web/CLAUDE.md, src/lib/proxy/CLAUDE.md, src/lib/proxy/drivers/CLAUDE.md, web-client/CLAUDE.md
```

**Structure Decision**: keep the express layer thin (`routes/setup.ts` only parses and maps `SetupActionError`), with step logic in `src/web/setup/proxy.ts` as `proxmox.ts` does for step 1. The only change outside the walkthrough is the new optional driver method.

## Complexity Tracking

No constitution violations to justify.
