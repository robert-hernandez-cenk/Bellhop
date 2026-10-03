# Proxmox access for VM creators

When a non-admin person creates a VM from the web UI, Bellhop does the
actual creation over SSH as `root`, so by default the creator gets no
Proxmox permission on the VM at all — logging in to the Proxmox web UI
shows them nothing they can use. This feature closes that gap: once
configured, the person who created a VM from Bellhop's web UI can log in
to Proxmox with the same identity-provider account and immediately start
it, open its console, and change its configuration, with no administrator
involved.

It applies to VMs created with `create-vm` only. Containers created by
`create-lxc`, `install-app`, or `deploy-vpn-gateway` are unaffected — a
later change can reuse the same grant step for them.

## Prerequisites

The grant maps a signed-in Bellhop user onto a Proxmox user ID, which only
works if Proxmox is set up to agree with Bellhop about who that person is:

- The Proxmox realm you point this feature at must be an **OpenID**
  realm (`pve`, `pam`, `ldap`, and `ad` realms are not supported).
- That realm's **username claim** must be set to `username` or `email` —
  not `subject` (Proxmox's default) and not left unset. Set it in the
  Proxmox web UI under **Datacenter > Permissions > Realms**, on that
  realm's own edit dialog.
- The realm should be backed by the **same identity provider** that
  authenticates Bellhop's own web UI (e.g. the same Authentik instance),
  so the username or email Bellhop sees in a request's `X-authentik-*`
  headers is the same one Proxmox's OIDC login derives a user ID from.
  Bellhop does not verify this — a realm backed by a different provider
  will still produce grants, just to the wrong (or a nonexistent) Proxmox
  user.

With a `username`-claim realm, the grant targets `<username>@<realm>`.
With an `email`-claim realm, it targets `<email>@<realm>` — note this
produces a user ID with `@` twice (e.g. `alice@example.com@authentik`),
which is the form Proxmox itself expects for an email-claim realm.

## Settings

Two settings, both optional, both set the same way as every other
inventory-wide setting — `set-config` or the web UI's Settings page
(shown unconditionally, regardless of which `proxyDriver` is selected):

```bash
bellhop set-config pveUserRealm authentik --apply
bellhop set-config pveCreatorRole PVEVMUser --apply
bellhop set-config pveUserRealm --unset --apply   # turns the feature back off
```

| Setting | Unset means |
|---|---|
| `pveUserRealm` | The creator grant is off entirely — no Proxmox access command is ever sent |
| `pveCreatorRole` | `PVEVMAdmin` |

Both are validated with the same rule in the CLI and the web UI, so an
invalid value is rejected identically by either front end: a realm ID
must start with a letter and contain only letters, digits, `.`, `-` and
`_`; a role name must contain only letters, digits, `.`, `-` and `_`.

## Choosing a role

`PVEVMAdmin` (Proxmox's built-in role, and the default here) gives the
creator the same day-to-day control over that one VM an administrator
would have: starting and stopping it, opening its console, reconfiguring
its hardware, taking snapshots and backups, cloning it, and migrating or
deleting it — scoped to that VM's own `/vms/<vmid>` path, never anything
else in the cluster.

To grant less, set `pveCreatorRole` to `PVEVMUser` instead — Proxmox's
narrower built-in role, which gives console access, power management
(start/stop), and CD-ROM/cloud-init changes, but not hardware
reconfiguration, snapshots, backups, cloning, or deletion. Any other
existing Proxmox role name works too, built-in or custom — Bellhop
grants whatever `pveCreatorRole` names and never checks that it exists
until the grant command itself runs.

## How the grant works

After a VM is successfully created through the web UI, Bellhop:

1. Reads the configured realm's own configuration from Proxmox to learn
   its type and username claim.
2. Derives the creator's Proxmox user ID from that claim and the
   signed-in person's username or email (see Prerequisites above).
3. Creates that Proxmox user if it doesn't exist yet, with a comment
   naming the VM — an OpenID realm's `autocreate` only creates a user on
   their *first login*, and pre-creating it here is what lets a
   first-time Proxmox user see their VM immediately, before they've ever
   logged in to Proxmox at all.
4. Grants the configured role on the VM's own `/vms/<vmid>` path to that
   user ID.

The creator is always the real, signed-in person who triggered the job —
unaffected by an admin's group impersonation, and never the synthetic
local operator the web UI falls back to when no identity provider is
configured (see [Web UI authentication](web-ui.md)). A VM created through
the MCP server or the CLI is never granted, since neither has a signed-in
person to grant to.

The Create VM dry run includes a line naming the role, VM, and person it
would grant to once the realm is configured, without making any extra
contact with Proxmox to produce it — the actual user ID can only be
known once the realm is read, which only the real `--apply` does.

## This is web UI only

Only a web-UI-triggered Create VM job has a signed-in person attached to
it. The CLI's `create-vm` has no grant step at all and prints nothing for
this feature. The MCP server's `create_vm` tool runs through the same
code path as the web UI but never carries a signed-in person either, so
it never grants — when the realm is configured, its preview and job log
still carry one informational line saying there was no signed-in user to
grant to, the same message a web UI job logs when the local operator
(no identity provider configured) creates a VM.

## Permissions survive a migration

`migrate-guest` moves a guest to another host by backing it up and
restoring it under a new VMID, then destroying the original — and
Proxmox permissions are attached to a VMID, so without help, every
permission on the original guest (a creator grant from this feature, or
one an administrator added by hand for a user, group, or API token) would
be lost the first time a guest is migrated.

To prevent that, `migrate-guest` reads every permission on the old VMID's
own `/vms/<old-vmid>` path and re-creates each one (same user/group/token,
role, and propagation flag) on the new VMID — after the new guest is
confirmed running, and before the original is destroyed. A guest with no
permissions sends no extra command at all. The migration dry run states
that permissions would be copied, without reading them. A failure to read
or copy permissions never aborts the migration — it only warns, with
Proxmox's error output and the exact `pveum` commands to re-create them by
hand.

**Pool membership is not copied.** Proxmox's own guest-destroy step (see
below) removes the old VMID's pool membership along with its ACLs, and
this feature doesn't re-create it on the new VMID. If you use pools, add
the migrated guest back to its pool by hand afterward.

Only a permission on the guest's *own* VMID path is copied — a permission
on a broader path (a pool, or `/vms`) is untouched, since it isn't tied to
the old VMID and already applies to the new one just as it did before.

## Destroying a guest already cleans up its permissions

When Bellhop destroys a guest — through `delete-guest`, or
`migrate-guest`'s removal of the original after a successful move —
Proxmox itself removes every permission on that VMID as part of the
destroy, whether or not `--purge` is used. This was verified by reading
the destroy code paths on a live Proxmox VE 9.2.10 host
(`PVE::AccessControl::remove_vm_access`, called unconditionally by both
the VM and container destroy APIs; see
`specs/016-pve-creator-acl/research.md`, R4). Bellhop therefore adds no
extra cleanup step: a VMID that's later reused by a new guest never
inherits the old guest's permissions.

## Job-log messages and their fixes

Every grant or copy attempt ends in exactly one job-log line.

### Granting a VM's creator access

| Message | Level | Meaning / fix |
|---|---|---|
| `Proxmox creator grant is off -- set pveUserRealm (bellhop set-config pveUserRealm <realm> --apply, or the web UI's Settings page) to grant VM creators access in Proxmox` | info | `pveUserRealm` is unset. Set it to turn the feature on. |
| `No Proxmox creator grant for VM <vmid>: no signed-in user (only web UI jobs carry one)` | info | The job has no signed-in person (MCP, CLI, or the local operator with no identity provider). Nothing to fix — this is expected for those front ends. |
| `Skipping Proxmox creator grant: couldn't read realm '<realm>' (exit <n>): <stderr> -- check that pveUserRealm names an existing OpenID realm (bellhop set-config pveUserRealm <realm> --apply, or the web UI's Settings page)` | warn | `pveUserRealm` names a realm Proxmox couldn't read — check it's spelled correctly and actually exists. |
| `Skipping Proxmox creator grant: realm '<realm>' is type '<type>', not openid -- set pveUserRealm to an OpenID realm` | warn | The realm exists but isn't an OpenID realm. Point `pveUserRealm` at an OpenID realm instead. |
| `Skipping Proxmox creator grant: realm '<realm>' names users by '<claim>' -- set its username claim to 'username' or 'email' in Proxmox (Datacenter > Permissions > Realms)` | warn | The realm's username claim is `subject` (or unset). Change it on the realm's edit dialog in Proxmox. |
| `Skipping Proxmox creator grant: realm '<realm>' names users by email, but no email is known for '<username>'` | warn | The realm uses the `email` claim, but Bellhop doesn't know this person's email (their identity-provider login didn't carry one). |
| `Skipping Proxmox creator grant: '<name>' can't be part of a Proxmox user ID (contains whitespace, ':' or '/')` | warn | The person's username or email contains a character Proxmox user IDs can't, so no grant was attempted. |
| `Granted <role> on VM <vmid> to <userid>` | info | Success. |
| `Failed to grant <role> on VM <vmid> to <userid> (exit <n>): <stderr> -- run on <host> by hand:\n<script>` | warn | The grant command itself failed on Proxmox (e.g. the configured role doesn't exist). The log includes the exact commands to run by hand. |

### Copying permissions during a migration

| Message | Level | Meaning / fix |
|---|---|---|
| `Copied <n> permission(s) from /vms/<old> to /vms/<new>` | info | Success. |
| `No permissions on /vms/<old> to copy` | info | The guest had no permissions on its old VMID — nothing to do. |
| `Couldn't read the permissions on /vms/<old> on <host> (exit <n>): <detail> -- check pveum acl list on <host> and re-create any permissions on /vms/<new> by hand` | warn | Reading the old VMID's permissions failed. The migration still completes; re-create any permissions by hand using the command named in the message. |
| `Failed to copy permissions from /vms/<old> to /vms/<new> (exit <n>): <stderr> -- run on <host> by hand:\n<script>` | warn | The read succeeded but re-creating one or more permissions on the new VMID failed. The log includes the exact `pveum acl modify` commands to run by hand. |
