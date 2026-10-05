# Web job runner

The job queue behind the web UI and the MCP server: `JobRunner`, `JobStore` (`job-store.ts`, `data/jobs.sqlite3`), `JobSSHClient` (`job-ssh-client.ts`), the prompt relay, and cross-process watching/control of jobs.

## Prompt relay (issue #57)

The web UI answers app-script prompts by relaying them. `src/web/routes/provisioning.ts` sets `watchForPrompts` for `install-app` alone (every other job type leaves it unset, so `JobSSHClient` behaves as it always has, with no detection overhead) and pre-scans the app script via `checkAppUrl(...).prompts`. `JobSSHClient` watches the output stream, moves the job to `awaiting_input`, and emits the text over the `/ws/jobs/:id` WebSocket (replayed to a client connecting mid-prompt). `POST /api/jobs/:id/answer` writes the reply back into the channel; `/dismiss-prompt` abandons a false positive.

Supplying `onStdinReady` makes `exec()` request a real pty and keep stdin open, instead of its default immediate `stream.end()`. That is what makes answering possible, and also why an undetected prompt **hangs the job** here rather than failing fast on EOF the way every non-watching exec does. `JobSSHClient.execInteractive()` is rejected outright (a background job has no terminal; see `src/commands/provisioning/CLAUDE.md` for the CLI interactive path).

The MCP server runs through the same `JobRunner`/`JobSSHClient` detection and relays each pause through MCP elicitation instead of a WebSocket: one detection path, two front ends. See `src/mcp/CLAUDE.md` (`wait_for_job`, elicitation). The banner copy per origin lives in `web-client/CLAUDE.md` (`promptBannerView()` in `web-client/src/lib/prompt-banner.ts`).

### Detection tiers (issue #160)

Detection runs on one self-re-arming timer with three cumulative silence tiers:

- **2s**: tests the trailing line against the app's own pre-scanned prompt strings, compiled into regexes by `src/web/jobs/prompt-matcher.ts`. Shell expansions in the hint become wildcards, since the script source carries `${TAB3}Enter the token: ` while the pty prints `   Enter the token: `.
- **30s**: adds the two original trailing-line heuristics: a *string-final* `?`, or a `(y/n)`-style hint.
- **5 minutes**: escalates whatever is in the buffer unconditionally as a `stall`. `watchForPrompts` mode holds stdin open and an undetected prompt would otherwise hang forever (no EOF backstop; the 15-minute abandon timer only starts once a prompt has already been detected).

### OutputActivity: what counts as silence (issue #52)

