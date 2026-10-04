# Contract: `/api/settings` (admin-only, unchanged gate)

Non-admins and admins impersonating a non-admin group: `403 { "error": "forbidden" }` on GET and
PATCH (unchanged).

## GET /api/settings

Existing fields unchanged (`settings`, `derived`, `proxyDrivers`, `defaultProxyDriver`,
`caddyTlsModes`, `defaultCaddyTls`). `settings` holds **stored** non-secret values only (what the
inputs edit). Added:

```json
{
  "sources": { "authentikApiUrl": "settings", "webUiAuthMode": "environment", "nfsServer": "settings" },
  "environment": {
    "webUiAuthMode": { "variable": "WEB_UI_AUTH_MODE", "value": "authentik" },
    "githubApiToken": { "variable": "GITHUB_API_TOKEN" }
  },
  "secrets": {
    "authentikApiToken": { "set": true, "source": "settings" },
    "cloudflareDnsApiToken": { "set": false, "source": "none" },
    "npmApiPassword": { "set": false, "source": "none" },
    "githubApiToken": { "set": true, "source": "environment" }
  }
}
```

- `sources` covers every non-secret key; keys with no env var can only be `settings` or `none`.
- `environment` lists only keys currently pinned by the environment. A non-secret entry carries
  its effective `value` (shown read-only); a secret entry **never** has `value`.
- No field anywhere in any response contains a secret value or any part of one.

## PATCH /api/settings

Body: any subset of non-secret and secret keys; a string sets, `null` or `''` clears.

Refusals (400 unless stated, nothing written):

| Condition | Error |
| --- | --- |
| Unknown key | `Unknown setting(s): <keys>` (unchanged) |
| Value not a string/null | `<key> must be a string or null` (unchanged) |
| Schema failure | `<key>: <message>` (message never contains the value) |
| Key pinned by environment | `<key> is set by the environment variable <VAR> -- unset <VAR> (or remove it from data/<file>.env) to manage it here` |
| Admin-group change locks requester out | `Refusing to change <key>: you would no longer be an administrator (your groups: ...)` -- 409 |
| `webUiAuthMode: "authentik"` from a request without forward-auth headers | `Refusing to set webUiAuthMode to authentik: this request did not come through Authentik forward-auth, so every later request would be rejected` -- 409 |

Success: 200 with the same shape as GET.
