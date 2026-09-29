# Quickstart: validating the Traefik driver

## Automated

```sh
npm run typecheck
npm test            # includes test/lib/proxy/drivers/traefik.test.ts and the
                    # executed-script cases in test/lib/proxy/file-driver.test.ts
npm run web:build
```

## Against a local Traefik (no infrastructure needed)

1. Download a Traefik v3 release binary into a scratch directory, and write
   a static configuration with:
   - a `websecure` entry point on a high loopback port;
   - `api.insecure: true` (API on `:8080`);
   - `providers.file.directory: <scratch>/dyn` with `watch: true`;
   - an ACME resolver named `cloudflare` whose `caServer` points at an
     unreachable address, so no real issuance is attempted.
2. Render the file for an example inventory. That inventory should have one
   ungated entry, one forward-gated entry with `/health` and `/api/*`
   exempt and `insecureBackendTls`, and one OIDC entry. Render it with the
   driver's `plan()` (for example through `sync-proxy` against a temp
   `INVENTORY_FILE` fixture) and copy the previewed file into
   `<scratch>/dyn/bellhop.yml`.
3. Expect `GET /api/http/middlewares/bellhop-generation-<hash>@file` to
   return 200, and `GET /api/http/routers/<name>@file` to report
   `"status":"enabled"` for every router in the file.
4. Run the generated apply script's validate block against this Traefik
   (under `sh`, with `proxyApiUrl` `http://127.0.0.1:8080`), and check two
   cases:
   - An unchanged file passes.
   - A file with a broken router, such as an entry point renamed to
     `nosuch`, fails with that router named and the previous file restored.

## Settings page (browser, desktop and a viewport no wider than 640px)

1. Start the dev web UI against a temp inventory.
2. On Settings, select **Traefik**. Proxy cert resolver and Proxy API URL
   appear, with placeholders `cloudflare` and `http://127.0.0.1:8080`. The
   config path placeholder is `/etc/traefik/dynamic/bellhop.yml`. Status
   page path and the TLS fields are hidden.
3. Select **Caddy**. The two Traefik fields are hidden, and their saved
   values are still there when you switch back.
4. Saving `ftp://x` as Proxy API URL is rejected with the schema message.
