# Contract: Settings API changes

## `GET /api/settings` and the `PATCH /api/settings` response

Adds a `webLogin` object (no secret of any kind):

```json
{ "webLogin": { "source": "managed", "entry": "bellhop-lxc", "redirectUri": "https://bellhop.example.com/auth/callback" } }
```

```json
{ "webLogin": { "source": "custom" } }
```

```json
{ "webLogin": { "source": "none", "missing": ["webUiOidcIssuer"], "managedProblem": "No guest is flagged as Bellhop" } }
```

`managedProblem` is one of a fixed set of messages: `No guest is flagged as
Bellhop`, `<guest> is not OIDC-gated (set an auth group and OIDC mode)`,
`<guest> has no callback URL ending in /auth/callback`, `No OpenID client
exists yet for <guest> (run sync-authentik)`, `Authentik could not be
reached`. It is omitted when `missing` is the whole story.

`sources`, `environment`, `secrets` are unchanged. The four `webUiOidc*` keys
remain ordinary settings in `settings`/`secrets`; only their `group` moves.

## `PATCH /api/settings` guard (webUiAuthMode `oidc`)

- Switching to oidc: 409 unless web login is configured after the request
  (all four custom keys set after the PATCH, or a usable managed login), then
  the existing real-requester session check, then the existing admin check.
  Unconfigured message: `Web login is not configured: flag Bellhop's own
  guest in its Advanced settings, or set <missing keys> on the Web login tab
  first`.
- Staying in oidc: 409 `Refusing to clear <keys> while webUiAuthMode is oidc:
  nobody could sign in. Set webUiAuthMode to none first` when this request
  clears a value of the complete custom set that is in effect (even if a
  flagged guest could take over), or clears one with no usable managed login.
  Clearing a stray value while the custom set was already incomplete and a
  managed login signs people in is allowed. An unrelated save is never
  refused.
- All other PATCH behavior (env-pin refusal, validation, secrets write-only)
  is unchanged.

## Sign-in pages

`/auth/login` with neither source usable shows the existing "not configured"
page, listing the custom setting names still missing and, when a flagged guest
exists, its fixed-text reason. If Authentik is unreachable and no value was
ever resolved, the page says Authentik could not be reached.
