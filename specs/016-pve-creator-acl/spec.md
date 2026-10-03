# Feature Specification: Proxmox Access for VM Creators

**Feature Branch**: `issue-53-pve-creator-acl`

**Created**: 2026-10-03

**Status**: Draft

**Input**: User description: "Issue #53: VMs created from the web UI grant the creating user no access in Proxmox. Grant the creating web user a configurable Proxmox role on the VM they create, mapped to their Proxmox OIDC-realm user, and keep Proxmox permissions intact when migrate-guest renumbers a guest."

## Background

Bellhop creates every guest as root over SSH. When a non-admin person
creates a VM from the web UI, nothing grants them a Proxmox permission on
it, so logging in to the Proxmox web UI with the same identity-provider
account shows them nothing they can use: the VM is missing or can't be
started, opened, or reached through its console. Today an administrator
has to add a Proxmox permission by hand for every VM someone else creates.

Bellhop already records who triggered a job, but that identity never reaches
the step that creates the VM, and Bellhop has no notion of the Proxmox user
that corresponds to a Bellhop user. Proxmox's OpenID Connect realms name
their users from a configurable claim (`subject`, `username`, or `email`);
only the latter two can be derived from what Bellhop knows about a signed-in
person.

A second, related gap: `migrate-guest` moves a guest to another host by
backing it up and restoring it under a new VMID, then destroying the
original. Proxmox permissions are attached to a VMID, so every permission on
the original guest — including the one this feature adds — is lost on the
first migration.

The design was agreed with the operator and recorded on issue #53.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A VM's creator can use it in Proxmox (Priority: P1)

A person signed in to Bellhop's web UI creates a VM. Once the job finishes,
they log in to the Proxmox web UI with the same identity-provider account and
find the new VM listed, and can start/stop it, open its console, and change
its configuration — with no administrator involved, even if they have never
logged in to Proxmox before.

**Why this priority**: This is the whole of issue #53. Without it, every VM a
non-admin creates needs a manual administrator step before it is usable.

**Independent Test**: With the Proxmox realm setting configured, create a VM
from the web UI as a test user, then confirm the job log reports the grant
and Proxmox lists a permission on that VM for the user's realm account with
the configured role.

**Acceptance Scenarios**:

1. **Given** the Proxmox realm setting names an OpenID realm whose username
   claim is `username`, **When** user `alice` creates VM 4005 from the web UI,
   **Then** the job log reports that the configured role was granted on VM
   4005 to `alice@<realm>`, and Proxmox holds that permission.
2. **Given** the realm's username claim is `email` and the signed-in user's
   email is known, **When** they create a VM, **Then** the grant goes to
   `<email>@<realm>`.
3. **Given** the creator's Proxmox user does not exist yet, **When** they
   create a VM, **Then** Bellhop creates that Proxmox user (with a comment
   naming the VM) before granting, so their first Proxmox login maps onto it.
4. **Given** the creator's Proxmox user already exists, **When** they create
   a VM, **Then** Bellhop grants without creating or changing the user.
5. **Given** an administrator is impersonating a group, **When** they create a
   VM, **Then** the grant goes to the administrator's own (real) account, not
   to anything derived from the impersonated group.
6. **Given** no role setting is configured, **When** a VM is created, **Then**
   the role granted is `PVEVMAdmin`; **Given** the role setting names another
   role, **Then** that role is granted instead.
7. **Given** the feature is configured, **When** a user previews (dry-runs)
   Create VM, **Then** the preview includes a line saying it would grant the
   configured role on the VM to the creating user in the configured realm,
   and the preview makes no additional contact with Proxmox to produce it.

---

### User Story 2 - The grant never breaks VM creation (Priority: P1)

An operator who hasn't configured the feature, or whose Proxmox realm can't
support it, sees VM creation behave exactly as before, plus one clear log line
explaining why no grant was made and what to change.

**Why this priority**: The grant is an add-on to a VM that was already
created successfully. A failure here must never turn a working VM creation
into a failed job, and an unconfigured deployment must not change at all.

**Independent Test**: Run Create VM with the realm setting unset, with a realm
whose username claim is `subject`, and with a Proxmox command that fails;
each job succeeds, the VM is recorded in inventory, and the log carries one
line naming the reason and the fix.

**Acceptance Scenarios**:

1. **Given** the realm setting is unset, **When** a VM is created, **Then** no
   Proxmox access command is sent and the job log has one informational line
   saying the creator grant is off and naming the setting that turns it on.
2. **Given** the configured realm is not an OpenID realm, or does not exist,
   **When** a VM is created, **Then** the job succeeds and logs a warning
   naming the realm and the problem.
3. **Given** the realm's username claim is `subject` or unset, **When** a VM is
   created, **Then** the job succeeds and logs a warning telling the operator
   to set the realm's username claim to `username` or `email`.
4. **Given** the realm's username claim is `email` but no email is known for
   the creator, **When** a VM is created, **Then** the job succeeds and logs a
   warning saying the grant was skipped for that reason.
