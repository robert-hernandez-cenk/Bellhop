# Feature Specification: Shared signed-in identity in the web UI

**Feature Branch**: `issue-13-shared-whoami-context`

**Created**: 2026-09-24

**Status**: Draft

**Input**: GitHub issue #13: "web-client: share /whoami through one context instead of per-component fetches", plus the design agreed during brainstorming.

## Background

The web UI learns who is signed in, and what that person may do, from one
server endpoint, the *identity lookup* (`GET /api/whoami`). It answers
with the username, whether the viewer is an admin, the configured admin
group names, whether a user directory is available, whether the viewer is a
local operator, and which group, if any, an admin is currently
impersonating.

Today four places in the UI each ask for the identity lookup on their own:
the navigation sidebar, the Users & Groups page, the guest Advanced
modal's auth-mode controls (two of them, sharing one local helper), and its
OIDC credentials row. Opening the Advanced modal for an OIDC-gated guest
sends up to three identical lookups. Worse, each place keeps whatever
answer it got when it first appeared. After an admin starts or stops
impersonating a group, a control that fetched earlier still reflects the
old identity until it disappears and reappears. One control can look
enabled while another looks disabled. The server checks every permission
on every request, so nothing leaks: the worst case is a control that fails
with "forbidden" when used, or one disabled for no reason.

Starting or stopping impersonation currently reloads the whole browser
page. That hides the staleness, but at the cost of a full reload.

This is cleanup: consistency and removal of duplicated code, not a
performance or security fix.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - One identity answer for the whole page (Priority: P1)

A signed-in user opens any page of the web UI. The UI asks the server who
they are once, and every part of the page that depends on the answer uses
that same answer. Opening the guest Advanced modal, including for an
OIDC-gated guest, asks nothing new.

**Why this priority**: This is the core of the issue. It removes the
duplicated lookups and guarantees that everything on screen agrees about
who the viewer is. Story 2 builds on it.

**Independent Test**: Load the Dashboard with the browser's network panel
open and count identity lookups, then open an OIDC-gated guest's Advanced
modal and count again. Also load the Users & Groups page directly.

**Acceptance Scenarios**:

1. **Given** a signed-in admin opens the web UI, **When** the page finishes loading, **Then** exactly one identity lookup has been sent.
2. **Given** the Dashboard is loaded, **When** the admin opens the Advanced modal for an OIDC-gated guest, **Then** no identity lookup is sent, and the auth-mode controls and OIDC credentials row reflect the admin's identity.
3. **Given** a signed-in non-admin, **When** they open the Advanced modal for an OIDC-gated guest, **Then** the auth-mode controls are disabled and the credentials row shows the "visible to admins" note, as today.
4. **Given** the Users & Groups page is opened, **When** it loads, **Then** it uses the already-known identity for the self-lockout guard and the admin group names, without a lookup of its own.

---

### User Story 2 - Impersonation updates everything together, without a reload (Priority: P2)

An admin picks a group in the sidebar and starts impersonating it, then
later stops. At each change the sidebar, the page being viewed, and any
admin-gated control all switch to the new identity at once. The browser
page does not reload. The page's own data, such as the Dashboard's
inventory, which the server filters by the viewer's permissions, is fetched
again, so it matches the new identity.

**Why this priority**: This fixes the stale-view problem and replaces the
full-page reload. It depends on Story 1's single shared answer.

**Independent Test**: As an admin on the Dashboard, start impersonating a
restricted group and confirm the sidebar banner, the admin nav links, and
the Dashboard's inventory all change with no browser reload. Then stop
impersonating and confirm they all revert.

**Acceptance Scenarios**:

1. **Given** an admin on any page, **When** they start impersonating a group, **Then** exactly one new identity lookup is sent, the browser page is not reloaded, the sidebar shows the impersonation banner, the admin nav links follow the impersonated group's access, and the current page re-fetches its data under the new identity.
2. **Given** an admin is impersonating, **When** they stop impersonating, **Then** exactly one new identity lookup is sent, the page is not reloaded, and the sidebar, admin controls and page data return to the admin's own identity.
3. **Given** the first page load, **When** the identity lookup completes, **Then** the current page is not shown and fetched a second time because of it.

---

### Edge Cases

