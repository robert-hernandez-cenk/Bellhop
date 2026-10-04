# Data Model: One settings store (#64)

## Setting definitions (`src/lib/settings-defs.ts`)

One record per moved or new key. Existing pre-#64 settings (`nfsServer`, `proxyDriver`, ...) keep
living in `inventory.ts` with no env var and group `general`/`proxy` assigned client-side.

| Key | Env var | Group | Secret | Default (when unset) | Validation |
| --- | --- | --- | --- | --- | --- |
| `authentikApiUrl` | `AUTHENTIK_API_URL` | authentik | no | -- (integration off) | http(s) URL |
| `authentikApiToken` | `AUTHENTIK_API_TOKEN` | authentik | **yes** | -- (integration off) | non-empty, no whitespace |
| `authentikAdminGroup` | `AUTHENTIK_ADMIN_GROUP` | authentik | no | `bellhop-admins` | non-empty |
| `authentikBuiltinAdminGroup` | `AUTHENTIK_BUILTIN_ADMIN_GROUP` | authentik | no | `authentik Admins` | non-empty |
| `authentikGroupLadder` | `AUTHENTIK_GROUP_LADDER` | authentik | no | the 4-rung default | non-empty, comma-separated |
| `authentikOutpostName` | `AUTHENTIK_OUTPOST_NAME` | authentik | no | `authentik Embedded Outpost` | non-empty |
| `authentikOutpostPort` | `AUTHENTIK_OUTPOST_PORT` | authentik | no | `9000` | positive integer string |
| `authentikAuthorizationFlowSlug` | `AUTHENTIK_AUTHORIZATION_FLOW_SLUG` | authentik | no | stock slug | non-empty |
| `authentikInvalidationFlowSlug` | `AUTHENTIK_INVALIDATION_FLOW_SLUG` | authentik | no | stock slug | non-empty |
| `authentikOidcSigningKeyName` | `AUTHENTIK_OIDC_SIGNING_KEY_NAME` | authentik | no | stock key name | non-empty |
| `webUiAuthMode` | `WEB_UI_AUTH_MODE` | general | no | `auto` | `auto` \| `authentik` \| `none` |
| `cloudflareDnsApiToken` | `CLOUDFLARE_DNS_API_TOKEN` | cloudflare | **yes** | -- (prune skipped) | non-empty, no whitespace |
| `npmApiUrl` | `NPM_API_URL` | nginx-proxy-manager | no | `http://<proxy ip>:81` | http(s) URL |
| `npmApiEmail` | `NPM_API_EMAIL` | nginx-proxy-manager | no | -- | non-empty |
| `npmApiPassword` | `NPM_API_PASSWORD` | nginx-proxy-manager | **yes** | -- | non-empty, no control chars |
| `githubApiToken` | `GITHUB_API_TOKEN` | github | **yes** | -- (anonymous) | non-empty, no whitespace |

Defaults stay where they are today (`authentik-config.ts`, `npm-client.ts`); the definitions carry
only what the accessor and Settings page need.

## Storage

- Non-secret: `meta(key, value)` rows, exactly like existing settings; part of `Inventory`.
- Secret: new table `secret_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)` in `bellhop.db`.
  Never read by `loadInventory`, never written by `saveInventory`. Written only by
  `writeSecret`/`clearSecret` (`src/lib/config.ts`) and the import.

## Effective value

`configValue(key, env)` -> `{ value?: string; source: 'environment' | 'settings' | 'none' }`:

1. `env[envVar]` set and non-empty -> `source: 'environment'`.
2. else stored row (meta or secret_settings) -> `source: 'settings'` (re-validated; malformed ->
   throw naming the key).
3. else `source: 'none'`; the consumer applies its own default.

Snapshot: the stored half is cached per process for 2 s, invalidated per `/api` request and on
every in-process write (research R3).

## AuthUser

Gains `viaForwardAuth?: true` -- set only when the identity came from verified
`X-authentik-*` headers. Preserved by the impersonation overlay (it only replaces `groups`).

## State transitions

- Import: stored(none) + file value -> stored(file value). Stored(any) is never changed.
- `webUiAuthMode` -> `authentik` only from a request whose forward-auth headers name an admin
  under the post-save admin groups (web). From `authentik` to
  anything else: UI confirmation. CLI/MCP: unrestricted (host-level trust).
- Admin groups: a web write is refused if the real requester would stop being an admin.
