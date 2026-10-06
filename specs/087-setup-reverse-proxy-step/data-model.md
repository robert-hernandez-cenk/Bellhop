# Data model: reverse-proxy step (#87)

No new tables or columns. The step reads and writes existing records.

## Stored state

| Record | Where | Written by this step |
|---|---|---|
| Proxy flag | inventory `hosts[].proxy` / `guests[].proxy` (at most one `true`) | save |
| `proxyDriver`, `proxyConfigPath`, `tlsSource`, `acmeDnsProvider`, `proxyTlsCertificate`, `proxyTlsKey`, `proxyCertResolver`, `proxyApiUrl`, `npmApiUrl`, `npmApiEmail` | inventory settings (`meta`) | save |
| `cloudflareDnsApiToken`, `npmApiPassword` | `secret_settings` (write-only) | save, only when the request carries a non-empty value |
| Completed steps | `setup_state.completed_steps_json` | `proxy` added by a passing check or by saving `none`; removed by a save that changes anything |

## `ProxyStepState` (the `GET` response)

| Field | Type | Meaning |
|---|---|---|
| `drivers` | `ProxyDriverInfo[]` | `proxyDriversInfo()`: `id`, `label`, `defaultConfigPath`, `managesProxy`, `tlsSources`, `defaultTlsSource`, `usesCertResolver`, `usesApiUrl`, `usesNpmApi`, `configPathNote` |
| `defaultDriver` | string | `DEFAULT_PROXY_DRIVER_ID` |
| `acmeDnsProviders`, `defaultAcmeDnsProvider` | string[], string | as the Settings response |
| `entries` | `{ name, kind: 'host' \| 'guest', parent?: string, ip?: string }[]` | candidates for the proxy flag |
| `choice` | `ProxyChoice` | what is stored now |
| `secrets` | `{ cloudflareDnsApiToken: boolean, npmApiPassword: boolean }` | set / not set; never a value |
| `pinned` | `{ key: string, variable: string }[]` | settings an environment variable pins (empty on a fresh install) |
| `complete` | boolean | `proxy` is in the completed steps |

## `ProxyChoice` (the `PUT` body and the stored view)

| Field | Type | Rules |
|---|---|---|
| `driver` | one of `PROXY_DRIVER_IDS` | required |
| `entry` | string (name of a host or guest) | required unless `driver` is `none`; ignored for `none` |
| `configPath` | absolute path, optional | schema: `proxyConfigPath`; only for a driver with a config file |
| `tlsSource` | one of `TLS_SOURCES`, optional | must be in the driver's `tlsSources` (R6) |
| `acmeDnsProvider` | one of `ACME_DNS_PROVIDERS`, optional | |
| `certificatePath`, `keyPath` | absolute paths, optional | `proxyTlsCertificate` / `proxyTlsKey` |
| `certResolver`, `apiUrl` | optional | Traefik: `proxyCertResolver` / `proxyApiUrl` |
| `npmApiUrl`, `npmApiEmail` | optional | NPM |
| `secrets` | `{ cloudflareDnsApiToken?: string, npmApiPassword?: string }` | write-only; blank or absent keeps the stored value |

An empty string clears an optional non-secret value (as the Settings page does).

## `ProxyCheckResult` (the check response)

| Field | Type | Meaning |
|---|---|---|
| `ok` | boolean | the driver check passed |
| `summary` | string | one line from the driver on success |
| `preview` | string | `runSyncProxy` dry-run text; present on `ok` when the preview built |
| `previewError` | string | present when the check passed but the dry run threw |
| `completedSteps` | string[] | after the call |

A failed check answers an HTTP error (`502`) carrying `error`, not a result object.

## State transitions

```text
not complete --save(non-none)--> not complete
not complete --check passes AND preview builds--> complete
not complete --save(driver none)--> complete
complete --save with any changed value--> not complete
complete --save with identical values--> complete (no change)
```
