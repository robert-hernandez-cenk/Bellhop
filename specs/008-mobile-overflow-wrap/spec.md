# Feature Specification: Long values wrap instead of overflowing on phone-width screens

**Feature Branch**: `issue-5-mobile-overflow`

**Created**: 2026-09-28

**Status**: Draft

**Input**: GitHub issue #5, "Web UI: job page and mobile table cards overflow horizontally at 390px". At narrow phone widths the job detail header and the mobile card layout of tables grow wider than the screen when a value contains a long word with no natural break point, clipping text and pushing controls out of reach.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Answer or stop a job from a phone (Priority: P1)

An operator opens a job's detail page on a phone, for example to answer a prompt from an install that is waiting for input, or to stop a job that has gone wrong. The job targets a guest whose name is one long word with no hyphens (for example `examplelongguestnamewithoutanyhyphenslxc`). Today the header row grows wider than the screen: the status badge is cut off and the Stop control sits off the right edge, reachable only by scrolling sideways, if at all. After this change the whole header fits the screen: the title wraps, and the status and Stop control sit beside it when there is room or on their own line below it when there is not.

**Why this priority**: the Stop control is the one action on this page that matters most when something goes wrong, and a status that reads `AWAITING INPU` is misleading. Losing either on a phone defeats the point of mobile being a first-class target.

**Independent Test**: open the detail page of a job with a long unbroken target name at 390px and 320px wide and confirm the page does not scroll sideways, the full status text is visible, and Stop can be tapped.

**Acceptance Scenarios**:

1. **Given** a running or waiting job whose target is a single long word, **When** its detail page is shown on a 390px-wide screen, **Then** the page is no wider than the screen, the target name is shown in full across as many lines as it needs, and the status badge and Stop control are fully visible.
2. **Given** the same job, **When** the page is shown on a 320px-wide screen, **Then** the same holds.
3. **Given** a job with an ordinary short target, **When** its detail page is shown at a desktop width, **Then** the header looks as it does today: title on the left, status and Stop on the right, on one row.
4. **Given** any job, **When** its header is shown at any width, **Then** the status badge text stays on one line (for example `AWAITING INPUT` is never split into two lines).

---

### User Story 2 - Read job history on a phone (Priority: P2)

An operator scrolls the Jobs & History list on a phone, where each job is shown as a card of label/value rows. A value that is one long word, such as a long guest name or a long username, today runs past the card's right edge and is cut off. After this change the value wraps within the card, and stays right-aligned like the shorter values around it.

**Why this priority**: the history list is read-only, so a clipped value loses information rather than blocking an action; still, a target name that can't be read makes it hard to find the job to open.

**Independent Test**: show the jobs list at 320px with a job whose target and triggering user are long single words, and confirm every card fits the screen and every value is readable in full.

**Acceptance Scenarios**:

1. **Given** a job whose target is a single long word, **When** the jobs list is shown at 390px or 320px wide, **Then** its card is no wider than the screen and the target is shown in full, wrapped onto more lines if needed.
2. **Given** a card value that wraps onto more than one line, **When** it is shown, **Then** it is right-aligned, matching the single-line values in the same card.
3. **Given** a card whose values are all short, **When** it is shown, **Then** it looks as it does today.

---

### User Story 3 - Other card tables stay intact (Priority: P3)

Every table in the web UI switches to the same card layout on a phone (Dashboard hosts, bridges, storage, guests, and the other admin tables). They share the card rules this change adjusts, so they gain the same protection against long values. Nothing about their current phone or desktop appearance may break, including cards whose values are inputs, dropdowns, buttons or badges rather than plain text.

**Why this priority**: this guards against regression rather than adding value, but the shared rule makes it unavoidable to check.

**Independent Test**: show the Dashboard and the other card-table pages at 390px and at a desktop width before and after the change, and confirm nothing that fitted before now overflows or misaligns.

**Acceptance Scenarios**:

1. **Given** the Dashboard with example inventory, **When** it is shown at 390px wide, **Then** no card is wider than the screen and its inline controls are still usable.
2. **Given** any card-table page, **When** it is shown at a desktop width, **Then** its table layout is unchanged.

### Edge Cases

- A value with no break points at all (a long single word, a long email address) must break mid-word rather than overflow.
- A value that already has break points (hyphens, spaces) keeps breaking at them as it does today.
- A job with no target shows the command alone in the header; nothing changes for it.
- A card row whose value is an interactive control (input, dropdown, button, badge) keeps the control usable; a control is never squeezed to zero width.
- The status badge is the widest single unbreakable item in the job header (about 120px for `AWAITING INPUT`), well under the narrowest supported width, so keeping it on one line never causes overflow on its own.
- The job log area already wraps long lines and is not changed.
- A job waiting for input shows an answer banner with a free-text field and a Submit button side by side. At 320px the field's built-in minimum width made the banner about 5px wider than the screen, even with a short target, so the field must be allowed to narrow to fit.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The job detail header MUST fit within the screen width at any width down to 320px, whatever the length of the command and target text.
- **FR-002**: When the job title and the status/actions group do not fit side by side, the status/actions group MUST move below the title rather than overflow.
- **FR-003**: Long text in the job title MUST wrap, breaking inside a word only when there is no other break point.
- **FR-004**: The job status badge MUST display its full text on a single line.
- **FR-005**: On phone-width screens (at or below the existing mobile breakpoint), every card-layout table cell MUST keep its value within the card, wrapping long text and breaking inside a word only when there is no other break point.
- **FR-006**: A card value that wraps MUST stay right-aligned, consistent with single-line values.
- **FR-007**: Values MUST be shown in full; truncating them with an ellipsis is not an acceptable fix.
- **FR-008**: At desktop widths, table layout and the job header's appearance MUST be unchanged for values of ordinary length.
- **FR-009**: The fix MUST NOT change what data is shown or introduce a new breakpoint.
- **FR-010**: The answer banner on a job waiting for input MUST fit within the screen width down to 320px, with the free-text field narrowing so that it and its Submit button stay side by side inside the banner.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: At 390px and at 320px wide, the jobs list, a job detail page with a long single-word target, and the Dashboard each scroll sideways by 0px.
- **SC-002**: On those pages at those widths, all of the job header's text and controls, and all of each card's values, lie within the visible screen.
- **SC-003**: At a desktop width (1280px), the same pages show no visible layout difference from before the change when values are of ordinary length.
- **SC-004**: On a phone, the Stop control on a running job can be reached without any sideways scrolling.

## Assumptions

- 320px is the narrowest width supported; it covers the smallest phones still in common use. 390px is the reference width from the issue.
- The existing single mobile breakpoint (640px) stays the only breakpoint.
- Wrapping is preferred over truncation because a phone offers no hover to reveal truncated text.
- Pages outside the jobs list, job detail page and card tables were not reported as overflowing and are out of scope, though they benefit where they share the adjusted card rules.
- No automated visual-regression tooling is added. The project's rule of verifying web UI changes in a browser at desktop and mobile widths is the acceptance check, backed by a unit test that pins the styling rules the fix depends on.
