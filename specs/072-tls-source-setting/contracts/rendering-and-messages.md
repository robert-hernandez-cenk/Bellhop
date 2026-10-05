# Contract: rendering, refusals and log lines (#72)

## Rendering by effective TLS source

### Caddy (Caddyfile, per site block, last clause)

| `tlsSource` | Clause (byte-identical to the old mode) |
|---|---|
| `acme-dns` + `cloudflare` | `CLOUDFLARE_TLS_BLOCK` (old `cloudflare`) |
| `acme-http` | none (old `letsencrypt`) |
| `internal` | `    tls internal` |
| `files` | `    tls <cert> <key>` (`caddyfileToken`-quoted) |
| `external` | unreachable: refused by `checkTlsSource`; the renderer throws a programming error |

### Caddy admin API (`renderTlsObjects`, `planCaddyConfig`)

Same mapping as the Caddyfile: `acme-dns` → the Cloudflare DNS-01 automation
policy; `internal` → internal-issuer policy; `files` → `load_files` +
connection policy; `acme-http` → nothing. "Writes an automation policy"
(conflict detection) is true for `acme-dns` and `internal`. The existing
`test/fixtures/caddy/*-adapted.json` parity fixtures stay unchanged.

### Traefik

| `tlsSource` | Every router's `tls` | Top-level `tls:` |
|---|---|---|
| `acme-dns`, `acme-http` | `{ certResolver: <proxyCertResolver ?? 'cloudflare'> }` | none |
| `external` | `{}` (old `proxyCertResolver: none`) | none |
| `files` | `{}` | `certificates: [{ certFile: ctx.tls.certificatePath, keyFile: ctx.tls.keyPath }]` |
| `internal` | unreachable (refused; renderer throws) | — |

### nginx, Nginx Proxy Manager, HAProxy

Output unchanged; their single supported source is their default.

## Refusal (`checkTlsSource`, thrown by `runSyncProxy` and `convert-caddyfile`)

```text
tlsSource 'internal' is not supported by the 'nginx' proxy driver (it supports: files) -- run: bellhop set-config tlsSource files --apply, or set it on the web UI's Settings page
```

- Raised before `driverDeps`, `buildRoutes`, any preview, or any SSH call;
  dry run and `--apply` alike.
- Not raised for the `none` driver (the `managesProxy` short-circuit runs
  first), on load, on `set-config`, on Settings PATCH, or by
  `commitGuestEdit`'s capability check.

## Prune skip line (`pruneAcmeChallengesLive`)

```text
prune-acme-challenges: skipped, the TLS source is 'acme-http' (only acme-dns with the cloudflare DNS provider leaves challenge records)
```

When the source is `acme-dns` and the provider `cloudflare`, the existing
Cloudflare-credentials check and prune run unchanged.

## Migration log line (`openInventoryDb`, only when something changed)

```text
Migrated TLS settings to tlsSource (#72, one-time, irreversible): <details>
```

`<details>` names the converted value (e.g. `proxyCaddyTls 'letsencrypt' -> tlsSource 'acme-http'`)
and the removed keys. Never logged for a database with no legacy rows.
