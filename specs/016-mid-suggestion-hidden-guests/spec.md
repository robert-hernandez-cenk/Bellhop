# Feature Specification: MID suggestions that account for hidden guests

**Feature Branch**: `issue-54-mid-suggestion-hidden-guests`

**Created**: 2026-10-03

**Status**: Draft

**Input**: Issue #54: "when creating a guest (tested with create VM) a non-admin gets an MID suggestion which already has been assigned."

## Background

The web UI's guest-creating forms (create LXC, create VM, install app, deploy VPN gateway, and
migrate guest) fill in a suggested Machine ID (MID) for the selected host: the lowest MID in
the supported range that no inventory guest on that host is using. The suggestion is worked
out from the inventory the signed-in user can see. A user restricted by per-resource group
permissions sees only some guests, so a guest hidden from them does not count as using its
MID. They are offered that MID, and the create fails later with an error they cannot explain,
because the guest in the way is invisible to them.

The same blind spot affects the warning shown when a user types an MID that is already taken,
and migrate guest's check of whether the guest's current MID is free on the target host.

A related leak: when the create step itself finds the MID's VMID already in use, its error
names the inventory guest holding it, even when the user is not allowed to see that guest.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Restricted user gets a free MID (Priority: P1)

A user whose group has a restricted view opens a create form and picks a host. The MID field
is filled with an MID that no inventory guest on that host is using, including guests the
user cannot see.

**Why this priority**: this is the reported bug. The suggested value is the one users accept
without thinking, and today it can be guaranteed to fail.

**Independent Test**: with a group whose rules hide a guest using the lowest occupied MID on a
host, sign in as (or impersonate) that group, open Create VM, pick the host, and check that
the suggested MID is not the hidden guest's.

**Acceptance Scenarios**:

1. **Given** host `pve1` with guests on MIDs 2 and 3, and the user's group cannot see the guest
   on MID 2, **When** the user picks `pve1` in any create form, **Then** the MID field shows 4.
2. **Given** the same setup, **When** an admin picks `pve1`, **Then** the MID field shows 4
   (unchanged behavior).
3. **Given** a migrate-guest form where the selected guest's current MID is used on the target
   host by a guest the user cannot see, **When** the user picks that target host, **Then** the
   MID field falls back to the next free MID on that host instead of the colliding one.

---

### User Story 2 - Collision warning covers hidden guests without naming them (Priority: P2)

When a user types an MID that is already taken on the selected host, the form warns them. If
they can see the guest holding it, the warning names that guest, as it does today. If they
cannot, the warning says only that the MID is already in use on that host.

**Why this priority**: a user who overrides the suggestion should get the same early warning,
but the warning must not reveal a guest they are blocked from.

**Independent Test**: as the restricted user from Story 1, type MID 2 for `pve1` and leave the
field. Check that a warning appears and contains no guest name.

**Acceptance Scenarios**:

1. **Given** MID 2 on `pve1` is used by a guest hidden from the user, **When** they enter 2 and
   leave the field, **Then** they see "MID 2 is already in use on pve1." with no guest name.
2. **Given** MID 3 on `pve1` is used by guest `media`, which the user can see, **When** they
   enter 3 and leave the field, **Then** the warning names `media` and its VMID as today.
3. **Given** MID 9 is free on `pve1`, **When** they enter 9, **Then** no warning appears.

---

### User Story 3 - Create errors don't name hidden guests (Priority: P3)

When a web-triggered preview or apply finds that the chosen MID's VMID is already taken, the
error names the guest holding it only if the user can see that guest.

**Why this priority**: closes the remaining leak of a hidden guest's name. It is rarer once
Stories 1 and 2 steer users away from taken MIDs, but still reachable by a determined user or
a guest added after the form loaded.

**Independent Test**: as the restricted user, preview install app on `pve1` with MID 2. The
error says the VMID is in use and does not name the hidden guest. The same action from the
CLI still names it.

