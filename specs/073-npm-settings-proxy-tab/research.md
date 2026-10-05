# Research: Nginx Proxy Manager settings on the Proxy tab

No open unknowns; these record the choices made.

## R1 — How the page decides to show the fields

- **Decision**: A new optional driver field `usesNpmApi` (absent = false),
  reported by `proxyDriversInfo()` and read by `proxyFieldView` as
  `showNpmApiFields`.
- **Rationale**: Every other driver-specific field works this way
  (`usesSharedCertificate`, `usesCertResolver`, `usesApiUrl`,
  `usesCaddyTls`); the issue asks for the same, and it keeps id comparisons
  out of the page.
- **Alternatives**: Reusing `defaultConfigPath === null` — wrong, the Caddy
  admin-API driver has no config file either. Comparing
  `id === 'nginx-proxy-manager'` in the page — rejected by the issue.

## R2 — Where the fields go in the Proxy tab

- **Decision**: After `proxyApiUrl`, in the order URL, email, password.
- **Rationale**: Keeps the existing driver-dependent fields' order and the
  old tab's order. With Nginx Proxy Manager selected the config path,
  status page, TLS and Traefik fields are all hidden, so the three fields
  appear directly under the driver dropdown anyway.

## R3 — The `SETTING_DEFS` group

- **Decision**: Move the three to `group: 'proxy'` and drop
  `'nginx-proxy-manager'` from `SettingGroup`. `envFile` stays
  `nginx-proxy-manager.env` (the one-time import source is unchanged).
- **Rationale**: `group` is documented as the Settings-page group; leaving
  a group with no tab would be a stale value. Nothing else reads `group`
  (checked with a repository search).

## R4 — Remembered tab

- **Decision**: Nothing to migrate.
- **Rationale**: `SettingsPage` starts on `'general'` every load
  (`useState<SettingsTab>('general')`); no tab is stored.

## R5 — Screenshots

- **Decision**: Regenerate `docs/images/settings-proxy-driver.png` only.
- **Rationale**: It is the only screenshot of the Settings page
  (`scripts/screenshots.ts`), and it shows the tab strip, which loses a tab.
  The Caddy driver it shows hides the npm fields, so the field area itself
  is unchanged.
