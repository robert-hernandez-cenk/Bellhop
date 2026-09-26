# Contracts: navigation, messages, Settings page text

## `adminNavLinks(isAdmin: boolean, hasDirectory: boolean): { to: string; label: string }[]`

`web-client/src/lib/admin-nav.ts`

| isAdmin | hasDirectory | Result |
| --- | --- | --- |
| false | any | `[]` (no Admin group rendered) |
| true | false | `[Settings]` |
| true | true | `[Users, Permissions, Settings]` (today's order) |

Paths: `/users`, `/permissions`, `/settings`. The Sidebar renders the "Admin" group label only when the result is non-empty.

## `settingFix(key: SettingKey, valueHint: string): string`

`src/lib/settings-hint.ts`

Returns exactly:

```text
run: bellhop set-config <key> <valueHint> --apply, or set it on the web UI's Settings page
```

Messages after this change (lead-ins unchanged):

| Source | Message |
| --- | --- |
| sync-inventory warning | `nfsServer is not set -- skipping NFS mount discovery -- ${settingFix('nfsServer', '<ip>')}` |
| sync-inventory summary | `NFS mounts: skipped -- nfsServer is not set -- ${settingFix('nfsServer', '<ip>')}` |
| migrate-nfs-mount | `nfsServer is not set -- ${settingFix('nfsServer', '<ip>')}` |
| set-guest-vpn | `dnsServer is not set -- ${settingFix('dnsServer', '<ip>')}` |
| migrate-guest | `backupStorage is not set -- ${settingFix('backupStorage', '<storage-id>')}, or pass --backup-storage` |
| render-status-page (skip) | `statusPagePath is not set -- skipping the status page render -- ${settingFix('statusPagePath', '</absolute/path>')}` |
| render-status-page (throw) | `statusPagePath is not set -- ${settingFix('statusPagePath', '</absolute/path>')}` |

## Settings page text (`web-client/src/lib/settings-display.ts`)

- `caddyHostText(caddy: { name: string; ip: string } | null): string`
  - non-null: `"<name> (<ip>)"` (today's format)
  - null: `"not set — no inventory entry has caddy: true with an IP yet"`
- `LAN_GATEWAYS_EMPTY_TEXT`: `"LAN gateways: none yet — no host has a midScheme"`. Rendered in place of the gateway list items when `lanGateways` is empty.

Intro text states every setting is optional and each field says what happens while it is unset, and keeps the `set-config` pointer. Each field label is followed by an "Optional" marker.
