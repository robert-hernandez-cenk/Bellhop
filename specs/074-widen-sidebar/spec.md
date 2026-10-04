# Feature Specification: Widen the desktop sidebar so nav links stay on one line

**Feature Branch**: `issue-74-widen-sidebar`

**Created**: 2026-10-04

**Status**: Draft

**Input**: Issue #74 — the desktop sidebar is too narrow for the "Deploy VPN Gateway" nav link; the label wraps onto a second line, which makes the nav list tall enough to show a vertical scroll bar in the sidebar.

## Background

The desktop sidebar is a fixed 200px column. Measured in the demo instance, "Deploy VPN Gateway" needs about 150px of text against a usable width of about 159px, so it fits only while the sidebar shows no scroll bar. Once the nav list is tall enough to scroll (a real deployment adds the Users and Permissions links and the impersonation picker to what the demo shows), a classic always-visible scroll bar (about 15px on Windows) narrows the column, the label wraps, and the wrapped line makes the list taller still. The wrap and the scroll bar feed each other.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Every nav link reads on one line at desktop width (Priority: P1)

An operator using the web UI on a desktop browser sees every sidebar link, including "Deploy VPN Gateway", on a single line, and the sidebar does not show a scroll bar at a normal desktop window height.

**Why this priority**: This is the whole issue — the wrapped label looks broken and the scroll bar it causes wastes width and suggests hidden content.

**Independent Test**: Open the web UI at a desktop width (for example a 1920x1080 window) as an admin, so the full admin nav shows; check that no link wraps and the sidebar has no scroll bar.

**Acceptance Scenarios**:

1. **Given** a desktop-width window, **When** the sidebar renders, **Then** every nav link occupies exactly one line.
2. **Given** a desktop-width window of normal height (1920x1080) and an admin with the full nav (Users, Permissions, Settings, impersonation picker), **When** the sidebar renders, **Then** its content fits without a vertical scroll bar.
3. **Given** a shorter window where the nav does need to scroll, **When** the scroll bar appears, **Then** no link wraps because of the narrower column.

---

### User Story 2 - The mobile drawer is unchanged (Priority: P2)

An operator on a phone (viewport 640px wide or narrower) opens the off-canvas navigation drawer and sees it exactly as before: same width, every link readable, closing on backdrop tap or link tap.

**Why this priority**: Mobile is a first-class target; the fix must not regress it.

**Independent Test**: Open the web UI at a 390px-wide viewport, open the drawer, and compare against the current behavior.

**Acceptance Scenarios**:

1. **Given** a viewport of 640px or narrower, **When** the drawer is opened, **Then** it keeps its existing width and every link is fully readable on one line.

### Edge Cases

- A future nav label longer than the column: it stays on one line and is truncated with an ellipsis rather than wrapping or widening the layout.
- Very short windows: the sidebar may still scroll, which is expected; links still do not wrap.
- Larger browser text size or zoom: links stay on one line (truncating if necessary) rather than wrapping.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: At desktop widths (above 640px), the sidebar MUST be wide enough that every current nav link label fits on one line, with room for a classic scroll bar.
- **FR-002**: Sidebar nav links MUST never wrap onto a second line at any width; a label that does not fit MUST be truncated with an ellipsis.
- **FR-003**: At a 1920x1080 desktop window with the full admin nav, the sidebar MUST show no vertical scroll bar.
- **FR-004**: The mobile off-canvas drawer (640px and narrower) MUST keep its existing width and behavior.
- **FR-005**: The main content area MUST still fill the remaining width; the wider sidebar MUST NOT introduce horizontal page scrolling at common desktop widths (1280px and up).

### Non-goals

- Reordering, renaming, or regrouping nav items.
- Changing the sidebar's vertical spacing.
- A collapsible or resizable sidebar.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 0 nav links render on more than one line at desktop width, with or without a scroll bar showing.
- **SC-002**: At a 1920x1080 window with the full admin nav, the sidebar content height is no greater than its visible height (no scroll bar).
- **SC-003**: At a 390px-wide viewport, the drawer's width and link layout match the current release.

## Assumptions

- A 220px column is enough: the widest current label is about 150px of text, plus 16px link padding, 24px sidebar padding, a 1px border, and about 15px for a classic scroll bar (about 206px total).
- "Normal desktop height" means a 1920x1080 window (roughly 950px of usable viewport height).
- Only the web client stylesheet changes; no server or API behavior is affected.
- Verification is a browser check at desktop and mobile widths; the project has no automated CSS layout tests.
