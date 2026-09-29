# Data Model: Proxy driver dropdown with a "no proxy" option

## ProxyDriverId

`'caddy' | 'none'` (`PROXY_DRIVER_IDS` in `src/lib/proxy/ids.ts`). Stored as the optional `proxyDriver` row in the `meta` table. Unset means `DEFAULT_PROXY_DRIVER_ID` = `'caddy'`.

Validation: `SettingsSchema.proxyDriver = z.enum(PROXY_DRIVER_IDS).optional()` (unchanged expression; new member). Shared by `set-config`, `PATCH /api/settings`, the MCP `set-config` operation, and `loadInventory`.

## ReverseProxyDriver (extended)

| Field | Type | Caddy | None |
| --- | --- | --- | --- |
| `id` | `ProxyDriverId` | `caddy` | `none` |
| `label` | `string` | `Caddy` | `No proxy` |
| `capabilities.authModes` | `ProxyAuthMode[]` | `['forward','oidc']` | `['forward','oidc']` |
| `capabilities.acmeDns01ViaCloudflare` | `boolean` | `true` | `false` |
| `defaultConfigPath` | `string \| null` | `/etc/caddy/Caddyfile` | `null` |
| `statusPage` | `{ suggestedPath: string } \| null` | `{ suggestedPath: '/usr/share/caddy/index.html' }` | `null` |
| `plan/apply/snapshot` | methods | file-driver cycle | no-op / no-op / throws |

`managesProxy(driver)`: `false` only for `none` (`driver.id !== NO_PROXY_DRIVER_ID`). It is the one signal for "Bellhop manages no proxy"; `statusPage === null` only means a managed driver serves no status page.

`fileDriver(def)` requires both `label` and `statusPage` (no defaults), so a new file-configured driver has to state its dropdown label and whether it serves a status page.

`driverDeps()` resolves `configPath` as `inventory.proxyConfigPath ?? driver.defaultConfigPath`. It is only ever called for a driver that manages a proxy. A managed driver with `defaultConfigPath: null` and no override is a programming error, and it throws naming `proxyConfigPath`.

## ProxyDriverInfo (API view)

`{ id: ProxyDriverId; label: string; defaultConfigPath: string | null; suggestedStatusPagePath: string | null; managesProxy: boolean }`, one per registered driver in registration order.

## SyncProxyResult (changed)

`proxyHost: string | null`: `null` exactly when the active driver manages no proxy. `applied` is always `false` in that case, even with `--apply`, since nothing is written.

## StatusPageSkip

`statusPageSkipReason(inventory)` returns `{ message: string; level: 'info' | 'warn' } | null`. `level` is `warn` only for a managed driver that serves no status page while `statusPagePath` is set.

## ProxyFieldView (web client, derived)

`{ showConfigPath: boolean; configPathPlaceholder: string; configPathHelp: string; showStatusPagePath: boolean; statusPagePlaceholder: string }`, computed from the currently selected driver (the unsaved draft, else the default).
