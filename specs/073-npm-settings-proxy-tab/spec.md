# Feature Specification: Nginx Proxy Manager settings on the Proxy tab

**Feature Branch**: `issue-73-npm-settings-proxy-tab`

**Created**: 2026-10-04

**Status**: Draft

**Input**: Issue #73 — "Show Nginx Proxy Manager settings on the Proxy tab only when that driver is selected."

## Background

The Settings page (issue #64) groups settings into one tab per integration:
General, Proxy, Authentik, Cloudflare, Nginx Proxy Manager and GitHub. The
Nginx Proxy Manager tab holds three settings — its API URL, its login email
and its login password (a write-only secret) — and is shown whatever proxy
driver is selected. It exists only because those three settings were
imported from their own `data/*.env` file; the #64 spec gives no other
reason for a separate tab.

Only the Nginx Proxy Manager proxy driver reads these settings. The Proxy
tab already shows and hides its fields according to the driver selected in
its Proxy driver dropdown (the Traefik, Caddy and nginx fields work this
way), using information each driver reports about the settings it reads.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Configure Nginx Proxy Manager from the Proxy tab (Priority: P1)

An admin selects "Nginx Proxy Manager" in the Proxy tab's Proxy driver
dropdown. The Nginx Proxy Manager API URL, email and password fields appear
on the same tab, below the other proxy fields, and the admin sets them
there. There is no separate Nginx Proxy Manager tab any more.

**Why this priority**: This is the whole issue — the settings belong with
the driver that uses them, and an admin choosing that driver should find
its credentials right next to the choice.

**Independent Test**: Open the Settings page, go to the Proxy tab, select
Nginx Proxy Manager, and check that the three fields appear and can be
saved; check the tab bar has no Nginx Proxy Manager tab.

**Acceptance Scenarios**:

1. **Given** the Settings page has loaded, **When** the admin looks at the
   tab bar, **Then** it shows General, Proxy, Authentik, Cloudflare and
   GitHub, in that order, and no Nginx Proxy Manager tab.
2. **Given** the Proxy tab with Nginx Proxy Manager selected (saved or not),
   **When** the admin looks at the tab, **Then** the Nginx Proxy Manager API
   URL, email and password fields are shown after the other proxy fields.
3. **Given** those fields are shown, **When** the admin saves or clears any
   of them, **Then** it saves or clears exactly as it did on the old tab.
4. **Given** the password field, **When** it is shown, **Then** it keeps the
   write-only secret behaviour: masked, never pre-filled, showing only
   whether a password is set and where it comes from, with Replace/Save and
   Clear.
5. **Given** an environment variable pins one of the three settings,
   **When** the field is shown, **Then** it is read-only and labelled "set
   by environment" with its stored copy, as before.

---

### User Story 2 - Fields hidden for every other driver (Priority: P1)

An admin using any other driver (Caddy, Caddy admin API, nginx, HAProxy,
Traefik, or No proxy) never sees the Nginx Proxy Manager fields. Switching
the dropdown back and forth shows and hides them without losing anything.

**Why this priority**: Showing credentials for a proxy that isn't in use is
the confusion the issue reports.

**Independent Test**: On the Proxy tab, select each driver in turn and
check the three fields appear for Nginx Proxy Manager only; type an unsaved
value, switch away and back, and check nothing was cleared or saved.

**Acceptance Scenarios**:

1. **Given** any driver other than Nginx Proxy Manager is selected in the
   dropdown (saved or not), **When** the admin views the Proxy tab,
   **Then** none of the three fields is shown.
2. **Given** stored values for the three settings and another driver
   selected, **When** the admin switches the dropdown to Nginx Proxy
   Manager, **Then** the fields show the stored values (and the password's
   status) again.
3. **Given** an unsaved edit in one of the three fields, **When** the admin
   switches the dropdown away and back without saving, **Then** the edit is
   still there, and no save was sent because of the switch.
4. **Given** the driver list has not loaded yet (or failed to load),
   **When** the Proxy tab renders, **Then** the three fields are hidden.

### Edge Cases

- The default driver is Caddy, so with no `proxyDriver` stored the fields
  are hidden until the admin selects Nginx Proxy Manager.
- Stored Nginx Proxy Manager values are kept when another driver is saved;
  nothing is deleted because a driver no longer uses them.
- At phone width (≤640 px) the five tabs and the Proxy tab's fields lay out
  without horizontal scrolling, as the six tabs did before.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The Settings page MUST NOT have a Nginx Proxy Manager tab; its
  tabs MUST be General, Proxy, Authentik, Cloudflare and GitHub, in that
  order.
- **FR-002**: The Proxy tab MUST contain the Nginx Proxy Manager API URL,
  email and password fields, after its other fields.
- **FR-003**: Each proxy driver MUST report whether it reads the Nginx Proxy
  Manager API settings; only the Nginx Proxy Manager driver does, and a
  driver that says nothing about it counts as not reading them.
- **FR-004**: The settings API's driver list MUST include that information
  for every driver, `false` unless the driver reports otherwise, alongside
  the existing per-driver flags.
- **FR-005**: The page MUST show the three fields only while the driver
  selected in the Proxy driver dropdown — including an unsaved selection —
  reports reading them. The page MUST decide this from the reported driver
  information, never by comparing driver ids.
- **FR-006**: The three fields MUST stay hidden until the driver list has
  loaded, and while it is unavailable.
- **FR-007**: Hiding the fields MUST be display-only: changing the dropdown
  MUST NOT clear a draft or a stored value and MUST NOT send a save.
- **FR-008**: The password field MUST keep issue #64's secret behaviour
  unchanged, and every one of the three fields MUST keep #64's
  environment-pinned behaviour unchanged.
- **FR-009**: The settings definitions MUST list the three settings under
  the Proxy integration group, not a group of their own.
- **FR-010**: The user documentation MUST describe the fields as part of the
  Proxy tab, shown when the Nginx Proxy Manager driver is selected, and no
  longer mention an Nginx Proxy Manager tab; screenshots that show the tab
  bar MUST be regenerated.

### Key Entities

- **Proxy driver information**: what the settings API reports about each
  driver (its id, label, defaults, and which driver-specific settings it
  reads). Gains one more "reads the Nginx Proxy Manager API settings" flag.
- **Settings tab**: a named group of fields on the Settings page. The
  Nginx Proxy Manager tab is removed; its three fields move to Proxy.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With any of the six other drivers selected, 0 Nginx Proxy
  Manager fields are visible anywhere on the Settings page.
- **SC-002**: With Nginx Proxy Manager selected, all 3 fields are visible on
  the Proxy tab and an admin can set the driver and its credentials without
  leaving that tab.
- **SC-003**: Switching the driver dropdown any number of times sends 0
  saves and loses 0 unsaved edits or stored values.
- **SC-004**: The Settings page has 5 tabs, and fits a 640 px-wide screen
  with no horizontal scrolling.

## Assumptions

- Saved values, the settings API's save behaviour, the command-line
  `set-config` command, the MCP server and the Nginx Proxy Manager driver's
  own reading of these settings are unchanged.
- The Settings page does not remember which tab was last open, so no stored
  tab choice needs migrating.
- The Cloudflare tab's similar problem (its token matters only when
  Cloudflare DNS-01 is used) is out of scope; it belongs with issue #72.
