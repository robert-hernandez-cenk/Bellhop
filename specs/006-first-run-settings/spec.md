# Feature Specification: First-run settings without Authentik

**Feature Branch**: `issue-20-first-run-settings`

**Created**: 2026-09-26

**Status**: Draft

**Input**: GitHub issue #20 — "First-run friction without Authentik: Settings hidden from nav, settings needed before first sync". Found while walking a fresh clone through the README with no Authentik configured (`auto` mode, always-admin local operator).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Reach Settings without Authentik (Priority: P1)

A new operator runs the web UI with no Authentik configured. They are an admin (the local operator), and the Settings page works for them, but the navigation never shows a link to it, because the whole Admin group is hidden whenever Authentik's user directory is unavailable. They should see Settings in the navigation, while Users and Permissions, which really need Authentik, stay hidden.

**Why this priority**: Without the link, the only way to find the page is to already know its address. It is the web UI's only way to set inventory-wide values, and a new operator without Authentik is exactly the person who needs it.

**Independent Test**: Start the web UI with no Authentik configured, open it as the local operator, and check that the navigation shows an Admin group containing Settings only, and that the link opens a working Settings page.

**Acceptance Scenarios**:

1. **Given** an admin and no user directory available, **When** the navigation renders, **Then** it shows the Admin group label with Settings, and does not show Users or Permissions.
2. **Given** an admin and a user directory available, **When** the navigation renders, **Then** it shows Users, Permissions, and Settings under Admin, as today.
3. **Given** a non-admin user, **When** the navigation renders, **Then** it shows no Admin group at all, as today.

---

### User Story 2 - Set settings before the first sync (Priority: P2)

A new operator follows the README from the top. Today the README's Setup section comes before "Inventory-wide settings", so their first `sync-inventory` runs with `nfsServer` unset, skips NFS mount discovery, and they have to run it again after setting the value. The README should have them set settings before the first sync. Every message that reports an unset setting should name both ways to fix it: the CLI command and the web UI's Settings page.

**Why this priority**: Nothing breaks and the fix is already printed, but it is a predictable first-run stumble with a cheap fix.

**Independent Test**: Read the README's Setup section and confirm a settings step comes before the first `sync-inventory`. Run `sync-inventory` against an inventory with `nfsServer` unset and confirm the warning names both `bellhop set-config nfsServer <ip> --apply` and the Settings page.

**Acceptance Scenarios**:

1. **Given** the README, **When** a new operator reads Setup top to bottom, **Then** they reach a step for inventory-wide settings (calling out `nfsServer` before the first `sync-inventory`) before any instruction to run `sync-inventory`.
2. **Given** `nfsServer` unset, **When** `sync-inventory` runs (CLI or web), **Then** both its warning line and its summary line name the `set-config` command and the web UI's Settings page.
3. **Given** any other command that stops or skips work because a setting is unset (`migrate-nfs-mount`, `set-guest-vpn`, `migrate-guest`, `render-status-page`), **When** it reports that, **Then** its message names the Settings page as well as the `set-config` command, worded the same way everywhere.
4. **Given** the README's "Running without Authentik" section, **When** read, **Then** it still says Users and Permissions disappear from the navigation, and also says Settings remains.

---

### User Story 3 - A Settings page a newcomer can read (Priority: P3)

A new operator opens the Settings page on a fresh inventory with no `caddy: true` entry and possibly no host with a MID scheme. They should be able to tell that every setting is optional and what happens while each one is unset. The read-only derived values should say plainly when there is nothing to show yet, not show a bare "none" or nothing at all.

**Why this priority**: This is polish on a page that already works. It matters most once Story 1 makes the page reachable for exactly this audience.

**Independent Test**: Open the Settings page against an inventory with no `caddy: true` entry and no host `midScheme`. Check the intro text, the per-field markers, and the derived-values section.

**Acceptance Scenarios**:

1. **Given** the Settings page, **When** it renders, **Then** its intro says every setting is optional and each field says what happens while it is unset. It no longer claims that commands fail with a named error while a setting is unset.
2. **Given** the Settings page, **When** it renders, **Then** each field is visibly marked as optional.
3. **Given** no inventory entry has `caddy: true`, **When** the derived values render, **Then** the Caddy host line explains that no entry has `caddy: true` yet.
4. **Given** no host has a MID scheme, **When** the derived values render, **Then** a line explains that no host has a MID scheme yet, so there are no LAN gateways to show.
5. **Given** a `caddy: true` entry and hosts with MID schemes, **When** the derived values render, **Then** they show as today.

### Edge Cases

- A `caddy: true` entry exists but has no IP: the server already treats it the same as no Caddy entry (it returns nothing). The empty-state wording must stay true for this case, e.g. by saying no `caddy: true` entry with an IP exists yet.
- The operator is impersonating a non-admin group: the Admin group is hidden, since admin status reflects the impersonated view. This is unchanged.
- The page is viewed at 640px or narrower: the Optional markers and empty-state lines must not overflow or break the existing layout.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The navigation MUST show the Admin group label and the Settings link to every admin, whether or not a user directory is available.
- **FR-002**: The navigation MUST keep showing the Users and Permissions links only to admins who have a user directory available (unchanged).
- **FR-003**: The impersonation picker's visibility MUST NOT change.
- **FR-004**: The README's Setup section MUST include an inventory-wide settings step before any instruction to run `sync-inventory`, and MUST point out that setting `nfsServer` first lets the first sync discover NFS mounts.
- **FR-005**: The README's "Running without Authentik" section MUST say that Settings stays in the navigation while Users and Permissions disappear.
- **FR-006**: Every message that reports an unset inventory-wide setting and tells the user to run `bellhop set-config` MUST also name the web UI's Settings page. The wording MUST come from one shared place, so all such messages match.
- **FR-007**: The Settings page intro MUST state that every setting is optional, and MUST NOT claim that commands fail while a setting is unset.
- **FR-008**: Each field on the Settings page MUST be marked optional and MUST keep its existing description of what happens while it is unset.
- **FR-009**: When there is no Caddy entry with an IP, the derived-values section MUST say so in words, not show a bare "none".
- **FR-010**: When no host has a MID scheme, the derived-values section MUST say so, not render an empty list.
- **FR-011**: No setting's storage, validation, API response shape, or permission gating may change.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With no Authentik configured, an admin reaches the Settings page from the navigation in one click.
- **SC-002**: A new operator who follows the README Setup section in order runs their first sync with inventory-wide settings already in place, so NFS discovery does not require a second run.
- **SC-003**: 100% of "setting is not set" messages name both the CLI command and the Settings page.
- **SC-004**: On a fresh inventory, the Settings page has no blank or bare-"none" derived values; every empty state is a sentence explaining why it is empty.
- **SC-005**: The navigation and the Settings page render without overflow at both desktop width and 640px or narrower.

## Assumptions

- Settings, like today, needs only admin rights, not Authentik. The server already allows it for the local operator.
- The phrase pointing at the web UI follows the wording `src/lib/app-source.ts` already uses ("or on the Settings page").
- Message changes alter only the text. The conditions under which each message appears stay the same.
- `app-source.ts`'s own custom-repository messages already mention the Settings page and are out of scope.
- Non-goals: changing which settings exist, their validation, Users/Permissions gating, impersonation gating, or any authentication behavior.
