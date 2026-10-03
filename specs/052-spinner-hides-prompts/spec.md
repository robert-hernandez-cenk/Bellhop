# Feature Specification: Prompts Hidden Behind a Redrawing Spinner

**Feature Branch**: `issue-52-spinner-hides-prompts`

**Created**: 2026-10-03

**Status**: Draft

**Input**: Issue #52 — "install-app hangs undetected when a read prompt fires
while the build.func spinner is still running."

## Background

An install-app job started from the web UI or the MCP server watches the
installer's output for questions the app's install script asks (issue #57,
refined in issue #160). It decides a question is waiting by noticing that
output has gone quiet: after 2 seconds it checks the last line against the
app's own pre-scanned questions, after 30 seconds it also tries two generic
question patterns, and after 5 minutes it escalates whatever is on screen as
a possible stall, so that no undetected question can hang a job forever.

Some community-scripts installers leave a progress spinner running on the
host side for the whole install, redrawing the same status line roughly ten
times a second (for example `⠋ Skipping host LXC stack upgrade prompt
(unattended mode)`). Output therefore never goes quiet. When the install
script then asks a question (for example `Would you like to add PhpMyAdmin?
<y/N>`), none of the three checks ever runs, the job never pauses, and the
operator cannot answer because the job is "not awaiting input". The job
hangs until someone intervenes outside Bellhop. In the reported case the
job sat for more than 80 minutes and its log grew to several megabytes of
spinner frames.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A question asked under a running spinner is surfaced (Priority: P1)

An operator installs an app whose install script asks a question while a
host-side spinner keeps redrawing its status line. The job pauses at the
question, the operator sees the question text, answers it, and the install
continues.

**Why this priority**: This is the reported failure. Without it, the job
hangs with no way to recover from Bellhop.

**Independent Test**: Feed the job's output watcher a spinner that keeps
redrawing, then a pre-scanned question, then more spinner frames, and
confirm that the job pauses within the first check's window, tagged as an
expected question with the right question number and the question as its
text.

**Acceptance Scenarios**:

1. **Given** a spinner is redrawing the same status line continuously,
   **When** the install script prints a pre-scanned question and the spinner
   keeps redrawing afterwards, **Then** the job pauses as an expected
   question about 2 seconds after the question appeared, showing the
   question's text, not the spinner line.
2. **Given** the job is paused at that question, **When** the operator
   answers it and the script asks a second pre-scanned question under the
   same spinner, **Then** the job pauses again at the second question.
3. **Given** a spinner is redrawing continuously, **When** the script asks a
   question that was not pre-scanned but looks like one (ends in `?` or
   carries a `(y/n)`-style hint), **Then** the job pauses as a heuristic
   match about 30 seconds after the question appeared.

---

### User Story 2 - A spinner can no longer defeat the stall backstop (Priority: P2)

An operator runs an install where something blocks that no check
recognises, while a spinner keeps redrawing. After 5 minutes with nothing
but spinner redraws, the job escalates as a possible stall, showing the last
meaningful line of output, so the operator can answer, dismiss, or cancel.

**Why this priority**: The stall check exists so that no job hangs forever.
Restoring that guarantee covers every case the first two checks miss
(questions built from variables, scripts with no pre-scan).

**Independent Test**: Feed a meaningful line, then only spinner redraws for
longer than 5 minutes, and confirm a stall pause whose text is that
meaningful line.

**Acceptance Scenarios**:

1. **Given** the last meaningful output was a line of text and only spinner
   redraws followed, **When** 5 minutes pass, **Then** the job pauses as a
   stall showing that line.
2. **Given** a line whose numbers keep changing (a counter or percentage),
   **When** it keeps updating, **Then** it counts as real activity and the
   stall check does not fire while it updates.

---

### User Story 3 - Existing detection behaviour is unchanged (Priority: P3)

Installs without a spinner behave exactly as before: the same questions are
detected at the same moments with the same tags, dismissing or answering
works the same way, and output that arrives during a pause is still
considered afterwards.

**Why this priority**: Issue #160's behaviour is relied on and tested; the
fix must not regress it.

**Independent Test**: The existing output-watcher test suite passes
unchanged.

**Acceptance Scenarios**:

1. **Given** any scenario covered by the existing prompt-detection tests,
   **When** the same output is fed, **Then** the same pauses occur with the
   same text, tags, and timing.

---

### Edge Cases

- A spinner frame split across two output chunks: neither half counts as
  activity.
- A spinner that draws a glyph with no text: counts as a redraw.
- A status line that finishes with a different glyph (for example a check
  mark replacing the spinner on the same text): counts as a redraw.
- A question that is overwritten in place by the next spinner frame (the
  spinner returns to the start of the line and clears it): the question
  remains the line the checks consider.
- A line that ends with a newline is complete output, not a waiting
  question, and is never matched as one (unchanged from today).
- The same question asked again after an answer (for example after an
  invalid answer): detected again.
- A question echoed back by the script after it has been answered: does not
  pause the job a second time (unchanged from today).
- A very long install with continuous spinner output: the watcher's memory
  use stays bounded rather than growing with the log.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The output watcher MUST classify each line of installer
  output, where lines are separated by newlines or carriage returns, as
  either meaningful output or a redraw.
- **FR-002**: A line MUST be compared on its text alone, ignoring terminal
  colour and cursor control codes, leading spinner glyphs, symbols and
  whitespace, and differences in runs of whitespace. Digits MUST be
  significant.
- **FR-003**: A completed line MUST count as a redraw when its compared text
  is empty or equals one of the most recent distinct meaningful lines (a
  small fixed number, at least 8).
- **FR-004**: A line still being written (no line ending yet) MUST count as
  a redraw when its compared text is empty or is the beginning of one of
  those recent meaningful lines.
- **FR-005**: Redraws MUST NOT restart the silence checks and MUST NOT be
  considered by them. Every other output MUST restart them, as all output
  does today.
- **FR-006**: The text the checks test for a waiting question MUST be the
  most recent meaningful line, provided it was not ended by a newline. A
  line ended by a carriage return (overwritten in place) still counts.
- **FR-007**: A stall pause MUST show the most recent meaningful line,
  falling back to the previously reported question as it does today.
- **FR-008**: After a pause is answered or dismissed, the watcher MUST
  forget what the pause already reported, keep meaningful output that
  arrived during the pause, restart the checks from the first one, and
  forget its record of recent lines so a repeated question counts as new.
- **FR-009**: The job log MUST keep recording all output, redraws included,
  exactly as today.
- **FR-010**: Jobs that do not watch for questions MUST be unaffected.
- **FR-011**: The watcher's retained output MUST be bounded in size
  regardless of how long the job runs.

### Key Entities

- **Meaningful line**: a line of output whose compared text is new relative
  to the recent lines; the unit the question checks look at.
- **Redraw**: a line that only repeats recent output (a spinner frame, a
  status line rewritten in place) and carries no new information.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With a status line redrawn every 100 milliseconds, a
  pre-scanned question is surfaced to the operator within 3 seconds of
  appearing, in 100% of test runs.
- **SC-002**: With only redraws after the last meaningful line, the job
  escalates as a stall at 5 minutes, never later.
- **SC-003**: Every existing prompt-detection test passes without change to
  its expectations.
- **SC-004**: No install-app job can sit "running" with a question waiting
  for more than 5 minutes because of a redrawing status line.

## Assumptions

- Spinners redraw the same text on each frame; a spinner whose text
  includes a changing number (an elapsed-time counter) is treated as
  activity, by the operator's decision, so such a spinner can still delay
  stall detection. Progress bars are the reason: a long download showing
  only a percentage should not raise a false stall.
- Matching stays limited to the last meaningful line rather than anywhere in
  recent output, so a question echoed back after it has been answered never
  pauses the job.
- Out of scope: changing what the job log records, collapsing spinner frames
  in the job log or the web UI, an absolute timeout that ignores output,
  and reporting the never-stopped spinner to community-scripts.
