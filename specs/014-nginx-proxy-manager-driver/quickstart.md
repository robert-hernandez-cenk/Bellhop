# Quickstart: validating the Nginx Proxy Manager driver

## 1. Automated checks

```bash
npm run typecheck
npm test
npm run web:build
```

The driver, client and settings tests use a fake `NpmClient` and stubbed
`fetch` over `test/fixtures/nginx-proxy-manager/` — no network.

## 2. Throwaway NPM instance (WSL/Linux with Docker)

```bash
docker run -d --name bellhop-npm-test \
  -v bellhop-npm-data:/data -v bellhop-npm-le:/etc/letsencrypt \
  -p 18080:80 -p 18081:81 -p 18443:443 jc21/nginx-proxy-manager:latest
curl -s http://localhost:18081/api/          # {"status":"OK","setup":false,...}
# First admin (only while setup is false):
curl -s -XPOST localhost:18081/api/users -H 'content-type: application/json' \
  -d '{"name":"Admin","nickname":"admin","email":"admin@example.com","roles":["admin"],"is_disabled":false,"auth":{"type":"password","secret":"changeme-long-password"}}'
```

Upload a self-signed `*.example.test` certificate in NPM (SSL Certificates
-> Add -> Custom) so no Let's Encrypt request is needed.

## 3. Temp inventory and credentials

Build a temp `bellhop.db` (any test's `saveInventory` pattern) with
`domain: example.test`, a `proxy: true` host, and guests whose `ip` points at
something reachable from inside the container (e.g. `127.0.0.1`, port 81 —
NPM's own admin UI) — one ungated, one forward-gated with
`unauthenticatedPaths: ['/api/*', '/health']`, plus an `authentik: true`
entry. Then, in a scratch `data/` dir:

```text
NPM_API_URL=http://localhost:18081
NPM_API_EMAIL=admin@example.com
NPM_API_PASSWORD=changeme-long-password
```

## 4. Scenarios

| # | Do | Expect |
|---|---|---|
| a | `set-config proxyDriver nginx-proxy-manager --apply`; `sync-proxy` | preview lists `+ create` per route with the wildcard certificate; NPM unchanged |
| b | `sync-proxy --apply` | hosts created, marked, `online: true`; `curl -k --resolve app.example.test:18443:127.0.0.1 https://app.example.test:18443/` -> 200 |
| c | `sync-proxy` again | `No changes` |
| d | gated host: `/`, `/api/x`, `/health` | `/` goes through auth_request (302 to sign-in with a stub outpost returning 401); exempt paths reach the backend |
| e | change a guest's port, re-sync | `~ update ... forward_port, advanced_config`; applied in place (same id) |
| f | hand-create an NPM host for a route hostname, re-sync | `! conflict` in preview; apply changes the rest, then exits non-zero naming it; the hand-made host is unchanged |
| g | remove a guest's subdomains, re-sync | `- delete` for its host |
| h | edit a Bellhop host's advanced_config in NPM to an invalid directive | next sync restores it (drift) |
| i | wrong password in env | error names the URL and both variables |
| j | Settings page, select Nginx Proxy Manager, desktop + 390px width | config path, status page and TLS fields hidden |
| k | `render-status-page` | "serves no status page" error |

## 5. First real use (not automatable here)

- A Let's Encrypt request for a publicly reachable hostname succeeds, and a
  real `letsencrypt` certificate row matches the schema (research R8).
- A forward-gated site against a real Authentik outpost signs in and
  receives the `X-authentik-*` headers.

## 6. Cleanup

```bash
docker rm -f bellhop-npm-test; docker volume rm bellhop-npm-data bellhop-npm-le
```
