# Feature Specification: Bellhop-Managed Web Login

**Feature Branch**: `issue-85-managed-web-login`

**Created**: 2026-10-05

**Status**: Draft

**Input**: User description: "Issue #85: when Bellhop runs as a Proxmox guest that Bellhop manages, derive its web login from that guest's own OpenID client instead of a separate CLI step and four hand-managed settings; move the custom OIDC settings to their own Settings tab for installs not managed this way."

## Background

Bellhop's web UI signs people in through its own OpenID client in the
identity provider. When Bellhop itself runs as a guest in the inventory,
that guest already gets an OpenID client through the ordinary guest
interface (OIDC auth mode, callback URLs, the identity-provider sync). Yet
using that client for Bellhop's own sign-in takes a separate step: a command
line step (`configure-web-login <entry> --apply`) copies the client's issuer,
ID, callback URL and secret into four settings on the General tab of the
Settings page.

This feature removes that step for the managed case: marking Bellhop's own
guest is enough. The four hand-managed settings stay for installs that
Bellhop does not manage in Proxmox (a workstation, or a host outside the
inventory), on a tab that says so. The design was agreed with the operator
on issue #85: an explicit flag identifies Bellhop's own guest, and the
custom settings win when both are present.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Mark Bellhop's own guest and sign in (Priority: P1)

An administrator whose Bellhop runs as a managed guest already has that guest
gated by OIDC with a callback URL ending in `/auth/callback`. They flag the
guest as "this is Bellhop" in the guest editor. With no custom login
settings stored, the next sign-in at `/auth/login` uses that guest's OpenID
client, with no command and no settings entered.

**Why this priority**: this is the feature: it removes the manual wiring.

**Independent Test**: with an identity-provider test double holding the
guest's client, flag the guest, leave the four custom settings empty, and
complete a sign-in; the session is created for the signed-in user.

**Acceptance Scenarios**:

1. **Given** a guest flagged as Bellhop, OIDC-gated, with callback
   `https://bellhop.example.com/auth/callback` and its client existing in the
   identity provider, and no custom settings, **When** a person opens
   `/auth/login`, **Then** they are sent to that client's provider and a
   successful callback signs them in.
2. **Given** the same setup, **When** the client's secret is rotated in the
   identity provider and a person signs in again, **Then** sign-in succeeds
   using the new secret without a restart or any settings change.
3. **Given** the web service starts with such a guest, **When** a signed-in
   session is re-checked later, **Then** the re-check uses the managed
   client.
4. **Given** the guest is flagged but not OIDC-gated, or has no callback
   ending in `/auth/callback`, or its client does not exist yet, **When** a
   person opens `/auth/login`, **Then** they see that web login is not
   configured, with the reason, never a secret.

---

### User Story 2 - Custom settings on their own tab (Priority: P2)

An operator running Bellhop outside the inventory opens Settings and finds
the four custom login values on a "Web login" tab, whose text says it is for
installs not managed by Bellhop in Proxmox. The General tab no longer shows
them. The tab says which source is currently in effect: the custom values,
the managed guest (named), or none, with what is missing.

**Why this priority**: it keeps the unmanaged case working and makes the
two modes understandable, but the managed flow (US1) delivers value alone.

**Independent Test**: load the Settings page at desktop and phone width;
confirm the tab, its explanatory text, and the active-source line.

**Acceptance Scenarios**:

1. **Given** any install, **When** an admin opens Settings, **Then** the four
   login values appear only on the "Web login" tab, and General keeps the
   auth mode.
2. **Given** all four custom values are set and a flagged guest also
   qualifies, **When** a person signs in, **Then** the custom values are
   used (they win) and the tab says custom values are in effect.
3. **Given** the custom set is incomplete and a flagged guest qualifies,
   **When** the page loads, **Then** it says the managed guest is in effect
   and names it.
4. **Given** an existing deployment with the four custom values stored,
   **When** this change is installed, **Then** sign-in behaves exactly as
   before.

---

### User Story 3 - Require sign-in with the managed login (Priority: P2)

An administrator who set up the managed login switches the auth mode to
"oidc" (sign-in required). The existing safeguards still apply: it is
refused until they have proved they can sign in, but a working managed login
counts as configured, so they are not told to set four settings they do not
need.

**Why this priority**: without it the managed login could never be made
mandatory from the Settings page.

**Independent Test**: PATCH the auth mode to oidc with only a managed guest
configured, before and after the requester has a session.

**Acceptance Scenarios**:

1. **Given** a usable managed login and a requester signed in as an admin,
   **When** the auth mode is set to oidc, **Then** it is accepted.
2. **Given** a usable managed login but no web-login session for the
   requester, **When** the mode is set to oidc, **Then** it is refused as
   today (sign in first).
3. **Given** neither custom values nor a usable managed login, **When** the
   mode is set to oidc, **Then** it is refused with a message that names the
   two ways to configure it (flag Bellhop's own guest, or fill in the Web
   login tab) and no longer mentions `configure-web-login`.
4. **Given** the mode is already oidc with a complete custom set in effect,
   **When** a save clears one custom value, **Then** it is refused as today.
   When a managed guest is the one in effect, an unrelated custom-value
   change is not refused.

---

### User Story 4 - The old command is gone (Priority: P3)

`configure-web-login` no longer exists, and no documentation points to it.

**Why this priority**: housekeeping that follows from US1; the project is
pre-release, so there is no compatibility shim.

