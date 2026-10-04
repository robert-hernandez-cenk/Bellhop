# Research: Daily App Update Checks

All values below are examples (constitution Principle I). Counts come from a shallow clone of `community-scripts/ProxmoxVE` `main` taken on 2026-10-03.

## R1. How community-scripts decides "update available"

**Decision**: Mirror `check_for_gh_release` from `misc/tools.func` exactly, instead of inventing a version comparison.

The upstream function (abridged):

- `app_lc = lowercase(name) with spaces removed`, and the current-version file is `$HOME/.<app_lc>`.
- If that file is missing and exactly one `/opt/*_version.txt` exists, that file is used. (Upstream also migrates the file; Bellhop only reads.)
- It fetches `GET https://api.github.com/repos/<owner/repo>/releases/latest`. When there is no pin and no prefix and that returns 200, the result is used. Otherwise it fetches `GET .../releases?per_page=100`. Pinned versions first try `.../releases/tags/<pin>` directly; a response other than 200/403/429 there -- including a 200 that turns out to be a draft or pre-release -- falls back to the same paginated list, matching the pin against the list's tags after v-normalizing both sides (FR-017 ruling, fix round 1: the brief's original "must exist at the direct tag" wording undershot what upstream actually does, which always re-derives its candidate tags from a fetched list rather than trusting one direct hit blindly).
- Drafts and pre-releases are dropped, tags are filtered by an optional prefix, and the first remaining tag is "latest" (unpinned) or the one matching the pin (pinned, via the list fallback above).
- A leading `v` is stripped only when followed by a digit (`v1.2` → `1.2`, `vault-1` unchanged), for both tags and the installed version.
- If pinned: update available exactly when `installed != pin`. Unpinned: when `installed` is empty or `!= latest`. This is an inequality, not a semver ordering.

**Rationale**: SC-004 requires the badge to agree with what running the update actually does. Copying the comparison, including its inequality semantics, guarantees that.

**Alternatives considered**: Source tools.func inside the guest and run the function. Rejected because `ensure_dependencies jq` installs packages (which breaks FR-020, read-only), it needs bash and network access inside the guest, and its output is meant for humans. A semver "is newer" comparison was also rejected, because it disagrees with upstream for re-tagged or downgraded releases.

## R2. Finding the release check in a script

**Decision**: `parseReleaseCheck(script)` finds the **first** `check_for_gh_release` occurrence in the file and tokenizes its arguments as shell words. It accepts double-quoted, single-quoted, or bare words, and stops at `;`, `then`, `&&`, `||`, or end of line.

- Arguments 1 (name) and 2 (`owner/repo`) must be literal: no `$`. Otherwise the result is `unsupported`.
- Argument 3 (pin) may be literal, or a variable reference `$VAR` / `${VAR}`. A variable resolves only through a single literal assignment in the same script, `VAR="x"` or `VAR="${VAR:-x}"` (the default is used). If the variable can't be resolved, the result is `unsupported`. An empty-string pin counts as no pin.
- Argument 4 (reason) is ignored. Argument 5 (prefix) must be literal when present.
- The name must match `^[A-Za-z0-9._ -]+$` after lowercasing and space removal leaves `^[a-z0-9._-]+$`, which keeps the guest read command trivially safe. The repo must match `^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$`.

**Survey**: 414 of 617 `ct/` scripts call `check_for_gh_release`. 8 first calls contain `$`, all in argument 3: `"${RELEASE}"` with a literal `RELEASE="v3.2.4"`-style assignment, and `"$PANGOLIN_VERSION"` with `PANGOLIN_VERSION="${PANGOLIN_VERSION:-1.23.0}"`. Some calls sit behind a guard (`[[ -d /opt/x ]] && if check_for_gh_release ...`). The first call is still the app's primary release.

**Alternatives considered**: Choosing the call inside `update_script()` only. Every surveyed first occurrence already is inside it, so this adds nothing. A full bash parser is overkill.

## R3. GitHub requests and rate limit

**Decision**: `fetchLatestRelease(repo, { pin, prefix }, fetchImpl)` follows R1's request order. A `ReleaseCache` (a Map keyed by `repo|pin|prefix`, holding a promise) is shared across one run, so each repository is queried once (FR-017). Requests carry `Accept: application/vnd.github+json` and `X-GitHub-Api-Version: 2022-11-28`, and time out after 15 seconds. Responses are zod-validated (`tag_name`, `draft`, `prerelease`). There is no token.

Status 403 or 429 (from either the direct tag lookup or a paginated list fetch) becomes the error "GitHub API rate limit reached; the next scheduled check will retry", with no fallback -- it's rate-limited either path. Other failures name the HTTP status and repository, including a failed fallback-list fetch in the pinned path (fix round 1: that wording must never say "not found", since the list itself was never reached). Only once the fallback list loads successfully and still has no tag matching the pin does the pinned path say "Pinned version '<pin>' not found for <repo>". A failure poisons only that cache entry, so every guest using that repository gets the same error (FR-019).

