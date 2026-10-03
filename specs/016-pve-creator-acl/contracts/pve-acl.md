# Contract: `src/lib/pve-acl.ts`

This is the only module that knows how a Bellhop user maps to a Proxmox user
and how per-guest permissions are read and written. Its callers are the
`create-vm` operation (grant) and `runMigrateGuest` (copy). Every remote call
goes through `runRemote` against a `pve` host.

## Exports

```ts
export const DEFAULT_CREATOR_ROLE = 'PVEVMAdmin';

export interface Actor { username: string; email?: string }

export const RealmInfoSchema: z.ZodType<{ type: string; 'username-claim'?: string | null }>;
export const AclEntrySchema: z.ZodType<AclEntry>;
export interface AclEntry { path: string; type: 'user' | 'group' | 'token'; ugid: string; roleid: string; propagate: 0 | 1 }

// Host commands. They print only filtered JSON (research R2/R5).
export function buildRealmReadCommand(realm: string): string;
export function buildGuestAclReadCommand(vmid: number): string;

// Pure functions.
export function pveUserIdFor(realm: string, info: RealmInfo, actor: Actor):
  { userid: string } | { skip: string };              // skip = full warning text, naming the fix
export function buildGrantScript(userid: string, vmid: number, role: string): string;
export function aclsForVmid(entries: AclEntry[], vmid: number): AclEntry[];
export function buildAclCopyScript(entries: AclEntry[], newVmid: number): string;
export function creatorGrantPreview(inventory: Inventory, actor: Actor | undefined, vmid: number): string | undefined;

// Effectful. Each never throws and logs exactly one line through logInfo/logWarn.
export async function grantCreatorAccess(
  ssh: SSHClient, inventory: Inventory, host: string, vmid: number, actor: Actor | undefined
): Promise<'granted' | 'off' | 'no-actor' | 'skipped' | 'failed'>;
export async function copyGuestAcls(
  ssh: SSHClient, inventory: Inventory, host: string, oldVmid: number, newVmid: number
): Promise<'copied' | 'none' | 'failed'>;
```

## Behavior

`grantCreatorAccess`:

1. If `inventory.pveUserRealm` is unset, return `off` and log info.
2. If `actor` is undefined, return `no-actor` and log info.
3. Run `buildRealmReadCommand`. A non-zero exit, or output that fails
   `RealmInfoSchema`, returns `skipped` with a warning that names the realm
   and Proxmox's stderr.
4. Run `pveUserIdFor`. A `skip` result returns `skipped` and logs that text
   as a warning.
5. Run `buildGrantScript` with `inventory.pveCreatorRole ?? DEFAULT_CREATOR_ROLE`.
   A non-zero exit returns `failed` and warns with stderr plus the script
   text, which doubles as the manual commands. Exit 0 returns `granted` and
   logs info.

`copyGuestAcls`:

1. Run `buildGuestAclReadCommand(oldVmid)`. On a failure or parse error,
   return `failed` and warn.
2. Re-filter with `aclsForVmid`. If nothing is left, return `none` and log
   info.
3. Run `buildAclCopyScript`. A non-zero exit returns `failed` and warns with
   stderr plus the script. Otherwise return `copied` and log the count.

## Messages (stable text, asserted by tests)

- Off: `Proxmox creator grant is off -- set pveUserRealm (bellhop set-config pveUserRealm <realm> --apply, or the web UI's Settings page) to grant VM creators access in Proxmox`
- No actor: `No Proxmox creator grant for VM <vmid>: no signed-in user (only web UI jobs carry one)`
- Not OpenID: `Skipping Proxmox creator grant: realm '<realm>' is type '<type>', not openid -- set pveUserRealm to an OpenID realm`
- Unsupported claim: `Skipping Proxmox creator grant: realm '<realm>' names users by '<claim|subject (default)>' -- set its username claim to 'username' or 'email' in Proxmox (Datacenter > Permissions > Realms)`
- No email: `Skipping Proxmox creator grant: realm '<realm>' names users by email, but no email is known for '<username>'`
- Unsafe ID: `Skipping Proxmox creator grant: '<name>' can't be part of a Proxmox user ID (contains whitespace, ':' or '/')`
- Granted: `Granted <role> on VM <vmid> to <userid>`
- Failed: `Failed to grant <role> on VM <vmid> to <userid> (exit <n>): <stderr> -- run on <host> by hand:\n<script>`

## Settings contract

`pveUserRealm` and `pveCreatorRole` are added to `SettingsSchema`, with the
patterns in `data-model.md`, so `set-config` and `PATCH /api/settings` reject
the same values with the same messages:
- realm: `must start with a letter and contain only letters, digits, ., - and _`
- role: `must contain only letters, digits, ., - and _`
