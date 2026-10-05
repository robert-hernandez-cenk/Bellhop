# Quickstart: validating the TLS source setting (#72)

All commands run from the worktree root against a temporary fixture
(`INVENTORY_FILE`), never the real inventory.

## Automated

```bash
npm run typecheck
npm test
npm run web:build
```

Key suites: `test/lib/proxy/tls.test.ts`, `test/lib/proxy/legacy-tls.test.ts`,
`test/lib/inventory.test.ts` (migration), `test/lib/proxy/drivers/*.test.ts`
(rendering per source), `test/commands/sync-proxy.test.ts` (refusal),
`test/web/proxy-sync.test.ts` (prune decision), `test/web/routes/settings.test.ts`,
`test/web-client/settings-display.test.ts`.

## CLI walk-through (fixture)

1. Seed a fixture: `npm run bellhop -- import-yaml-inventory --yaml-path inventory/hosts.yaml.example --db-path <tmp>/bellhop.db --apply`, then `export INVENTORY_FILE=<tmp>/bellhop.db`.
2. `npm run bellhop -- sync-proxy` — Caddy, unset `tlsSource`: every block ends with the Cloudflare `tls { dns cloudflare ... }` clause.
3. `npm run bellhop -- set-config tlsSource acme-http --apply`, then `sync-proxy` — no TLS clause.
4. `npm run bellhop -- set-config proxyDriver nginx --apply`, then `sync-proxy` — refused: `tlsSource 'acme-http' is not supported by the 'nginx' proxy driver (it supports: files) -- to use its default (files), run: bellhop set-config tlsSource --unset --apply, or set it on the web UI's Settings page`.
5. `npm run bellhop -- set-config tlsSource --unset --apply`, then `sync-proxy` — nginx preview with `ssl_certificate` lines.
6. `set-config proxyDriver traefik` + `set-config tlsSource files` — preview has routers with `tls: {}` and a top-level `tls.certificates` entry.

## Migration (fixture)

Insert `proxyCaddyTls = letsencrypt` directly into the fixture's `meta`
table, run any command (e.g. `sync-proxy`): one migration log line, the row
replaced by `tlsSource = acme-http`, output identical to step 3. Run again:
no log line.

## Web UI (`npm run demo`)

Settings → Proxy, at desktop width and at ≤640px:

- Caddy: TLS source lists `acme-dns (default)`, `acme-http`, `internal`, `files`; `acme-dns` shows ACME DNS provider; `files` shows certificate/key.
- Traefik: `acme-http` shows Proxy cert resolver; `external` hides it.
- With `internal` drafted, switch the driver dropdown to nginx: warning `The nginx driver does not support 'internal'. It supports: files.`
- No proxy: no TLS fields.

Regenerate `docs/images/settings-proxy-driver.png` with `npm run docs:screenshots` and check it shows example values only.

## Not verifiable here

Traefik actually serving a certificate from `tls.certificates` needs a real
Traefik instance — operator hand-check (dynamic file written, `curl -v
https://<site>` shows the supplied certificate).