**Rationale**: A daily run with about one request per distinct repository stays well under 60 per hour for a homelab (SC-005). A token setting is listed as a follow-up.

## R4. Resolving each guest's script source without exhausting the API

**Decision**: Add `createAppSourceResolver(inventory, fetchImpl)` to `src/lib/app-source.ts`. It returns `(app) => Promise<AppSource>`, memoized per slug. When a custom repository is configured, the resolver runs the two rate-limited calls (`resolveHeadSha`, `compareBranch`) **once per resolver** instead of once per slug. `resolveAppSource` is refactored onto the same internals, so its behavior is unchanged for its existing callers.

The script is then fetched as raw content:

- kind `custom`: `source.ctUrl` (pinned commit).
- kind `upstream`: the stable raw URL, falling back to dev on 404 (same order as `buildUpdateAppScript`).

Raw content isn't API-rate-limited. Scripts are cached per slug within a run.

**Rationale**: Without this, a configured fork would cost 2 API calls per distinct app. With 30 apps that is 60 calls, the entire hourly budget, before a single release lookup.

## R5. Which guests, and stopped guests

**Decision**: Eligible guests are `type === 'lxc' && app` set (FR-012). At the start of a full run, `getGuestStatuses` runs once. A `stopped` guest gets `not-checked` with "Guest is stopped" and is never contacted (FR-013). A guest whose host status query failed is still attempted, and a read failure there becomes `error`. A `--guest` / post-update single-guest check skips the status query and simply attempts the read.

The inventory snapshot is taken at run start (spec edge case).

## R6. Reading the installed version inside the guest

**Decision**: A POSIX `sh` script sent with `runRemote(ssh, inventory, guest, script)`, where `<name>` is the validated `app_lc` from R2:

```sh
f="${HOME:-/root}/.<name>"
if [ -f "$f" ]; then cat "$f"; exit 0; fi
set -- /opt/*_version.txt
if [ "$#" -eq 1 ] && [ -f "$1" ]; then cat "$1"; exit 0; fi
exit 3
```

Exit 0: the trimmed first line of stdout is the installed version. Exit 3: `error`, "No installed-version record (~/.<name>) found in the guest; run the app's update once to create it". Any other exit: `error` naming the exit code and stderr. Nothing is written (FR-020).

## R7. Outcomes and storage

**Decision**: Outcomes are `update-available | up-to-date | unsupported | not-checked | error` (FR-018). They live in `app_update_status`, keyed by guest name; see data-model.md. A full run replaces the whole table in one transaction (FR-021). A single-guest check upserts one row. `GET /api/app-updates` reads the table and drops rows for guests the caller can't see (`isResourceAllowed(..., 'guest', name)`), and for guests that are no longer eligible in the current inventory. That covers a guest removed between runs.

## R8. Scheduler semantics

**Decision**: `TaskScheduler` gets an injected `now()` and `setInterval`-style ticker (default 60 s), and also ticks once right after `start()` so a missed run starts within seconds (SC-003). For each enabled task:

- `slot = mostRecentSlot(now, 'HH:MM')`: today at HH:MM local, or yesterday's if today's hasn't come yet. It is built with `new Date(y, m, d, hh, mm)`. JS local-time normalization moves a nonexistent DST hour forward, and an ambiguous hour resolves to one instant, so each calendar day yields exactly one slot.
- Start a run when `lastRunStartedAt` is unset, or when it is earlier than `slot` **and** falls on an earlier local calendar day than `slot` (`slotIsDue`), and no run of that task is active. The last start counts whatever started it, scheduled run or Run now.
- The calendar-day rule keeps the schedule to one run per day. Without it, moving the time later after today's run (ran at 04:00, moved to 06:00 at 05:00) would run again at 06:00, and a Run now at 03:00 would be followed by the 04:00 run. With it, both wait for the next day's slot. A catch-up after an outage still runs once, since the last start is on an earlier day than the missed slot.
- A brand-new install has no `lastRunStartedAt`, so it runs at its first tick. That is intentional: it gives results right after deploying this feature.

"Active" means the last recorded job id's row in `JobStore` is `queued`, `running`, or `awaiting_input`. `reconcileOrphanedJobs()` already marks a previous process's rows interrupted before the scheduler starts, so a crash never leaves a task permanently "active".

`startRun(taskId, triggeredBy)` records `lastRunStartedAt = now` and `lastJobId` in the same call that enqueues the job. Both the schedule and "Run now" go through it, so FR-004 holds for both. The scheduler also keeps the last start and job id per task in memory, set right after the enqueue and consulted alongside the database row. If the database write fails, it is logged with `logWarn` and the in-memory record still stops later ticks from enqueuing a duplicate in this process. `nextRun` is the first slot after `max(now, lastRunStartedAt)` that is on a later calendar day than `lastRunStartedAt`.

