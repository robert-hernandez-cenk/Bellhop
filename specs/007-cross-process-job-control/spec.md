# Feature Specification: Cross-Process Job Streaming and Control

**Feature Branch**: `issue-6-mcp-job-web-control`

**Created**: 2026-09-26

**Status**: Draft

**Input**: GitHub issue #6: "Web UI live streaming and control for jobs owned by the MCP server". The
approach, scope and non-goals below come from the design settled while brainstorming the issue.

## Background

Bellhop runs jobs from two kinds of process that share one jobs database and one job-log
directory: the web service, and any number of MCP server processes. Every job records which
process owns it. Today only the owning process can show a job's live output or act on it:

- In the web UI, a job started over MCP shows the log as it was when the page was opened and never
  updates. Its status badge, prompt banner and log all freeze until the page is reloaded.
- Stopping a job, answering its installer prompt, and dismissing a false-positive prompt all fail
  with "owned by `mcp:<pid>`; control it from there" when requested from any process other than the
  owner. That holds for the web UI acting on an MCP job and for an MCP tool acting on a web job or
  on another MCP process's job.

The operator is left with no way to watch or stop a long MCP-started install from the browser, and
no way to use the MCP tools to stop a job the web UI started.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Watch an MCP-started job live in the web UI (Priority: P1)

An operator asks an assistant to install an app through the MCP server, then opens that job in the
web UI's Job History. The log keeps growing as output arrives, the status badge moves from queued
to running to its final state, and if the installer pauses on a question, the prompt banner
appears (and disappears once the question is answered anywhere).

**Why this priority**: watching is the most common need and the foundation for the others. The
operator cannot answer or stop a job sensibly without seeing its current state.

**Independent Test**: start a job owned by a second process, open it in the web UI, and confirm
new output, status changes and prompt appear/disappear on the page without a reload.

**Acceptance Scenarios**:

1. **Given** a running job owned by an MCP process, **When** the operator opens its job page,
   **Then** the page shows the log so far and then shows each new piece of output within about
   two seconds of it being written, without a reload.
2. **Given** that page is open, **When** the job finishes (success, failure, cancellation or
   interruption), **Then** the status badge shows the final status within about two seconds and the
   log includes every line written before the job finished.
3. **Given** that page is open, **When** the job pauses on an installer question, **Then** the
   prompt banner appears with the same text, numbering and stall notice it would show for a job the
   web service owns; **When** the question is then answered or dismissed from any process, **Then**
   the banner disappears.
4. **Given** a job the operator's group is not allowed to see, **When** they open its page or live
   stream, **Then** access is refused exactly as it is today.

---

### User Story 2 - Stop, answer or dismiss an MCP-owned job from the web UI (Priority: P1)

From that same job page, the operator presses Stop, answers the installer's question, or marks a
detected prompt as "not stuck", and the owning MCP process carries it out.

**Why this priority**: this is the second half of the issue, and without it a stuck MCP install
can only be stopped by ending the assistant's session.

**Independent Test**: with a job owned by a second process paused on a prompt, answer it from the
web UI and confirm the job resumes; with another such job running, press Stop and confirm it ends as
cancelled.

**Acceptance Scenarios**:

1. **Given** a running job owned by an MCP process, **When** the operator presses Stop, **Then**
   the job ends as cancelled, the web UI receives a success response, and the job's log records that
   the stop was requested from the web UI and by whom.
2. **Given** a job owned by an MCP process that is paused on a prompt, **When** the operator
   submits an answer, **Then** the answer reaches the installer, the job resumes, and the log
   records where the answer came from and by whom (never the answer text itself, which may be a
   secret).
3. **Given** the same paused job, **When** the operator dismisses the prompt, **Then** the job
   resumes watching without anything being sent to the installer.
4. **Given** a job owned by an MCP process that already finished, or is not paused on a prompt,
   **When** the operator stops, answers or dismisses it, **Then** they get the same "nothing to
   cancel/answer/dismiss" refusal a web-owned job in that state gives.
5. **Given** a job whose owning MCP process is no longer running, **When** the operator tries to
   act on it, **Then** the request is refused immediately with a message saying the owning process
   has exited, rather than waiting.

---

### User Story 3 - Control any job from the MCP tools (Priority: P2)

An assistant using the MCP server's stop, answer and dismiss tools can act on a job the web UI
started, or one another MCP process started, the same way it acts on its own jobs.

**Why this priority**: the operator chose to make the control channel work in both directions. It
reuses the same mechanism as Story 2 and matters less often.

**Independent Test**: with a web-owned job running, call the MCP stop tool on it and confirm the job
ends as cancelled.

**Acceptance Scenarios**:

1. **Given** a running job owned by the web service, **When** the MCP stop tool is called on it,
   **Then** the web service cancels it and the tool reports success.
2. **Given** a web-owned job paused on a prompt, **When** the MCP answer or dismiss tool is called
   on it, **Then** the web service applies it and the tool reports success; the web UI's open
   job page updates as it would for a local answer.
3. **Given** a job owned by another process, **When** the MCP wait tool is called on it, **Then**
   it is still refused as not owned by this process (waiting and relaying prompts through the
   assistant stay limited to the owning process).

### Edge Cases

- The owning process is alive but does not act on a request (hung, or busy past the wait limit):
  the requester gets a clear timeout error naming the owner and saying the request may still be
  applied later, rather than hanging.
- The owning process exits while a request is waiting: the request is never applied; the job is
  closed out as interrupted by the existing orphan cleanup, and a later request is refused as
  "owner has exited".
