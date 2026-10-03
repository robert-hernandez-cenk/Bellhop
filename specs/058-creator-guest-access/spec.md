# Feature Specification: Creator access to guests

**Feature Branch**: `issue-58-creator-guest-access`

**Created**: 2026-10-03

**Status**: Draft

**Input**: Issue #58 — "Guests a user creates should be accessible to that user in Bellhop."

## Background

Bellhop's per-resource permissions (issue #13) are group-based: an admin puts
an identity-provider group in `allow-list` mode (the group sees only the
hosts/guests listed for it) or `block-list` mode (the group sees everything
except what is listed), and a user's access is the intersection across all of
their groups. A guest a non-admin user creates through the web UI is on no
allow-list, so a user in an allow-list group creates a guest and immediately
loses sight of it — on the Dashboard, in its actions, and in job history —
until an admin edits the group's rule by hand. Issue #53 solved the
Proxmox-side half of this (the creator gets a Proxmox permission on their VM);
this feature is the Bellhop-side half.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A restricted user keeps access to the guest they create (Priority: P1)

A user whose group is in allow-list mode (and who is allowed on a Proxmox host)
creates a guest on that host from the web UI. As soon as the create job
succeeds, the new guest appears on their Dashboard and they can act on it
(power, edit, update, configure, delete, see and control its jobs) exactly as
if an admin had added it to their group's allow-list — without any admin step.

**Why this priority**: This is the whole bug. Without it, self-service guest
creation is unusable for restricted users.

**Independent Test**: Configure a group in allow-list mode containing only a
host; as a member of that group, create a guest on that host; confirm the guest
is listed, its status is shown, and a guest-scoped action on it is accepted.

**Acceptance Scenarios**:

1. **Given** user A belongs only to group G in allow-list mode listing host H,
   **When** A creates guest X on H through the web UI and the job succeeds,
   **Then** X appears in A's inventory view and guest status, and A can run
   guest-scoped actions on X.
2. **Given** the situation in scenario 1, **When** user B (also only in G, not
   the creator) views the inventory, **Then** X is not visible to B.
3. **Given** A created X, **When** A views job history, **Then** jobs whose
   target is X (e.g. a later update or power action on X) are visible to A and
   A can cancel/answer them.
4. **Given** A belongs to G (allow-list, not listing X) and to group K in
   block-list mode that explicitly lists X, **When** A views the inventory,
   **Then** X is hidden from A — an explicit block wins over creator access.

---

### User Story 2 - Creator access survives renames, syncs, and migrations (Priority: P1)

The creator's access is tied to the person, not to the spelling of their
login name, and it stays attached to the guest through Bellhop's routine
operations.

**Why this priority**: The identity provider in real use has already renamed
users' login names once; a grant tied to the login name would silently vanish
on the next rename, re-creating the original bug with no warning.

**Independent Test**: Create a guest as a user, change that user's login name
(keeping their stable identity), and confirm they still see the guest; run an
inventory sync and a guest migration and confirm the creator is unchanged.

**Acceptance Scenarios**:

1. **Given** A created X while signed in as login name `a-old`, **When** A's
   login name becomes `a-new` but their stable identity is unchanged, **Then**
   A still has creator access to X.
2. **Given** X has a recorded creator, **When** an inventory sync runs, X is
   re-created by a later upsert, or X is migrated to another host, **Then** X's
   recorded creator is unchanged.
3. **Given** X has a recorded creator, **When** X is deleted (leaves the
   inventory), **Then** the creator record goes with it, and a different guest
   later created under the same name does not inherit it.

---

### User Story 3 - Admins can see who created a guest (Priority: P2)

In the guest's Advanced dialog, anyone who can see the guest sees a read-only
"Created by" value, so an admin can understand why a user can reach a guest
that is not on their group's allow-list.

**Why this priority**: Explains an otherwise surprising access result; not
required for the core fix.

