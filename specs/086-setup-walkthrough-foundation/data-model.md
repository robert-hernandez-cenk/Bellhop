# Data model: First-run setup walkthrough foundation (#86)

## setup_state (new table in `inventory/bellhop.db`)

Owned by `src/lib/setup-state.ts`. Not touched by `saveInventory`.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PRIMARY KEY | `CHECK (id = 1)`: one row per install |
| `status` | TEXT NOT NULL | `CHECK (status IN ('pending', 'finished'))` |
| `token` | TEXT | The setup token while `pending`; `NULL` once `finished` |
| `completed_steps_json` | TEXT NOT NULL | JSON array of step ids, e.g. `["proxmox"]`; `'[]'` initially |
| `updated_at` | TEXT NOT NULL | ISO-8601 |

**Phase** (derived, not stored), from R2:

| Row | Hosts in inventory | Phase |
|---|---|---|
| none | 0 | `pending` (start-up creates the row) |
| none | ≥ 1 | `not-applicable` |
| `pending` | any | `pending` |
| `finished` | any | `finished` |

**Transitions**:

```text
(no row, no hosts) --start-up--> pending(token)
pending --complete step--> pending(completed_steps += id)
pending --finish (steps proxmox + basics complete)--> finished(token = NULL)
finished --> (terminal)
```

**Step ids** (this part): `proxmox`, `basics`. Later parts of #70 add their own ids; `finish` checks a fixed list of required ids that each part extends.

## Setup authorization (cookie)

- `bellhop_setup=<token>`: HttpOnly, `SameSite=Strict`, `Path=/`, browser-session lifetime, not `Secure`.
- Valid only while the phase is `pending` and the value matches `setup_state.token` (constant-time).

## Bellhop SSH key (files)

- `<dataDir>/ssh/id_ed25519`: OpenSSH private key, unencrypted, mode 0600.
- `<dataDir>/ssh/id_ed25519.pub`: `ssh-ed25519 AAAA… bellhop`.
- Created on first need. Never overwritten if present.

## HostEntry (existing, unchanged shape)

The walkthrough writes `name` (the node's `hostname`), `ssh_target`, `ssh_user`, `ssh_port` (only when not 22), `ssh_identity_file` (the key path in use) and `midScheme`. `bridges`, `storages` and `nfsMounts` come from the `sync-inventory` apply.

## Settings: `domain` (moved)

- Was: `InventorySchema.domain: z.string().min(1)` (required).
- Now: `SettingsSchema.domain`: optional DNS name (R10), stored in `meta` under `domain` as before (same row, so no migration).
- New `validateInventory` rule: any entry with non-empty `subdomains` while `domain` is unset is an error.

## Setup step payloads (validated with zod at the route)

- `KeyChoice`: `{ mode: 'generated' } | { mode: 'file', path: string }`
- `HostEndpoint`: `{ address: string (non-empty, no whitespace), user: string (default 'root'), port: integer 1–65535 (default 22) }`
- `InstallKeyRequest`: `HostEndpoint & { password: string (non-empty, no control characters) }`
- `MidSchemeInput`: `MidSchemeSchema` (existing)
- `BasicsInput`: `{ domain: string, dnsServer?: string, backupStorage?: string, nfsServer?: string }`, validated with `SettingsSchema.pick(...)`
