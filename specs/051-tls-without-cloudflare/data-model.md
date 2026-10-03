# Data Model: TLS Without Cloudflare (issue #51)

## Settings (`SettingsSchema`, `meta` table)

| Key | Type | Default when unset | Read by |
|---|---|---|---|
| `proxyCaddyTls` *(new)* | `'cloudflare' \| 'letsencrypt' \| 'internal' \| 'files'` | `cloudflare` | `caddy`, `caddy-api` |
| `proxyTlsCertificate` *(existing)* | absolute path | `/etc/letsencrypt/live/<domain>/fullchain.pem` | `nginx`; now also both Caddy drivers in `files` mode |
| `proxyTlsKey` *(existing)* | absolute path | `/etc/letsencrypt/live/<domain>/privkey.pem` | as above |
| `proxyCertResolver` *(existing)* | `^[A-Za-z0-9_-]+$` | `cloudflare` | `traefik`; the value `none` is now reserved |

`proxyCaddyTls` is a `meta` scalar like every other setting: stored by
`saveInventory`'s key-by-key upsert, cleared by `set-config --unset` or a
Settings PATCH of `null`/`''`. No schema migration; a new key simply has no row.

## ProxyContext (`src/lib/proxy/routes.ts`)

Gains `caddyTls: CaddyTlsMode`, always present (unset → `cloudflare`), resolved
by `caddyTlsMode(inventory)`.

## Driver contract (`src/lib/proxy/driver.ts`)

- `DriverCapabilities.acmeDns01ViaCloudflare: (inventory: Inventory) => boolean`
  (was `boolean`).
- `ReverseProxyDriver.usesCaddyTls?: boolean` — `true` on `caddy` and
  `caddy-api` only.

## Bellhop TLS objects in Caddy's live configuration (`caddy-api`)

| `@id` | Location | Present in mode |
|---|---|---|
| `bellhop-tls` | `apps.tls.automation.policies[]` | `cloudflare` (ACME + Cloudflare DNS), `internal` (`issuers: [{module: internal}]`) |
| `bellhop-tls-files` | `apps.tls.certificates.load_files[]`, tag `bellhop-cert` | `files` |
| `bellhop-tls-connection` | target server's `tls_connection_policies[]`, first | `files` |
| `bellhop-tls-default` | target server's `tls_connection_policies[]`, last | `files`, only when the server has no untagged catch-all |

State transition on a mode change: every sync removes all `bellhop-tls*` objects
and adds those the current mode lists above; untagged objects are never edited.
With zero kept routes, none are present in any mode.
