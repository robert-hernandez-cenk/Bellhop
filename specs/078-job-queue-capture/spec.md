# Feature Specification: Accept a second action while a job is running

**Feature Branch**: `issue-78-job-queue-capture`

**Created**: 2026-10-04

**Status**: Draft

**Input**: GitHub issue #78, "Second web-UI action doesn't appear in the job queue until the running job finishes".

## Background

When a job is already running in the web UI (for example `update-app` on one guest), the operator can start another action (for example `update-app` on a second guest). Today that second action adds nothing to Job History, and the request that started it stays open, until the first job has finished. The operator has no sign that the second action was accepted, and may click it again or assume it failed.

The cause is that every console capture in the process runs one at a time: both the capture around each running job and the capture that produces a dry-run preview. A new action's preview is produced before its job is created, so it waits behind the whole of the running job. The MCP server uses the same job machinery, so the same delay applies to its apply tools.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A second action is accepted right away (Priority: P1)

While one job is running, the operator starts a second action. The second action is accepted at once, its preview is returned, and it appears in Job History as `queued`. When the first job finishes, the second one starts.

**Why this priority**: This is the reported defect. Without it, the operator can't tell whether the second click did anything.

**Independent Test**: Start a job that stays running until the test releases it. Then start a second action through the same path the web routes and MCP tools use. The second call returns its job id and preview while the first job is still running, and the second job is `queued`.

**Acceptance Scenarios**:

1. **Given** one job is running, **When** the operator applies a second action, **Then** the request completes without waiting for the first job, and Job History shows the second job as `queued`.
2. **Given** a second job is `queued` behind a running one, **When** the first job finishes (success, failure or cancellation), **Then** the second job starts.
3. **Given** two jobs have been queued behind a running one, **Then** they start in the order they were queued, one at a time.

---

### User Story 2 - Jobs still run one at a time (Priority: P1)

Accepting actions right away does not change how jobs run: only one job runs at a time, as today.

**Why this priority**: Jobs that save the inventory could overwrite each other's saves if they ran together. Keeping jobs serial is a hard requirement of this fix.

**Independent Test**: Queue two jobs. Check that the second never reaches `running` while the first is still running.

**Acceptance Scenarios**:

1. **Given** a job is running and a second is queued, **Then** the second job does not start any work until the first has finished.
2. **Given** a queued job is cancelled before it starts, **Then** it is marked `cancelled` immediately, none of its work runs, and the next queued job still starts when its turn comes.

---

### User Story 3 - Every job's log holds its own output, and only its own (Priority: P2)

Output a job produces still ends up in that job's log, including output from work that happens in callbacks during the job (remote command output, prompt detection, timers). A preview produced while a job is running does not leak into that job's log, and the job's output does not leak into the preview.

**Why this priority**: Once previews no longer wait for the running job, they run at the same time as it. Keeping each output stream separate is what makes that safe.

**Independent Test**: Run a job whose work logs from inside a callback, and produce a preview at the same time. The job log contains only the job's lines, and the preview contains only the preview's lines.

**Acceptance Scenarios**:

1. **Given** a running job and a preview in progress at the same time, **Then** each sees only its own lines.
2. **Given** a job whose work logs from inside an event or timer callback, **Then** those lines appear in that job's log.
3. **Given** a capture started inside another capture, **Then** lines logged inside the inner one go to the inner capture only.
4. **Given** output logged outside any capture, **Then** it goes wherever it went before this change (the MCP server's standard error stream, for the MCP server), never into a job log, and the MCP server's protocol output stays clean.

### Edge Cases

- A callback scheduled during a job fires after the job has finished: its output goes to the normal console, not into the finished job's log.
- A job is cancelled while it is `queued`: it is marked `cancelled` immediately, without running, and the jobs queued behind it are not held up.
- A job fails or throws: the next queued job still starts.
- Code that temporarily replaces the console itself (tests do this) is still respected while no capture is active, and a capture does not permanently replace it.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Applying an action MUST create its job (status `queued` or `running`) and return to the caller without waiting for any other job to finish.
- **FR-002**: Producing a dry-run preview MUST NOT wait for a running job to finish.
- **FR-003**: At most one job per job runner MUST be running at any time. Queued jobs MUST start in the order they were queued.
- **FR-004**: Cancelling a `queued` job MUST mark it `cancelled` immediately, without starting any of its work, and MUST NOT delay the jobs queued after it.
- **FR-005**: A job that fails, throws, or is cancelled while running MUST NOT stop the next queued job from starting.
- **FR-006**: Output produced during a job, including output from callbacks the job's work schedules, MUST go to that job's log.
- **FR-007**: Captures running at the same time (a job and a preview, or two previews) MUST each receive only their own output.
- **FR-008**: Output from a capture started inside another capture MUST go only to the inner capture.
- **FR-009**: Output produced outside any active capture MUST go to the console that was in place before capturing began, so the MCP server keeps sending it to standard error and never onto its protocol channel.
- **FR-010**: Previews MUST still be produced before their job is created, so each job's log still begins with its preview.

### Key Entities

- **Job**: an operator action recorded in Job History, with a status (`queued`, `running`, `awaiting_input`, `success`, `failed`, `cancelled`, `interrupted`). This feature changes when a job is created relative to other running jobs, not the job record itself.
- **Capture**: one collection of console output, belonging to either a running job (its log) or a preview (its text).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: While a job is running, a second action appears in Job History as `queued` as soon as its request completes, in the time its preview takes to produce, not the time the running job takes.
- **SC-002**: Across every automated test that queues two or more jobs, no two jobs from the same runner are ever `running` at the same time.
- **SC-003**: A cancelled queued job never runs any of its work.
- **SC-004**: When a job and a preview run at the same time, neither output contains a line from the other.

## Assumptions

- Running jobs at the same time is out of scope. It needs its own design, because jobs that save the inventory could overwrite each other's saves.
- The web UI already shows `queued` jobs in Job History and on the job page, so no UI change is needed.
- The web service and the MCP server each have their own job runner. "One at a time" applies per runner, as it does today; their jobs were never serialized against each other's processes.
- The CLI does not use the job runner or console capture, and is unaffected.
