# Quickstart: validating TLS Without Cloudflare (issue #51)

All steps use a temporary inventory (`INVENTORY_FILE`), never the real one, and
dry runs only — nothing here touches a real proxy.

## 1. Automated checks

```bash
npm run typecheck
npm test
npm run web:build
```

The parity tests in `test/lib/proxy/caddy-json.test.ts` compare each mode
against the captured adapter fixtures (`contracts/rendering-and-settings.md`).

## 2. CLI dry runs per Caddy mode

```bash
export INVENTORY_FILE=<tmp>/bellhop.db   # seeded from inventory/hosts.yaml.example
npm run bellhop -- set-config proxyCaddyTls internal --apply
npm run bellhop -- sync-proxy            # each site ends with "tls internal"
npm run bellhop -- set-config proxyCaddyTls files --apply
npm run bellhop -- sync-proxy            # "tls /etc/letsencrypt/live/<domain>/fullchain.pem …"
npm run bellhop -- set-config proxyCaddyTls letsencrypt --apply
npm run bellhop -- sync-proxy            # no tls clause at all
npm run bellhop -- set-config proxyCaddyTls bogus --apply   # rejected
npm run bellhop -- set-config proxyCaddyTls --unset --apply
npm run bellhop -- sync-proxy            # identical to before the feature
```

Repeat the `sync-proxy` steps with `proxyDriver traefik` and
`proxyCertResolver none`: every router shows `tls: {}`.

## 3. Optional: real Caddy check

With a stock Caddy v2.10.x on PATH, `caddy adapt --adapter caddyfile` of the
`internal`/`letsencrypt` previews succeeds, and `caddy validate` of the `files`
preview fails only on the missing certificate path (research R5).

## 4. Settings page (desktop and ≤640px)

`npm run demo`, open Settings:
- Caddy / Caddy (admin API): the Caddy TLS dropdown shows `cloudflare (default)`.
- Choose `files` (unsaved): the Proxy TLS certificate/key fields appear;
  choose `internal`: they disappear.
- nginx: no Caddy TLS dropdown, certificate fields shown as before.
- Traefik: no Caddy TLS dropdown.
