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

## Certificate modes

How Caddy obtains a certificate for each site is the `proxyCaddyTls`
setting (issue #51), read by both this driver and the [admin-API
driver](caddy-api.md):

```bash
bellhop set-config proxyCaddyTls letsencrypt --apply
```

| Mode | What Caddy does | What it needs |
|---|---|---|
| unset / `cloudflare` (the default) | Issues its own certificate via DNS-01 with Cloudflare | A Caddy build carrying the `caddy-dns/cloudflare` module, and `CLOUDFLARE_API_TOKEN` set in Caddy's own environment (Bellhop never sets it — the Caddyfile references `{env.CLOUDFLARE_API_TOKEN}`) |
| `letsencrypt` | No TLS clause at all — Caddy's own automatic HTTPS obtains a certificate via a public HTTP-01/TLS-ALPN-01 challenge | Ports 80 and 443 reachable from the internet for each hostname |
| `internal` | `tls internal` — every site is served from Caddy's own internal (self-signed) CA | That CA's root certificate trusted on whatever clients connect — Caddy prints it on first run, or export it with `caddy trust` |
| `files` | `tls <certificate> <key>` — every site is served from one shared certificate/key pair | The `proxyTlsCertificate`/`proxyTlsKey` settings (same pair the [nginx driver](nginx.md) uses); unset defaults to certbot's own path for the inventory domain, `/etc/letsencrypt/live/<domain>/fullchain.pem`/`.../privkey.pem` |

Switching between any two modes needs only the setting change and one
`sync-proxy --apply` — there's no manual cleanup of Caddy's own
configuration either way. A certificate Caddy already obtained under an
old mode (`cloudflare`'s DNS-01 certificate, say) stays in its storage
unused; nothing deletes it. A mode `caddy validate` can catch —
`cloudflare` on a Caddy build without the Cloudflare module, or `files`
naming a certificate/key pair that doesn't exist on the proxy host —
fails through the existing validate-and-restore path: validation rejects
it, the previous Caddyfile is restored, and Caddy's own error is reported.
Bellhop never checks a `files`-mode path in advance.

### File permissions in `files` mode

The packaged Caddy service runs as the `caddy` user, but Bellhop runs
`caddy validate` as root — so in `files` mode a certificate or key the
`caddy` user can't read **passes validation and then fails at `systemctl
reload caddy`**. By then the file driver has already disarmed its restore
step and deleted its backup, so that failure is **not rolled back**: the
new Caddyfile stays on disk, Caddy keeps serving its old configuration
until its next restart, and that restart then fails. certbot's defaults
hit exactly this — `/etc/letsencrypt/live` is mode `0700` and the private
key `0600`, both owned by root.

Make the pair readable by `caddy` before switching to `files`. One way is a
certbot deploy hook that copies the renewed files somewhere Caddy owns:

```bash
mkdir -p /etc/caddy/certs
cat > /etc/letsencrypt/renewal-hooks/deploy/caddy.sh <<'EOF'
#!/bin/sh
install -o caddy -g caddy -m 0640 "$RENEWED_LINEAGE/fullchain.pem" /etc/caddy/certs/fullchain.pem
install -o caddy -g caddy -m 0600 "$RENEWED_LINEAGE/privkey.pem" /etc/caddy/certs/privkey.pem
systemctl reload caddy
EOF
chmod +x /etc/letsencrypt/renewal-hooks/deploy/caddy.sh
RENEWED_LINEAGE=/etc/letsencrypt/live/example.com /etc/letsencrypt/renewal-hooks/deploy/caddy.sh   # run it once now
bellhop set-config proxyTlsCertificate /etc/caddy/certs/fullchain.pem --apply
bellhop set-config proxyTlsKey /etc/caddy/certs/privkey.pem --apply
```

Granting a group the `caddy` user belongs to read access to the certbot
directories (and the key) works too. Either way, check with
`sudo -u caddy cat <path> >/dev/null` for both files before the first
`sync-proxy --apply` in `files` mode.

### Stale ACME challenge records

Stale `_acme-challenge` records that `cloudflare`-mode issuance leaves
behind are cleaned up by `prune-acme-challenges` and the web UI's
push-live step once `data/cloudflare-api.env` is set — see
[Environment variables](../environment-variables.md). The other three
modes never touch Cloudflare's DNS at all, so that cleanup is skipped for
them (and the web UI's push-live step logs why) — see [Reverse proxy
drivers](README.md). The decision follows `proxyCaddyTls` alone: if you
issue through Cloudflare DNS-01 some other way in `letsencrypt` mode — a
global `acme_dns cloudflare` option in your own Caddyfile, or (admin-API
driver) your own catch-all automation policy — Bellhop can't tell and
skips the prune. Use `cloudflare` mode if you want the prune.

The status page is opt-in through the `statusPagePath` setting, for example:

```bash
bellhop set-config statusPagePath /usr/share/caddy/index.html --apply
```

Switching to another driver leaves the Caddyfile's `bellhop-managed`
section in place, still valid, for you to retire by hand — see
[nginx driver](nginx.md).