Changing the time does not reset `lastRunStartedAt`. Moving the time on a day that has already run, earlier or later, therefore doesn't trigger an extra run that day; the new time takes effect the next day.

A cancelled run stops and saves nothing. `JobDefinition.run` receives the job's `AbortSignal` as a second argument, the scheduler passes it to the task as `TaskRunContext.signal`, and `runCheckAppUpdates` checks it between guests and before saving. Without that check, a cancelled run's aborted SSH calls would come back as per-guest errors and overwrite every saved result.

**Alternatives considered**: `setTimeout` to the exact next slot. Rejected because of drift across sleep/DST and harder testing. Cron libraries were rejected as a new dependency for one daily time.

## R9. Task runs as jobs

**Decision**: `TaskDefinition { id, label, description, defaultTime, command, run(deps) }`. `startRun` calls `jobRunner.enqueue({ command: task.command, category: 'maintenance', target: undefined, argsJson: '{}', triggeredByUsername, run })`.

- The scheduler uses `triggeredByUsername: 'scheduler'`. Run now uses `resolveTriggeredBy(req)`.
- `check-app-updates`'s `run` reloads inventory (same as `enqueue` in `src/operations/core.ts`), calls `runCheckAppUpdates({ apply: true }, { ssh: jobSsh, ... })`, and logs `formatCheckAppUpdates(result)` to the job log.
- The job fails only on an unexpected exception. Per-guest errors are results, not job failures.
- Targetless jobs are admin-only in Job History (`isJobVisible` returns false for `target === null` for non-admins). That fits an admin-only task whose log lists every guest.

Only `src/web/server.ts` constructs and starts the scheduler. The MCP server and CLI never do (FR-006). The `/api/tasks` routes get the scheduler through `AppDeps`. When it's absent (tests that don't care), the routes return 503.

## R10. Re-check after an app update

**Decision**: In the `update-app` operation's `apply` (`src/operations/maintenance.ts`, used by web and MCP), after `runUpdateApp` returns `result.result?.code === 0`, call `checkOneGuest(guest, deps)` and upsert the result. The re-check runs only when the update's `app` matches the guest's recorded `app`; otherwise it logs one info line and skips. When the job pinned an `appSource`, the re-check uses it as its resolver, so it reads the exact script just run with no second resolution of a custom branch. Any thrown error becomes `logWarn` and the job still succeeds (FR-022). A non-zero exit skips the re-check, leaving the old result (US4 scenario 2).

Note: today `update-app`'s apply does not fail the job on a non-zero script exit. Changing that is out of scope and listed as a follow-up. The re-check is gated on the exit code directly.

The CLI's own `update-app --apply` does not re-check. The operator can run `check-app-updates --guest x --apply`, and the next daily run refreshes it anyway.

## R11. UI

**Decision**:

- Update page: fetch `/api/app-updates` alongside `/inventory`. `appUpdateView(result)` in `web-client/src/lib/app-update-display.ts` maps each outcome to `{ tone: 'available' | 'quiet' | 'none', text, title }`:
  - available: `Update available 1.2.3 → 1.3.0`
  - up-to-date: `Up to date (1.2.3)`
  - error: `Update check failed`, with the message in the title
  - not-checked: `Not checked: guest is stopped` (the stored message's own wording, e.g. check-app-updates.ts's "Guest is stopped", with its first letter lower-cased so it reads naturally after the fixed "Not checked: " prefix)
  - unsupported: no view at all
  - The title always includes `Checked <local time>`.
  - The app update button gets a `button-attention` class when an update is available.
  - Because `title` doesn't show on touch, the note is a `FieldHelp`-style disclosure (tap to show the checked time and message), not a hover-only tooltip.
- Tasks page: `.data-table` with `data-label` cells (Task, Schedule, Last run, Next run, Actions). The time is a `<input type="time">` plus enabled checkbox and a Save button. Run now navigates to the new job. Validation goes through `isValidTimeOfDay` (`^([01]\d|2[0-3]):[0-5]\d$`), shared in spirit with the server's zod rule.
- `adminNavLinks` adds `Tasks` (needs only `isAdmin`, like Settings).

## R12. Fixtures

**Decision**: Capture real responses for public repositories: `releases/latest` and `releases?per_page=100` for one repository whose list includes a pre-release, plus one `ct/*.sh` script with a plain call and one with a `${RELEASE}` pin. Fixtures are stored exactly as captured, since Principle I requires preserving array lengths and shape. To keep them small, the fixture repository is chosen for small `assets`/`body` fields. These are public upstream data, not operator data, so no redaction is needed beyond confirming that.