5. **Given** creating the Proxmox user or granting the permission fails,
   **When** a VM is created, **Then** the job succeeds, the VM is recorded in
   inventory, and the job log warns with Proxmox's error output and the exact
   commands an administrator can run by hand to make the grant.
6. **Given** the VM is created through the MCP server or the CLI, which have
   no signed-in user, **When** the create succeeds, **Then** no grant is
   attempted and (for MCP, when the realm is configured) one informational line
   says there was no user to grant to.
7. **Given** the web UI runs with no identity provider (the synthetic local
   operator), **When** a VM is created, **Then** no grant is attempted and one
   informational line says so.

---

### User Story 3 - Settings are configurable from the CLI and the web UI (Priority: P2)

An operator turns the feature on and chooses the role either with
`set-config` or from the web UI's Settings page; both reject the same invalid
values the same way.

**Why this priority**: Needed to turn the feature on at all, but a thin layer
over the existing settings mechanism.

**Independent Test**: Set and clear both settings through `set-config` and
through the Settings page; confirm an invalid realm or role name is rejected
by both with the same message.

**Acceptance Scenarios**:

1. **Given** an administrator on the Settings page, **When** they view it,
   **Then** the Proxmox realm and creator role fields are shown with help
   text, regardless of which proxy driver is selected.
2. **Given** a value containing characters Proxmox doesn't allow in a realm or
   role name, **When** it is submitted through either front end, **Then** it is
   rejected with the same message.
3. **Given** a setting is cleared, **When** the next VM is created, **Then**
   the cleared setting takes effect (realm cleared turns the feature off; role
   cleared reverts to `PVEVMAdmin`).

---

### User Story 4 - Permissions survive a migration (Priority: P2)

An operator migrates a guest (VM or container) to another host. Every Proxmox
permission that existed on the original guest — a creator grant, or one an
administrator added by hand for a user, group, or API token — exists on the
migrated guest afterwards.

**Why this priority**: Without it, User Story 1's grant silently disappears
the first time the VM is migrated, and so does any hand-made permission.

**Independent Test**: Give a guest a user permission and a group permission,
migrate it, and confirm both exist on the new VMID with the same roles and
propagation flags before the original is destroyed.

**Acceptance Scenarios**:

1. **Given** a guest with permissions on its VMID, **When** it is migrated,
   **Then** each permission (same user/group/token, role, and propagation flag)
   is re-created on the new VMID after the new guest is confirmed running and
   before the original is destroyed.
2. **Given** a guest with no permissions, **When** it is migrated, **Then** no
   permission command is sent.
3. **Given** copying permissions fails, **When** a guest is migrated, **Then**
   the migration still completes and the log warns with the error and the
   commands to re-create the permissions by hand.
4. **Given** a migration dry run, **When** it is previewed, **Then** the preview
   says it would copy any permissions from the old VMID to the new one, without
   reading them.
5. **Given** a permission on a broader path (e.g. a pool or `/vms`), **When**
   a guest is migrated, **Then** it is not copied, since it is not tied to the
   old VMID.

---

### User Story 5 - A reused VMID never inherits old permissions (Priority: P3)

When a guest is deleted (or its original destroyed by a migration) and its
VMID is later reused, the new guest does not inherit permissions granted on
the old one.

