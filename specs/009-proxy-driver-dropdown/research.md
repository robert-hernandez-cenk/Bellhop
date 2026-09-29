# Research: Proxy driver dropdown with a "no proxy" option

## R1. How "no proxy" is represented

- **Decision**: A real registered driver with id `none`, implementing `ReverseProxyDriver`. Its `plan()` returns a fixed "nothing to write" preview, `apply()` does nothing, and `snapshot()` throws the same named error `render-status-page` uses. Callers detect it through `managesProxy(driver)` in `driver.ts`, which returns `driver.id !== NO_PROXY_DRIVER_ID` (`'none'`, exported from `ids.ts`). That function is the one signal for "Bellhop manages no proxy"; callers do not scatter `=== 'none'` checks, and `statusPage === null` is never used to mean it.
- **Rationale**: Keeping `none` in the registry means `getDriver`, the capability check, the ACME-prune capability gate, and the settings driver list all work with no special cases. `checkCapabilities` accepts both modes because `authModes` is `['forward', 'oidc']` (the user's decision), and the prune step skips because `acmeDns01ViaCloudflare` is `false`.
- **Alternatives considered**: (a) Making `getDriver` return `null` for `none`. Rejected: every caller would need a null branch, and the settings list would need a separate entry. (b) Treating an unset setting as "no proxy". Rejected: it changes behavior for existing deployments, violating FR-002.

## R2. Where the short-circuit happens

- **Decision**: `runSyncProxy` checks `managesProxy(driver)` right after `getDriver` and **before** `driverDeps()`, `buildRoutes()`, and `checkCapabilities()`. It returns `{ proxyHost: null, driver: 'none', preview: NO_PROXY_SYNC_MESSAGE, applied: false }`.
- **Rationale**: `driverDeps()` throws when no entry has `proxy: true`, and `buildRoutes()` throws when a forward-gated route has no authentik ip. Neither failure is meaningful when Bellhop writes nothing (FR-009, acceptance 2.2). `applied` is `false` even with `--apply`, since nothing is ever written. The CLI and the `sync-proxy` operation key on `proxyHost === null`, not on `applied`, so they print the message for both a dry run and `--apply`. `syncProxyLive` and `migrate-guest` log the same `preview` via `logInfo` rather than dropping it, and `migrate-guest` does not print its "Pushing the new IP ... live via the proxy" line under `none`. Every caller of `runSyncProxy` gets this: the CLI, the `sync-proxy` operation (web and MCP), `syncProxyLive`, and `migrate-guest`.
- **Alternatives considered**: Relaxing `driverDeps` to allow a missing proxy host. Rejected: that leaks a nullable `proxyHost` into every real driver.

## R3. Status page under `none`

- **Decision**: Each driver declares `statusPage: { suggestedPath: string } | null`. Caddy's suggested path is `/usr/share/caddy/index.html`, the Caddy package's default document root and the placeholder the page already shows. `none` declares `null`. `runRenderStatusPage` checks, before the `statusPagePath` check: a driver that does not `managesProxy()` throws `NO_PROXY_STATUS_PAGE_ERROR` (naming `settingFix('proxyDriver', 'caddy')`); a managed driver whose `statusPage` is `null` throws `statusPageUnsupportedError(id)`, whose remedy is to clear `statusPagePath` or choose a driver that serves a page. No managed driver without a status page ships today, but the two cases are kept distinct. `syncProxyLive` and `migrate-guest` share one helper, `statusPageSkipReason(inventory)`, which returns `{ message, level }` or `null`, checked in the same order: the `none` skip message (`info`), the managed-but-no-status-page message (`warn` when `statusPagePath` is set, since the operator's setting is being ignored, else `info`), the unset-path message (`info`). Both callers log it through `logStatusPageSkip`.
- **Rationale**: The status page's content is the deployed proxy configuration, and it is served by the proxy's file server. With no managed proxy, neither exists. The helper removes the two duplicated `if (statusPagePath !== undefined)` blocks.
- **Alternatives considered**: Letting the status page render under `none` with an empty config section. Rejected: there is no host guaranteed to write it to, since `proxy: true` may be absent.

## R4. How the client learns about drivers

- **Decision**: `GET` and `PATCH /api/settings` add `proxyDrivers: Array<{ id, label, defaultConfigPath: string | null, suggestedStatusPagePath: string | null, managesProxy: boolean }>` and `defaultProxyDriver: 'caddy'`. They are built from `listDrivers()` in `src/lib/proxy/index.ts`, in registration order: Caddy first, No proxy second.
- **Rationale**: FR-004. The web client is a separate build that cannot import `src/`, and adding a future driver then needs no client change.
- **Alternatives considered**: A separate `GET /api/proxy-drivers` endpoint. Rejected: it adds a second fetch and a second admin gate for data that only the Settings page uses.

## R5. Page behavior

- **Decision**: A pure helper `proxyFieldView(selectedId, drivers)` returns `{ showConfigPath, configPathPlaceholder, configPathHelp, showStatusPagePath, statusPagePlaceholder }`. The config path field shows exactly when the selected driver `managesProxy`; its placeholder is the driver's default path, or empty with help text saying a path is required when it has none. The status page field shows when the driver manages a proxy and suggests a status page path. An unknown id hides both. The selection is `drafts.proxyDriver || defaultProxyDriver`, so it follows the unsaved dropdown value (acceptance 3.5). The `<select>` has one `<option>` per driver, and the default driver's label gets the suffix " (default)". An unset setting displays as the default option (value `''` → default id). Choosing the default driver explicitly and saving stores it explicitly, and Clear returns to unset. Both behave the same. Without the driver list (a failed load), the field is a disabled `<select>` with no options and its Save is disabled, never a free-text input.
- **Rationale**: Keeps the page thin and puts the logic under `node --test`, following the same convention as `admin-nav.ts`.
- **Alternatives considered**: A separate "(unset)" option. Rejected: it duplicates the default option without meaning anything different, and Clear already covers it.

## R6. Hidden fields keep their values

- **Decision**: Hiding only skips rendering. Drafts and stored values are untouched, and no PATCH is sent (FR-008).

## R7. `set-config` CLI description

- **Decision**: Build the description from `SETTINGS_KEYS.join(', ')`, as the `set-config` operation already does. This covers `proxyDriver` and `proxyConfigPath` and cannot drift again (FR-013).
