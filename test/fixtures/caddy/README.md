# Caddy admin-API fixtures

Captured from a real Caddy v2.10.2 built with `github.com/caddy-dns/cloudflare`
v0.2.4 (issue #26), run locally with example data only. Nothing here came from
a real deployment, so nothing needed redaction.

| File | How it was produced |
| --- | --- |
| `characterization-adapted.json` | `caddy adapt --adapter caddyfile` of the file-based Caddy driver's characterization block (`EXPECTED_LINES` in `test/lib/proxy/drivers/caddy.test.ts`, markers removed), pretty-printed. |
| `convert-adapted.json` | `caddy adapt` of a Caddyfile holding only one hand-authored site (`www.example.com { respond "hello" }`) -- what `convert-caddyfile` gets once the managed section is removed. |
| `get-config-empty.txt` | `curl -sS -D - http://localhost:2019/config/` against a Caddy with no configuration (CRLF headers, then the body). |
| `get-config-routes.txt` | The same after loading `convert-adapted.json`. |
| `patch-200.txt`, `patch-412.txt`, `patch-500.txt` | The driver's write command (`curl -X PATCH ... -w '\nBELLHOP_HTTP_STATUS=%{http_code}\n'`): a successful write, a stale `If-Match`, and a configuration Caddy refused to load. |

## TLS modes (issue #51)

Captured from the official Caddy v2.10.2 Windows release (no extra modules),
example data only. Each is `caddy adapt --adapter caddyfile --pretty` of the
same characterization block as `characterization-adapted.json`, with every
`tls { dns cloudflare ... }` clause replaced by the mode's clause.

| File | Clause per site |
| --- | --- |
| `tls-letsencrypt-adapted.json` | none (Caddy's automatic HTTPS) |
| `tls-internal-adapted.json` | `tls internal` |
| `tls-files-adapted.json` | `tls /etc/letsencrypt/live/example.com/fullchain.pem /etc/letsencrypt/live/example.com/privkey.pem` |
