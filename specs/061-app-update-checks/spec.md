# Feature Specification: Daily App Update Checks

**Feature Branch**: `issue-61-app-update-checks`

**Created**: 2026-10-03

**Status**: Draft

**Input**: Issue #61: "For an LXC container's primary app, the Update page should indicate that an update is available. This should be done via a new tasks concept: a task should run once a day that checks if the app has an update available."

## Overview

The Update page lets an operator re-run an LXC guest's community-scripts app update, but it gives no hint whether an update actually exists. The operator either updates blindly or checks each app by hand.

This feature adds two things:

1. **Scheduled tasks**: a general way for the web service to run background work at a fixed time every day. Each run appears in Job History like any other job. An admin-only Tasks page shows every task's schedule and its last run, and has a button to run a task right away.
2. **The first task, the app update check**: once a day it compares each LXC guest's installed app version with the app's latest stable upstream release, and records the result. The Update page then shows which guests have an update waiting.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See which apps have an update waiting (Priority: P1)

An operator opens the Update page. Next to each LXC guest's app, they can see whether a newer release exists ("Update available 1.2.3 → 1.3.0"), or that the app is up to date. The update button for a guest with a waiting update stands out, so they know which guests are worth updating today.

**Why this priority**: this is what the issue asks for. Without it, the scheduled check has no visible value.

**Independent Test**: record a check result for a guest (by running the check by hand), open the Update page, and confirm the badge and the emphasized button appear for that guest and not for one that is up to date.

**Acceptance Scenarios**:

1. **Given** the last check found guest `media` running app version 1.2.3 while 1.3.0 is the latest release, **When** the operator opens the Update page, **Then** `media`'s card shows "Update available 1.2.3 → 1.3.0" and its app update button is visually emphasized.
2. **Given** the last check found guest `web-lxc` up to date at 2.0.0, **When** the operator opens the Update page, **Then** its card shows a quiet "Up to date" note, and hovering over or tapping the note shows when it was checked.
3. **Given** a guest whose app cannot be checked (its script has no recognizable release check), **When** the operator opens the Update page, **Then** that card shows no update indicator at all, and nothing about it looks like an error.
4. **Given** a restricted user who cannot see guest `media`, **When** they open the Update page, **Then** no check result for `media` reaches them.
5. **Given** the last check failed for a guest (for example, the release service could not be reached), **When** the operator opens the Update page, **Then** that card shows a quiet "Update check failed" note, and the note's details give the reason.

---

### User Story 2 - The check runs by itself every day (Priority: P1)

Without anyone doing anything, the web service runs the app update check once a day at the configured time (04:00 server time by default) and refreshes every result. If the service was down at that time, the check runs as soon as the service starts again.

**Why this priority**: a manual-only check would go stale and defeat the point of the indicator. The daily schedule is the "tasks concept" the issue asks for.

**Independent Test**: with a simulated clock, advance past the scheduled time and confirm exactly one check run starts and appears in Job History, with "Triggered by" showing the scheduler.

**Acceptance Scenarios**:

1. **Given** the check is scheduled for 04:00 and last ran yesterday at 04:00, **When** the clock reaches 04:00 today, **Then** one check run starts and appears in Job History as triggered by the scheduler.
2. **Given** the service was stopped from 03:00 to 06:00, **When** it starts at 06:00, **Then** the missed 04:00 run starts once, shortly after startup.
3. **Given** a run of the check is still in progress, **When** the scheduled time arrives again (or a manual run is requested), **Then** a second concurrent run is not started.
4. **Given** the task is disabled, **When** its scheduled time passes, **Then** no run starts.
5. **Given** the check has already run today after 04:00, **When** the service restarts at 10:00, **Then** no extra run starts.

---

### User Story 3 - Manage tasks from the Tasks page (Priority: P2)

