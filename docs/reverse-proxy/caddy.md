# Caddy driver

Caddy is the default driver: with `proxyDriver` unset, `sync-proxy` uses it.
Everything the drivers share (how a driver is chosen, the dry run, backup
and restore on a failed validate, capability checks) is described in
[Reverse proxy drivers](README.md). To run Caddy from its admin API rather
than a Caddyfile, see the [Caddy (admin API) driver](caddy-api.md).

Its configuration file defaults to `/etc/caddy/Caddyfile` (override with
`proxyConfigPath` — see
[Inventory-wide settings](../configuration.md#inventory-wide-settings)).
It is a file-configured driver that replaces a managed section while leaving
everything else on the file untouched: only the `bellhop-managed` section
is Bellhop's, and the rest of the Caddyfile stays yours.

Caddy issues its own certificates via Cloudflare DNS-01 with no extra setup.
Stale `_acme-challenge` records that issuance leaves behind are cleaned up
by `prune-acme-challenges` and the web UI's push-live step once
`data/cloudflare-api.env` is set — see
[Environment variables](../environment-variables.md).

The status page is opt-in through the `statusPagePath` setting, for example:

```bash
bellhop set-config statusPagePath /usr/share/caddy/index.html --apply
```

Switching to another driver leaves the Caddyfile's `bellhop-managed`
section in place, still valid, for you to retire by hand — see
[nginx driver](nginx.md).
