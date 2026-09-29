# Quickstart: Validating the Caddy Admin-API Driver

## Automated

```bash
npm run typecheck
npm test            # includes test/lib/proxy/drivers/caddy-api.test.ts,
                    # test/lib/proxy/caddy-json.test.ts (adapter parity),
                    # test/commands/convert-caddyfile.test.ts
npm run web:build
```

What proves each requirement is in [plan.md](./plan.md) "Test map".

## Manual, against a real Caddy (no Proxmox needed)

This procedure runs the driver's real generated commands locally, against a
real Caddy built with `caddy-dns/cloudflare`, through a scratch
`SSHClient` that execs the command with `sh -c` instead of opening SSH.

1. Build or download Caddy with the Cloudflare module and start it from an
   empty directory with `CLOUDFLARE_API_TOKEN` set to any placeholder of
   plausible length: `caddy run`.
2. Seed a temp inventory from `test/lib/proxy/drivers/caddy.test.ts`'s
   characterization inventory with `proxyDriver: 'caddy-api'`.
3. Run `runSyncProxy({})`, then `{ apply: true }`, then `{ apply: true }`
   again. Expect the dry-run preview to list 7 adds; `GET /config/` to show
   7 `bellhop-route-*` routes and `bellhop-tls`; and the third run to report
   no changes.
4. Add an untagged route for `www.example.com` via the admin API, rerun:
   it's untouched and stays after Bellhop's routes.
5. Add an untagged route claiming `web.example.com`, rerun with apply:
   the conflict is reported, and every other route is still in place.
6. Change the config between plan and apply (a manual `PATCH`): apply
   fails with the "changed after it was read" message and nothing changes.
7. Conversion: write the characterization Caddyfile plus one hand-authored
   site to a temp path, and run `runConvertCaddyfile` against a fresh Caddy.
   The dry run lists the hand-authored server and 7 adds; apply loads it; a
   second conversion refuses.

Record the Caddy version and the results in the PR description
(constitution Principle III for code with no automated live test).