**Independent Test**: the CLI lists no such command; docs contain no
references.

**Acceptance Scenarios**:

1. **Given** the CLI, **When** `configure-web-login` is run, **Then** it is
   reported as an unknown command.

---

### Edge Cases

- More than one guest flagged as Bellhop: inventory validation rejects the
  save (as for the proxy and Authentik flags), naming the entries.
- The flagged guest's gate or callback is edited afterwards: the managed
  login follows the edit on the next sign-in or re-check, and an edit that
  makes it unusable shows the not-configured reason.
- The identity provider is unreachable when a sign-in begins and no value is
  yet resolved: web login is reported unavailable (the provider could not be
  reached), not "not configured". Once a value has been resolved, an
  unreachable provider keeps the last good value in use.
- Only some custom values are set alongside a flagged guest: the custom set
  is incomplete, so the managed guest is used; the partial values are not
  mixed in.
- The flagged guest is deleted or un-flagged while sessions exist: the next
  re-check finds no usable login and, as today, signs those sessions out.
- A client secret never appears in any response, page, log line, error
  message, job record, or inventory snapshot, including the resolved managed
  value.
- A non-admin web user cannot set or clear the flag; the flag is changed only
  through the admin-only guest edit paths.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: An administrator MUST be able to flag at most one guest as
  Bellhop's own, through the web guest editor and the MCP edit-guest tool,
  and to clear the flag. The flag MUST be saved with the inventory and
  survive restarts.
- **FR-002**: Inventory validation MUST reject more than one guest flagged
  as Bellhop's own, naming them. Flagging a host entry is out of scope.
- **FR-003**: Only an administrator MUST be able to change the flag, on the
  same footing as the other OIDC fields of a guest.
- **FR-004**: When the four custom login settings are not all set and a
  flagged guest is OIDC-gated and has a callback URL whose path is exactly
  `/auth/callback`, the web login MUST use that guest's OpenID client:
  issuer, client ID and secret read from the identity provider, and that
  callback URL as the redirect URI.
- **FR-005**: When all four custom settings are set, they MUST be used
  regardless of any flagged guest. Partial custom values MUST NOT be mixed
  with managed ones.
- **FR-006**: The managed client's values MUST be read again from the
  identity provider at service start, at the start of every sign-in, and
  before a session re-check that is due, so a rotated secret or an edited
  callback takes effect without a restart. They MUST be held only in the
  running process and never stored.
- **FR-007**: If the identity provider cannot be reached while refreshing,
  the last successfully resolved managed value MUST stay in use, and the
  failure MUST be logged without secret material.
- **FR-008**: When neither source is usable, the sign-in page MUST say web
  login is not configured and list what is missing by name, never a value.
- **FR-009**: The four custom login settings MUST move from the General tab
  to a new "Web login" tab. The tab MUST state that it is intended for
  installs not managed by Bellhop in Proxmox, and MUST show which source is
  in effect (custom, the named managed guest, or none and why). The auth mode
  stays on General.
- **FR-010**: Settings responses MUST expose the active source and, for the
  managed source, the guest's name and callback URL; never the client secret
  or any other secret.
- **FR-011**: The rule that refuses switching the auth mode to oidc until the
  requester has signed in MUST count a usable managed login as configured,
  and MUST keep its other checks unchanged. Its refusal message MUST name the
  two ways to configure web login and MUST NOT mention `configure-web-login`.
- **FR-012**: The rule that refuses clearing login settings while the mode is
  oidc MUST apply only when the custom settings are what is in effect.
- **FR-013**: The `configure-web-login` command, its tests and its
  documentation MUST be removed.
- **FR-014**: Existing deployments with stored custom settings MUST sign in
  exactly as before.
- **FR-015**: The MCP authorization server MUST continue to derive its
  issuer origin from the resolved web login, whichever source supplies it.
- **FR-016**: Documentation (README links, `docs/`, nested guidance files)
  MUST describe the flag, the precedence, the new tab and the removed
  command, using example values only.

### Key Entities

- **Bellhop-own guest flag**: a yes/no marker on a guest entry, at most one
  per inventory.
- **Managed web login**: the issuer, client ID, secret and callback URL
  derived from the flagged guest and held in memory only.
- **Active web-login source**: custom, managed (with guest name), or none
  (with missing items).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An administrator with a managed Bellhop guest completes
  "enable web login" with one action (flagging the guest) and zero commands
  or pasted values.
- **SC-002**: After a client-secret rotation in the identity provider, the
  next sign-in succeeds with no service restart and no settings change.
- **SC-003**: An install with the four custom values stored before this
  change signs in unchanged (no regression across the existing sign-in test
  suite).
- **SC-004**: Across all responses, pages and logs produced in the test
  suite for both sources, no client secret value appears.
- **SC-005**: The Web login tab and the flag control are fully usable at
  desktop width and at a 640px-or-narrower viewport.

## Assumptions

- Bellhop's own entry is a guest (LXC/VM) in the inventory; Bellhop running
  on a Proxmox host entry is out of scope.
- The operator runs one Bellhop service and one web origin (a recorded
  single-operator assumption): exactly one flagged guest, one callback URL.
- Creating or installing Bellhop's own container is a separate effort
  (issue #67) and does not flag the guest automatically.
- The identity provider client is created and maintained by the existing
  guest interface and sync; this feature only reads it.
- Pre-release project: removing the command needs no deprecation period.
- Client secrets are never persisted by this feature; the existing secret
  store is unchanged.
