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

## TLS sources

How Caddy obtains a certificate for each site is the driver-independent
`tlsSource` setting (issue #72; it replaced the Caddy-only
`proxyCaddyTls` of issue #51), read by both this driver and the
[admin-API driver](caddy-api.md). Both Caddy drivers support `acme-dns`,
`acme-http`, `internal` and `files`; `external` is refused — see
[TLS sources](README.md#tls-sources) for every driver.

```bash
bellhop set-config tlsSource acme-http --apply
```

| `tlsSource` | What Caddy does | What it needs |
|---|---|---|
| unset / `acme-dns` (the default) | Issues its own certificate via DNS-01 with the `acmeDnsProvider` (`cloudflare`, the default and only one) | A Caddy build carrying the `caddy-dns/cloudflare` module, and `CLOUDFLARE_API_TOKEN` set in Caddy's own environment (Bellhop never sets it — the Caddyfile references `{env.CLOUDFLARE_API_TOKEN}`) |
| `acme-http` | No TLS clause at all — Caddy's own automatic HTTPS obtains a certificate via a public HTTP-01/TLS-ALPN-01 challenge | Ports 80 and 443 reachable from the internet for each hostname |
| `internal` | `tls internal` — every site is served from Caddy's own internal (self-signed) CA | That CA's root certificate trusted on whatever clients connect — Caddy prints it on first run, or export it with `caddy trust` |
| `files` | `tls <certificate> <key>` — every site is served from one shared certificate/key pair | The `proxyTlsCertificate`/`proxyTlsKey` settings (same pair the [nginx driver](nginx.md) uses); unset defaults to certbot's own path for the inventory domain, `/etc/letsencrypt/live/<domain>/fullchain.pem`/`.../privkey.pem` |

Each source renders exactly the Caddyfile clause the matching old
`proxyCaddyTls` mode did (`cloudflare` → `acme-dns`, `letsencrypt` →
`acme-http`, `internal` and `files` unchanged), so a deployment moving
to `tlsSource` sees no change in its Caddyfile. On upgrade a stored
`proxyCaddyTls: cloudflare` (the old default) just leaves `tlsSource`
unset, which already means `acme-dns` here; the other modes are written
as an explicit `tlsSource`.

Switching between any two sources needs only the setting change and one
`sync-proxy --apply` — there's no manual cleanup of Caddy's own
configuration either way. A certificate Caddy already obtained under an
old source (`acme-dns`'s DNS-01 certificate, say) stays in its storage
unused; nothing deletes it. A source `caddy validate` can catch —
`acme-dns` on a Caddy build without the Cloudflare module, or `files`
naming a certificate/key pair that doesn't exist on the proxy host —
fails through the existing validate-and-restore path: validation rejects
it, the previous Caddyfile is restored, and Caddy's own error is reported.
Bellhop never checks a `files` path in advance.

### File permissions with `files`

The packaged Caddy service runs as the `caddy` user, but Bellhop runs
`caddy validate` as root — so under `files` a certificate or key the
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
`sync-proxy --apply` with `files`.

### Stale ACME challenge records

Stale `_acme-challenge` records that `acme-dns` issuance leaves
behind are cleaned up by `prune-acme-challenges` and the web UI's
push-live step once the `cloudflareDnsApiToken` setting is set — see
[Integration settings and secrets](../configuration.md#integration-settings-and-secrets). The other three
sources never touch Cloudflare's DNS at all, so that cleanup is skipped for
them (and the web UI's push-live step logs why) — see [Reverse proxy
drivers](README.md). The decision follows `tlsSource` alone: if you
issue through Cloudflare DNS-01 some other way under `acme-http` — a
global `acme_dns cloudflare` option in your own Caddyfile, or (admin-API
driver) your own catch-all automation policy — Bellhop can't tell and
skips the prune. Use `acme-dns` if you want the prune.

The status page is opt-in through the `statusPagePath` setting, for example:

```bash
bellhop set-config statusPagePath /usr/share/caddy/index.html --apply
```

Switching to another driver leaves the Caddyfile's `bellhop-managed`
section in place, still valid, for you to retire by hand — see
[nginx driver](nginx.md).
