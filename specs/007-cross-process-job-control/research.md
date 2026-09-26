# Research: Cross-Process Job Streaming and Control

All decisions below are grounded in the current code: `src/web/jobs/job-runner.ts`,
`job-store.ts`, `job-log.ts`, `src/web/routes/jobs.ts`, `src/mcp/build-server.ts` and
`src/mcp/job-helpers.ts`. No third-party API is involved, so no captured fixtures are needed.

## R1. How the web service follows a job it does not own

**Decision**: when `/ws/jobs/:id` upgrades for a job whose `owner ?? 'web'` differs from the local
`jobRunner.owner`, the handler does not subscribe to `jobRunner.events` (those never fire for that
job). Instead it runs a per-connection **foreign-job tailer** (`src/web/jobs/job-tail.ts`) on a
`setInterval` (default 1000ms, injectable). Each tick:

1. re-reads the job row;
2. reads the log file's bytes from the current offset (initially where the backlog ended), decodes
   them with a `StringDecoder('utf8')` that carries a split multi-byte sequence into the next tick,
   and sends a `chunk` message when non-empty;
3. sends `status` when the row's status changed, `prompt` when a new prompt appeared (compared on
   prompt text + origin + matched index), and `prompt-cleared` when a prompt that was shown is gone;
4. when the row read in step 1 is terminal, stops after this tick.

Row-then-log order matters: the owner writes the final log line before `markFinished`, so reading
the row first and the log second guarantees every line written before the terminal status is
flushed before the tailer stops.

The backlog for this path is read as a `Buffer` (new `JobLog.readBytes(name, offset)`), so the
starting offset is exactly the backlog's byte length and nothing is duplicated or skipped between
backlog and first tick. The initial `status`/`prompt` messages are sent from the same row snapshot
the tailer starts from, so its first comparison is against what the client already has.

**Rationale**: both processes already share the data directory; the log file is the complete
record (`JobRunner.execute`'s `emitChunk` appends every chunk before emitting it), and the row holds
status and prompt state. Polling is simple, bounded (one `stat`-sized read and one indexed row read
per second per open page), and needs no new process-to-process transport. The client protocol is
unchanged, satisfying FR-002.

**Alternatives considered**:

- `fs.watch` on the log file: unreliable on Windows for appends from another process and still
  needs row polling for status/prompt; not worth two mechanisms.
- A socket/IPC channel from the MCP process to the web service: new transport, lifecycle and
  discovery for no user-visible gain.
- Relying on the client's existing 2s HTTP polling fallback: it only engages when the socket
  closes, and re-downloads the whole log every tick.

## R2. How a non-owning process asks the owner to act

**Decision**: a new `job_control_requests` table in `data/jobs.sqlite3` (created by `JobStore`'s
constructor alongside `jobs`). A non-owner inserts a row; the owning `JobRunner` polls for
unhandled rows on jobs it owns, applies each through its existing `cancel`/`answerPrompt`/
`dismissPrompt`, and marks it handled. The requester does not wait (operator decision, recorded
in spec FR-010/FR-012).

**Rationale**: the database is already shared across processes in WAL mode (#16), so a row is the
cheapest durable, ordered, cross-process queue available. Reusing the runner's own methods means a
remote stop/answer/dismiss behaves exactly like a local one.

**Alternatives considered**:

- A `cancel_requested` column on `jobs` (the issue's example): covers cancel only; answer and
  dismiss need text and ordering, which a queue table gives naturally.
- Waiting up to ~5s for an acknowledgment: dropped by the operator: the job itself (status, prompt,
  log, live view) already shows the outcome.

## R3. What the requester checks before recording

**Decision**: a shared `requestJobControl` function (`src/web/jobs/job-control.ts`) used by both the
web routes and the MCP tools:

- Local job (`owner === runner.owner`): call the runner method directly, exactly as today.
- Foreign job owned by `mcp:<pid>` whose pid is dead (`defaultIsPidAlive`, reused from
  `job-store.ts`): refuse with "job N's owning process mcp:<pid> has exited".
- Foreign job whose row is terminal (cancel) or not `awaiting_input` (answer/dismiss): refuse with
  the same "nothing to cancel/answer/dismiss" wording the local path uses.
  A queued/running job can still be cancelled.
- Otherwise insert the request and return `requested`.

The web service's liveness can't be checked the same way (its owner string carries no pid). A
request aimed at a stopped web service sits unhandled; when the service next starts, its orphan
cleanup interrupts the job, and the request is later marked not-applicable (R5). That is
acceptable at single-operator scale and is documented rather than solved.

**Rationale**: keeps the three front-end call sites (three web routes, three MCP tools) as thin
adapters, per the constitution's "shared logic lives in one place".

## R4. Owner-side polling

**Decision**: `JobRunner` starts a `setInterval` (default 500ms, injectable as
`controlPollMs`, `unref()`'d) when its first job is enqueued, and clears it in `execute`'s
`finally` when `controllers` becomes empty. A public `processControlRequests()` does one pass
(tests call it directly rather than depending on the timer). Each pass reads
`JobStore.pendingControlRequests(owner)` in id order, and for each row:

- job id not in `controllers` → mark handled `not-applicable` (covers FR-014: finished jobs and
  rows left from a previous process's lifetime are never applied);
- otherwise apply: `cancel` → `this.cancel(id)`; `answer` → `this.answerPrompt(id, text)`;
  `dismiss` → `this.dismissPrompt(id)`; result `applied` when the method returned true, else
  `not-applicable`;
- when applied, append an attribution line to the job log (FR-015):
  `Stop requested from <source> by <user>` / `Answer sent from <source> by <user>` /
  `Prompt dismissed from <source> by <user>`, with ` by <user>` omitted when unknown. Source is
  `web UI` for `web`, `MCP (mcp:<pid>)` for an MCP requester. The answer text never appears;
- `markControlRequestHandled` sets `handled_at`, `result`, and `text = NULL` (SC-005).

Pending rows are only ever read while the runner has active jobs, satisfying FR-011's "no work while
idle". A row that arrives while the runner is idle and its job is already finished is by definition
not applicable, so leaving it until the next active period is harmless.

## R5. MCP tools

**Decision**: `cancel_job`, `answer_job_prompt` and `dismiss_job_prompt` call `requestJobControl`
(requester `mcp:<pid>`, no user) instead of `requireOwned`. `wait_for_job` keeps `requireOwned`
(FR-017). A `requested` result returns `{ requested: true, owner, note }`, where the note tells the
model the owner applies it within about a second and to check `get_job`.

## R6. Web responses

**Decision**: local results keep today's bodies (`{ cancelled: true }` etc., 200). A foreign
`requested` returns **202** `{ requested: true, owner }`. Refusals stay 409 with an `error`
message. `JobView` already treats any 2xx as success and waits for the live status/prompt change,
so no web-client change is needed. The requesting user recorded is the real identity
(`req.realUser ?? req.user`).username, matching how `triggeredByUsername` is recorded.

## R7. Testing without wall-clock dependence

**Decision**: the tailer takes an injectable interval and exposes one tick as a function
(`createForeignJobTail(...)` returns `{ tick, stop }`), so unit tests drive ticks directly. The
WebSocket integration test uses a short interval plus the existing `waitFor` polling helper, the
same pattern existing WS tests use. The runner's `processControlRequests()` is called directly in
tests.
