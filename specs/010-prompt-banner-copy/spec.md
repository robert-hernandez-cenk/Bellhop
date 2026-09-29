# Feature Specification: Prompt banner copy per detection origin

**Feature Branch**: `issue-4-prompt-banner-copy`

**Created**: 2026-09-29

**Status**: Draft

**Input**: Issue #4 — "JobView: prompt banner copy doesn't fit the three detection origins"

## Background

When a web-triggered `install-app` job pauses because the app's installer
seems to be asking a question, the job page shows a prompt banner: the
question text, answer controls (Yes, No, a free-text answer), and a control
that dismisses the pause and lets the job carry on waiting. Every pause
carries a **detection origin**, which says how confident the toolkit is that
the paused line really is a question:

- **expected** — the line matched a prompt that was found ahead of time in
  the app's own install script. This is a confirmed question.
- **heuristic** — the line did not match any known prompt, but it looked like
  a question (ends in `?`, or carries a `(y/n)`-style hint) and output went
  quiet for 30 seconds. Lower confidence.
- **stall** — output went quiet for 5 minutes and the last line matched
  nothing. It may not be a question at all.

The banner's wording was written before these origins existed and was only
partly updated when they arrived. Three defects follow:

1. The dismiss control reads "Not stuck — keep waiting" for every origin. For
   a confirmed (`expected`) question that is advice to do the wrong thing:
   dismissing ignores a real question and the job goes on waiting for an
   answer that never comes.
2. A `heuristic` pause shows no explanation at all, so it looks the same as
   the old, pre-origin banner even though it is now the second-least
   confident of the three.
3. The `stall` explanation tells the operator to "Dismiss", but no control
   has that label.

This feature changes wording and emphasis only. What dismissing or answering
actually does is unchanged.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Answer a confirmed question without being steered away from it (Priority: P1)

An operator installs an app from the web UI. The installer asks a question
that was found in the app's install script ahead of time. The banner
presents answering as the obvious action, and the control that skips the
question says plainly that it skips the question and is visually secondary.

**Why this priority**: This is the defect that actively misleads — the
current label invites the operator to ignore a real question and leave the
job hanging. It is also the most common pause origin for apps whose prompts
were found in advance.

**Independent Test**: Open a job paused with origin `expected` and confirm
the dismiss control reads "Skip this question", is styled as a secondary
control, and the answer controls keep their normal, primary styling.

**Acceptance Scenarios**:

1. **Given** a job paused on an `expected` prompt that is question 1 of up to
   4 known prompts, **When** the operator opens the job page, **Then** the
   banner shows "Question 1 of up to 4 — matches a known prompt in this app's
   install script." and a dismiss control labelled "Skip this question".
2. **Given** the same banner, **When** the operator looks at the controls,
   **Then** Yes, No, and Submit look like primary actions and "Skip this
   question" looks visually quieter than them.
3. **Given** an `expected` pause whose position among the known prompts is
   not known, **When** the page renders, **Then** the explanation reads
   "Matches a known prompt in this app's install script." and the dismiss
   control is still "Skip this question".

---

### User Story 2 - Understand that a heuristic pause is a guess (Priority: P2)

An operator sees a pause that the toolkit guessed at: the line looked like a
question but was not one of the known prompts. The banner says so, so the
operator knows to read the log before answering and can tell the job to keep
waiting with a control that means that.

**Why this priority**: Without an explanation, the operator can't tell a
guess from a confirmed question. That matters, but a wrong call here is
recoverable, so it ranks below Story 1.

**Independent Test**: Open a job paused with origin `heuristic` and confirm
an explanation is shown and the dismiss control reads "Not a question — keep
waiting".

**Acceptance Scenarios**:

1. **Given** a `heuristic` pause for an app with known prompts, **When** the
   page renders, **Then** the banner reads "Looks like a question, but it
   doesn't match any prompt in this app's install script — it may not be
   one."
2. **Given** a `heuristic` pause for an app with no known prompts to compare
   against, **When** the page renders, **Then** the banner reads "Looks like
   a question, but there were no known prompts for this app to check it
   against — it may not be one."
3. **Given** either heuristic banner, **When** the operator looks at the
   controls, **Then** the dismiss control reads "Not a question — keep
   waiting" and the answer and dismiss controls have equal visual weight.

---

### User Story 3 - Follow the stall explanation to the right control (Priority: P3)

An operator sees a job whose output stopped for 5 minutes. The explanation
names the exact control to use to keep waiting, and that control exists with
that label.

**Why this priority**: The mismatch is confusing but the right control is
still findable; it is the smallest of the three defects.

**Independent Test**: Open a job paused with origin `stall` and confirm that
the explanation names "Not a question — keep waiting" and a control with
exactly that label is shown.