**Independent Test**: Open the Advanced dialog for a guest with and without a
recorded creator; confirm the value (or its absence) is shown and cannot be
edited.

**Acceptance Scenarios**:

1. **Given** X has a recorded creator, **When** the Advanced dialog for X is
   opened, **Then** a read-only "Created by" line shows the creator's login
   name as recorded.
2. **Given** a guest has no recorded creator, **When** its Advanced dialog is
   opened, **Then** no "Created by" value is shown (or an explicit "unknown"),
   and nothing implies one exists.

---

### User Story 4 - Existing guests get their creators back-filled (Priority: P2)

An operator runs a one-time command that works out who created each existing
guest from Bellhop's job history and records it, so users who already created
guests before this feature regain access without an admin editing allow-lists.

**Why this priority**: Real restricted users already created guests before
this feature existed; without a backfill those guests stay hidden from them.

**Independent Test**: With a job history containing successful create jobs by
several users, run the command as a dry run, check the reported plan, then
apply it and confirm the matching guests now carry their creators.

**Acceptance Scenarios**:

1. **Given** a successful web-UI create job by user A for guest X that still
   exists in inventory (same host, same derived VMID, same name), **When** the
   backfill is applied, **Then** X records A as its creator.
2. **Given** the backfill is run without the apply flag, **Then** it changes
   nothing and prints every guest it would update plus every job it skipped,
   with the reason.
3. **Given** a job recorded under a login name that no longer exists in the
   identity provider (it was renamed), **When** the operator supplies an
   explicit `old=new` mapping for that name, **Then** the job is attributed to
   the mapped current user; **when** no mapping is supplied, the job is
   skipped and reported as an unknown user.
4. **Given** a guest that already has a recorded creator, **When** the
   backfill runs, **Then** that creator is never overwritten.
5. **Given** a job triggered from the MCP server, by the CLI, by no recorded
   user, or a job that did not succeed, **Then** the backfill never uses it.

---

### Edge Cases

- A guest whose name matches a create job but whose host/VMID differs (the
  original was deleted and a different guest now uses the name, or the VMID
  was reused): not matched; reported as skipped.
- Several successful create jobs match the same current guest (it was created,
  deleted, and re-created identically): the most recent successful job wins.
- The create job succeeds in Proxmox but recording the guest into inventory
  fails: the guest has no creator; a later inventory sync adds it without one;
  the backfill can attribute it afterward if the job itself succeeded. (A
  failed job is never used, so a guest whose recording failed the job stays
  unattributed — reported, fixed by an admin's allow-list edit.)
- An admin creates a guest: the creator is recorded (harmless — admins bypass
  rules anyway), so it stays meaningful if they later lose admin rights.
- An admin creates a guest while impersonating a group: the creator is the
  real admin, never the impersonated group.
- An admin impersonating a group views a guest the admin created: creator
  access is ignored, so the view shows exactly what the group sees.
- A request whose identity carries no stable identifier (local development or
  test identities, the synthetic local operator): creator matching falls back
  to the login name for such identities; the synthetic local operator never
  records a creator.
- The creator later leaves every restricted group: creator access is moot
  (they are unrestricted); nothing changes.
- The recorded login name becomes stale after a rename: access still works by
  stable identity; the "Created by" display shows the name as recorded.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Each guest MUST be able to carry an optional creator record
  consisting of the creator's stable identity-provider user identifier (when
  known) and their login name at the time it was recorded.
- **FR-002**: When a guest is created through the web UI by a real signed-in
  person — create LXC, create VM, install app, deploy VPN gateway — the system
  MUST record that person as the guest's creator when the guest is written to
  inventory. The real person is used even while an admin is impersonating a
  group.
- **FR-003**: Guests created through the MCP server, the CLI, or by the
  synthetic local operator MUST NOT get a creator record.
- **FR-004**: For a caller who is the guest's creator, the guest MUST count as
  listed on every allow-list group the caller belongs to. Block-list groups
  that explicitly list the guest MUST still deny access. Groups with no rule
  and admin bypass are unchanged.
