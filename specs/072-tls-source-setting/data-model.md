# Data Model: TLS source (#72)

## Settings (meta rows, `SettingsSchema` in `src/lib/inventory.ts`)

| Key | Type | Unset means | Status |
|---|---|---|---|
| `tlsSource` | enum `TLS_SOURCES` = `acme-dns`, `acme-http`, `internal`, `files`, `external` | the active driver's `defaultTlsSource` | **new** |
| `acmeDnsProvider` | enum `ACME_DNS_PROVIDERS` = `cloudflare` | `cloudflare` (`DEFAULT_ACME_DNS_PROVIDER`) | **new** |
| `proxyCaddyTls` | — | — | **removed** (migrated, R2) |
| `proxyCertResolver` | string `^[A-Za-z0-9_-]+$` | `cloudflare` | kept; `none` no longer reserved |
| `proxyTlsCertificate` / `proxyTlsKey` | absolute path | certbot path for `domain` | kept; read under `files` |

Both new keys are validated only as enums on load and write. Whether the
active driver supports `tlsSource` is checked only when configuration is
produced (`checkTlsSource`).

`TLS_SOURCES`, `TlsSource`, `ACME_DNS_PROVIDERS`, `AcmeDnsProvider` and
`DEFAULT_PROXY_DRIVER_ID` live in the dependency-free `src/lib/proxy/ids.ts`.
`CADDY_TLS_MODES`/`CaddyTlsMode` are removed.

## Driver TLS capability (`DriverCapabilities` in `src/lib/proxy/driver.ts`)

```text
capabilities: {
  authModes: ProxyAuthMode[];
  tlsSources: TlsSource[];        // replaces acmeDns01ViaCloudflare
  defaultTlsSource: TlsSource;    // must be in tlsSources
}
```

| Driver | `tlsSources` | `defaultTlsSource` |
|---|---|---|
| `caddy`, `caddy-api` | acme-dns, acme-http, internal, files | acme-dns |
| `traefik` | acme-dns, acme-http, files, external | acme-dns |
| `nginx` | files | files |
| `nginx-proxy-manager` | acme-http | acme-http |
| `haproxy` | external | external |
| `none` | all five | external |

Removed `ReverseProxyDriver` hints: `usesCaddyTls`, `usesSharedCertificate`.
Kept: `usesCertResolver`, `usesApiUrl`, `usesNpmApi`, `configPathNote`.

## `ProxyContext` (`src/lib/proxy/routes.ts`)

```text
outpost?, externalPort, tls: { certificatePath, keyPath }, certResolver: string,
tlsSource: TlsSource,               // effective, replaces caddyTls
acmeDnsProvider: AcmeDnsProvider    // resolved, default cloudflare
```

`buildProxyContext(inventory, driver)`.

## Derived values (`src/lib/proxy/tls.ts`)

- `effectiveTlsSource(inventory, driver) = inventory.tlsSource ?? driver.capabilities.defaultTlsSource`
- `acmeDnsProvider(inventory) = inventory.acmeDnsProvider ?? DEFAULT_ACME_DNS_PROVIDER`
- `checkTlsSource(inventory, driver): string | null` — message when the effective source is not in `tlsSources`
- `usesCloudflareDns01(inventory, driver)` — `acme-dns` && `cloudflare`

## Legacy conversion (`src/lib/proxy/legacy-tls.ts`)

```text
convertLegacyTlsSettings({ proxyDriver?, proxyCaddyTls?, proxyCertResolver?, tlsSource? })
  -> { tlsSource?: TlsSource; remove: Array<'proxyCaddyTls' | 'proxyCertResolver'> }
```

| Active driver | Legacy value | Writes `tlsSource` (if unset) | Removes |
|---|---|---|---|
| caddy / caddy-api / unset | proxyCaddyTls cloudflare / letsencrypt / internal / files | acme-dns / acme-http / internal / files | proxyCaddyTls |
| traefik | proxyCertResolver none | external | proxyCertResolver |
| any other | proxyCaddyTls any | — | proxyCaddyTls |
| any other than traefik | proxyCertResolver none | — | proxyCertResolver |
| any | proxyCertResolver named | — | — |

State transition: a database holding legacy rows converts once, on the first
open by this version; after that it holds none, so later opens change nothing
and log nothing.
