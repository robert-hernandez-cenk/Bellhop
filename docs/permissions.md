# Permissions

Once a second real user exists in the web UI (see [Web UI](web-ui.md) and
[Authentik](authentik.md)), an admin can restrict what a non-admin
identity-provider group can see and act on, from the admin-only
Permissions page.

## Group allow-lists and block-lists

A group with no rule configured is **unrestricted** — this is the default
for every group until an admin sets one. Once a rule exists, it's one of:

- **allow-list** — the group sees only the hosts/guests listed for it.
  Anything not listed is hidden.
- **block-list** — the group sees everything *except* the hosts/guests
  listed for it.

Host rules and guest rules are independent: blocking a host (e.g. `pve2`)
hides only that host's own inventory row, never the guests running on it —
those are controlled by their own separate rules.

A caller's effective access is the **intersection** across every group
they belong to: a group with no rule allows everything, so it never widens
what a more restrictive group denies. If a user belongs to both `app-users`
(allow-list, listing only `web-lxc`) and `blocked` (block-list, listing
`web-lxc`), the block-list's explicit entry wins and `web-lxc` is hidden —
see "Creator access" below for the same rule applied to a guest's creator.

Admins (membership in the configured admin group, or Authentik's own
built-in admin group) bypass every rule entirely and always see and can act
on everything. An admin viewing the app **as** a chosen non-admin group
(impersonation, from the Sidebar) sees exactly what that group would see —
including every creator-access rule below being switched off, so the
impersonated view can be used to verify a group's rule actually behaves as
intended.

Enforcement covers the inventory views, guest-scoped actions (power, edit,
update, VPN), and job history/control (list, view, live log, cancel,
answer, dismiss) for jobs whose target is a restricted resource. A few
fleet-wide actions with no single target (`update-all`, `sync-inventory`,
`sync-proxy`, and similar) stay admin-only rather than being filtered.

## Creator access

A user whose group is in allow-list mode, and who creates a guest from the
web UI, would otherwise lose sight of their own guest immediately — it
isn't on anyone's allow-list yet. Creator access fixes that automatically,
with no admin step.

**Who gets it.** Only the real, signed-in person who created the guest
through the **web UI** — create LXC, create VM, install app, or deploy VPN
gateway. A guest created through the MCP server, the CLI, or run as the
synthetic local operator (the always-admin identity the web UI falls back
to when no identity-provider headers are present) never gets a creator
recorded, so none of those paths grant creator access. Nobody else in the
creator's group gains anything from it — it is tied to the one person, not
their group membership.

**How it combines with group rules.** For the creator, the guest counts as
listed on every allow-list group they belong to — so a user `test-user` in
an allow-list group `app-users` that lists nothing yet can still see and
act on a guest `web-lxc` they just created on host `pve1`. It never widens
a **block-list** group: if `web-lxc` is explicitly named on a block-list
group `test-user` also belongs to, that block still hides the guest from
them, creator or not. This mirrors the ordinary intersection rule above —
one restrictive group rule can only narrow access, and creator access never
overrides an explicit block.

**Jobs on the guest.** The creator also sees, and can cancel or answer, the
jobs that target their guest — but only jobs that started once the creator
was recorded. If a guest is deleted and a new one is later created under the
same name, the new guest's creator does not see the old guest's jobs. A guest
whose name is the same as a host's name gets no job access this way at all,
since jobs that create guests are recorded against the host: the creator
still sees the guest itself, but jobs on that name follow the group rules
alone.

**Impersonation ignores it.** While an admin is viewing the app as an
impersonated group, creator access is switched off entirely, even for a
guest that admin themselves created — the impersonated view must show
exactly what the group sees, nothing more.

**Matching survives a rename.** The creator is matched by the
identity provider's stable per-user identifier (the OIDC `sub` claim in the user's session) when both the recorded creator
and the caller carry one — not by login name. A user's login name can be
renamed in the identity provider (it has happened for real users before)
without losing creator access to guests they already created. The login
name is still recorded alongside the identifier, for display, and as a
fallback when either side has no stable identifier at all (a local
dev/test identity, for example).

**Lifetime.** The creator record lives and dies with the guest's own
inventory entry: it survives `sync-inventory`, a repeat write of the same
guest, and `migrate-guest` (which only rewrites host/VMID/IP), and it is
gone once the guest leaves the inventory — a different guest later created
under the same name never inherits it, nor the jobs that ran on the old one.
The record notes when it was written; that time is what limits the jobs the
creator sees. It cannot be set, changed, or
cleared through the Dashboard's guest edit or the MCP server's `edit_guest`
tool; any attempt to send a creator field there is ignored.

**Created by.** Anyone who can see a guest with a recorded creator sees a
read-only "Created by" row, showing the creator's login name as it was
recorded, in the guest's Advanced dialog. A guest with no recorded creator
shows no such row. This is informational only — it explains why a user who
isn't on a group's allow-list can still reach a particular guest; there's
no control here to grant, revoke, or transfer that access. An admin who
needs to take a guest away from its creator adds an explicit block-list
entry for it instead.

## Backfilling existing guests

Guests created before this feature existed (or created via a path that
predates creator recording) have no creator record, so their creators
don't automatically regain access. A one-time CLI command,
`backfill-guest-creators`, works out each one's creator from Bellhop's own
job history and records it — see [Commands](commands.md) for its flags and
output.
