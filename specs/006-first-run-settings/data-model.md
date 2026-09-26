# Data Model: First-run settings without Authentik

No persisted data changes. The inventory `meta` table, `SettingsSchema`, and the `GET`/`PATCH /api/settings` response are all unchanged.

Inputs to the new pure functions (all already present in the client):

- **WhoAmI** (`web-client/src/api/types.ts`): `isAdmin: boolean`, `capabilities.userDirectory: boolean`. These are the inputs to `adminNavLinks`.
- **SettingsResponse.derived**: `lanGateways: { host, gateway }[]` and `caddy: { name, ip } | null`. These are the inputs to the settings-display text.
- **Settings key** (`SETTINGS_KEYS`, `src/lib/inventory.ts`): the `key` argument to `settingFix`.
