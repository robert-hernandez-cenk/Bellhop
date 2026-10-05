# Data Model: Nginx Proxy Manager settings on the Proxy tab

No stored data changes. Two in-memory shapes gain a field, and two lists
change.

## Proxy driver information (`ProxyDriverInfo`, settings API)

| Field | Type | Change |
|---|---|---|
| `usesNpmApi` | boolean | **New.** `true` only for `nginx-proxy-manager`; `false` for every other driver (the driver's own optional field defaults to false). |

All other fields unchanged.

## Proxy field view (`ProxyFieldView`)

| Field | Type | Change |
|---|---|---|
| `showNpmApiFields` | boolean | **New.** `driver.usesNpmApi` for a managed driver; `false` for "No proxy" and for an id not in the driver list. |

## Settings tabs

- Before: General, Proxy, Authentik, Cloudflare, Nginx Proxy Manager, GitHub.
- After: General, Proxy, Authentik, Cloudflare, GitHub.
- Proxy tab fields, in order: `proxyDriver`, `proxyConfigPath`,
  `statusPagePath`, `proxyCaddyTls`, `proxyTlsCertificate`, `proxyTlsKey`,
  `proxyCertResolver`, `proxyApiUrl`, `npmApiUrl`, `npmApiEmail`,
  `npmApiPassword`.

## Setting definitions (`SETTING_DEFS`)

| Key | group before | group after | envVar / secret / envFile |
|---|---|---|---|
| `npmApiUrl` | `nginx-proxy-manager` | `proxy` | unchanged |
| `npmApiEmail` | `nginx-proxy-manager` | `proxy` | unchanged |
| `npmApiPassword` | `nginx-proxy-manager` | `proxy` | unchanged |

`SettingGroup` loses `'nginx-proxy-manager'`.
