# Data Model: Bellhop-Managed Web Login

## Guest entry: `bellhop` (persisted)

| Field | Type | Notes |
|---|---|---|
| `bellhop` | `boolean?` | On `GuestEntrySchema` only. Absent means false. At most one guest may be `true`. |

Storage: `guests.bellhop INTEGER` (null = absent), added by
`ensureColumn(db, 'guests', 'bellhop', 'bellhop INTEGER')`; loaded as
`row.bellhop ? true : undefined`; saved as `guest.bellhop ? 1 : null`.

Validation (`validateInventory`): more than one guest with `bellhop: true`
yields `Inventory validation: multiple entries flagged 'bellhop: true' (only
one is allowed): a b`. Hosts have no such field.

Qualification for the managed login (checked at resolve time, not at write
time, because a flagged guest may legitimately not be gated yet):
`effectiveAuth(guest) === 'oidc'`, and `oidcRedirectUris` contains a URL
whose pathname is exactly `/auth/callback`.

## Managed login (in memory only)

```ts
interface ManagedLogin {
  entry: string;        // the flagged guest's name
  issuer: string;
  clientId: string;
  clientSecret: string; // never leaves this module's consumers' config path
  redirectUri: string;  // the entry's /auth/callback URL
}
```

Module state: `current?: ManagedLogin`, `lastProblem?: string` (fixed text).
Cleared when no guest qualifies; kept on an Authentik error.

## Web login source (derived, returned to the Settings page)

```ts
type WebLoginStatus =
  | { source: 'custom' }
  | { source: 'managed'; entry: string; redirectUri: string }
  | { source: 'none'; missing: ConfigKey[]; managedProblem?: string };
```

`WebLoginConfig` (existing: `configured: true` with issuer/clientId/
clientSecret/redirectUri, or `configured: false` with `missing`) is unchanged.
`webLoginConfig()` returns the custom set when complete, else the cached
managed one as `configured: true`, else `{ configured: false, missing }`
with the custom missing keys.

## Settings

`SettingGroup` gains `'weblogin'`; `webUiOidcIssuer`, `webUiOidcClientId`,
`webUiOidcRedirectUri`, `webUiOidcClientSecret` move to it. Env vars, files
and stored values are unchanged.
