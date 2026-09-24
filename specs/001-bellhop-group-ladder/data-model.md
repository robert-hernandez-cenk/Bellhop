# Data Model: Rename the Default Group Ladder to Bellhop Names

No schema change. No table, column, or stored value is added, removed, or rewritten.

## Group ladder (configuration, not stored)

| Field | Source | Change |
| --- | --- | --- |
| Rungs, low to high | `AUTHENTIK_GROUP_LADDER`, comma-separated; falls back to the default when unset or empty | Default changes from `homelab-app-users-open,homelab-app-users,homelab-users,authentik Admins` to `bellhop-app-users-open,bellhop-app-users,bellhop-users,authentik Admins` |

Rules (unchanged): names are trimmed; empty entries and duplicates are dropped, keeping the first occurrence; order is preserved.

## `authGroup` on hosts, guests, and external sites (stored)

| Field | Storage | Change |
| --- | --- | --- |
| `authGroup` | `auth_group` column on `hosts`, `guests`, `external_sites` in `inventory/bellhop.db` | None. Existing values are kept as written. |

State of an entry relative to the active ladder:

- **On-ladder**: its `authGroup` is a rung. `sync-authentik` maintains its Application and bindings.
- **Off-ladder**: its `authGroup` is not a rung. It still loads; `sync-authentik` reports it and leaves its existing Application and bindings as they are.
- **Ungated**: no `authGroup`. Unaffected.

An existing entry stored as `homelab-app-users-open`, `homelab-app-users`, or `homelab-users` moves from on-ladder to off-ladder when the operator upgrades without setting `AUTHENTIK_GROUP_LADDER`. It moves back to on-ladder when the operator either sets the ladder to the old names or re-tiers the entry to a new rung.
