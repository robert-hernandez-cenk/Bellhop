# Feature Specification: Audience-Named Default Group Ladder

**Feature Branch**: `issue-97-audience-group-ladder`

**Created**: 2026-10-05

**Status**: Draft

**Input**: User description: "#97 — change the default Authentik groups. bellhop-users -> bellhop-admin-family; bellhop-app-users -> bellhop-friends-family; bellhop-app-users-open -> bellhop-public; add bellhop-public-readonly. Stored tiers on the old names are renamed once, unless the operator pinned the old ladder."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - New operator gets tiers named after their audience (Priority: P1)

An operator installs Bellhop and does not configure a group ladder. The access tiers Bellhop offers for gating an app say who each one is for, lowest (fewest apps reachable) to highest:

| Tier | Audience |
|---|---|
| `bellhop-public-readonly` | The most constrained tier: members reach only the apps gated here. |
| `bellhop-public` | Members of the public using an external, public-facing site. Self-created accounts are acceptable here. |
| `bellhop-friends-family` | Friends and family the operator shares more with, such as external websites. |
| `bellhop-admin-family` | Household members such as a spouse: more than friends, close to an administrator. |
| `authentik Admins` | Authentik's built-in administrators (unchanged). |

**Why this priority**: This is the change itself. The previous names (`bellhop-app-users-open`, `bellhop-app-users`, `bellhop-users`) did not say who belonged in each tier, and there was no tier narrower than the open one.

**Independent Test**: With no ladder configured, list the access tiers (web UI dropdown, Settings help, or a `sync-authentik` dry run) and confirm they are the five tiers above, in order.

**Acceptance Scenarios**:

1. **Given** no ladder is configured, **When** the operator opens the access-tier dropdown for an app, **Then** it offers the five tiers above, lowest to highest.
2. **Given** no ladder is configured and an app is gated at `bellhop-public`, **When** the operator runs the Authentik sync, **Then** the app is bound to `bellhop-public`, `bellhop-friends-family`, `bellhop-admin-family`, and `authentik Admins` — not to `bellhop-public-readonly`.
3. **Given** no ladder is configured and an app is gated at `bellhop-public-readonly`, **When** the operator runs the Authentik sync, **Then** the app is bound to all five tiers.
4. **Given** none of the new groups exist in Authentik yet, **When** the operator runs the Authentik sync dry run, **Then** the missing groups are reported by name and none are created.

---

### User Story 2 - Existing operator on the old defaults is carried over (Priority: P1)

An operator who ran Bellhop on the previous default ladder, without pinning it, upgrades. Their gated apps were stored at `bellhop-app-users-open`, `bellhop-app-users` or `bellhop-users`. On the first open of the inventory after upgrading, each of those stored tiers is renamed to its successor, so every app keeps the same relative position on the ladder. The operator renames the matching groups in Authentik, runs the sync, and nothing else needs re-tiering.

**Why this priority**: Without it, every gated app on an unpinned deployment falls off the ladder at upgrade and stops being maintained until re-tiered by hand.

**Independent Test**: Open an inventory whose entries use the old names with no ladder configured; confirm the stored tiers now read the new names and one log line per changed table reports the rename.

**Acceptance Scenarios**:

1. **Given** entries stored at `bellhop-users`, `bellhop-app-users` and `bellhop-app-users-open` and no ladder configured, **When** the inventory is opened, **Then** they read `bellhop-admin-family`, `bellhop-friends-family` and `bellhop-public` respectively.
2. **Given** the rename has already happened, **When** the inventory is opened again, **Then** nothing changes and nothing is logged.
3. **Given** entries stored at `authentik Admins`, at no tier, or at a name that is not an old default, **When** the inventory is opened, **Then** those entries are unchanged.
4. **Given** the renamed entries but Authentik groups still on the old names, **When** the operator runs the Authentik sync dry run, **Then** the new group names are reported as missing and nothing is created, until the operator renames the groups in Authentik.

---

### User Story 3 - Operator who pinned a ladder is left alone (Priority: P1)

An operator who configured the ladder explicitly (a stored setting or the `AUTHENTIK_GROUP_LADDER` environment variable) upgrades. Whatever names they pinned stay in effect and none of their stored tiers change.

**Why this priority**: Renaming a stored tier that the pinned ladder still lists would knock that app off the ladder — the opposite of the migration's purpose.

