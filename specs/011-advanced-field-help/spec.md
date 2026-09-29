# Feature Specification: Field Explanations in the Guest Advanced Modal

**Feature Branch**: `issue-34-advanced-modal-tooltips`

**Created**: 2026-09-29

**Status**: Draft

**Input**: GitHub issue #34, "Explain each field in the guest Advanced modal with a tooltip".

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Understand a field before changing it (Priority: P1)

An operator opens a guest's **Advanced** modal on the Dashboard and sees a field
such as "read-only proxy" or "unauthenticated paths". Next to the label is a small
info marker. Activating it shows a one-to-two-sentence explanation of what the
field does and anything surprising about it, so the operator can decide whether to
change it without reading the project's source or developer notes.

**Why this priority**: this is the whole feature. Several fields are unintelligible
from their label alone, and some have non-obvious consequences (a gate that still
applies, a value that is overwritten automatically).

**Independent Test**: open the Advanced modal for any guest, activate the info
marker next to each label in turn, and confirm an explanation appears for every one.

**Acceptance Scenarios**:

1. **Given** the Advanced modal is open, **When** the operator hovers the mouse over
   the info marker next to "read-only proxy", **Then** an explanation appears saying
   that the entry's proxy configuration is hand-written outside Bellhop's managed
   section, and that Authentik gating still applies to it.
2. **Given** the explanation is showing, **When** the pointer leaves the marker,
   **Then** the explanation disappears (unless it was opened by a click or tap).
3. **Given** the Advanced modal is open, **When** the operator clicks the marker,
   **Then** the explanation stays open until the marker is clicked again, Escape is
   pressed, or the operator clicks elsewhere.
4. **Given** the modal is open for a guest in OIDC mode, **When** the operator
   inspects the "oidc client" row, **Then** it has an explanation too.

---

### User Story 2 - Reach explanations on a phone (Priority: P1)

The operator uses the Dashboard on a phone (viewport 640px wide or narrower). Hover
does not exist there, so the operator taps the info marker to show the explanation
and taps it again, or taps elsewhere, to hide it.

**Why this priority**: mobile is a first-class target for this web UI. An
explanation reachable only by hover would fail the feature for every touch user.

**Independent Test**: at a ≤640px viewport, tap each info marker and confirm the
explanation is fully visible inside the modal with no horizontal overflow.

**Acceptance Scenarios**:

1. **Given** a viewport ≤640px wide, **When** the operator taps a field's info
   marker, **Then** the explanation is shown in full within the modal's width.
2. **Given** an explanation is open on a phone, **When** the operator taps outside
   it, **Then** it closes.
3. **Given** an explanation is open, **When** the operator taps a different field's
   marker, **Then** only the newly chosen explanation is shown.

---

### User Story 3 - Reach explanations by keyboard (Priority: P2)

A keyboard user tabs through the modal. Each info marker is focusable, Enter or
Space toggles its explanation, and Escape closes it. Assistive technology announces
the marker as a control that expands the explanation for a named field.

**Why this priority**: required by the issue's acceptance criteria, and it costs
little on top of the tap/click behavior.

**Independent Test**: with only the keyboard, reach each marker, open and close its
explanation.

**Acceptance Scenarios**:

1. **Given** focus is on a field's info marker, **When** the operator presses Enter
   or Space, **Then** the explanation opens; pressing it again closes it.
2. **Given** an explanation is open, **When** the operator presses Escape, **Then**
   it closes and focus stays on the marker.
3. **Given** an explanation is open, **When** focus moves away from the marker,
   **Then** the explanation closes.

---

### Edge Cases

- The "oidc client" row is only rendered in OIDC mode; its explanation exists
  regardless, and no marker appears when the row is absent.
- Opening an explanation must not shift the layout of the modal's other rows, so a
  hover that brushes past a marker cannot make controls jump under the pointer.
- An explanation for the last row of the modal must remain readable (not clipped by
  the modal's own bounds).
- Clicking or tapping inside an open explanation must not close it (so text can be
  selected), while clicking the modal's own backdrop still closes the modal.
- Pressing Escape while an explanation is open closes the explanation, not the
  whole modal.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Every field label in the guest Advanced modal MUST have an adjacent
  info marker that reveals an explanation of that field. The fields are: type, ip,
  subdomains, host, vmid, port, read-only proxy, insecure backend tls, auth group,
  auth mode, callback urls, oidc client, unauthenticated paths, vpn, app.
- **FR-002**: Each explanation MUST be at most two sentences stating what the field
  does and anything surprising about it.
- **FR-003**: The explanations MUST include these facts:
  - read-only proxy: the entry's proxy block is hand-written outside Bellhop's
    managed section, so Bellhop's proxy sync skips it, but Authentik gating still
    applies.
  - insecure backend tls: set automatically when Bellhop checks the backend's TLS
    after a subdomain or port change.
  - unauthenticated paths: no effect unless the entry is gated with forward-auth.
  - callback urls: no effect unless the entry is in OIDC mode.
- **FR-004**: An explanation MUST be reachable by mouse (hover shows it; click
  toggles it open), by keyboard (the marker is focusable; Enter/Space toggles;
  Escape closes), and by touch (tap toggles; tapping outside closes).
- **FR-005**: The marker MUST expose its expanded/collapsed state and name the field
  it explains to assistive technology.
- **FR-006**: At most one explanation MUST be open at a time.
- **FR-007**: Showing an explanation MUST NOT change the position of any other
  content in the modal.
- **FR-008**: At a viewport 640px wide or narrower, an explanation MUST be fully
  visible within the modal with no horizontal page scroll.
- **FR-009**: All explanation text MUST be defined in one place alongside the modal,
  not inside the individual field editors.
- **FR-010**: Existing field editing behavior MUST be unchanged.
- **FR-011**: The explanations MUST read correctly in both light and dark themes.

### Key Entities

- **Field explanation**: a field's label paired with its explanation text. One per
  field listed in FR-001.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 15 of 15 fields in the Advanced modal have an explanation reachable by
  mouse, keyboard, and touch.
- **SC-002**: Every explanation is two sentences or fewer.
- **SC-003**: At a 375px-wide viewport, opening any explanation produces no
  horizontal scroll and no text clipped outside the modal.
- **SC-004**: Opening or closing an explanation moves no other row in the modal.
- **SC-005**: An automated check fails if a field is added to the modal without an
  explanation, or an explanation is left for a field the modal no longer shows.

## Assumptions

- The operator is already signed in and can open the Advanced modal; explanations
  are the same for admins and non-admins (who-can-change-what notes are part of the
  text where relevant, not a separate per-role variant).
- Explanations describe current behavior only; they are English-only, like the rest
  of the web UI.
- Tooltips elsewhere in the web UI (Provisioning forms, Settings) are out of scope;
  the marker is built so those pages can reuse it later.
- No server-side change is needed; the inventory and API are untouched.
