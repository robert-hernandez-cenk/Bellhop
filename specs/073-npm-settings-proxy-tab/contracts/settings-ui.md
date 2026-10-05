# Contract: Settings API driver list and Settings page visibility

## `GET`/`PATCH /api/settings` — `proxyDrivers[]`

Each entry gains `usesNpmApi: boolean`. Example (other fields elided):

```json
{ "id": "nginx-proxy-manager", "label": "Nginx Proxy Manager", "managesProxy": true, "usesNpmApi": true }
{ "id": "caddy", "label": "Caddy", "managesProxy": true, "usesNpmApi": false }
{ "id": "none", "label": "No proxy", "managesProxy": false, "usesNpmApi": false }
```

Nothing else in the response or in PATCH handling changes. PATCH still
accepts `npmApiUrl`/`npmApiEmail`/`npmApiPassword` whatever driver is
saved.

## Settings page visibility rules for the three fields

| Condition | `npmApiUrl` / `npmApiEmail` / `npmApiPassword` |
|---|---|
| Driver list not loaded, or failed to load | hidden |
| Selected (possibly unsaved) driver has `usesNpmApi: true` | shown on the Proxy tab |
| Any other driver, or an id not in the list | hidden |

Hidden fields keep their drafts and stored values; switching the dropdown
sends no request. A shown field renders exactly as on the old tab:
editable, env-pinned (read-only, "set by environment", stored copy), or —
for `npmApiPassword` — the write-only secret control.

## Tabs

`SETTINGS_TABS` labels, in order: General, Proxy, Authentik, Cloudflare,
GitHub.