An admin opens the Tasks page in the Admin section of the navigation. For each task they see what it does, its time of day, whether it is enabled, when it last ran (with its outcome and a link to that run's log), and when it runs next. They can change the time, turn the task off or on, or press "Run now".

**Why this priority**: the daily run works without this page, but the operator needs to see whether the task is healthy, adjust when it runs, and refresh results on demand (for example, right after a big round of updates).

**Independent Test**: as an admin, change the task's time to 05:30, press Run now, and confirm the page shows the new next-run time and a last run linking to the new job. As a non-admin, confirm the page and its actions are refused.

**Acceptance Scenarios**:

1. **Given** an admin on the Tasks page, **When** they change the app update check's time to 05:30 and save, **Then** the next-run time shows the next 05:30, and the scheduler uses the new time from then on.
2. **Given** an admin on the Tasks page, **When** they press Run now, **Then** a run starts at once and shows in Job History with them as the triggering user, and the page's last-run entry links to it.
3. **Given** a non-admin user, **When** they try to view or change tasks, or run one, **Then** they are refused, and the Tasks link does not appear in their navigation.
4. **Given** an admin enters an invalid time such as `25:00`, **When** they save, **Then** the change is rejected with a message giving the expected format, and the stored schedule is unchanged.
5. **Given** a phone-sized screen, **When** an admin opens the Tasks page, **Then** every task's details and controls are readable and usable without horizontal scrolling.

---

### User Story 4 - Indicator stays accurate after updating (Priority: P2)

After the operator updates an app from the Update page and the update succeeds, that guest's indicator reflects the new version without waiting for the next daily run.

**Why this priority**: otherwise a guest that was just updated would keep saying "Update available" until tomorrow, which would teach operators to ignore the badge.

**Independent Test**: record "update available" for a guest, run a successful app update for that guest, and confirm its result is refreshed (to up to date, given the new installed version) when the update finishes.

**Acceptance Scenarios**:

1. **Given** `media` shows "Update available 1.2.3 → 1.3.0", **When** an app update for `media` completes successfully, **Then** `media`'s result is re-checked as part of that update job, and the page shows "Up to date" once the job finishes.
2. **Given** an app update fails, **When** the job finishes, **Then** the guest's previous result is left as it was.

---

### User Story 5 - Check from the command line (Priority: P3)

An operator runs `bellhop check-app-updates` (optionally `--guest <name>`) to see each LXC app's installed and latest versions in the terminal. Adding `--apply` also saves the results so the Update page shows them.

**Why this priority**: consistent with the rest of the toolkit's CLI, and useful for debugging the check, but the web schedule covers the main need.

**Independent Test**: run the command against a test inventory and confirm it prints one line per eligible guest and only writes saved results when `--apply` is given.

**Acceptance Scenarios**:

1. **Given** two LXC guests with apps, **When** the operator runs `check-app-updates`, **Then** one line per guest is printed with its outcome, and nothing is saved.
2. **Given** the same, **When** they add `--apply`, **Then** the results are saved, and the Update page shows them.
3. **Given** `--guest` names a guest that is not an LXC guest with an app, **When** the command runs, **Then** it fails with a message saying why.

### Edge Cases

- **Stopped guest**: the installed version cannot be read, so the result is "not checked (stopped)". It is never reported as an error or as up to date.
- **App script has no recognizable release check** (roughly a third of community-scripts apps, e.g. apps that update through a package repository): the result is "unsupported", and the Update page shows nothing for it.
- **Release check uses values computed at run time** (not literal text): treated as unsupported rather than guessed.
- **Installed-version record missing in the guest**: the result is an error that says the version record was not found and suggests running the app update once to create it.
- **App pinned to a specific version by its script**: compared against the pinned version, the same way community-scripts itself does, so a pinned app is not flagged just because a newer release exists.
- **App's releases filtered by a tag prefix**: only releases with that prefix are considered.
- **Several guests run the same app**: the release service is asked once per repository per run.
- **Release service rate limit or outage**: the affected guests get an error result naming the cause. Other guests' results are unaffected, and the run as a whole still finishes.
- **App installed from a configured custom script repository**: the release check is read from that repository's version of the script.
- **Guest removed from inventory, converted to a VM, or app cleared**: its saved result is removed on the next full run and is never shown.
- **Inventory changes while a run is in progress**: the run uses the guest list as it was when the run started.
- **Clock changes such as daylight-saving shifts**: a scheduled time is evaluated in server local time. A day never gets more than one scheduled run, and a missing or repeated local hour does not cause a skipped day.
- **The service restarts during a run**: the interrupted job is marked interrupted like any other job. The next scheduled slot (or a manual run) runs it again.

## Requirements *(mandatory)*

### Functional Requirements

**Scheduled tasks**

- **FR-001**: The web service MUST support scheduled tasks. A task has an identifier, a human-readable name and description, a time of day, an enabled flag, and the work it performs.
- **FR-002**: Each task's time of day and enabled flag MUST persist across service restarts. A task that has never been configured MUST use its built-in default time (04:00 for the app update check) and be enabled.
- **FR-003**: The web service MUST start a task's run when the task is enabled, its most recent scheduled time has passed, and it has not been started since that time. This MUST also start a run missed while the service was down, once, after startup.
- **FR-004**: A task MUST NOT have two runs in progress at once, whether started by the schedule or by hand.
- **FR-005**: Every task run MUST be recorded as a job, with a log, a final status, and a visible trigger: "scheduler" for scheduled runs, or the admin's identity for manual runs. It MUST appear in Job History like any other job.
- **FR-006**: Only the web service MUST run tasks on a schedule. The MCP server and CLI never start scheduled runs.
- **FR-007**: Admins MUST be able to list tasks with their description, time, enabled flag, last run (start time, status, link to its job), and next scheduled run.
- **FR-008**: Admins MUST be able to change a task's time of day (24-hour `HH:MM`) and enabled flag. An invalid time MUST be rejected with a message giving the expected format.
- **FR-009**: Admins MUST be able to start a task immediately ("Run now"). If a run is already in progress, they get a message saying so and no second run starts.
- **FR-010**: Viewing tasks, changing them, and running them MUST be restricted to admins. This uses the same admin rule as the other Admin pages, including the impersonation behavior those pages already have.
- **FR-011**: The Tasks page MUST be reachable from the Admin section of the navigation for admins only, and MUST be usable at desktop width and at phone width (640px or narrower).

**App update check**

- **FR-012**: The app update check MUST consider every LXC guest in inventory that has an app recorded. VMs and guests without an app MUST be ignored.
- **FR-013**: For a stopped guest, the check MUST record "not checked" with the reason, without contacting the guest.
- **FR-014**: The check MUST determine the app's release source from the app's own install script, as resolved for that guest: upstream stable or development, or the configured custom script repository. It does this by recognizing the script's GitHub release check and its literal arguments (version record name, repository, and optionally a pinned version and a tag prefix).
- **FR-015**: An app whose script has no recognizable release check, or whose check arguments are not literal, MUST be recorded as "unsupported".
- **FR-016**: The check MUST read the installed version from the same version record inside the guest that the community-scripts update itself reads, including its fallback to a single legacy version file. A missing record MUST be recorded as an error with a suggested fix.
- **FR-017**: The check MUST determine the latest stable release (excluding drafts and pre-releases) the same way the community-scripts update does: the same leading-"v" normalization, the same pinned-version behavior, and the same tag-prefix filtering. It MUST query each repository at most once per run.
- **FR-018**: Each guest's outcome MUST be one of: update available (with installed and target versions), up to date (with installed version), unsupported, not checked, or error (with a message). Every outcome MUST record when it was checked.
- **FR-019**: A failure for one guest (unreachable guest, unreadable script, release service error or rate limit) MUST be recorded for that guest only, and MUST NOT stop the rest of the run.
- **FR-020**: The check MUST NOT change anything on the guest. It only reads.
- **FR-021**: After a full run, saved results MUST exist only for guests that are currently eligible. Results for removed or no-longer-eligible guests MUST be deleted.
- **FR-022**: After an app update started from the web UI or MCP server completes successfully, the check MUST re-run for that one guest as part of the same job and replace its saved result. A failure of that re-check MUST be logged as a warning and MUST NOT fail the update job.
- **FR-023**: The CLI MUST offer `check-app-updates [--guest <name>] [--apply]`. It prints each checked guest's outcome, and saves the results only with `--apply`. `--guest` limits the check to one eligible guest and fails with an explanation for an ineligible one.

**Update page**

- **FR-024**: The Update page MUST show each guest's saved result next to its app. Update available shows a prominent badge with both versions, and the guest's app update button is emphasized. Up to date shows a quiet note. Error shows a quiet note with the reason available. Not checked shows a quiet note with the reason. Unsupported shows nothing.
- **FR-025**: The time of each result's check MUST be visible from its note or badge, on hover or tap.
- **FR-026**: Results MUST only be returned for guests the requesting user is allowed to see, using the same per-resource rules as the rest of the web UI.

### Key Entities

- **Task**: a named unit of scheduled work. Attributes: identifier, name, description, time of day, enabled, last run start time, last run's job.
- **Task run**: one execution of a task, recorded as a job (status, log, trigger, start and end times).
- **App update result**: the latest check outcome for one guest. Attributes: guest, app, outcome, installed version, latest or target version, release repository, message, checked-at time.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For any LXC guest whose app uses a recognizable GitHub release check, an operator can tell from the Update page alone whether an update is available, without opening a terminal or the app's project page.
- **SC-002**: The check runs automatically once per day with no operator action. Over any 7-day period with the service running, exactly 7 scheduled runs appear in Job History.
- **SC-003**: After a service outage that spans the scheduled time, the missed check starts within 2 minutes of the service starting.
- **SC-004**: The badge agrees with what the community-scripts update itself decides. For every guest shown "Update available", running its app update actually updates it, and for every guest shown "Up to date", running its app update reports no update.
- **SC-005**: A daily run for a homelab of up to 50 app guests completes without hitting the release service's unauthenticated request limit.
- **SC-006**: Immediately after a successful app update, the guest's indicator no longer claims an update is available.
- **SC-007**: A restricted user never sees a check result for a guest they are blocked from.

## Assumptions

- Only apps whose script uses community-scripts' GitHub release check are checked. Apps that update through Codeberg, GitLab, or a package repository are reported as unsupported, which is not a failure. Covering them is a possible follow-up.
- No GitHub token is configured. One run a day, querying each repository once, stays within the unauthenticated limit for a homelab-sized inventory. A token setting is a possible follow-up.
- Scheduled times use the server's local time zone. There is one time of day per task: no cron expressions, and no more than one scheduled run per day.
- The app update check is the only task delivered here. The tasks concept is built so further tasks can be added later without changes to the scheduler or the Tasks page.
- Results are not exposed through a dedicated MCP tool in this feature. The MCP server's update-app jobs still refresh the result for their guest (FR-022).
- Checking never updates anything automatically. Updating stays an explicit operator action.
- Saved schedules and results live with the rest of the toolkit's local data and are not part of the inventory's own host and guest records, so syncing inventory never erases them.
