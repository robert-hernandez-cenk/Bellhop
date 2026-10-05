# Research: Accept a second action while a job is running (#78)

## R1. Why the second action waits

**Finding**: `withCapturedConsole` (`src/web/console-capture.ts`) runs every capture on one module-level promise chain, because each capture swaps the global `console.log`/`console.error` and two captures running together would steal each other's lines. `JobRunner.execute` wraps a job's whole `run()` in a capture. `previewAndEnqueue` (`src/operations/core.ts`) runs the operation's `preview()` before `jobRunner.enqueue`, and almost every `preview()` is itself a `withCapturedConsole` call. So a second action's preview waits behind the whole running job, and no job row exists for it until then.

The chain was also process-wide rather than per runner: in the test suite every `JobRunner` shared it, and the standalone Preview button (`POST /api/provisioning/:id/preview`) and the App check had the same wait.

## R2. Isolating captures: AsyncLocalStorage

**Decision**: Each capture runs its function inside `AsyncLocalStorage.run(sink, fn)`. The console wrappers look up `storage.getStore()` and append to that sink, or fall back to the console when there is none.

**Rationale**: async context follows `await`, promise callbacks, timers, and the callbacks of handles created inside the context. That includes net sockets, and so ssh2's channel events. Checked on Node 26.1.0 with a scratch script: two `net.connect` calls made inside two different `run()` contexts each saw their own store in their `data` and `close` callbacks, even though the events interleaved. `AsyncLocalStorage` is stable in every Node version CI runs (24 and 26, `engines: >=24`), and it needs no dependency.

**Alternatives considered**:
- *Pass an explicit logger through every call*: correct, but it means rewriting every `console.log`/`logInfo` call reachable from a command. That is hundreds of call sites, and commands would print differently under the CLI.
- *Keep the chain but enqueue before the preview*: the preview would have to run inside the job, the very deadlock the existing comment warns about, and the request still couldn't return a preview without waiting.

## R3. Installing the wrappers: reference counting, not once at module load

**Decision**: The wrappers are installed when the number of active captures goes from 0 to 1. Whatever `console.log`/`console.error` are at that moment are saved as the fallback. When the count drops back to 0, the saved functions are restored, but only if the wrappers are still the ones installed.

**Rationale**:
- `src/mcp/server.ts` sets `console.log = console.error` in its module body. ES module imports evaluate first, so wrappers installed at import time would be overwritten and MCP job output would go to stderr instead of the job log. Installing at first capture runs after that line, so the redirect becomes the fallback, and stdout stays clean outside captures (FR-009).
- Many tests swap `console.log` for a collector and restore it afterwards. With permanent wrappers, a test that saved a wrapper as its "original" could leave a stale collector as the fallback. Restoring at count 0 keeps the console exactly as it was outside captures, which also preserves the existing test that checks the original is restored.
- "Only if still ours" means code that replaced the console during a capture isn't overwritten on the way out.

**Alternative considered**: install once and never restore, the issue's wording. Rejected for the two reasons above. Reference counting keeps the issue's intent, a single patch shared by all concurrent captures, without the ordering hazard.

## R4. Lines after a capture settles

**Decision**: Each sink has an `active` flag that is cleared when its function settles. A wrapper that finds an inactive sink (a timer or socket callback outliving the capture) uses the fallback.

**Rationale**: matches today's behavior, where the console was restored at that point. It also stops a late line from being appended to a finished job's log. While other captures are still active the wrappers stay installed, so without this flag such a line would land in the finished capture's array.

## R5. Nested captures

**Decision**: An inner `withCapturedConsole` starts a new `run()`, so the inner store shadows the outer one until it settles. Lines logged inside go to the inner sink only (the issue's "check" item). Once the inner capture settles, its context's late lines fall back to the console, not to the outer sink. That edge case is acceptable and matches R4.

## R6. Jobs stay one at a time: a serial queue in JobRunner

**Decision**: `JobRunner` keeps `private queue: Promise<void> = Promise.resolve()`. `enqueue` creates the row (`queued`), registers the controller, and chains `this.queue = this.queue.then(() => this.execute(...))`. `execute` catches everything already; the chain link's catch logs any rejection that still escapes (naming the job) and keeps the chain alive. Cancelling a job that hasn't started yet finishes it on the spot (code review, FR-004 "immediately"): `cancel()` writes "Job cancelled by operator" to its log, marks it `cancelled`, emits the status event and drops its in-memory state, and when its turn comes `execute` sees it no longer has a controller and returns without doing anything. It is never marked `running`. A runner tracks which jobs have started so `cancel()` can tell a queued job from a running one; a running job is still cancelled by aborting its controller, as before.

**Rationale**: "one at a time" was a side effect of the console chain. Making it an explicit, per-runner property keeps it true when captures stop waiting on each other. The web service and each MCP server already have separate runners in separate processes, so per-runner is the same scope as before in production.

**Alternative considered**: a counter plus a pending-job array. More code for the same ordering guarantee a promise tail gives.

## R7. The core.ts comment and preview placement

**Decision**: Replace the deadlock warning with the reason previews still run before enqueue: the preview text is logged at the top of the job log, and a bad input fails the request before any job row exists. A preview inside a job would no longer deadlock, but nothing moves into the job.

**Consequence**: because `previewAndEnqueue` no longer waits behind a running job, a queued job's preview -- and, for a `resolvesApp` operation, its pinned custom-repository commit -- is computed when the job is queued, which may be well before it runs.

## R8. Documentation

`CLAUDE.md`'s "Shared operations layer" bullet calls the ordering "the ordering that avoids the `withCapturedConsole` deadlock"; it is reworded. No user docs under `docs/` describe the queue, and Job History already shows `queued` jobs, so no user-facing page changes.