**Why this priority**: A safety property. Proxmox removes a VMID's
permissions whenever the guest is destroyed, with or without `--purge`
(verified against a live Proxmox VE 9.2.10 host's source; research R4), so
this story needs no code, only the recorded verification.

**Independent Test**: On a real Proxmox host, create a throwaway VM, add a
permission on it, destroy it the way Bellhop does, and inspect the
permission list.

**Acceptance Scenarios**:

1. **Given** a guest with a permission on its VMID, **When** Bellhop destroys
   it (delete-guest, or migrate-guest's removal of the original), **Then** no
   permission on that VMID remains afterwards.
2. **Given** the live check shows Proxmox already removes them, **Then** no
   cleanup step is added and the verified behavior and Proxmox version are
   recorded in this feature's research notes; **otherwise** Bellhop removes
   every permission on that VMID right after a successful destroy.

### Edge Cases

- A username or email containing characters a shell would interpret is quoted
  safely; the Proxmox user ID is passed as one argument.
- An email-derived user ID contains `@` twice (`user@example.com@realm`) —
  Proxmox accepts this form for email-claim realms, and it is passed through
  unchanged.
- The VM's host is unreachable when the grant runs (after the VM was created):
  same as any grant failure — warning, job succeeds.
- The configured role does not exist in Proxmox: Proxmox rejects the grant;
  warning names the role and the setting.
- Two Bellhop users create VMs concurrently: each grant is independent and
  targets its own VMID.
- A migration where the old VMID's permission list can't be read: treated as
  a copy failure (warning, migration continues).
- The VM is created but a later step (recording it in inventory, or pushing
  its subdomains live) fails: the job fails as it does today, but the grant
  is still attempted, because the VM exists.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide an optional `pveUserRealm` setting naming
  the Proxmox realm whose users receive creator grants. While it is unset, no
  creator grant is ever attempted.
- **FR-002**: The system MUST provide an optional `pveCreatorRole` setting
  naming the Proxmox role granted to a VM's creator, defaulting to
  `PVEVMAdmin` when unset.
- **FR-003**: Both settings MUST be settable and clearable through `set-config`
  and through the web UI's Settings page, validated by one shared rule that
  accepts only characters Proxmox allows in a realm ID or role name.
- **FR-004**: After a VM is successfully created through the web UI (whether
  or not later steps of the job succeed), the system MUST attempt to grant the configured role on that VM to the
  creating user's Proxmox account.
- **FR-005**: The creating user MUST be the real signed-in person, unaffected
  by group impersonation. The synthetic local operator MUST never receive a
  grant.
- **FR-006**: The system MUST determine the creator's Proxmox user ID by
  reading the configured realm's own configuration from Proxmox: the realm
  must be an OpenID realm; a `username` claim yields `<username>@<realm>`; an
  `email` claim yields `<email>@<realm>`; any other claim, or none, means no
  grant.
- **FR-007**: When the creator's Proxmox user does not exist, the system MUST
  create it (with a comment naming the VM) before granting.
- **FR-008**: Every outcome of the grant step MUST be reported as exactly one
  job-log line: success (role, VM, user ID), or an informational/warning line
  naming the reason and what to change. A warning for a failed command MUST
  include Proxmox's error output and the commands an administrator can run by
  hand.
- **FR-009**: The grant step MUST NOT fail the job or prevent the VM from
  being recorded, whatever happens.
- **FR-010**: Creating a VM through the MCP server or the CLI MUST NOT attempt
  a grant, since neither has a signed-in user.
- **FR-011**: The Create VM dry run MUST state the grant it would attempt when
  the realm is configured, and MUST NOT contact Proxmox to produce that line.
- **FR-012**: When migrating a guest, the system MUST re-create every
  permission whose path is exactly the original VMID's path — for users,
  groups, and API tokens, keeping each role and propagation flag — on the new
  VMID, after the new guest is verified running and before the original is
  destroyed.
- **FR-013**: A failure to read or copy permissions during a migration MUST
  NOT abort the migration; it MUST be reported as a warning with the error and
  the manual commands.
- **FR-014**: The migration dry run MUST state that permissions would be
  copied from the old VMID to the new one.
- **FR-015**: After Bellhop destroys a guest, no permission on that VMID may
  remain. Whether this requires a cleanup step MUST be decided by a live check
  against real Proxmox and recorded.
- **FR-016**: Creating containers (`create-lxc`, `install-app`,
  `deploy-vpn-gateway`) MUST behave exactly as before; this feature grants on
  VMs only.

### Key Entities

- **Creator (actor)**: the real person who triggered a web-UI job — username
  and, when known, email. Absent for MCP and CLI jobs.
- **Proxmox realm**: an OpenID authentication realm in Proxmox, identified by
  ID, whose username claim decides how a person's Proxmox user ID is formed.
- **Proxmox user ID**: `<name>@<realm>`, where `<name>` is the creator's
  username or email depending on the realm's claim.
- **Permission (ACL entry)**: a path (here `/vms/<vmid>`), a subject (user,
  group, or API token), a role, and a propagation flag.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A non-admin who creates a VM from the web UI can start it, open
  its console, and change its configuration in Proxmox with zero administrator
  steps, on their first Proxmox login.
- **SC-002**: 100% of web-UI VM creations that succeeded before this feature
  still succeed with it, whatever the grant's outcome.
- **SC-003**: Every web-UI VM creation's job log states whether the creator
  was granted access and, if not, why and what to change.
- **SC-004**: After a migration, the migrated guest has the same set of
  per-guest permissions as the original had immediately before.
- **SC-005**: A deployment that does not set the realm sees no change in
  behavior beyond one informational log line per VM creation.

## Assumptions

- The Proxmox OpenID realm is backed by the same identity provider that
  authenticates Bellhop's web UI, so the username (or email) Bellhop receives
  is the one Proxmox derives the user ID from. Bellhop does not verify this.
- `/etc/pve` is shared across the cluster, so a grant or user creation made on
  the VM's own host is visible cluster-wide.
- Granting to administrators too is intended: a Bellhop administrator is not
  necessarily a Proxmox administrator, and a redundant grant is harmless.
- MCP and CLI are trusted operator front ends with no per-person identity, so
  "no grant" there is the same rule (grant to the signed-in creator, if any)
  rather than a divergence between front ends.
- Permissions removed for a destroyed VMID are expected to be removed by
  Proxmox itself; User Story 5 confirms it.

## Out of Scope

- Grants on containers created by `create-lxc`, `install-app`, or
  `deploy-vpn-gateway` (a later change can reuse the same grant step).
- Non-OpenID Proxmox realms (`pve`, `pam`, `ldap`, `ad`).
- Separate local Bellhop logins for several people without an identity
  provider.
- Revoking a creator's grant when the VM changes hands, or reconciling grants
  for VMs created before this feature.
