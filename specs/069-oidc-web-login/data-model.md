# Data Model: Web UI login (#69)

## Session store: `data/sessions.sqlite3`

Owned by `SessionStore` (`src/web/login/session-store.ts`). Not part of `inventory/bellhop.db`, so `saveInventory`'s full replace never touches it. `':memory:'` in tests.

### `sessions`

| Column | Type | Notes |
|---|---|---|
| `id_hash` | TEXT PK | SHA-256 hex of the cookie value (32 random bytes, base64url). The raw id is never stored. |
| `username` | TEXT NOT NULL | `preferred_username` |
| `uid` | TEXT NOT NULL | `sub`; becomes `AuthUser.uid` (#58 creator match, `Actor`) |
| `email` | TEXT | nullable |
| `groups_json` | TEXT NOT NULL | JSON array of group names |
| `refresh_token` | TEXT NOT NULL | Server-side only; replaced on every successful re-check (rotation) |
| `id_token` | TEXT NOT NULL | Latest ID token, used only as `id_token_hint` at sign-out |
| `created_at` | INTEGER NOT NULL | epoch ms, sign-in time |
| `last_checked_at` | INTEGER NOT NULL | epoch ms, last successful sign-in or re-check |
| `last_attempt_at` | INTEGER | epoch ms, last re-check attempt that failed to reach the provider |

Rules:

- **Valid** while `now < created_at + 30 days`; otherwise deleted on sight and by the purge.
- **Re-check due** when `now - last_checked_at >= 5 min` and (`last_attempt_at` is null or `now - last_attempt_at >= 1 min`).
- Re-check success → update `username`, `email`, `groups_json`, `refresh_token`, `id_token` (when a new one is returned), `last_checked_at = now`, `last_attempt_at = null`.
- Re-check refused (invalid grant/client, `sub` mismatch, userinfo 401) → delete row.
- Re-check unreachable (network error, timeout, 5xx) → `last_attempt_at = now`; identity unchanged.
- Sign-out → delete row.
- Purge: rows past 30 days, run at store open and on each new sign-in.

### `login_attempts`

| Column | Type | Notes |
|---|---|---|
| `id_hash` | TEXT PK | SHA-256 hex of the `bellhop_login_<state>` cookie value |
| `state` | TEXT NOT NULL | OAuth `state` |
| `nonce` | TEXT NOT NULL | OIDC `nonce` |
| `code_verifier` | TEXT NOT NULL | PKCE verifier (S256) |
| `return_to` | TEXT NOT NULL | Validated same-origin path, default `/` |
| `created_at` | INTEGER NOT NULL | epoch ms |

Rules: valid for 10 minutes; consumed (deleted) in the same transaction that reads it; purged when expired.

### State transitions (session)

```text
(none) --callback ok + refresh token--> active
active --request, check not due--> active
active --request, check due, provider ok--> active (identity refreshed)
active --request, check due, provider unreachable--> active (last-known identity, retry later)
active --request, check due, provider refuses--> deleted
active --age >= 30 days--> deleted
active --POST /auth/logout--> deleted
```

## `AuthUser` (src/web/auth.ts)

- `viaForwardAuth` is removed; `viaOidc?: true` is set only for a session identity (survives the impersonation overlay, which replaces only `groups`).
- `uid` = session `uid` for session identities; absent for the dev user and local operator (unchanged).
- Everything else unchanged.

## Settings (settings store)

| Key | Kind | Env var | Validation | Group |
|---|---|---|---|---|
| `webUiAuthMode` | setting | `WEB_UI_AUTH_MODE` | `oidc` \| `none` | general |
| `webUiOidcIssuer` | setting | `WEB_UI_OIDC_ISSUER` | http(s) URL | general |
| `webUiOidcClientId` | setting | `WEB_UI_OIDC_CLIENT_ID` | non-empty | general |
| `webUiOidcRedirectUri` | setting | `WEB_UI_OIDC_REDIRECT_URI` | https URL (http only on loopback) whose path is `/auth/callback` | general |
| `webUiOidcClientSecret` | secret | `WEB_UI_OIDC_CLIENT_SECRET` | non-empty, no whitespace | general |

All four OIDC keys set (effective value, env or stored) = **OIDC configured**.

One-time migration in `openInventoryDb`: `meta.webUiAuthMode = 'authentik'` → `'oidc'`; `'auto'` → row deleted.

## Removed

- `forwardAuthIdentity`, every `x-authentik-*` read in `src/web/`.
- `WebUiAuthMode` values `auto`, `authentik`.
- `resolveProxyIp` (`scripts/windows-service.ts`), Settings API `derived.proxy` and its UI line.
- `DEMO_IDENTITY_HEADERS` (replaced by a seeded demo session).