- **FR-005**: A caller MUST be recognised as the creator by stable identifier
  when both the request identity and the creator record carry one; only when
  either side lacks a stable identifier MUST the login names be compared
  instead.
- **FR-006**: FR-004 MUST apply everywhere guest access is decided: the
  inventory and guest-status views, every guest-scoped action and route check,
  and job visibility and control (list, view, live log stream, cancel, answer,
  dismiss) for jobs whose target is that guest.
- **FR-007**: While an admin is impersonating a group, creator access MUST be
  ignored for every check.
- **FR-008**: A guest's creator record MUST survive inventory sync, repeat
  inventory upserts of the same guest, and guest migration; it MUST disappear
  when the guest leaves the inventory.
- **FR-009**: The creator record MUST NOT be settable or changeable through
  the Dashboard guest edit or the MCP guest-edit tool; any such field in an
  edit request MUST be ignored or rejected, never stored.
- **FR-010**: The guest Advanced dialog MUST show the recorded creator's login
  name read-only when one exists, and show nothing misleading when none does,
  at both desktop and mobile widths.
- **FR-011**: The system MUST provide a one-time backfill command, dry-run by
  default and applying only with an explicit apply flag, that attributes
  existing guests to creators from successful web-UI create jobs in job
  history.
- **FR-012**: The backfill MUST match a job to a guest only when the job's
  host, the VMID derived from its machine ID, and the guest name all match a
  guest currently in inventory; when several jobs match one guest, the most
  recent successful one wins.
- **FR-013**: The backfill MUST resolve each job's recorded login name to a
  current identity-provider user (obtaining their stable identifier), accept
  operator-supplied `old=new` login-name mappings for renamed users, and skip
  and report any name it cannot resolve.
- **FR-014**: The backfill MUST never overwrite an existing creator record,
  never use failed/cancelled/interrupted jobs or jobs attributed to the MCP
  server or to no user, and MUST report every guest it updates and every job
  it skips with a reason.

### Key Entities

- **Guest creator record**: attached to one guest; holds the creator's stable
  identity-provider user identifier (optional) and login name as recorded.
  Lives and dies with the guest's inventory entry.
- **Caller identity**: the signed-in person on a request — login name, groups,
  and (when the identity provider supplies it) a stable user identifier;
  marked as impersonating when an admin is viewing as a group.
- **Create job**: an existing job-history row for a guest-creating command,
  with its status, arguments (host, machine ID, guest name) and the login name
  of whoever triggered it.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A restricted user who creates a guest can see and act on it
  immediately after the create job succeeds, with zero admin steps.
- **SC-002**: No user other than the creator gains access to a guest through
  this feature (group-mates included).
- **SC-003**: Renaming a creator's login name in the identity provider removes
  none of their creator access.
- **SC-004**: An explicit block-list entry naming a guest always denies access,
  creator or not.
- **SC-005**: After the backfill is applied, every existing guest with a
  matching successful, attributable create job carries its creator, and every
  unattributed job is listed in the report with a reason.
- **SC-006**: Admin "view as group" shows exactly the group's access, unaffected
  by guests the admin created.

## Assumptions

- The identity provider's forward-auth headers include a stable per-user
  identifier alongside the login name (the reverse proxy already forwards it).
- Guest names are not editable after creation, so a creator record never needs
  to follow a rename of the guest.
- The job that creates a guest targets its Proxmox host, so the creator already
  had access to that host; this feature does not grant host access.
- The backfill runs from the CLI against the deployment's own job history and
  inventory, reading the identity provider's user list; it is not exposed in
  the web UI or MCP server.
- No web-UI control to revoke or transfer creator access is provided; an admin
  who must take a guest away uses an explicit block-list entry.
- Out of scope: granting the creator's groups, Proxmox-side access (issue #53).
