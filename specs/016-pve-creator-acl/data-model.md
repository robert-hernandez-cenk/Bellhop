# Data Model: Proxmox Access for VM Creators

No database tables change. Two optional settings join the existing `meta`
key/value rows, and three in-memory shapes are validated at their trust
boundary.

## Settings (`meta` table, `SettingsSchema`)

| Key | Type | Validation | Unset means |
| --- | --- | --- | --- |
| `pveUserRealm` | string | `^[A-Za-z][A-Za-z0-9._-]+$` | The creator grant is off |
| `pveCreatorRole` | string | `^[A-Za-z0-9._-]+$` | `PVEVMAdmin` (`DEFAULT_CREATOR_ROLE`) |

Both keys are written and cleared through `set-config` and `PATCH /api/settings`,
like every other `SETTINGS_KEYS` entry, and round-trip through `saveInventory`'s
upsert/delete of `meta`.

## Actor (`OperationDeps.actor`, in memory only)

| Field | Type | Source |
| --- | --- | --- |
| `username` | string | `(req.realUser ?? req.user).username` (the `X-authentik-username` header) |
| `email` | string, optional | `(req.realUser ?? req.user).email` (the `X-authentik-email` header) |

It's absent for MCP, CLI, and the synthetic local operator. It's never
persisted, and the job row keeps recording only `triggeredByUsername`, as it
does today.

## RealmInfo (output of the filtered realm read, `RealmInfoSchema`)

| Field | Type | Notes |
| --- | --- | --- |
| `type` | string | `openid` is required for a grant |
| `username-claim` | string \| null, optional | `username` and `email` are supported. `subject`, null, or missing means no grant |

## AclEntry (output of the filtered ACL read, `AclEntrySchema`)

| Field | Type | Notes |
| --- | --- | --- |
| `path` | string | Kept only when exactly `/vms/<old vmid>` |
| `type` | `'user' \| 'group' \| 'token'` | Selects `--users`, `--groups` or `--tokens` |
| `ugid` | string | User ID, group name, or token ID |
| `roleid` | string | Role name |
| `propagate` | `0 \| 1` | Passed as `--propagate <n>` |

## Grant outcome (job-log line)

Each grant attempt ends in exactly one log line:

| Outcome | Level | Message names |
| --- | --- | --- |
| `granted` | info | role, VM, user ID, and whether the user was created |
| `off` | info | `pveUserRealm` and `set-config` / the Settings page |
| `no-actor` | info | that no signed-in user exists (MCP/CLI/local operator) |
| `skipped` | warn | the reason (not openid, unsupported claim, no email, unsafe ID, missing realm) and the fix |
| `failed` | warn | stderr from Proxmox, plus the manual `pveum` commands |

The CLI has no grant step, so it prints nothing for this feature.