**Independent Test**: Pin the old ladder, open an inventory whose entries use the old names, and confirm every stored tier is unchanged and a sync dry run reports no off-ladder apps.

**Acceptance Scenarios**:

1. **Given** the ladder pinned to the previous default names, **When** the inventory is opened, **Then** no stored tier changes.
2. **Given** a ladder pinned to the new names explicitly, **When** an inventory with old names is opened, **Then** the old names are renamed, exactly as under the default.
3. **Given** a ladder that keeps one old name and contains the successor of another (e.g. `bellhop-app-users-open,bellhop-friends-family,...`), **When** the inventory is opened, **Then** only the pair whose old name is absent and successor present is renamed.

### Edge Cases

- A stored tier of `authentik Admins` is on both ladders and never changes.
- The one-time legacy upgrade from the old "requires auth" flag assigns the ladder's top rung, which is `authentik Admins` in both the old and new defaults, so its outcome is unchanged.
- A ladder that contains neither the old name nor its successor (a fully custom ladder): no rename; any old-named entries remain off-ladder and are reported by the sync as today.
- Web UI permissions, user/group records, and the administrator group (`bellhop-admins`) refer to Authentik groups too, but are operator-defined, not ladder defaults; they are not touched.
- A deployment whose real Authentik groups still carry the old names after the rename sees those names reported as missing by the sync until it renames them; existing Applications are not deleted in the meantime.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: When no ladder is configured, the system MUST use the default ladder `bellhop-public-readonly`, `bellhop-public`, `bellhop-friends-family`, `bellhop-admin-family`, `authentik Admins`, in that order from lowest to highest.
- **FR-002**: When a ladder is configured explicitly, the system MUST use it unchanged.
- **FR-003**: On opening the inventory, the system MUST rename stored access tiers on hosts, guests, and external sites according to the pairs `bellhop-users` → `bellhop-admin-family`, `bellhop-app-users` → `bellhop-friends-family`, `bellhop-app-users-open` → `bellhop-public`.
- **FR-004**: Each rename pair MUST apply only when the effective ladder (stored setting, overridden by the environment variable, else the default) does not contain the old name and does contain its successor.
- **FR-005**: The rename MUST be idempotent: a second open changes nothing. It MUST log a line naming the table, count, and pair only when it changes rows, and MUST NOT log otherwise.
- **FR-006**: The rename MUST NOT touch any stored value other than an exact old default name, and MUST NOT touch any table other than the inventory's hosts, guests, and external sites.
- **FR-007**: The Authentik sync MUST NOT create or rename any group; a needed group that does not exist MUST be reported as missing, as today.
- **FR-008**: The documentation that states the default ladder (configuration reference, environment-variable reference, Settings page help and placeholder, networking guidance) MUST state the new default, describe each tier's intended audience, and give the upgrade path: rename the groups in Authentik (stored tiers are renamed automatically when the ladder is not pinned), or keep the old names by pinning the old ladder.
- **FR-009**: The administrator group default (`bellhop-admins`) MUST NOT change.
- **FR-010**: Example data (demo inventory, tests) MUST use the new tier names.

### Key Entities

- **Group ladder**: An ordered list of Authentik group names, lowest audience to highest. An app gated at one rung is reachable by members of that rung and every rung above it.
- **Access tier (stored on an inventory entry)**: The name of the one ladder rung an app is gated at.
- **Rename pair**: An old default tier name and its successor, applied to stored tiers on open under FR-004.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A fresh deployment with no ladder configured shows exactly five access tiers in the documented order, and zero tiers carrying a previous default name.
- **SC-002**: An unpinned deployment on the old defaults has 100% of its old-named stored tiers renamed on first open, and zero apps reported off-ladder by the sync afterward.
- **SC-003**: A deployment that pinned the old ladder has zero stored tiers changed by the upgrade.
- **SC-004**: Zero documents in the repository describe a previous default name as the current default.

## Assumptions

- Operators create or rename the groups in Authentik themselves; Bellhop never creates ladder groups.
- Setting up an Authentik self-enrollment flow that places new sign-ups in `bellhop-public` is out of scope (follow-up issue).
- "Read-only" in `bellhop-public-readonly` describes the tier's intended audience; Bellhop enforces only which apps a tier reaches, not what members can do inside an app.
- Historical specs under `specs/001-*` and others describe past defaults and are records, not current documentation; they are not rewritten.
