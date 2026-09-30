# Contract: Commands, Remote Calls, and Messages

Exact behavior the tests pin. `<host>` is the `proxy: true` entry's name.

## Remote commands (run on the proxy host via `runRemote`, POSIX `sh`)

**Read for sync (`plan`)**

```sh
if systemctl is-active --quiet caddy.service 2>/dev/null; then exit 3; fi
command -v curl >/dev/null 2>&1 || exit 4
curl -sS -D - http://localhost:2019/config/
```

**Read for snapshot / conversion**: the same, without the `systemctl`
line.

**Write (`apply`, conversion `--apply`)**

```sh
command -v curl >/dev/null 2>&1 || exit 4
curl -sS -X PATCH -H 'Content-Type: application/json' -H '<If-Match: etag>' \
  --data-binary @- -w '\nBELLHOP_HTTP_STATUS=%{http_code}\n' \
  http://localhost:2019/config/ <<'BELLHOP_CADDY_CONFIG'
<compact JSON>
BELLHOP_CADDY_CONFIG
```

**Adapt (conversion only)**

```sh
F=<caddyfile, single-quoted>
[ -f "$F" ] || exit 5
T="$(mktemp "$(dirname "$F")/.bellhop-convert.XXXXXX")"
trap 'rm -f "$T"' EXIT
sed '/# BEGIN bellhop-managed/,/# END bellhop-managed/d' "$F" > "$T"
if grep -q '[^[:space:]]' "$T"; then caddy adapt --adapter caddyfile --config "$T"; else echo null; fi
```

## Error messages

| Case | Message |
| --- | --- |
| Exit 3 (Caddyfile mode) | `Caddy on '<host>' is running from a Caddyfile (caddy.service is active); changes made through its admin API would be lost on the next reload. Convert with 'bellhop convert-caddyfile --apply', then run 'systemctl disable --now caddy && systemctl enable --now caddy-api' on '<host>'.` |
| Exit 4 | `curl is not installed on '<host>'; the caddy-api proxy driver needs it to reach Caddy's admin API at localhost:2019.` |
| Other non-zero read | `Could not read Caddy's configuration from the admin API at localhost:2019 on '<host>': <stderr>` |
| Non-200 read | `Caddy's admin API on '<host>' answered <status> reading /config/: <body>` |
| Multiple / no HTTPS servers | `Caddy's configuration on '<host>' has <n> servers listening on port 443 (<names>); the caddy-api driver needs exactly one to hold its routes.` |
| 412 on write | `Caddy's configuration on '<host>' changed after it was read; nothing was written. Run the sync again.` |
| Other non-200 write | `Caddy on '<host>' rejected the new configuration (<status>); its previous configuration is still running: <error>` |
| Conflicts after a write | One line per conflict, joined: `Hostname '<h>' for entry '<name>' is already claimed by a hand-authored <route in server '<s>' \| TLS automation policy> in Caddy's configuration on '<host>'; it was left out. Remove or change that object, or mark the entry proxyManual.` |
| Conversion, already converted | `Caddy's configuration on '<host>' already has Bellhop objects; convert-caddyfile is only for the first switch. Use 'bellhop sync-proxy' instead.` |
| Conversion, exit 5 | `No Caddyfile at <path> on '<host>' -- pass --caddyfile <path>.` |
| Conversion, adapt failed | `caddy adapt could not convert <path> on '<host>': <stderr>` |

## Preview format

```text
+ route proxmox.example.com, pve-admin.example.com -> 198.51.100.10:8006 (insecure backend TLS)
+ route app.example.com -> 192.0.2.20:80 (forward-auth)
~ route media.example.com -> 192.0.2.50:8096
- route old.example.com
! conflict web.example.com (entry 'web-lxc'): claimed by a hand-authored route in server 'srv0'
~ tls policy: 7 hostnames
<blank line>
Bellhop objects after this change:
<pretty JSON array: routes then tls policy>
```

With nothing to do, the preview is `No changes: Caddy's configuration
already matches the inventory.` The CLI prints the preview under
`[DRY RUN] Generated caddy-api configuration for <host>:` like the other
drivers.

## CLI

```text
bellhop convert-caddyfile [--caddyfile <path>] [--apply]
```

A dry run by default. After `--apply` it prints:

```text
Loaded the converted configuration into Caddy on <host>. Next:
  1. On <host>: systemctl disable --now caddy && systemctl enable --now caddy-api
  2. bellhop set-config proxyDriver caddy-api --apply
The Caddyfile was left unchanged.
```

Exit code 1 on any error, and when conflicts remain after an apply.
