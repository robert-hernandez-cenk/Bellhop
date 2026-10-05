# Implementation Plan: Nginx Proxy Manager settings on the Proxy tab

**Branch**: `issue-73-npm-settings-proxy-tab` | **Date**: 2026-10-04 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/073-npm-settings-proxy-tab/spec.md`

## Summary

Remove the Settings page's Nginx Proxy Manager tab and show its three
fields (`npmApiUrl`, `npmApiEmail`, `npmApiPassword`) on the Proxy tab,
only while the selected driver reports a new `usesNpmApi` metadata flag.
The flag follows the exact path the existing per-driver flags take
(`usesCertResolver`/`usesApiUrl`/`usesCaddyTls`): an optional field on
`ReverseProxyDriver`, set on the Nginx Proxy Manager driver, reported by
`proxyDriversInfo()` with a `false` default, read by `proxyFieldView`, and
consulted by the page's `isVisible`. The three settings' `SETTING_DEFS`
group moves to `'proxy'`. Docs, `CLAUDE.md` and the one Settings
screenshot are updated.

## Technical Context

**Language/Version**: TypeScript on Node.js (server), React + Vite (web-client)

**Primary Dependencies**: Express (settings route), React (Settings page); no new dependencies

**Storage**: Unchanged — settings stay in `bellhop.db` `meta`/`secret_settings`

**Testing**: `node --test` (`npm test`): `test/web/routes/settings.test.ts`, `test/web-client/settings-display.test.ts`, `test/lib/settings-defs.test.ts`, `test/lib/proxy/index.test.ts`; browser check via the demo instance

**Target Platform**: The Bellhop web service and its browser UI (desktop and ≤640 px)

**Project Type**: Web service + web client in one repository

**Performance Goals**: N/A (display-only change)

**Constraints**: Hiding is display-only (no draft/stored value cleared, no PATCH); decisions from driver metadata, never an id comparison in the page

**Scale/Scope**: ~6 source files, 4 test files, 4 docs files, 1 screenshot

## Constitution Check

| Principle | Check | Status |
|---|---|---|
| I. No real operational data | Spec/docs/tests use example values only; the regenerated screenshot comes from the demo instance's example inventory | Pass |
| II. Code quality | Follows the existing metadata-flag pattern; no new abstraction | Pass |
| III. Testing | Each behavior change (flag in API, field view, tab list, defs group) gets a test; no third-party API fixture involved | Pass |
| IV. UX consistency | No CLI/MCP change (settings API PATCH unchanged); secret masking unchanged; browser check at desktop and ≤640 px; docs and `CLAUDE.md` updated in the same change | Pass |

Post-design re-check: unchanged — the design adds no front-end-specific rule and no new storage.

## Project Structure

### Documentation (this feature)

```text
specs/073-npm-settings-proxy-tab/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── settings-ui.md
└── tasks.md            # created by /speckit-tasks
```

### Source Code (repository root)

```text
src/lib/proxy/driver.ts                       # usesNpmApi?: boolean on ReverseProxyDriver
src/lib/proxy/drivers/nginx-proxy-manager.ts  # usesNpmApi: true
src/web/routes/settings.ts                    # proxyDriversInfo(): usesNpmApi ?? false
src/lib/settings-defs.ts                      # npm* group -> 'proxy'; SettingGroup loses 'nginx-proxy-manager'
web-client/src/api/types.ts                   # ProxyDriverInfo.usesNpmApi
web-client/src/lib/settings-display.ts        # showNpmApiFields; tab list; Proxy field list
web-client/src/pages/SettingsPage.tsx         # isVisible for the three npm* keys
test/web/routes/settings.test.ts
test/web-client/settings-display.test.ts
test/lib/settings-defs.test.ts
test/lib/proxy/index.test.ts
docs/web-ui.md, docs/configuration.md, docs/reverse-proxy/nginx-proxy-manager.md
CLAUDE.md
docs/images/settings-proxy-driver.png         # regenerated (tab strip changes)
```

**Structure Decision**: Existing layout; no new files outside `specs/`.

## Complexity Tracking

No violations.
