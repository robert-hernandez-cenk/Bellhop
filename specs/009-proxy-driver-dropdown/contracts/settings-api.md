# Contract: `/api/settings` (admin-only)

## GET /api/settings, and the body of every successful PATCH response

```json
{
  "settings": { "proxyDriver": "none", "proxyConfigPath": "/etc/caddy/Caddyfile" },
  "derived": { "lanGateways": [{ "host": "pve1", "gateway": "192.0.2.1" }], "proxy": null },
  "proxyDrivers": [
    { "id": "caddy", "label": "Caddy", "defaultConfigPath": "/etc/caddy/Caddyfile", "suggestedStatusPagePath": "/usr/share/caddy/index.html", "managesProxy": true },
    { "id": "none", "label": "No proxy", "defaultConfigPath": null, "suggestedStatusPagePath": null, "managesProxy": false }
  ],
  "defaultProxyDriver": "caddy"
}
```

- `proxyDrivers` lists every registered driver in registration order. It does not depend on inventory.
- `managesProxy` is `false` only for "No proxy". The page uses it, not `defaultConfigPath`, to decide whether the proxy config path field applies.
- `defaultProxyDriver` is the driver used when `settings.proxyDriver` is absent.
- A stored `proxyConfigPath` or `statusPagePath` is still returned under `none`. Stored values are never dropped.

## PATCH /api/settings

Unchanged rules. `{"proxyDriver": "none"}` → 200. `{"proxyDriver": "nginx"}` → 400 with the same zod message `set-config` produces. `{"proxyDriver": null}` clears the setting, which means default Caddy.
