# Quickstart: validating the proxy driver dropdown

All commands run from the worktree root against a temp inventory, never the real one:

```bash
export INVENTORY_FILE=$(mktemp -d)/bellhop.db
npm run bellhop -- import-yaml-inventory --yaml-path inventory/hosts.yaml.example --db-path "$INVENTORY_FILE" --apply
```

## 1. Automated checks

```bash
npm run typecheck && npm test && npm run web:build
```

## 2. CLI under `none`

```bash
npm run bellhop -- set-config proxyDriver none --apply        # accepted
npm run bellhop -- set-config proxyDriver nginx --apply       # rejected, same message as the web PATCH
npm run bellhop -- sync-proxy                                 # prints NO_PROXY_SYNC_MESSAGE, exit 0, no SSH
npm run bellhop -- sync-proxy --apply                         # same, exit 0
npm run bellhop -- render-status-page                         # fails naming `set-config proxyDriver caddy`
npm run bellhop -- set-config proxyDriver --unset --apply     # back to default Caddy
```

## 3. Settings page (desktop and ≤640px)

1. `npm run web:dev` against the temp inventory; open `/settings`.
2. The Proxy driver field is a dropdown showing "Caddy (default)" and "No proxy". Unset shows "Caddy (default)".
3. Select "No proxy" (unsaved): Proxy config path and Status page path disappear.
4. Select "Caddy": both reappear. The placeholders are `/etc/caddy/Caddyfile` and `/usr/share/caddy/index.html`, and the config path help names the Caddy default.
5. Save "No proxy", reload: it stays selected, and any previously stored config path is still returned by `GET /api/settings`.
6. Clear: back to "Caddy (default)".
7. Repeat steps 2-4 at a viewport width of 390px and confirm there is no horizontal overflow.
