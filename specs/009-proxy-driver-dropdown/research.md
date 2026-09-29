# Research: Proxy driver dropdown with a "no proxy" option

## R1. How "no proxy" is represented

- **Decision**: A real registered driver with id `none`, implementing `ReverseProxyDriver`. Its `plan()` returns a fixed "nothing to write" preview, `apply()` does nothing, and `snapshot()` throws the same named error `render-status-page` uses. Callers detect it by metadata through `managesProxy(driver)` in `driver.ts`, which returns `driver.id !== 'none'`. Callers do not scatter `=== 'none'` checks.
- **Rationale**: Keeping `none` in the registry means `getDriver`, the capability check, the ACME-prune capability gate, and the settings driver list all work with no special cases. `checkCapabilities` accepts both modes because `authModes` is `['forward', 'oidc']` (the user's decision), and the prune step skips because `acmeDns01ViaCloudflare` is `false`.
- **Alternatives considered**: (a) Making `getDriver` return `null` for `none`. Rejected: every caller would need a null branch, and the settings list would need a separate entry. (b) Treating an unset setting as "no proxy". Rejected: it changes behavior for existing deployments, violating FR-002.

## R2. Where the short-circuit happens

- **Decision**: `runSyncProxy` checks `managesProxy(driver)` right after `getDriver` and **before** `driverDeps()`, `buildRoutes()`, and `checkCapabilities()`. It returns `{ proxyHost: null, driver: 'none', preview: NO_PROXY_SYNC_MESSAGE, applied: opts.apply === true }`.
- **Rationale**: `driverDeps()` throws when no entry has `proxy: true`, and `buildRoutes()` throws when a forward-gated route has no authentik ip. Neither failure is meaningful when Bellhop writes nothing (FR-009, acceptance 2.2). `applied` still reflects the request, so the CLI prints "Wrote nothing" rather than a dry-run header. Every caller of `runSyncProxy` gets this: the CLI, the `sync-proxy` operation (web and MCP), `syncProxyLive`, and `migrate-guest`.
- **Alternatives considered**: Relaxing `driverDeps` to allow a missing proxy host. Rejected: that leaks a nullable `proxyHost` into every real driver.

## R3. Status page under `none`

- **Decision**: Each driver declares `statusPage: { suggestedPath: string } | null`. Caddy's suggested path is `/usr/share/caddy/index.html`, the Caddy package's default document root and the placeholder the page already shows. `none` declares `null`. `runRenderStatusPage` throws `NO_PROXY_STATUS_PAGE_ERROR` when `statusPage` is null, before the `statusPagePath` check. That error names `settingFix('proxyDriver', 'caddy')`. `syncProxyLive` and `migrate-guest` share one helper, `statusPageSkipReason(inventory)`, which returns the driver skip message, the unset-path message, or `null`.
- **Rationale**: The status page's content is the deployed proxy configuration, and it is served by the proxy's file server. With no managed proxy, neither exists. The helper removes the two duplicated `if (statusPagePath !== undefined)` blocks.
- **Alternatives considered**: Letting the status page render under `none` with an empty config section. Rejected: there is no host guaranteed to write it to, since `proxy: true` may be absent.

## R4. How the client learns about drivers

- **Decision**: `GET` and `PATCH /api/settings` add `proxyDrivers: Array<{ id, label, defaultConfigPath: string | null, suggestedStatusPagePath: string | null }>` and `defaultProxyDriver: 'caddy'`. They are built from `listDrivers()` in `src/lib/proxy/index.ts`, in registration order: Caddy first, No proxy second.
- **Rationale**: FR-004. The web client is a separate build that cannot import `src/`, and adding a future driver then needs no client change.
- **Alternatives considered**: A separate `GET /api/proxy-drivers` endpoint. Rejected: it adds a second fetch and a second admin gate for data that only the Settings page uses.

## R5. Page behavior

- **Decision**: A pure helper `proxyFieldView(selectedId, drivers, defaultId)` returns `{ showConfigPath, configPathPlaceholder, configPathHelp, showStatusPagePath, statusPagePlaceholder }`. The selection is `drafts.proxyDriver || defaultProxyDriver`, so it follows the unsaved dropdown value (acceptance 3.5). The `<select>` has one `<option>` per driver, and the default driver's label gets the suffix " (default)". An unset setting displays as the default option (value `''` → default id). Choosing the default driver explicitly and saving stores it explicitly, and Clear returns to unset. Both behave the same.
- **Rationale**: Keeps the page thin and puts the logic under `node --test`, following the same convention as `admin-nav.ts`.
- **Alternatives considered**: A separate "(unset)" option. Rejected: it duplicates the default option without meaning anything different, and Clear already covers it.

## R6. Hidden fields keep their values

- **Decision**: Hiding only skips rendering. Drafts and stored values are untouched, and no PATCH is sent (FR-008).

## R7. `set-config` CLI description

- **Decision**: Build the description from `SETTINGS_KEYS.join(', ')`, as the `set-config` operation already does. This covers `proxyDriver` and `proxyConfigPath` and cannot drift again (FR-013).
