# Contract: Rendering and Settings (issue #51)

## Caddyfile per-site TLS clause (`caddy` driver)

Placed where `TLS_BLOCK` is today (last lines of each site block):

| `proxyCaddyTls` | Lines |
|---|---|
| unset / `cloudflare` | `    tls {` / `        dns cloudflare {env.CLOUDFLARE_API_TOKEN}` / `        resolvers 1.1.1.1 8.8.8.8` / `    }` (unchanged) |
| `letsencrypt` | *(none)* |
| `internal` | `    tls internal` |
| `files` | `    tls <certificatePath> <keyPath>` — each path bare, or double-quoted when it contains whitespace, `"` or `\`; inside the quotes only `"` is escaped (as `\"`) and a backslash stays single, since `\"` is Caddy's only escape in a quoted token (a path ending in `\` can't be expressed) |

## Caddy JSON (`caddy-api` driver)

Each mode's Bellhop objects equal the corresponding objects in
`test/fixtures/caddy/{characterization,tls-internal,tls-files,tls-letsencrypt}-adapted.json`,
except: Bellhop objects carry the `@id`s in `data-model.md`, and the
certificate tag is `bellhop-cert` instead of `cert0`. Compared with
`canonicalJson` (key order ignored).

Preview lines (`formatCaddyPreview`) add, alongside the existing `tls policy`
lines:

```
+ tls certificate files: <certificatePath>
- tls certificate files
+ tls connection policy: <n> hostnames
~ tls connection policy: <n> hostnames
- tls connection policy
```

`CaddyChange.object` gains `'tls-files'` and `'tls-connection'`; the catch-all
`bellhop-tls-default` is reported as part of `tls-connection`, not separately.

## Traefik router TLS

| `proxyCertResolver` | Every router's `tls` |
|---|---|
| unset | `{ certResolver: cloudflare }` (unchanged) |
| `<name>` | `{ certResolver: <name> }` (unchanged) |
| `none` | `{}` |

## Cloudflare prune decision

`driver.capabilities.acmeDns01ViaCloudflare(inventory)`:

| Driver | Returns |
|---|---|
| `caddy`, `caddy-api` | `true` iff `proxyCaddyTls` is unset or `cloudflare` |
| `traefik` | `true` iff `proxyCertResolver` is not `none` |
| `nginx`, `nginx-proxy-manager`, `haproxy`, `none` | `false` |

When `false`, `syncProxyLive` logs the existing
`pruneAcmeDriverSkipMessage(driver.id)` line, whose text changes to:
`prune-acme-challenges: skipped, the '<id>' proxy driver is not configured to use ACME DNS-01 via Cloudflare`.

## `set-config` / Settings API

- `set-config proxyCaddyTls <cloudflare|letsencrypt|internal|files> [--apply]`;
  any other value is rejected by `SettingsSchema` with zod's enum message,
  identically on `PATCH /api/settings`.
- `GET`/`PATCH /api/settings` response gains:
  - `caddyTlsModes: ['cloudflare', 'letsencrypt', 'internal', 'files']`
  - `defaultCaddyTls: 'cloudflare'`
  - `proxyDrivers[].usesCaddyTls: boolean`

## Settings page

- "Caddy TLS" `<select>`, shown iff the selected driver's `usesCaddyTls`;
  options in `caddyTlsModes` order, the default labelled `cloudflare (default)`;
  value shown = draft, else stored, else default. Disabled with Save disabled
  until the response has loaded.
- Proxy TLS certificate/key fields shown iff `usesSharedCertificate`, or
  `usesCaddyTls` and the shown Caddy TLS value is `files`.
- Hiding either never edits the stored value.
