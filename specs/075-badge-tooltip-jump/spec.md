# Feature Specification: App update badge explanation that stays put

**Feature Branch**: `issue-75-badge-tooltip-jump`

**Created**: 2026-10-04

**Status**: Draft

**Input**: Issue #75 — "App update badge tooltip renders incorrectly and makes the Update page jump."

## Background

The Update page shows a saved app-update result next to each guest's app
(an "Update available" pill, or a quiet up-to-date / check-failed /
not-checked note). Each one has an info marker that reveals when it was
checked, or why the check failed. It opens on hover or on a tap or click.
It reuses the explanation disclosure built for the guest Advanced modal
(issue #34).

That disclosure was designed to drop down across the whole width of a modal
form row. On the Update page there is no row for it to span. Reproduced in
a browser with the example (demo) inventory: the explanation opened as a
strip across the full width of the window, below the last guest card. That
made the page 37 px taller, and the page then scrolled 37 px to show it.
That scroll is the "jump" the issue reports.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Read an update result's details without the page moving (Priority: P1)

An operator on the Update page hovers over, taps or clicks the info marker
on a guest's app-update badge. The explanation appears next to that badge,
about as wide as its text needs. Nothing else on the page moves. Moving the
pointer away, tapping elsewhere or pressing Escape closes it, and again
nothing moves.

**Why this priority**: This is the whole issue. Today the explanation is
unreadable in place, and opening it scrolls the page out from under the
operator.

**Independent Test**: Open the Update page with at least one badge. Open its
explanation by hover and by click, at desktop width and at phone width.
Check that the explanation sits next to the badge and that the page's
scroll position and height are unchanged.

**Acceptance Scenarios**:

1. **Given** the Update page at desktop width, **When** the operator hovers
   over a badge's info marker, **Then** the explanation appears directly
   below (or, without room below, directly above) the marker, no wider than
   its content or the maximum width, and the page neither scrolls nor
   changes height.
2. **Given** the Update page at phone width (≤640 px), **When** the operator
   taps a badge's info marker, **Then** the explanation appears next to the
   marker, fully inside the screen with at least a 16 px margin on each
   side, and the page does not scroll.
3. **Given** a badge in the rightmost card or near the window's right edge,
   **When** its explanation opens, **Then** it is shifted left so that it
   stays fully inside the window. It never causes horizontal scrolling.
4. **Given** a badge near the bottom of the window, **When** its explanation
   opens, **Then** it opens above the marker instead of extending past the
   bottom of the window.
5. **Given** a pinned (clicked-open) explanation, **When** the operator
   scrolls the page or resizes the window, **Then** the explanation stays
   attached to its marker.
6. **Given** light or dark theme, **When** an explanation is open, **Then**
   it uses the same themed colors as the Advanced modal's explanations.

---

### User Story 2 - Advanced modal explanations unchanged (Priority: P2)

The guest Advanced modal's field explanations keep working exactly as they
do today: they drop down across their form row and scroll into view inside
the modal on short screens.

**Why this priority**: The fix touches a shared component. A regression in
the modal would trade one broken disclosure for another.

**Independent Test**: Open a guest's Advanced modal, open a few field
explanations (including one in the bottom row on a phone-height window), and
compare with current behavior.

**Acceptance Scenarios**:

1. **Given** the Advanced modal, **When** a field's explanation opens,
   **Then** it spans that form row below the label, as before.
2. **Given** the Advanced modal on a short screen, **When** a bottom row's
   explanation opens, **Then** the modal scrolls it into view, as before.

### Edge Cases

- A very long explanation (for example a long check-failure reason) wraps
  inside the maximum width rather than widening the explanation past it.
- No room below or above the marker (a very short window): the explanation
  goes on the side with more room and may be cut off at that window edge,
  but it still never changes the page's size or scroll position.
- A window narrower than the maximum width plus margins: the explanation
  shrinks to the window width minus 16 px on each side.
- Hover-open then move the pointer onto the explanation: it stays open,
  same as today (it now sits next to the marker, so the gap is small).
- Several badges: opening one then another behaves as today. Each badge
  keeps its own open state.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The Update page's app-update explanation MUST appear next to
  its info marker: directly below it, or directly above it when there is
  more room above than below and not enough room below.
- **FR-002**: Its width MUST fit its content, up to a maximum of 320 px or
  the window width minus 16 px on each side, whichever is smaller. Longer
  text wraps.
- **FR-003**: It MUST stay fully inside the window horizontally, with at
  least 16 px of margin, shifting sideways from the marker when needed.
- **FR-004**: Opening, closing, hovering or re-positioning it MUST NOT
  change the page's height, width, scroll position or the layout of any
  other element.
- **FR-005**: While it is open, it MUST stay attached to its marker when the
  page scrolls or the window resizes.
- **FR-006**: Open/close behavior MUST be unchanged: hover opens and
  hover-out closes after the existing short delay, click or tap pins it,
  and a second click, Escape or a click outside closes it. Screen-reader
  wiring is also unchanged.
- **FR-007**: The guest Advanced modal's explanations MUST keep their
  current placement, sizing and scroll-into-view behavior.
- **FR-008**: The behavior MUST hold at desktop width and at phone width
  (≤640 px), in both light and dark themes.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Opening and closing any app-update explanation changes the
  page's scroll position by 0 px and its scrollable height and width by
  0 px, at both desktop and phone widths.
- **SC-002**: Every opened app-update explanation lies fully within the
  window horizontally with ≥16 px margins, and is never wider than 320 px.
- **SC-003**: The explanation's nearest edge is within 4 px of its marker
  whenever the window has room for it on that side.
- **SC-004**: The Advanced modal's explanations look and behave identically
  to before the change.

## Assumptions

- The Update page is the only place that uses the disclosure outside a
  modal form row today. The new "next to the marker" placement is offered
  as an option, not as a replacement for the modal's row-spanning one.
- 320 px and the 16 px gutter match the page's existing phone-width side
  gutter and a readable line length. They are fixed values, not settings.
- No third-party tooltip or positioning library is added.
- The badge's own look (pill, quiet note, wording) is out of scope.