**Acceptance Scenarios**:

1. **Given** the VMID for MID 2 on `pve1` is in use by a guest the user cannot see, **When**
   they preview or apply a web action that checks VMID availability, **Then** the error says
   the VMID is already in use on `pve1` and does not contain the guest's name.
2. **Given** the conflicting guest is visible to the user, **When** the same happens, **Then**
   the error names the guest, as today.
3. **Given** the same conflict, **When** the operator runs the action from the CLI or the MCP
   server, **Then** the error names the guest, as today.

### Edge Cases

- A host the user cannot see: it is not offered in the form, and the occupied-MID list
  returned to the user does not include it.
- A host with no MID scheme: no suggestion is made, as today.
- Every MID in the supported range taken: the MID field is left empty, as today.
- Guests whose VMID falls outside the host's MID range (a hand-numbered guest): they do not
  occupy an MID, as today.
- The occupied-MID list fails to load: the form must not silently fall back to suggesting
  from the user's filtered view. It suggests nothing (empty MID field) and shows an error,
  so the user enters an MID themselves, and the apply-time check still protects them.
- A VMID that is live on the host but missing from the inventory: not covered by the
  suggestion (inventory only, as today); the apply-time check still catches it.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST give a signed-in web user, for each host they are allowed to
  see, the set of MIDs occupied on that host by any inventory guest, whether or not the user
  can see those guests.
- **FR-002**: That set MUST contain only MID numbers. It MUST NOT reveal guest names, VMIDs
  beyond what the MID implies, IP addresses, or any other guest detail, and MUST NOT include
  hosts the user is not allowed to see.
- **FR-003**: Every web form with an MID field MUST suggest the lowest MID in the supported
  range that is not in the selected host's occupied set.
- **FR-004**: Migrate guest MUST treat the selected guest's current MID as unavailable on the
  target host when it is in that host's occupied set, and fall back to FR-003's suggestion.
- **FR-005**: The MID collision warning MUST appear for any MID in the selected host's
  occupied set. It MUST name the occupying guest only when that guest is visible to the user;
  otherwise it MUST state only that the MID is already in use on that host.
- **FR-006**: When a web-triggered preview or apply finds the requested VMID already in use,
  the error MUST omit the occupying guest's name unless the user is allowed to see that guest.
  Admins see every guest, so their errors are unchanged.
- **FR-007**: CLI and MCP server behavior MUST be unchanged: their VMID-in-use errors keep
  naming the occupying guest.
- **FR-008**: If the occupied-MID set cannot be loaded, the form MUST NOT fall back to a
  suggestion based only on the user's visible guests. It MUST leave the MID field empty and
  show the load error.

### Key Entities

- **Occupied MIDs**: per host, the MID numbers held by inventory guests on that host. Derived
  from the full inventory; scoped to the hosts the requesting user may see.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For a restricted user, 0 suggested MIDs collide with an existing inventory guest
  on the selected host, across all five MID-bearing forms.
- **SC-002**: For a restricted user, 0 warnings or errors in the provisioning flow contain the
  name of a guest that user is not allowed to see.
- **SC-003**: Admin, CLI, and MCP behavior for MID suggestion and VMID-in-use errors is
  unchanged (existing tests pass without modification to their expectations).

## Assumptions

- Revealing which MID numbers are occupied on a host the user can already provision on is
  acceptable. The user already learns this one MID at a time from apply-time errors, and it
  says nothing about which guests exist or what they run.
- The occupied-MID data is loaded once when the form opens, together with the inventory, as
  the inventory itself is. A guest created by someone else after that is caught by the
  apply-time check, as today.
- Admin bypass of permissions works exactly as it does elsewhere in the web UI, including
  under impersonation (an impersonating admin gets the impersonated group's view).
- Live-but-untracked VMIDs and an MID equal to the host's own last address octet stay out of
  scope.
