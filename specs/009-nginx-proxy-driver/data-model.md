# Data Model: nginx Proxy Driver

No new tables or columns. Two `meta` keys, one context field, one driver id.

## Settings (`SettingsSchema`, `src/lib/inventory.ts`)

| Key | Type | Validation | Unset means |
| --- | --- | --- | --- |
| `proxyDriver` | enum | now `'caddy' \| 'nginx'` (`PROXY_DRIVER_IDS`) | `'caddy'` (unchanged) |
| `proxyTlsCertificate` | string | absolute path (`/^\//`, "must be an absolute path") | `/etc/letsencrypt/live/<domain>/fullchain.pem` |
| `proxyTlsKey` | string | absolute path, same rule | `/etc/letsencrypt/live/<domain>/privkey.pem` |

Stored as rows in the `meta` table like every other setting (issue #124);
`saveInventory`'s key-by-key upsert/delete over `SETTINGS_KEYS` picks the
two new keys up with no SQL change. Settable/clearable through
`set-config <key> [value] [--unset] --apply` and `PATCH /api/settings`, both
validating against `SettingsSchema`. Neither is cross-field validated: each
defaults independently, so setting only one is legal (e.g. a non-standard
certificate name with certbot's default key path would be unusual but is
not Bellhop's to reject).

## ProxyContext (`src/lib/proxy/routes.ts`)

```text
ProxyContext {
  outpost?: { ip, port }          # unchanged
  externalPort: number            # unchanged (443)
  tls: {                          # NEW, always present
    certificatePath: string       # proxyTlsCertificate ?? /etc/letsencrypt/live/<domain>/fullchain.pem
    keyPath: string               # proxyTlsKey ?? /etc/letsencrypt/live/<domain>/privkey.pem
  }
}
```

Built only by `buildProxyContext(inventory)`. The Caddy driver's `render`
does not read `tls`, so its output is unchanged (FR-013).

## Driver registry

`PROXY_DRIVER_IDS` (`src/lib/proxy/ids.ts`) becomes `['caddy', 'nginx']`;
`DRIVERS` in `src/lib/proxy/index.ts` registers `nginxDriver`.

## nginxDriver (`src/lib/proxy/drivers/nginx.ts`)

| Property | Value |
| --- | --- |
| `id` | `'nginx'` |
| `capabilities` | `{ authModes: ['forward', 'oidc'], acmeDns01ViaCloudflare: false }` |
| `defaultConfigPath` | `/etc/nginx/conf.d/bellhop.conf` |
| `render(routes, ctx, configPath)` | one `FileSpec { path: configPath, mode: 'owned', content }` — see contracts/nginx-config.md |
| `validateCommand` | `nginx -t` (tests the whole tree as the service loads it; takes no path) |
| `reloadCommand` | `systemctl reload nginx` |
| `configFiles` | default (`[configPath]`) |

Built with the existing `fileDriver(...)`; no change to `file-driver.ts`.
