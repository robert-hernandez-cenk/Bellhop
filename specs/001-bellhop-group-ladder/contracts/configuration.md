# Contract: `AUTHENTIK_GROUP_LADDER` default

The only external interface this feature changes is the default of one environment variable. The variable's name, syntax, and precedence are unchanged.

## Variable

- **Name**: `AUTHENTIK_GROUP_LADDER`
- **Read from**: the process environment, populated from `data/authentik.env` by the CLI, the web service, the MCP server, and the Windows service installer.
- **Syntax**: comma-separated Authentik group names, ordered low (broadest audience) to high (narrowest).
- **Unset or empty**: the default below is used.

## Default

| | Value |
| --- | --- |
| Before | `homelab-app-users-open,homelab-app-users,homelab-users,authentik Admins` |
| After | `bellhop-app-users-open,bellhop-app-users,bellhop-users,authentik Admins` |

## Observable effects of the default

- `GET /api/auth-groups` returns the new rung names when the variable is unset.
- The Dashboard's access-tier dropdown lists the new names.
- `sync-authentik` binds gated Applications to the new names, reports any it cannot find in Authentik under missing rungs, and reports entries stored with old names as having an unknown `authGroup`.

## Unchanged

- `AUTHENTIK_ADMIN_GROUP` default: `bellhop-admins`.
- `AUTHENTIK_BUILTIN_ADMIN_GROUP` default: `authentik Admins`.
- Any explicitly set `AUTHENTIK_GROUP_LADDER` value.
