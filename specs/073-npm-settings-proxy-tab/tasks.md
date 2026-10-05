---
description: "Tasks for Nginx Proxy Manager settings on the Proxy tab (#73)"
---

# Tasks: Nginx Proxy Manager settings on the Proxy tab

**Input**: Design documents from `specs/073-npm-settings-proxy-tab/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/settings-ui.md, quickstart.md

**Tests**: Required — the constitution (Principle III) requires tests with every behavior change. Write each test first and see it fail.

All paths are relative to the worktree root
`C:\Users\rcher\Dev\Bellhop-Worktrees\issue-73-npm-settings-proxy-tab`.

## Phase 1: Setup

Nothing to set up — existing project, no new dependencies.

## Phase 2: Foundational (the `usesNpmApi` driver flag)

**Purpose**: Both stories read the new flag, so it ships first.

- [x] T001 [P] Add tests: in `test/lib/proxy/index.test.ts` assert the registered `nginx-proxy-manager` driver has `usesNpmApi === true` and every other registered driver has it falsy; in `test/web/routes/settings.test.ts` add `usesNpmApi` to every expected `proxyDrivers` entry (`true` only for `nginx-proxy-manager`, `false` for the rest — data-model.md: "`true` only for `nginx-proxy-manager`; `false` for every other driver")
- [x] T002 Add optional `usesNpmApi?: boolean` to `ReverseProxyDriver` in `src/lib/proxy/driver.ts` (comment in the style of `usesApiUrl`: "true = this driver reads the npmApiUrl/npmApiEmail/npmApiPassword settings (issue #73, Nginx Proxy Manager only)... Absent = false"); set `usesNpmApi: true` in `createNpmDriver` in `src/lib/proxy/drivers/nginx-proxy-manager.ts`; report `usesNpmApi: driver.usesNpmApi ?? false` from `proxyDriversInfo()` in `src/web/routes/settings.ts`
- [x] T003 Add `usesNpmApi: boolean` (with a comment matching its neighbours) to `ProxyDriverInfo` in `web-client/src/api/types.ts`, and add `usesNpmApi: false` (or `true` where the fixture is the NPM driver) to every `ProxyDriverInfo` literal in `test/web-client/settings-display.test.ts` so it typechecks

**Checkpoint**: `npm run typecheck` and the T001 tests pass.

## Phase 3: User Story 1 — Configure Nginx Proxy Manager from the Proxy tab (P1) 🎯 MVP

**Goal**: No Nginx Proxy Manager tab; the three fields appear on the Proxy tab when Nginx Proxy Manager is selected.

**Independent Test**: Settings page shows five tabs; selecting Nginx Proxy Manager on the Proxy tab shows the three fields, which save/clear as before.

- [x] T004 [P] [US1] Update tests in `test/web-client/settings-display.test.ts`: tab labels are exactly `['General', 'Proxy', 'Authentik', 'Cloudflare', 'GitHub']`; `fieldsForTab('proxy')` ends with `'npmApiUrl', 'npmApiEmail', 'npmApiPassword'` after `'proxyApiUrl'`; remove the `fieldsForTab('nginx-proxy-manager')` assertion; `proxyFieldView('nginx-proxy-manager', drivers, 'cloudflare')` for an NPM-shaped driver (`defaultConfigPath: null`, `suggestedStatusPagePath: null`, `usesNpmApi: true`) returns `showNpmApiFields: true` with config path, status page, TLS, Caddy TLS, cert resolver and API URL all hidden
- [x] T005 [P] [US1] Update `test/lib/settings-defs.test.ts`'s EXPECTED table so `npmApiUrl`/`npmApiEmail`/`npmApiPassword` have group `'proxy'` (envVar, secret flag and `envFile: 'nginx-proxy-manager.env'` unchanged)
- [x] T006 [US1] In `src/lib/settings-defs.ts` change the three `npm*` `SETTING_DEFS` entries to `group: 'proxy'` and remove `'nginx-proxy-manager'` from `SettingGroup`
- [x] T007 [US1] In `web-client/src/lib/settings-display.ts`: remove `'nginx-proxy-manager'` from `SettingsTab`, `SETTINGS_TABS` and `TAB_FIELDS`; append `'npmApiUrl', 'npmApiEmail', 'npmApiPassword'` to the `proxy` list after `'proxyApiUrl'`; add `showNpmApiFields: boolean` to `ProxyFieldView` (documented like `showCertResolverField`), `false` in the no-driver/unmanaged branch and `driver.usesNpmApi` in `shared`; update the comment above `SettingsTab` that says one tab per integration if needed
- [x] T008 [US1] In `web-client/src/pages/SettingsPage.tsx` `isVisible`: `if (key === 'npmApiUrl' || key === 'npmApiEmail' || key === 'npmApiPassword') return view?.showNpmApiFields ?? false;` with a comment in the style of the Traefik one ("hidden until loaded"; issue #73)

**Checkpoint**: typecheck and tests pass; US1 works in the browser.

## Phase 4: User Story 2 — Fields hidden for every other driver (P1)

**Goal**: The fields never show for another driver, before the driver list loads, or for an unknown id; switching is display-only.

**Independent Test**: Cycle the dropdown through every driver; only Nginx Proxy Manager shows the fields; an unsaved edit survives a switch away and back with no request sent.

- [x] T009 [US2] Add tests in `test/web-client/settings-display.test.ts`: `proxyFieldView` returns `showNpmApiFields: false` for a Caddy-shaped driver, for a Traefik-shaped driver, for an unmanaged ("No proxy") driver, and for an id not in the list; extend the existing "every hide flag false" assertions for the unmanaged/unknown branches to include `showNpmApiFields`
- [x] T010 [US2] Confirm `SettingsPage.tsx` never clears drafts or sends a PATCH on driver change for the new fields (the existing `isVisible` filter is display-only) — no code change expected; note the result in this task

  **Finding**: Confirmed by inspection. `isVisible(key)` is consulted only
  to build `visibleFields` (the render filter) in the JSX return; it is
  never called from `setDrafts`, `save`, or `requestSave`. `drafts` is
  populated once per load/reload in `applyResponse` (from `res.settings`,
  independent of which driver is selected) and is otherwise only updated
  by a field's own `onChange`/post-save handler. The proxy-driver
  `<select>`'s `onChange` touches only `drafts.proxyDriver`. So switching
  the dropdown away from Nginx Proxy Manager (or to it) changes nothing
  about `drafts.npmApiUrl`/`npmApiEmail`/`npmApiPassword`, and no PATCH is
  ever sent as a side effect of visibility changing -- the same
  already-established property every other driver-dependent field (TLS,
  Caddy TLS, cert resolver/API URL) already has. No code change needed.

**Checkpoint**: tests pass.

## Phase 5: Polish & Cross-Cutting

- [x] T011 [P] Update `docs/web-ui.md` (tab list: General, Proxy, Authentik, Cloudflare and GitHub; say the Proxy tab shows the Nginx Proxy Manager API URL/email/password when that driver is selected), `docs/configuration.md` (tab list sentence and the three table rows' Tab column -> `Proxy (Nginx Proxy Manager driver)`), `docs/reverse-proxy/nginx-proxy-manager.md` (Credentials: set on the Settings page's Proxy tab once Nginx Proxy Manager is the selected driver)
- [x] T012 [P] Update `CLAUDE.md`: the driver.ts paragraph's list of optional Settings-page hints (add `usesNpmApi`, "five optional" count), the Web UI Settings page bullet's `proxyDriversInfo` field list and `proxyFieldView` description, and the issue #64 tab list (drop Nginx Proxy Manager, say its fields are on the Proxy tab for that driver)
- [x] T013 Run `npm run typecheck`, `npm test`, `npm run web:build`; all must pass
- [x] T014 Browser check per quickstart.md (demo instance) at desktop width and at ≤640 px
- [x] T015 Regenerate `docs/images/settings-proxy-driver.png` with `npm run docs:screenshots` (keep only that image's change if others differ only by noise) and check it shows five tabs and example values only

## Dependencies

- T001 before T002/T003 (TDD). T002, T003 block Phase 3+.
- T004/T005 before T006–T008. T007 before T008.
- US2 (T009–T010) depends on T007.
- Polish after both stories; T015 after T013.

## Parallel examples

- T001 alongside nothing else in Phase 2 (T002/T003 need its failing tests).
- T004 and T005 together (different test files).
- T011 and T012 together (different docs).

## Implementation strategy

MVP is Phase 2 + US1 (the move itself). US2 is mostly test coverage for the
hiding rules US1's code already applies, then docs, verification and the
screenshot.
