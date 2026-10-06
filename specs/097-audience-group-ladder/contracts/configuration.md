# Contract: Default Group Ladder and Upgrade Behavior

## Setting `authentikGroupLadder` / env `AUTHENTIK_GROUP_LADDER`

| | Value |
|---|---|
| Before | `bellhop-app-users-open,bellhop-app-users,bellhop-users,authentik Admins` |
| After | `bellhop-public-readonly,bellhop-public,bellhop-friends-family,bellhop-admin-family,authentik Admins` |

Explicit values are used unchanged.

## Tier audiences (documented)

| Tier | Audience |
|---|---|
| `bellhop-public-readonly` | Most constrained; reaches only apps gated at this tier |
| `bellhop-public` | Public users of an external, public-facing site; self-created accounts acceptable |
| `bellhop-friends-family` | Friends and family to share more with, e.g. external websites |
| `bellhop-admin-family` | Household members such as a spouse; close to admin |
| `authentik Admins` | Authentik's built-in administrators |

## Inventory open (every CLI command, web service, MCP server)

- Renames stored `auth_group` per the pairs in [data-model.md](../data-model.md), only where the effective ladder lacks the old name and contains the new one.
- Log line (stderr via `logInfo`), one per table and pair changed:
  `Renamed <n> row(s) in '<table>' from auth_group='<old>' to '<new>' (#97, previous default ladder name).`
- No output when nothing changes.

## `sync-authentik`

Unchanged: creates no groups; reports missing rungs by name; reports off-ladder entries and leaves their Applications alone.