"Silence" means no *meaningful* output. `src/web/jobs/output-activity.ts`'s `OutputActivity` splits the stream on `\r`/`\n` (a pty's `\r\n` is one newline) and keys each line by its text, ignoring ANSI codes, leading glyphs and whitespace runs. A line with no letters or digits (bash `select`'s `#? `) keys on its punctuation instead, so only a line of Braille spinner glyphs and whitespace has an empty key.

A line whose key is empty or repeats one of the last 16 distinct meaningful lines is a *redraw*, such as the `build.func` spinner that redraws `⠋ Skipping host LXC stack upgrade prompt (unattended mode)` about ten times a second for a whole install. A redraw never re-arms a tier and is kept out of what the tiers look at. Digits are significant, so a ticking counter or percentage bar still counts as activity (operator decision: otherwise a long download showing only a percentage would raise a false stall).

- The text the tiers test is the last meaningful line unless a newline ended it. A prompt the next spinner frame overwrote with `\r` still counts, until a redraw ended by a newline (`msg_ok`'s check-mark line) moves past it.
- A prompt printed onto the end of a glyph-led spinner frame has the frame's text stripped, so the operator sees the bare question. The stall text is the last meaningful line.
- The retained transcript is capped at 16 KiB rather than holding the whole log.
- The MCP dialog's recent-output context (`lastLines`, `src/mcp/elicitation.ts`) drops redraws by the same rule.
- Spinner-only steps count as silent, so a long one raises a stall pause.

### Pause lifecycle: `resume()`, exemption, dismissal, stall clearing

- `resume()` keeps the recent lines, so the spinner is still a redraw after an answer and the next prompt stays the line the tiers test.
- After an *answered* expected or heuristic pause (never a stall, whose text may be the spinner line itself, and never a merely dismissed false positive) it instead exempts the reported prompt: a line starting with that prompt's text is never a redraw, so a question re-asked word for word after an invalid answer is caught again.
- A dismissed pause (`JobRunner.dismissPrompt` calls only `resume()`, never `write()`) must not get this exemption. A spinner status line that happens to match a heuristic, once dismissed, would otherwise have every later frame of that line counted as new meaningful output instead of a redraw, re-arming tier 0 forever and never letting the stall tier run. `fire()` hands `onPromptDetected` a `write()` wrapped to record whether it was actually called, and `resume()` reads that flag rather than trusting `origin` alone.
- New meaningful output arriving while a *stall* pause waits clears it exactly as a dismissal would, so the abandon timer can't cancel a job that was still working (operator decision). Expected and heuristic pauses never clear themselves.
- Every pause carries its origin (`expected`/`heuristic`/`stall`) through to the job row and the WebSocket, so `JobView` can number a known prompt ("question 2 of up to 4") and flag a stall as a guess rather than a detected question.

### Install-script pre-scan

The pre-scan reads `install/<slug>-install.sh`, the file `build.func` downloads into the container and where an app's own `read` prompts actually live. It is deliberately *not* `ct/<slug>.sh`: all 20 ct scripts that carry a `read` prompt have it inside `update_script()`, which `install-app` never reaches.

Measured 2026-09-10: 75 of 584 install scripts prompt (128 prompts); the two heuristics alone caught 61 and missed 67, and 33 scripts missed their *first* prompt, so a web-triggered apply stalled immediately. The web UI is now the equal path for a prompting app, with three residual gaps that fall back to the heuristic and stall tiers: the 14 `ct/` scripts with no conventionally-named install script, a pasted full script URL (no derivable counterpart), and a prompt whose text is built from a variable rather than a literal string.

See `src/commands/provisioning/CLAUDE.md` (`install-app`) for how a source is resolved and pinned for the pre-scan.

## Job owner stamp and orphan cleanup

The MCP server shares `data/jobs.sqlite3` with the web service. `JobRunner` stamps an `owner` on every job (`'web'`, or `'mcp:<pid>'`). Orphan cleanup (`JobStore.interruptOrphaned`) only touches the caller's own rows plus rows of MCP processes whose pid is dead, so neither process's startup interrupts the other's in-flight jobs.

## Cross-process job watching and control (issue #6)

A job owned by the *other* process is still fully watchable and controllable.

- **Watching.** `/ws/jobs/:id` (`src/web/routes/jobs.ts`) recognizes a job whose row `owner` differs from this process's own `JobRunner.owner`. That runner's events never fire for it, so it runs a per-connection foreign-job tailer (`src/web/jobs/job-tail.ts`): a `setInterval` that polls the shared job row and log file once a second and emits the same `chunk`/`status`/`prompt`/`prompt-cleared` messages a local job would, so a client sees no protocol difference. It stops (and the socket closes) once it sees the owning MCP process has died (checked via the row's `mcp:<pid>` owner, same liveness check as orphan cleanup) rather than polling a stuck row forever. The row itself is only closed out by orphan cleanup at the next web-service start.
- **Control** (cancel/answer/dismiss) goes through the shared `requestJobControl` (`src/web/jobs/job-control.ts`), used by both the three web routes and the three matching MCP tools. A local job is applied directly. A foreign job is refused up front the same way a local one would be (a terminal job's cancel, a not-`awaiting_input` job's answer/dismiss) plus one foreign-only case (an `mcp:<pid>` owner whose process has died). Otherwise it is recorded as a row in the `job_control_requests` table and returned immediately (202 on the web, `{ requested: true }` from MCP) without waiting on the owner.
- **Applying requests.** The owning `JobRunner` runs its own poll timer (`processControlRequests()`, 500ms, running only while it has active jobs) that applies each pending row through its ordinary `cancel`/`answerPrompt`/`dismissPrompt`, appends an attribution line to the job log (`Stop requested from web UI by <user>`, `Answer sent from MCP (mcp:<pid>)`, etc., never the answer text itself) and marks the row handled, or `not-applicable` if the job isn't one this runner still has a controller for.
- **Stale requests.** A request can outlive its target (the MCP process that queued it exits, or the job finishes before the owner polls again). `JobStore.closeStaleControlRequests()`, run at the top of every poll pass and from `reconcileOrphanedJobs()`, closes any pending request whose job is terminal or whose `mcp:<pid>` owner is dead, from any process, so a request aimed at a since-exited MCP server or a since-restarted web service never sits with its answer text lingering.
- **Exception.** `wait_for_job` stays owner-only (`requireOwned` in `src/mcp/job-helpers.ts`, now its only remaining caller): it blocks on the job's in-memory controller/events, which only the owning process holds. See `src/mcp/CLAUDE.md`.

## Job attribution columns

Every job has nullable `triggered_by_username`/`triggered_by_impersonating` columns on `job-store.ts`'s `jobs` table, populated on every `jobRunner.enqueue()` call site across `provisioning.ts`/`maintenance.ts`, not just impersonated ones. They are shown as a "Triggered by" column in the Job History table, so the real admin identity stays visible and auditable even while the admin's *view* is impersonated. The `/ws/jobs/:id` upgrade handler duplicates `applyImpersonation`'s overlay inline (it bypasses Express middleware); see `src/web/CLAUDE.md` (Web UI authentication, impersonation).
