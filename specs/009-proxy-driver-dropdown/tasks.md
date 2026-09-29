---
description: "Task list for the proxy driver dropdown with a no-proxy option"
---

# Tasks: Proxy driver dropdown with a "no proxy" option

**Input**: Design documents from `specs/009-proxy-driver-dropdown/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Required by the constitution (Principle III): every behavior change ships with tests, written first (TDD). Use `FakeSSHClient` and temp SQLite fixtures, following the existing files named below.

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Setup

None needed: existing project, dependencies installed.

---

## Phase 2: Foundational (blocking)

**Purpose**: The `none` id and driver metadata that every story reads.

- [x] T001 Write failing tests in `test/lib/proxy/index.test.ts` and `test/lib/proxy/driver.test.ts`. Cover:
  - `PROXY_DRIVER_IDS` equals `['caddy', 'none']`.
  - `getDriver({ ...inv, proxyDriver: 'none' }).id === 'none'`, and an unset setting still returns `caddy`.
  - `DEFAULT_PROXY_DRIVER_ID === 'caddy'`.
  - `listDrivers()` returns Caddy then None, in registration order.
  - `managesProxy(caddyDriver) === true` and `managesProxy(noneDriver) === false`.
  - Caddy metadata: `label 'Caddy'`, `defaultConfigPath '/etc/caddy/Caddyfile'`, `statusPage { suggestedPath: '/usr/share/caddy/index.html' }`.
  - None metadata: `label 'No proxy'`, `defaultConfigPath null`, `statusPage null`, `capabilities { authModes: ['forward','oidc'], acmeDns01ViaCloudflare: false }`.
  - `checkCapabilities` returns `[]` for forward and oidc routes under `noneDriver`.
  - None's `plan()` preview equals `NO_PROXY_SYNC_MESSAGE`, `apply()` resolves with no SSH calls, and `snapshot()` rejects with `NO_PROXY_STATUS_PAGE_ERROR`.
  - `SettingsSchema.safeParse({ proxyDriver: 'none' })` succeeds and `{ proxyDriver: 'nginx' }` fails; put these in `test/lib/inventory.test.ts` or wherever SettingsSchema is already tested.
- [x] T002 Add `'none'` to `PROXY_DRIVER_IDS` in `src/lib/proxy/ids.ts` and update its comment.
- [x] T003 Extend `ReverseProxyDriver` in `src/lib/proxy/driver.ts`:
  - Add `label: string`.
  - Change to `defaultConfigPath: string | null` ("null = the driver uses no configuration file").
  - Add `statusPage: { suggestedPath: string } | null` ("null = no status page served").
  - Export `managesProxy(driver)`, which is `false` only for the `none` driver.
  - Export the constants `NO_PROXY_SYNC_MESSAGE` and `NO_PROXY_STATUS_PAGE_ERROR` with the exact text from `contracts/commands-and-messages.md`. The error text uses `settingFix('proxyDriver', 'caddy')` from `src/lib/settings-hint.ts`.
- [x] T004 Thread `label` and `statusPage` through `fileDriver(def)` in `src/lib/proxy/file-driver.ts`. Its own `defaultConfigPath` stays a non-null `string`, since a file-configured driver always has a file. Then set `label: 'Caddy'` and `statusPage: { suggestedPath: '/usr/share/caddy/index.html' }` in `src/lib/proxy/drivers/caddy.ts`.
- [x] T005 Create `src/lib/proxy/drivers/none.ts` exporting `noneDriver`, with the metadata above:
  - `plan()` returns `{ preview: NO_PROXY_SYNC_MESSAGE, payload: null }`.
  - `apply()` is a no-op.
  - `snapshot()` throws `new Error(NO_PROXY_STATUS_PAGE_ERROR)`.
  - A short header comment explains that "none" means Bellhop manages no reverse proxy, not that none exists (issue #33).
- [x] T006 Update the registry in `src/lib/proxy/index.ts`:
  - Register `noneDriver` after Caddy.
  - Export `DEFAULT_PROXY_DRIVER_ID = 'caddy'` and use it in `getDriver` instead of the literal.
  - Export `listDrivers(): ReverseProxyDriver[]`, in registration order.
  - In `driverDeps`, resolve `configPath` as `inventory.proxyConfigPath ?? driver.defaultConfigPath`. When the result is `null`, throw `Error("The '<id>' proxy driver has no default config path -- " + settingFix('proxyConfigPath', '</absolute/path>'))`.
  - Fix any other compile errors caused by the nullable `defaultConfigPath`, for example in `test/lib/proxy/*` fakes, which now need `label`/`statusPage`.
- [x] T007 Run `npm run typecheck` and `npm test`. T001 should now pass and everything else stays green.

**Checkpoint**: `none` is a valid, registered driver. Nothing user-visible has changed yet.

---

## Phase 3: User Story 1 - Choose the proxy driver from a list (P1) 🎯 MVP

**Goal**: The Settings page shows the driver as a dropdown populated from the server.

**Independent Test**: `GET /api/settings` includes `proxyDrivers`/`defaultProxyDriver`. On the page, the field is a `<select>` listing "Caddy (default)" and "No proxy"; Save and Clear round-trip.

- [x] T008 [US1] Write failing tests in `test/web/routes/settings.test.ts`:
  - GET and PATCH responses include `proxyDrivers` exactly as in `contracts/settings-api.md` (Caddy first with its paths, None with `null`s) and `defaultProxyDriver: 'caddy'`.
  - PATCH `{proxyDriver: 'none'}` returns 200 and persists.
  - PATCH `{proxyDriver: 'nginx'}` returns 400.
  - PATCH `{proxyDriver: null}` clears it.
  - A stored `proxyConfigPath` is still returned while `proxyDriver` is `none`.
- [x] T009 [US1] In `src/web/routes/settings.ts`, add `proxyDrivers` (from `listDrivers()`, mapped to `{ id, label, defaultConfigPath, suggestedStatusPagePath: statusPage?.suggestedPath ?? null }`) and `defaultProxyDriver: DEFAULT_PROXY_DRIVER_ID` to both the GET and PATCH responses, through one shared response builder.
- [x] T010 [P] [US1] In `web-client/src/api/types.ts`, add a `ProxyDriverInfo` interface and add `proxyDrivers: ProxyDriverInfo[]` and `defaultProxyDriver: string` to `SettingsResponse`.
- [x] T011 [US1] Write failing tests in `test/web-client/settings-display.test.ts` for `proxyDriverOptions(drivers, defaultId)`. It returns `[{ value: 'caddy', label: 'Caddy (default)' }, { value: 'none', label: 'No proxy' }]`, suffixing only the default's label with " (default)".
- [x] T012 [US1] Implement `proxyDriverOptions` in `web-client/src/lib/settings-display.ts`. Keep the file framework-free.
- [x] T013 [US1] Update `web-client/src/pages/SettingsPage.tsx`:
  - Render the `proxyDriver` field as a `<select className="field-input">` whose options come from `proxyDriverOptions(data.proxyDrivers, data.defaultProxyDriver)`.
  - Its displayed value is `drafts.proxyDriver || data.defaultProxyDriver`.
  - Save sends the selected id, and Clear sends `null`, exactly as the text fields do.
  - Drop the proxyDriver `placeholder`, and update its help text to describe "No proxy" (Bellhop writes no proxy configuration; forward-auth assumes your own proxy enforces it).
  - Other fields stay `<input>`s.
- [x] T014 [US1] Run `npm run typecheck`, `npm test` and `npm run web:build`, then commit `Proxy driver dropdown on the Settings page (#33, US1)`.

**Checkpoint**: The driver is chosen from a list, and `none` can be saved.

---

## Phase 4: User Story 2 - Run Bellhop without a managed reverse proxy (P1)

**Goal**: Every command that touches the proxy behaves correctly under `none`.

**Independent Test**: With `proxyDriver: 'none'` and no `proxy: true` entry, sync-proxy (CLI and operation), syncProxyLive, and migrate-guest succeed with an empty `FakeSSHClient.history` for proxy work. render-status-page throws the named error.

- [x] T015 [P] [US2] Write failing tests in `test/commands/sync-proxy.test.ts`. Under `none`, with no `proxy: true` entry, and with a forward-gated entry but no `authentik` entry (proves routes are never derived), both dry run and apply must:
  - return `{ proxyHost: null, driver: 'none', preview: NO_PROXY_SYNC_MESSAGE }`,
  - set `applied` equal to `opts.apply === true`,
  - leave `ssh.history` empty.
  Keep an unset-setting case asserting today's Caddy behavior is unchanged.
- [x] T016 [P] [US2] Write failing tests in `test/commands/render-status-page.test.ts`. Under `none`, with or without `statusPagePath` set, it rejects with `NO_PROXY_STATUS_PAGE_ERROR` and makes no SSH calls.
- [x] T017 [P] [US2] Write failing tests in `test/web/proxy-sync.test.ts`. Under `none` with `statusPagePath` set, `syncProxyLive`:
  - makes no SSH calls,
  - logs the driver status-page skip line and the existing `pruneAcmeDriverSkipMessage('none')` line,
  - still runs sync-authentik when Authentik is configured, as the existing tests do.
- [x] T018 [P] [US2] Write failing tests in `test/commands/migrate-guest.test.ts`. A successful migration of a guest with subdomains under `none` (no `proxy: true` entry, `statusPagePath` set):
  - completes,
  - makes no proxy-host SSH calls,
  - logs the status-page skip line,
  - logs no "proxy sync failed" warning.
- [x] T019 [P] [US2] Write failing tests for the sync-proxy operation in `test/operations/` (the existing maintenance/networking operation tests file). Under `none`, the preview contains `NO_PROXY_SYNC_MESSAGE`. Also write failing tests in `test/cli.test.ts`, or the existing CLI coverage, if the CLI's sync-proxy output is tested there: the CLI prints the message rather than "Generated ... for null".
- [x] T020 [US2] In `src/commands/networking/sync-proxy.ts`:
  - Make `SyncProxyResult.proxyHost` a `string | null`, documented as null when the driver manages no proxy.
  - Right after `getDriver`, when `!managesProxy(driver)`, return `{ proxyHost: null, driver: driver.id, preview: NO_PROXY_SYNC_MESSAGE, applied: opts.apply === true }`. This must happen before `driverDeps`, `buildRoutes`, and `checkCapabilities`, because those throw on a missing `proxy: true` entry or authentik ip.
- [x] T021 [US2] In `src/commands/networking/render-status-page.ts`:
  - Throw `new Error(NO_PROXY_STATUS_PAGE_ERROR)` first when `getDriver(inventory).statusPage === null`, before the `statusPagePath` check.
  - Export `statusPageSkipReason(inventory): string | null`. It returns ``proxyDriver is '${id}' -- skipping the status page render`` when the driver serves no status page, `statusPagePathSkipMessage()` when the path is unset, and otherwise `null`.
- [x] T022 [US2] Use `statusPageSkipReason` in `src/web/proxy-sync.ts` (`syncProxyLive`) and `src/commands/provisioning/migrate-guest.ts`, replacing each `if (statusPagePath !== undefined)` block. When a reason is returned, log it with `logInfo`; otherwise render.
- [x] T023 [US2] Update the `sync-proxy` output in `src/cli.ts` and `src/operations/maintenance.ts`. When `result.proxyHost === null`, print/log `result.preview` via `logInfo` instead of the "Generated/Wrote ... for <host>" lines. The operation's preview already returns `result.preview`, so confirm it reads well. The apply path must log the message.
- [x] T024 [US2] Change the `set-config` command description in `src/cli.ts` to build its key list from `SETTINGS_KEYS.join(', ')` (FR-013), matching `src/operations/networking.ts`.
- [x] T025 [US2] Run `npm run typecheck` and `npm test`, then commit `No-proxy driver: sync-proxy and status page skip cleanly (#33, US2)`.

**Checkpoint**: `none` is fully usable from the CLI, web, and MCP.

---

## Phase 5: User Story 3 - Only see proxy fields that apply, with matching suggestions (P2)

**Goal**: Dependent fields show, hide, and change placeholder based on the selected driver.

**Independent Test**: Toggling the unsaved dropdown hides or shows Proxy config path and Status page path, and switches their placeholders.

- [x] T026 [US3] Write failing tests in `test/web-client/settings-display.test.ts` for `proxyFieldView(selectedId, drivers)`:
  - With Caddy selected, it returns `{ showConfigPath: true, configPathPlaceholder: '/etc/caddy/Caddyfile', configPathHelp: <mentions "Caddy" and "/etc/caddy/Caddyfile">, showStatusPagePath: true, statusPagePlaceholder: '/usr/share/caddy/index.html' }`.
  - With none selected, both `show*` are false.
  - An unknown id (defensive) behaves like no metadata: both hidden.
- [x] T027 [US3] Implement `proxyFieldView` in `web-client/src/lib/settings-display.ts`.
- [x] T028 [US3] In `web-client/src/pages/SettingsPage.tsx`:
  - Compute `view = proxyFieldView(drafts.proxyDriver || data.defaultProxyDriver, data.proxyDrivers)`.
  - Skip rendering `proxyConfigPath` when `!view.showConfigPath` and `statusPagePath` when `!view.showStatusPagePath`.
  - Use `view`'s placeholders and help text for those two fields in place of the static `FIELDS` values.
  - Drafts and stored values are never cleared by hiding (FR-008).
- [x] T029 [US3] Run `npm run typecheck`, `npm test` and `npm run web:build`, then commit `Settings: show proxy fields only when the driver uses them (#33, US3)`.

---

## Phase 6: Polish & Cross-Cutting

- [x] T030 [P] Update `README.md`:
  - "Reverse proxy drivers" section: document the `none` driver ("No proxy": Bellhop writes no proxy config, sync-proxy is a no-op, render-status-page fails, the push-live step skips the status page, forward-auth entries are allowed and assumed enforced by your own proxy).
  - Settings table row for `proxyDriver`: allowed values `caddy`/`none`.
  - Settings page description: the dropdown and conditional fields.
- [x] T031 [P] Update `CLAUDE.md`:
  - Driver-interface bullet: `none` driver, `label`/`defaultConfigPath: string | null`/`statusPage`, `managesProxy`, `listDrivers`, `DEFAULT_PROXY_DRIVER_ID`.
  - `render-status-page` bullet: the `none` error and the `statusPageSkipReason` skip.
  - Settings page bullet: `proxyDrivers`/`defaultProxyDriver` in the response, dropdown, and conditional fields via `proxyFieldView`.
  - Record the single-operator assumption change: not every deployment has a Bellhop-managed proxy.
  - Check `CONTRIBUTING.md` for any restated rule this changes (likely none).
- [x] T032 Run quickstart.md sections 1-2 (typecheck, test, web:build, CLI against a temp inventory) and paste the output.
- [x] T033 Run quickstart.md section 3 in a browser at desktop width and at ≤640px (390px), covering dropdown options, toggling, save/reload, and clear, with no horizontal overflow.
- [x] T034 Commit the docs and verification ticks: `Mark #33 verification tasks complete`.

---

## Dependencies & Execution Order

- Phase 2 (T001-T007) blocks everything.
- US1 (T008-T014) and US2 (T015-T025) are independent after Phase 2. They touch different files, except that both change `src/cli.ts`: T023/T024 belong to US2, so there is no conflict with US1.
- US3 (T026-T029) depends on US1, since it uses the same page and helper file.
- Polish comes after all stories.

## Parallel Opportunities

- T010 is parallel with T008/T009.
- T015-T019 (US2 tests) touch separate test files and can be written in parallel.
- T030/T031 are parallel.

## Implementation Strategy

MVP is Phase 2 + US1: the dropdown ships with `none` selectable. US2 must follow before merge, because otherwise selecting `none` would be accepted but still write Caddy config. US3 is the polish that hides irrelevant fields. All three ship in one PR.