**Acceptance Scenarios**:

1. **Given** a `stall` pause, **When** the page renders, **Then** the
   explanation still warns that output stopped for 5 minutes and the line may
   not be a question, and it tells the operator to choose "Not a question —
   keep waiting" to keep waiting or to answer if it is a prompt.
2. **Given** the same banner, **When** the operator looks at the controls,
   **Then** a dismiss control labelled exactly "Not a question — keep
   waiting" is present and is the emphasised control, with the answer
   controls visually secondary, as they are today.

---

### Edge Cases

- A paused job whose origin is not recorded (a job that paused before origins
  existed): the server already reports such a pause as `heuristic`, because
  every pause was a heuristic guess before origins existed, so it gets the
  heuristic banner (the "no known prompts" variant, since such a job has none
  recorded). Found during browser verification; the server's mapping is
  correct and unchanged.
- The page has not yet received the pause's origin (the moment before the
  live connection replays it): no explanation is shown, all controls have
  equal weight, and the dismiss control reads "Not a question — keep
  waiting".
- Narrow screens (640px wide or less): the banner's controls stack vertically
  as they do today, and the secondary styling of a de-emphasised control
  still reads as secondary.
- Light and dark themes: the banner keeps its fixed warning background, so a
  de-emphasised control must stay legible against it in both themes.
- Dismissing a pause, whatever its origin, behaves exactly as today: the
  pause is cleared and the job keeps watching for output.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The prompt banner MUST choose its explanation, dismiss-control
  label, and control emphasis from the pause's detection origin, with every
  origin (`expected`, `heuristic`, `stall`) and the unrecorded case covered.
- **FR-002**: For `expected`, the explanation MUST be unchanged from today
  ("Question N of up to M — matches a known prompt in this app's install
  script.", or "Matches a known prompt in this app's install script." when
  the position is unknown).
- **FR-003**: For `expected`, the dismiss control MUST read "Skip this
  question" and MUST be visually de-emphasised relative to the answer
  controls; the answer controls MUST keep their normal styling.
- **FR-004**: For `heuristic`, the banner MUST show an explanation that the
  line looks like a question but did not match a known prompt. It MUST use
  the "doesn't match any prompt in this app's install script" wording when
  known prompts exist for the job, and the "no known prompts for this app to
  check it against" wording when none do.
- **FR-005**: For `heuristic`, `stall`, and the unrecorded case, the dismiss
  control MUST read "Not a question — keep waiting".
- **FR-006**: For `stall`, the explanation MUST keep its existing warning and
  MUST refer to the dismiss control by its exact label.
- **FR-007**: For `stall`, the existing emphasis MUST be kept: dismiss
  emphasised, answer controls de-emphasised. For `heuristic` and the
  unrecorded case, all controls MUST have equal weight.
- **FR-008**: When the page has no origin for the pause (not yet received), it
  MUST show no explanation. A pause the server reports without a stored
  origin is `heuristic` and follows FR-004.
- **FR-009**: The banner MUST remain usable at desktop widths and at 640px or
  narrower, and in both light and dark themes.
- **FR-010**: What answering and dismissing do MUST NOT change; this feature
  changes presentation only.

### Key Entities

- **Detection origin**: how a pause was detected — `expected`, `heuristic`,
  `stall`, or not recorded. Determines the banner's wording and emphasis.
- **Known prompts**: the prompts found ahead of time in the app's install
  script, and which one (if any) the paused line matched. Used for the
  "Question N of up to M" count and to choose between the two heuristic
  explanations.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For every detection origin and the unrecorded case, the banner
  shows a defined explanation (or none, for unrecorded) and a defined dismiss
  label — no origin falls through to a default by accident.
- **SC-002**: A confirmed-question banner never offers "Not stuck — keep
  waiting" or any label suggesting the pause is not a real question.
- **SC-003**: Every control named in a banner explanation exists on that
  banner with exactly that label.
- **SC-004**: The three origins produce three visibly different banners
  (different explanation text), so an operator can tell a confirmed question,
  a guess, and a stall apart at a glance.

## Assumptions

- Only the web UI's job page is in scope. The MCP server's prompt dialog
  already uses its own wording ("Not a real prompt — resume") and is not
  changed.
- Detection itself, the server's dismiss and answer behavior, and the job
  data sent to the page are unchanged; the page already receives the origin,
  the known prompts, and the matched prompt's position.
- "Not a question — keep waiting" is used for both `heuristic` and `stall`
  rather than two different labels, to match the MCP dialog's meaning and to
  keep one name for one action.
- The Yes, No, and free-text answer controls keep their labels.
