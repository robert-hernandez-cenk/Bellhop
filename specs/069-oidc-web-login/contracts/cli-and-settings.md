# Contract: CLI command and settings (#69)

## `bellhop configure-web-login <entry> [--apply]`

Stores Bellhop's own sign-in client in the settings store. Prerequisites: `<entry>` (Bellhop's own inventory entry) has `authGroup`, `authMode: oidc`, a subdomain, and `https://<host>/auth/callback` in `oidcRedirectUris`, and `sync-authentik --apply` has created its client.

Dry run (default):

```text
Would store web login settings from bellhop (dry run -- pass --apply to write):
  webUiOidcIssuer: https://authentik.example.com/application/o/bellhop/
  webUiOidcClientId: <client id>
  webUiOidcRedirectUri: https://bellhop.example.com/auth/callback
  webUiOidcClientSecret: (would be set)
```

With `--apply`: same lines with "Stored" / "(set)", then a hint: `Next: sign in at https://bellhop.example.com/auth/login, then set webUiAuthMode to oidc (Settings page or bellhop set-config webUiAuthMode oidc --apply).`

Errors (exit non-zero, nothing written): every `OidcCredentialsError` from `runOidcCredentials` verbatim; Authentik not configured (`UNCONFIGURED_MESSAGE`); no redirect URI with path `/auth/callback`: `<entry> has no callback URL ending in /auth/callback in oidcRedirectUris -- add https://<host>/auth/callback (Dashboard: Callback URLs), run sync-authentik --apply, then retry`. An env-pinned key (e.g. `WEB_UI_OIDC_ISSUER` set) is stored anyway with the same warning `set-config` prints.

The client secret is never printed.

## `set-config`

Unchanged behavior; accepts the new keys. `webUiAuthMode` accepts `oidc` and `none` only (`must be one of: oidc, none`). The secret key is accepted only via `--stdin` or the no-echo prompt, as for every secret.

## Settings API (`GET`/`PATCH /api/settings`)

- New keys appear in `settings` (non-secret, stored), `sources`, `environment` and `secrets` exactly like existing keys.
- `derived.proxy` is removed.
- PATCH `webUiAuthMode: 'oidc'` when the effective mode is not already `oidc` → **409** unless all hold, checked in this order:
  1. all four OIDC settings set after this PATCH — else `Web login is not configured: set <missing keys> first (bellhop configure-web-login <entry> --apply)`;
  2. the real requester has a session (`viaOidc`) — else `Sign in through /auth/login first, so Bellhop can confirm you can still sign in after this change`;
  3. the requester is an admin under the post-save admin groups — else `You are signed in as <username>, who would not be an admin after this change`.
- On success the server `logWarn`s `webUiAuthMode set to oidc by <username>`; leaving `oidc` logs likewise (unchanged guard: the client confirms before leaving `oidc`).

## Environment

| Variable | Effect |
|---|---|
| `WEB_UI_AUTH_MODE` | `oidc` or `none`; `auto`/`authentik` stop the service at start-up naming the replacement |
| `WEB_UI_OIDC_ISSUER`, `WEB_UI_OIDC_CLIENT_ID`, `WEB_UI_OIDC_REDIRECT_URI`, `WEB_UI_OIDC_CLIENT_SECRET` | override the stored values |
| `WEB_UI_DEV_USER`, `WEB_UI_DEV_GROUPS` | dev/test identity, used when there is no session (either mode) |

## `sync-authentik`

`OIDC_SCOPE_MAPPINGS` gains `goauthentik.io/providers/oauth2/scope-offline_access`; the next `--apply` attaches it to every Bellhop-owned OIDC provider (reported as a drift fix like any other mapping change).
