# Feature Specification: Rename the Default Group Ladder to Bellhop Names

**Feature Branch**: `issue-8-bellhop-group-ladder`

**Created**: 2026-09-23

**Status**: Draft

**Input**: User description: "#8 — Rename default Authentik group ladder from homelab-* to bellhop-*. No migration: stored group names are not rewritten."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - New operator gets Bellhop-named groups by default (Priority: P1)

An operator installs Bellhop for the first time and does not configure a group ladder. The access tiers Bellhop offers for gating an app are named after the product (`bellhop-app-users-open`, `bellhop-app-users`, `bellhop-users`, then Authentik's built-in `authentik Admins`), not after the project's old name. The operator creates those groups in Authentik and gates apps with them.

**Why this priority**: This is the change itself. Every new deployment sees these names in the web UI's access-tier dropdown, the CLI output, and the documentation, and the old `homelab-` prefix is a leftover from before the rename to Bellhop.

**Independent Test**: With no ladder configured, list the available access tiers (web UI dropdown, or a `sync-authentik` dry run) and confirm they are the four Bellhop-named tiers in order.

**Acceptance Scenarios**:

1. **Given** no ladder is configured, **When** the operator opens the access-tier dropdown for an app, **Then** it offers `bellhop-app-users-open`, `bellhop-app-users`, `bellhop-users`, and `authentik Admins`, lowest to highest.
2. **Given** no ladder is configured and an app is gated at `bellhop-app-users`, **When** the operator runs the Authentik sync, **Then** the app is bound to `bellhop-app-users`, `bellhop-users`, and `authentik Admins`.
3. **Given** no ladder is configured and none of the `bellhop-*` groups exist in Authentik yet, **When** the operator runs the Authentik sync in dry-run mode, **Then** the missing groups are reported by name and none are created.

---

### User Story 2 - Existing operator keeps their current group names (Priority: P1)

An operator who already runs Bellhop on the old default ladder upgrades. Before upgrading, they set the ladder explicitly to the old `homelab-*` names, as the upgrade notes instruct. After the upgrade, every gated app keeps its access tier and nothing in Authentik changes.

**Why this priority**: Without this path, an upgrade silently stops maintaining every gated app's access bindings. It is as important as the rename itself.

**Independent Test**: Take an inventory whose gated apps use the old names, configure the ladder explicitly to the old names, and confirm an Authentik sync dry run reports no changes.

**Acceptance Scenarios**:

1. **Given** apps gated with `homelab-*` tiers and the ladder set explicitly to the old names, **When** the operator runs the Authentik sync dry run after upgrading, **Then** it reports no bindings to add or remove and no off-ladder apps.
2. **Given** the ladder set explicitly to any custom value, **When** the operator upgrades, **Then** the configured ladder is used unchanged; the new defaults have no effect.

---

### User Story 3 - Existing operator who skips the upgrade step is told what happened (Priority: P2)

An operator upgrades without reading the notes. Their apps are still gated with `homelab-*` tiers, but the default ladder now uses `bellhop-*` names. Bellhop must not change their stored data or silently weaken access; it must tell them which apps no longer match the ladder and how to fix it.

**Why this priority**: This is the failure path of Story 2. It must be safe and visible, but it only affects operators who skipped the documented step.

**Independent Test**: Load an inventory whose gated apps use `homelab-*` tiers with no ladder configured, run the Authentik sync dry run, and confirm the apps are listed as off-ladder and the inventory is unchanged.

**Acceptance Scenarios**:

1. **Given** apps gated with `homelab-*` tiers and no ladder configured, **When** the inventory loads, **Then** it loads successfully and each app's stored tier is unchanged.
2. **Given** the same setup, **When** the operator runs the Authentik sync, **Then** each such app is reported as having an unknown access tier, and its existing Authentik application and bindings are left as they were: not deleted, not rebound.
3. **Given** the same setup, **When** the operator reads the upgrade notes, **Then** they find both recovery paths: set the ladder explicitly to the old names, or rename the groups in Authentik and re-tier each app.

### Edge Cases

- An operator's stored tier is `authentik Admins`: it is on both the old and new default ladders, so that app keeps working with no action.
- An operator configured the ladder explicitly before this change: nothing about their deployment changes.
- A brand-new database created before any app is gated: nothing is stored under old names, so the new defaults apply cleanly.
- The one-time legacy upgrade from the old "requires auth" flag assigns the ladder's top rung. The top rung is `authentik Admins` in both the old and new defaults, so that upgrade's outcome does not change.
- Local development and test sessions that simulate group membership with the old names must be updated to the new names, or they stop matching a ladder rung.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: When no ladder is configured, the system MUST use the default ladder `bellhop-app-users-open`, `bellhop-app-users`, `bellhop-users`, `authentik Admins`, in that order from lowest to highest.
- **FR-002**: The top rung of the default ladder MUST remain `authentik Admins`, Authentik's built-in admin group.
- **FR-003**: When a ladder is configured explicitly, the system MUST use it unchanged, exactly as before this change.
- **FR-004**: The system MUST NOT rewrite, migrate, or otherwise change access tiers already stored on inventory entries.
- **FR-005**: An inventory entry whose stored tier is not on the active ladder MUST continue to load without error, and MUST be reported by the Authentik sync as having an unknown tier, with its existing Authentik application and bindings left in place. This is existing behavior and MUST be preserved.
- **FR-006**: The Authentik sync MUST NOT create any of the new default groups; a needed group that does not exist MUST be reported as missing, as today.
- **FR-007**: The README MUST state the new default ladder and include upgrade notes that describe both recovery paths for an operator on the old defaults: set the ladder explicitly to the old names before upgrading, or rename the groups in Authentik and re-tier each gated app.
- **FR-008**: The project's contributor and runtime guidance MUST be updated wherever it states the default ladder, so no document still names `homelab-*` as the default.
- **FR-009**: The admin group defaults (`bellhop-admins` and `authentik Admins`) MUST NOT change.

### Key Entities

- **Group ladder**: An ordered list of Authentik group names, lowest access to highest. An app gated at one rung is reachable by members of that rung and every rung above it. Either configured by the operator or taken from the default.
- **Access tier (stored on an inventory entry)**: The name of the one ladder rung an app is gated at. Stored as a plain name, so it stays valid only while that name is on the active ladder.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A fresh deployment with no ladder configured shows exactly four access tiers, all Bellhop-named except `authentik Admins`, and zero tiers with a `homelab-` prefix.
- **SC-002**: An existing deployment that sets its ladder to the old names before upgrading sees zero binding changes on its first Authentik sync after the upgrade.
- **SC-003**: An existing deployment that upgrades without configuring its ladder loses zero stored data: every inventory entry's stored tier is identical before and after the upgrade, and every affected app is named in the Authentik sync's report.
- **SC-004**: Zero documents in the repository describe `homelab-*` names as the default ladder after the change.

## Assumptions

- No automatic migration is provided (decided on issue #8). Operators on the old defaults take one of the two documented recovery paths themselves.
- The existing handling of an off-ladder tier (report it, leave its Authentik objects alone, keep the inventory loadable) is sufficient as the safety net for operators who skip the upgrade step; no new warning surface is required.
- The CLI's description and the project's package keywords use "homelab" to describe what the tool is for, not as a default name, and are out of scope.
- Renaming or creating groups inside Authentik is the operator's job; Bellhop never creates ladder groups.
