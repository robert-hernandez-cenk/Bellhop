# Data Model: Run the web service as an LXC container

## Setting: `bellhopGuest`

| Field | Type | Default | Validation |
|---|---|---|---|
| `bellhopGuest` | string | unset | non-empty when set (`z.string().min(1).optional()`), same as `nfsServer` |

- Stored as a row in the inventory database's `meta` table, through the existing `SettingsSchema`/`SETTINGS_KEYS` path. It is not a secret.
- Written by `set-config` (CLI, MCP `set_config`), the Settings page (General tab), and a `bellhopGuest` key in an imported YAML file. The installer prints the command to set it to the container hostname (research R7).
- Read by `isBellhopGuest`/`assertNotBellhopGuest` (`src/lib/bellhop-guest.ts`). It matches a guest by exact `name`. A value that names no inventory entry guards nothing and is not an error (FR-017).
- Never validated against the current inventory, because it is normally set right after the import, before `sync-inventory` has created the guest.

## `UpdateAllResult` (extended)

| Field | Type | Meaning |
|---|---|---|
| `pass`, `failConnect`, `failCommand`, `failUnknownPm` | unchanged | unchanged |
| `skippedSelf` | `string[]` | targets that were left out because they are Bellhop's own guest (always at most one entry) |

`skippedSelf` is not a failure: the `update-all` operation does not throw because of it.

## Container filesystem layout (installer)

| Path | Owner | Contents | Survives update |
|---|---|---|---|
| `/opt/bellhop` | root | release source, `node_modules`, built `web-client/dist` | no (replaced) |
| `/var/lib/bellhop` | root | data location | yes |
| `/var/lib/bellhop/inventory/bellhop.db` | root | inventory and settings store (`INVENTORY_FILE`) | yes |
| `/var/lib/bellhop/data` | root | jobs, job logs, sessions, optional `*.env` (`WEB_DATA_DIR`) | yes |
| `/root/.ssh/id_ed25519{,.pub}` | root, 0600/0644 | SSH identity found by the default key lookup | yes |
| `/etc/default/bellhop` | root, 0644 | `PORT`, `INVENTORY_FILE`, `WEB_DATA_DIR` | yes (not rewritten by update) |
| `/etc/systemd/system/bellhop.service` | root | web service unit | yes |
| `/usr/local/bin/bellhop` | root, 0755 | CLI wrapper | yes |
