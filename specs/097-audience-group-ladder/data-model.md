# Data Model: Audience-Named Default Group Ladder

No schema change. Only values change.

## Group ladder (setting `authentikGroupLadder`)

| Aspect | Value |
|---|---|
| Source precedence | `AUTHENTIK_GROUP_LADDER` env var → stored `meta.authentikGroupLadder` → default |
| Default (before) | `bellhop-app-users-open,bellhop-app-users,bellhop-users,authentik Admins` |
| Default (after) | `bellhop-public-readonly,bellhop-public,bellhop-friends-family,bellhop-admin-family,authentik Admins` |
| Validation | Unchanged (non-empty, comma-separated, duplicates collapse to first) |

## Stored access tier (`auth_group` on `hosts`, `guests`, `external_sites`)

Rename pairs, applied on open (FR-003/FR-004):

| Old stored value | New stored value | Applies when |
|---|---|---|
| `bellhop-users` | `bellhop-admin-family` | effective ladder lacks old, contains new |
| `bellhop-app-users` | `bellhop-friends-family` | same |
| `bellhop-app-users-open` | `bellhop-public` | same |

Values not in the table (`authentik Admins`, `NULL`, any custom name) are never changed. `bellhop-public-readonly` has no predecessor.

## State transitions

```text
auth_group = old  --(open; ladder lacks old, has new)-->  auth_group = new   [logInfo once per table+pair]
auth_group = old  --(open; ladder has old OR lacks new)-->  unchanged          [silent]
auth_group = new  --(any open)-->  unchanged                                   [silent]
```
