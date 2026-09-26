# Contract: User-facing surfaces

Every surface below changes in one step, with no aliases for old names.

## CLI

| Before | After |
|---|---|
| `bellhop sync-caddy [--apply]` | `bellhop sync-proxy [--apply]` |
| description "Generate and write Caddy reverse_proxy blocks from inventory subdomains" | "Generate and write reverse-proxy configuration from inventory subdomains" |
| dry run: `[DRY RUN] Generated managed block for <host>:` + block | `[DRY RUN] Generated <driver> configuration for <host>:` + preview |
| apply: `Wrote managed block to <host>` | `Wrote <driver> configuration to <host>` |
| `CADDYFILE_PATH` env var honored by `sync-caddy`/`render-status-page` | removed; `proxyConfigPath` setting honored everywhere |
| `set-config` keys | adds `proxyDriver`, `proxyConfigPath` |
| `render-status-page` description "…active Caddyfile) served on the Caddy host" | "…deployed proxy configuration) served on the proxy host" |

## Inventory (YAML import and SQLite)

| Before | After |
|---|---|
| `caddy: true` | `proxy: true` |
| `caddyManual: true` | `proxyManual: true` |

Messages:
- `No inventory entry has 'proxy: true'`
- `Inventory validation: multiple entries flagged 'proxy: true' (only one is allowed): <names>`
- `unauthenticatedPaths` rejection: `must be an exact path (/health) or a prefix ending in /* (/api/*)`

## Web API

| Endpoint | Change |
|---|---|
| `PATCH /api/inventory/guests/:name` (Dashboard guest edit) | body field `caddyManual` → `proxyManual`; new 400 when the edited guest's auth mode is unsupported by the active driver (capability message, see driver contract) |
| `GET /api/inventory` | entries carry `proxy`/`proxyManual` |
| `GET /api/settings` | `settings` adds `proxyDriver`, `proxyConfigPath`; `derived.caddy` → `derived.proxy` |
| `PATCH /api/settings` | accepts `proxyDriver`, `proxyConfigPath` |
| maintenance command id `sync-caddy` ("Sync Caddy") | `sync-proxy` ("Sync Proxy") |

## MCP

| Before | After |
|---|---|
| tool `sync_caddy` | `sync_proxy` |
| `edit_guest` input `caddyManual` | `proxyManual` (description: "Proxy config for this entry is hand-authored outside the managed section") |
| `set_config` key enum | adds `proxyDriver`, `proxyConfigPath` |

## Web UI

| Before | After |
|---|---|
| Dashboard column / Advanced modal "read-only caddy" (`EditableCaddyManual`) | "read-only proxy" (`EditableProxyManual`) |
| Maintenance "Sync Caddy" | "Sync Proxy" |
| Settings derived "Caddy IP" | "Proxy IP" |
| Settings fields | adds "Proxy driver" (placeholder `caddy`) and "Proxy config path" (placeholder `/etc/caddy/Caddyfile`) |

## Status page

The configuration `<pre>` block's heading changes from the Caddyfile to
"Deployed proxy configuration"; its content is `driver.snapshot()`.

## Windows service

Firewall scope from `findProxyEntry`; errors name `'proxy: true'`.

## Unchanged

Historical job rows (`sync-caddy`), `bellhop-managed` markers,
`insecureBackendTls`, `unauthenticatedPaths` (field name), `authentik`,
`prune-acme-challenges`.
