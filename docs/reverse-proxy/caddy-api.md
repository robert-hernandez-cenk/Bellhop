# Caddy (admin API) driver

Select it with `bellhop set-config proxyDriver caddy-api --apply` (or the
Settings page, where it's listed as "Caddy (admin API)"). It serves exactly
what the [Caddy driver](caddy.md) serves: the same hostnames, backends,
`X-Forwarded-Port` header, untrusted-backend-TLS setting, Authentik
forward-auth with `unauthenticatedPaths`, and the same four TLS sources
(issue #72's `tlsSource`: unset/`acme-dns` the default; `acme-http`;
`internal`; `files`; see [Caddy driver](caddy.md#tls-sources) for what
each needs). The difference is how it gets there. Instead of writing a
section of a Caddyfile and reloading, it changes Caddy's live JSON
configuration through Caddy's admin API.

## How it works

- **Reached over SSH.** Every admin call runs `curl` against
  `http://localhost:2019` on the proxy host (the `proxy: true` entry), so
  the admin endpoint is never exposed to the network.
- **Only Bellhop's objects.** Bellhop tags everything it creates with an
  `@id` starting with `bellhop-`: one route per subdomain-bearing entry
  (`bellhop-route-<hostname>`) and, per the effective `tlsSource` (see
  [TLS sources](#tls-sources) below), zero or more TLS objects.
  Untagged objects are yours, and `sync-proxy` never
  changes, moves, or removes them.
- **Placement.** Bellhop's routes go first in the one server listening on
  port 443, so a catch-all route of your own can't shadow them. On an empty
  Caddy, Bellhop creates that server (`srv0` on `:443`). If more than one
  server listens on 443, or none does while other servers exist,
  `sync-proxy` stops and names them.
- **Conflicts.** If an untagged route or TLS policy already names one of an
  entry's hostnames exactly, that entry is left out and reported. Every
  other change is still applied, and then the sync fails with one line per
  conflict. Remove or change the hand-authored object, or mark the entry
  `proxyManual`. Wildcard hosts (`*.example.com`) are not conflicts, because
  Bellhop's exact-host routes come first.
- **All or nothing.** `sync-proxy` reads the configuration and its version
  (`Etag`), then writes the whole new configuration in one conditional
  request. If Caddy rejects it, the previous configuration keeps running
  and the error is Caddy's own. If anything changed the configuration in
  between, nothing is written; run the sync again.
- **No reload, no file of record.** Changes are live as soon as they're
  written. There's no human-readable file to read or diff anymore. Read the
  configuration with `curl localhost:2019/config/` on the proxy host, or on
  the status page, whose "Deployed proxy configuration" section shows it
  pretty-printed.

## TLS sources

`tlsSource` (unset means `acme-dns`; see
[Caddy driver](caddy.md#tls-sources) for what each source needs) decides
which Bellhop-tagged TLS objects this driver writes into Caddy's live
configuration, reconciled the same way as routes — stripped and rebuilt
from the current source on every sync, never touching an object Bellhop
didn't tag. `external` is refused, as for the Caddy driver:

| `tlsSource` | Bellhop-tagged objects |
|---|---|
| unset / `acme-dns` | One automation policy, `bellhop-tls` (ACME issuer: DNS-01 through the `acmeDnsProvider`, `cloudflare`) |
| `acme-http` | None — Caddy's own automatic HTTPS handles it |
| `internal` | One automation policy, `bellhop-tls` (issuer: Caddy's internal CA) |
| `files` | A `load_files` certificate entry (`bellhop-tls-files`), a connection policy selecting it (`bellhop-tls-connection`), and — only when the target server has no untagged catch-all connection policy already — a catch-all `bellhop-tls-default` |

**An operator automation policy with no `subjects` (a catch-all) is
intended to apply to Bellhop's hostnames under `acme-http` and `files`**,
since Bellhop writes no automation policy of its own under either —
this is the one exception to "nothing untagged is ever touched": under
`acme-dns`/`internal`, an untagged policy naming a Bellhop hostname
is a conflict the same way an untagged route is, but under `acme-http`/
`files` it isn't, because there's no Bellhop policy for it to
collide with.

Under `files` the certificate and key must be readable by the user Caddy
runs as (`caddy` for the packaged `caddy-api.service`), not just by root —
certbot's defaults are root-only. See [File permissions with
`files`](caddy.md#file-permissions-with-files) for a recipe; with this
driver, end the deploy hook with `systemctl restart caddy-api` instead of
`systemctl reload caddy` (that unit is the Caddyfile service; `caddy-api`
resumes its autosaved configuration on restart, re-reading the files). A pair Caddy can't read surfaces as Caddy rejecting the `PATCH
/config/` load: nothing is written, Caddy keeps its previous
configuration, and `sync-proxy --apply` reports Caddy's own error.

Stale `_acme-challenge` cleanup follows `tlsSource` alone, the same as
for the Caddy driver: Cloudflare DNS-01 issued some other way (your own
catch-all automation policy under `acme-http`) isn't detected, so use
`acme-dns` if you want the prune — see [Stale ACME challenge
records](caddy.md#stale-acme-challenge-records).

## Prerequisites

- **Caddy 2.6 or newer**, any build — **with the Cloudflare DNS module**
  only if `tlsSource` is unset or `acme-dns` (the Caddy drivers'
  default); the other three sources need no extra module.
- **`curl` on the proxy host.**
- **Caddy running from its API-configured service, not a Caddyfile.** The
  packaged `caddy.service` runs Caddy from `/etc/caddy/Caddyfile`, and its
  reload re-reads that file, discarding every change made through the API.
  The packaged `caddy-api.service` instead runs `caddy run --environ
  --resume`, which restores the last configuration Caddy autosaved. While
  `caddy.service` is active, `sync-proxy` refuses to run, in both dry run
  and `--apply`, and says how to switch.
- **`CLOUDFLARE_API_TOKEN` in `caddy-api.service`'s environment** — only
  under `acme-dns`. A
  `systemctl edit caddy` override applies to `caddy.service` only, so copy
  it with `systemctl edit caddy-api`. Bellhop never writes the token itself;
  its TLS policy references `{env.CLOUDFLARE_API_TOKEN}`, exactly as the
  Caddyfile driver's `tls` block does.

## Switching from the Caddy driver

`convert-caddyfile` does the conversion once, with Caddy's own adapter:

```bash
bellhop convert-caddyfile           # dry run: what's kept from the Caddyfile, and the Bellhop routes it would add
bellhop convert-caddyfile --apply   # loads the result into the running Caddy
```

It reads the Caddyfile on the proxy host. By default that is the
`proxyConfigPath` setting while the Caddy driver is active, otherwise
`/etc/caddy/Caddyfile`; pass `--caddyfile <path>` to choose another. It
drops Bellhop's managed section, converts everything else with `caddy
adapt`, adds the inventory's routes as Bellhop-tagged ones, and loads the
result. Hostname conflicts are reported the same way `sync-proxy` reports
them. The Caddyfile itself is left unchanged, as a fallback. It works
while `caddy.service` is still running, since that's where you start
from. Once Caddy holds Bellhop objects, it refuses to run again, so an
old Caddyfile can never overwrite a live configuration. From then on,
`sync-proxy` is the way to update it.

Then finish the switch:

```bash
# on the proxy host:
systemctl disable --now caddy && systemctl enable --now caddy-api
# where you run Bellhop:
bellhop set-config proxyDriver caddy-api --apply
bellhop sync-proxy   # expect "No changes"
```

Your hand-authored sites (a landing page, the status page's site block,
`proxyManual` entries' blocks) survive as untagged routes. Edit them from
then on through the admin API, or with your own tooling, not the old
Caddyfile.

## Switching away

Changing `proxyDriver` doesn't touch Caddy. To go back to the Caddyfile
driver, re-enable `caddy.service` (whose Caddyfile still holds your
hand-authored sites) and disable `caddy-api.service`. To keep Caddy on the
API but stop Bellhop managing it, delete the `bellhop-` objects yourself,
for example `curl -X DELETE localhost:2019/id/bellhop-tls`.

## Limits

- The admin address is fixed at `localhost:2019`, Caddy's default.
- Caddy must run under systemd with the packaged unit names
  (`caddy.service` is what the Caddyfile check looks for).
- When the proxy host is a guest, the whole configuration travels as one
  command argument, and Linux caps a single argument at 128 KiB. A
  forward-gated route is about 2.5 KiB of JSON, so this only matters for a
  very large configuration.