- Two requests for the same job arrive close together (for example, Stop pressed in the web UI
  while an assistant answers the prompt): each is applied in the order received, and the second
  gets whatever result applies at that point ("nothing to answer" if the job was already stopped).
- A prompt is answered from one process just as it was replaced by a new prompt: the answer goes
  to whichever prompt is pending when the owner applies it. This is the same seconds-long race
  today's in-process answer path already has and is accepted.
- Output written in pieces that split a multi-byte character across two reads: the live view shows
  the character intact, never a replacement character.
- The web UI's live stream for a foreign job disconnects: the page falls back to its existing
  periodic refresh, as it does today for a web-owned job.
- A job that predates the owner column (treated as web-owned everywhere) keeps working as today.
- An old request left unhandled for a job that has since finished is never applied.

## Requirements *(mandatory)*

### Functional Requirements

**Live view of a job owned by another process**

- **FR-001**: When the web UI's live stream is opened for a job owned by a process other than the
  web service, the web service MUST send the log written so far and then keep sending newly written
  output as it appears, at most about one second after it is written.
- **FR-002**: That live stream MUST also send the job's status changes, prompt appearances (with
  the same text, expected-prompt list, detection origin and matched index as a local prompt) and
  prompt clearances, using the same messages the live stream already uses for web-owned jobs, so the
  web client needs no change to display them.
- **FR-003**: Once the job reaches a final status, the live stream MUST send any remaining output
  written before that point and the final status, and then stop watching.
- **FR-004**: Watching MUST stop when the viewer disconnects, and MUST never modify the job, its
  log, or its database row.
- **FR-005**: Output MUST be delivered without corrupting multi-byte characters split across reads.
- **FR-006**: Existing visibility rules for jobs MUST apply unchanged to the live stream of a job
  owned by another process.

**Control of a job owned by another process**

- **FR-007**: Stopping, answering and dismissing a job MUST work from any Bellhop process (the web
  service or any MCP server process) regardless of which process owns the job.
- **FR-008**: A request for a job the requesting process owns MUST keep working exactly as today,
  directly and without any added delay.
- **FR-009**: A request for a job owned by another process MUST be recorded durably in the shared
  jobs database, and the owning process MUST pick it up and apply it using the same stop, answer
  and dismiss behavior it uses for its own local requests.
- **FR-010**: The owning process MUST record the outcome of each request it picks up (applied, or
  not applicable because the job is not in a state for it), and the requester MUST report that
  outcome with the same success or "nothing to do" result a local request would give.
- **FR-011**: The owning process MUST check for new requests often enough that a request is applied
  within about one second in normal conditions. It MUST NOT do this work while it has no queued,
  running or paused jobs.
- **FR-012**: The requester MUST wait a bounded time (about five seconds) for the outcome. If none
  arrives, it MUST return a clear error naming the owner and noting the request may still be
  applied.
- **FR-013**: A request for a job whose owner is an MCP process that is no longer running MUST be
  refused immediately with a message saying the owning process has exited.
- **FR-014**: A request MUST only be applied to a job that is still queued, running or paused; a
  request left behind for a finished job MUST never be applied.
- **FR-015**: Every request applied on behalf of another process MUST add a line to the job's log
  naming the action, the requesting front end (web UI or MCP) and, where known, the requesting user.
  An answer's text MUST NOT appear in that line or anywhere else in the log or jobs database beyond
  what a local answer already records.
- **FR-016**: The web UI's existing visibility check MUST still gate stop, answer and dismiss for
  a job owned by another process, before any request is recorded.
- **FR-017**: The MCP server's wait tool MUST remain limited to jobs its own process owns.
- **FR-018**: The web UI and MCP tools MUST no longer refuse stop, answer and dismiss solely because
  another process owns the job.

**Documentation**

- **FR-019**: README and CLAUDE.md MUST be updated wherever they state that jobs owned by another
  process have no live streaming or controls in the web UI, or that control only works from the
  owning process.

### Key Entities

- **Job**: an existing record of one piece of work, with its owner, status, prompt state and log.
  Unchanged apart from being watched and controlled from other processes.
- **Job control request**: a new record of one requested action on a job by a non-owning process.
  Holds the job, the action (stop, answer, dismiss), the answer text for an answer (held only until
  applied), who asked and from which front end, when it was asked, and, once the owner handles it,
  when and with what outcome.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For a job started over MCP, the web UI job page reflects new output, status changes and
  prompt changes within 2 seconds, with no reload, in 100% of trials in the automated tests.
- **SC-002**: Stop, answer and dismiss on a job owned by another live process take effect and report
  their outcome to the requester within 2 seconds in normal conditions.
- **SC-003**: A request aimed at a job whose owning MCP process has exited is refused in under
  half a second, without waiting for a timeout.
- **SC-004**: No regression: every existing job, streaming and control test for jobs owned by the
  same process continues to pass unchanged.
- **SC-005**: A request's answer text is never present in the job log or retained after the request
  is handled.

## Assumptions

- The web service and MCP server processes run on the same machine and share one data directory
  (as they already do for the jobs database), so each can read the other's job log files.
- One operator at a time; concurrent-edit races lasting seconds are acceptable (project practice).
- The web client's live-stream messages and fallback refresh are sufficient as they are; no web
  client UI change is required beyond what already displays these messages.
- Answer text that a local answer already writes nowhere persistent stays that way: the control
  request clears it once handled.
- Waiting on and relaying prompts through the assistant (the MCP wait tool) for jobs owned by other
  processes is out of scope.
- No guard is added against an answer reaching a newer prompt than the one displayed, beyond
  today's in-process behavior.
- The job permission model does not change.