- **Identity lookup fails on first load.** The UI treats the viewer as not an admin: admin-only controls stay hidden or disabled, never enabled. The sidebar shows that the identity could not be loaded, with a retry action.
- **Identity lookup fails after an impersonation change.** The server-side change has already happened. The UI again fails closed and shows the error with a retry action in the sidebar. The retry must stay reachable even though the "stop impersonating" banner can no longer be shown, so the admin is never stranded.
- **Starting or stopping impersonation itself fails** (server rejects the request). No identity lookup is sent, nothing on the page changes, and the sidebar shows the error, as today.
- **The OIDC credentials row before the identity is known.** It renders nothing until the answer arrives, so a non-admin never briefly sees a reveal button.
- **A development build that mounts components twice** (React's strict mode). It still sends only one identity lookup per page load.
- **Unsaved input on the current page when impersonation changes.** The page is shown afresh under the new identity, so unsaved form input on it is lost. This matches today's behavior, where the full reload also discards it.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The web UI MUST request the identity lookup once per page load and share that single answer with every part of the UI that needs it.
- **FR-002**: The sidebar, the Users & Groups page, the auth-mode controls and the OIDC credentials row MUST read the shared answer and MUST NOT request the identity lookup themselves.
- **FR-003**: The shared answer MUST expose whether it is still loading, the last error if the lookup failed, and a way to request it again.
- **FR-004**: After an admin successfully starts or stops impersonating, the UI MUST request the identity lookup exactly once more, update every consumer from that one answer, and MUST NOT reload the browser page.
- **FR-005**: After a successful impersonation change, the page being viewed MUST be shown afresh so that its own server data is fetched again under the new identity. The sidebar MUST stay in place and update rather than be rebuilt.
- **FR-006**: The first identity lookup of a page load MUST NOT cause the page being viewed to be shown or fetched a second time.
- **FR-007**: When the identity lookup fails or has not completed, every consumer MUST behave as for a non-admin (fail closed). Admin-only controls MUST never be shown or enabled because of a missing answer.
- **FR-008**: When the identity lookup fails, the sidebar MUST show that it failed and offer a retry action, and that action MUST be available whether or not impersonation is active.
- **FR-009**: The OIDC credentials row MUST render nothing until the identity is known.
- **FR-010**: Apart from the number of identity lookups and the removal of the full-page reload on impersonation changes, nothing the user sees or can do may change: the same controls, the same enabled/disabled states, the same text, the same server-side permission checks.
- **FR-011**: The group management section and the auth-group control are out of scope. Neither requests the identity lookup today: the group section receives the admin group names from its page, and the auth-group control derives its admin-equivalent flag from the auth-groups lookup it already needs.
- **FR-012**: The server and the identity lookup's response MUST NOT change.

### Key Entities

- **Identity answer**: the response of the identity lookup, shared across the UI: username, email, groups, impersonated group (if any), local-operator flag, admin flag, configured admin group names, and user-directory capability. Unchanged in shape.
- **Shared identity state**: the single answer plus whether it is loading, the last error, a refresh action, and a counter that changes only after a refresh, used to show the current page afresh.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Loading any page sends exactly 1 identity lookup, down from up to 2 on the Users & Groups page.
- **SC-002**: Opening the guest Advanced modal sends 0 identity lookups, down from up to 3 for an OIDC-gated guest.
- **SC-003**: Starting or stopping impersonation sends exactly 1 identity lookup and 0 full page reloads, and every identity-dependent element on screen shows the new identity in the same update.
- **SC-004**: With the identity lookup failing, 0 admin-only controls are shown or enabled, and a retry is reachable from the sidebar.
- **SC-005**: All of the above hold at a desktop-width viewport and at a viewport 640px wide or narrower.

## Assumptions

- The identity lookup's response shape is stable, and no server change is needed or made.
- A single operator, occasionally with co-users, uses the UI. The server remains the authority for every permission, so a briefly stale view is a usability problem, not a security one.
- Losing unsaved form input when impersonation changes is acceptable. Today's full reload already loses it.
- The web client has no component test tooling. Adding it (a browser-like DOM and a component testing library) is out of scope for low-priority cleanup. The shared identity state's logic (single load, refresh, counter, fail-closed errors) is kept free of UI-framework code so it can be tested with the repository's existing Node test runner, per the constitution's testing standard. Rendering behavior is verified in a browser.
- Existing lint warnings in the web client are a baseline; this change adds exactly one new one, `react(only-export-components)` on `whoami.tsx`'s combined provider+hook export, the same pattern `theme.tsx` already carries.
