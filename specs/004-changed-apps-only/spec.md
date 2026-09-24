# Feature Specification: Custom Script Repository — Only the Apps the Branch Changes

**Feature Branch**: `issue-15-changed-apps-only`

**Created**: 2026-09-24

**Status**: Draft

**Input**: User description: "GitHub issue #15: #11 made the custom script repository win for every slug it contains. A real fork branch carries all of upstream ProxmoxVED's scripts, so almost every ProxmoxVED app now installs from the fork's (possibly stale) snapshot, each with an override warning. The custom repository should supply only the apps the branch actually changes; every other app keeps coming from upstream. Warn on a real conflict (upstream also changed the app since the branch point), but don't block."

## Clarifications

### Session 2026-09-24

Settled while designing issue #15, before this spec was written:

- Q: How is "changed on the branch" decided? → A: By comparing the branch, pinned to its current head commit, against upstream ProxmoxVED's main branch. An app is changed when its container script or its install script is added, modified, or renamed on the branch relative to the point where the branch left upstream. Deleting a script does not make an app "changed".
- Q: Why pin the comparison to a commit rather than the branch name? → A: A comparison addressed by branch name can silently be answered from a different fork of the same upstream repository when the configured fork doesn't exist, which would produce a wrong changed-app list with no error. A pinned commit either belongs to the upstream repository's fork network or the comparison fails outright.
- Q: How is a conflict detected? → A: Only for a changed app, and only when upstream has moved on since the branch point: the app's two scripts are read as they were at the branch point and as they are on upstream main now. If either differs, upstream also changed the app, and that is a conflict. This deliberately does not list every file upstream changed, because that list is capped and upstream moves fast enough to exceed the cap routinely.
- Q: What happens to an app that exists only in the fork but that the branch didn't change (e.g. inherited from an older upstream state and since removed upstream)? → A: It still installs from the fork, since there is nowhere else to get it, with no notice. It is not listed in the catalog's custom group, but typing its name still works.
- Q: What if the comparison can't be made? → A: Resolution fails with a named error, the same as a failure to pin the branch today. It never silently falls back to upstream.
- Q: Should the system authenticate to GitHub to raise its rate limit? → A: Out of scope for this change.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Only the apps I'm working on come from my branch (Priority: P1)

The operator's fork branch is a full copy of upstream ProxmoxVED plus a handful of apps they are developing. With the custom repository configured, installing or updating one of those developed apps uses the branch's copy, while installing any other app behaves exactly as if the feature were off, with no warnings.

**Why this priority**: This is the defect the issue reports. Today, nearly every development-repository app installs from a possibly stale fork snapshot with an override warning, which makes the feature unusable with a real fork.

**Independent Test**: Using a recorded comparison of a branch that is 8 commits ahead of upstream, 0 behind, and changes three apps, check one of the three apps and one app the branch doesn't touch. The first resolves to the fork at the pinned commit; the second resolves exactly as it does with the feature off and shows no notice.

**Acceptance Scenarios**:

1. **Given** the custom repository is configured and the branch changes apps A, B, and C, **When** the operator checks, previews, or installs A, **Then** the source is the fork at the pinned commit.
2. **Given** the same configuration, **When** the operator checks, previews, or installs an app the branch does not change and that exists upstream, **Then** the source is the same upstream repository the feature-off behavior picks, and no custom-repository notice is shown.
3. **Given** the same configuration, **When** the operator updates an existing guest whose app is one of A, B, C, **Then** the update resolves to the fork; for any other app it resolves to upstream.
4. **Given** the custom-repository settings are unset, **When** the operator installs any app, **Then** behavior is identical to today and no comparison is made.
5. **Given** an app exists only in the fork and the branch did not change it, **When** the operator installs it, **Then** it installs from the fork with no notice.

---

### User Story 2 - Be warned when upstream changed the same app (Priority: P1)

When the operator's branch has fallen behind upstream and upstream has also changed one of the apps the branch changes, installing that app warns them to rebase the branch. The install still proceeds from the fork, because the branch's copy is the one they are testing.

**Why this priority**: A branch copy that silently overrides a newer upstream fix is the risk that made the old blanket warning necessary. This keeps the warning, but only where it is real.

**Independent Test**: Using a recorded comparison of a branch that is behind upstream, where upstream changed one of the branch's apps since the branch point, check that app and confirm a warning naming the app and telling the operator to rebase appears in the CLI output, the web preview and job log, and the MCP result, and that the source is still the fork.

**Acceptance Scenarios**:

1. **Given** the branch changes app A and upstream also changed A's container or install script since the branch point, **When** the operator checks, previews, or installs A from any front end, **Then** a warning appears telling them upstream also changed A and to rebase the branch, and the source is still the fork.
2. **Given** the branch changes app A, A also exists upstream, and upstream has not changed A since the branch point, **When** the operator installs A, **Then** a single informational line says A is installing from the custom repository in place of the upstream copy, and no warning is shown.
3. **Given** the branch changes app A and A does not exist upstream, **When** the operator installs A, **Then** no notice of either kind is shown.
4. **Given** the branch is not behind upstream at all, **When** any changed app is checked, **Then** no conflict is reported and no conflict check is made.

---

### User Story 3 - The catalog shows only what I'm working on (Priority: P2)

The web UI's App suggestion list, and the MCP catalog listing, show the custom group with only the apps the branch changes, with conflicting apps visibly tagged. Every other app appears in its normal upstream group.

**Why this priority**: The custom group currently lists hundreds of inherited apps, which buries the handful being developed and hides them from their upstream groups. Installing by typing works without this.

**Independent Test**: With the recorded 3-app comparison, read the catalog and confirm the custom group lists exactly the three changed apps, each upstream group still lists every other app, and a conflicting app in the behind-and-conflicting recording carries a conflict tag.

**Acceptance Scenarios**:

1. **Given** the branch changes three apps, **When** the catalog is read, **Then** the custom group lists exactly those three.
2. **Given** a changed app also exists upstream, **When** the catalog is shown, **Then** it appears only in the custom group, marked with the upstream repository it overrides.
3. **Given** a changed app conflicts with upstream, **When** the catalog is shown in the web UI, **Then** its entry carries a visible conflict tag, at desktop and mobile widths.
4. **Given** the comparison cannot be made, **When** the catalog is read, **Then** the upstream groups still appear, the custom group is omitted, and a warning is logged, as today for an unreachable custom repository.

### Edge Cases

- The configured repository is not a fork of upstream ProxmoxVED (or the pinned commit is otherwise unknown to upstream's fork network): checking or installing fails with a named error pointing at the settings, never falling back to upstream.
- GitHub rate-limits the comparison, returns a server error, or is unreachable: the same named error.
- The branch changes so many files that the comparison's file list is truncated: resolution fails with a named error explaining that the changed-app list can't be determined in full, rather than acting on a partial list.
- A script was renamed on the branch: both the old and new names count as changed apps.
- A script was deleted on the branch: that deletion alone does not make the app changed; the app resolves as it would otherwise.
- Only the install script (not the container script) changed: the app still counts as changed.
- The conflict check can't read one of the scripts (network failure): the conflict check is informational, so the failure is logged and the app is treated as not conflicting; the install is not blocked.
- A pasted full script URL: unaffected, used exactly as given, no comparison, no notice.
- A slug that exists nowhere (not changed, not upstream, not in the fork): fails the same way it does with the feature off.
- The branch moves between a check and an apply: each resolution pins its own commit, and the web/MCP apply path keeps its existing guarantee that preview, prompt scan, and apply all use one pinned commit, including the changed-app list and conflict result computed for it.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: When the custom repository is configured, the system MUST determine the set of apps the configured branch changes, by comparing the branch at its pinned head commit against upstream ProxmoxVED's main branch.
- **FR-002**: An app MUST count as changed when its container script or its install script is added, modified, or renamed on the branch relative to the branch point (for a rename, both the old and new names). A deletion alone MUST NOT make an app changed.
- **FR-003**: A changed app MUST resolve to the custom repository at the pinned commit, exactly as a custom resolution does today (same installer direction, same prompt scan source, same recorded guest source).
- **FR-004**: An app that is not changed MUST resolve to upstream whenever either upstream repository has it, with the same repository choice the feature-off behavior makes, and MUST show no custom-repository notice.
- **FR-005**: An app that is not changed, is in neither upstream repository, but exists in the fork at the pinned commit MUST resolve to the custom repository with no notice.
- **FR-006**: If the comparison fails for any reason (unknown repository or commit, not in upstream's fork network, rate limit, server error, network failure, or a truncated file list), resolution MUST fail with an error that names the configured repository and branch and points at the setting that fixes it. It MUST NOT fall back to upstream.
- **FR-007**: For a changed app, when the branch is behind upstream, the system MUST check whether upstream changed either of that app's scripts since the branch point. A change to either is a conflict.
- **FR-008**: When the branch is not behind upstream, the system MUST NOT perform the conflict check.
- **FR-009**: A conflict MUST produce a warning naming the app and telling the operator to rebase the branch. The install or update MUST still proceed from the custom repository.
- **FR-010**: A changed app that also exists upstream and does not conflict MUST produce a single informational line naming the app and the upstream repository it replaces, not a warning.
- **FR-011**: A changed app absent from upstream, and a fork-only unchanged app, MUST produce no notice.
- **FR-012**: The warning or informational line MUST appear as the first line of the CLI dry run and apply output, the web preview and job log, and the MCP preview and job log, as the override warning does today.
- **FR-013**: A failure to read a script during the conflict check MUST be logged and treated as no conflict; it MUST NOT fail resolution.
- **FR-014**: The catalog's custom group MUST list exactly the changed apps, each marked with the upstream repositories it overrides and whether it conflicts. Apps not changed MUST remain in their upstream groups.
- **FR-015**: The web UI's App suggestion list MUST show a visible conflict tag on a conflicting custom app, legible at desktop and mobile widths. The MCP catalog listing MUST carry the same conflict information.
- **FR-016**: A catalog read that cannot make the comparison MUST omit the custom group, log a warning, and still return the upstream groups.
- **FR-017**: With the custom repository not configured, behavior MUST be unchanged, with no comparison and no conflict check.
- **FR-018**: On the web and MCP apply paths, the changed-app decision and conflict result MUST be computed once per operation, together with the commit pin, and reused by the preview, the prompt scan, and the apply.
- **FR-019**: README and CLAUDE.md MUST describe the new resolution rule, the conflict warning, and the catalog change.

### Key Entities

- **Branch comparison**: the result of comparing the pinned branch commit against upstream main — how far ahead and behind the branch is, the branch point commit, and the set of changed apps.
- **App source**: where one app resolves to (upstream, custom, or a pasted URL), extended with whether it is a changed app, whether it conflicts, and which upstream repositories it overrides.
- **Source notice**: the one line shown before an install or update: a conflict warning, an informational override line, or nothing.
- **Custom catalog group**: the list of changed apps, each with its overridden upstream repositories and conflict flag.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With a branch that is 8 ahead, 0 behind, and changes 3 apps, exactly those 3 apps resolve to the fork, with no warnings, and 100% of other upstream apps resolve to the same source as with the feature off.
- **SC-002**: With that branch, the catalog's custom group lists exactly 3 entries.
- **SC-003**: An app changed both on the branch and upstream since the branch point produces the rebase warning in all three front ends (CLI, web, MCP) and still installs from the fork.
- **SC-004**: With the feature off, every existing install/update/catalog test passes unchanged and no comparison is attempted.
- **SC-005**: Every comparison-failure case (unknown repository, rate limit, server error, network failure, truncated list) yields an error that names the setting to fix, in 100% of tested cases.
- **SC-006**: A single app resolution with the feature on makes no more than two rate-limited GitHub requests.

## Assumptions

- The fork is a fork of upstream ProxmoxVED (the development repository), and upstream's comparison base is its `main` branch, as issue #15 states. A fork of ProxmoxVE (stable) is not supported by this rule and fails with the named error.
- GitHub's comparison listing is capped at 300 files; a branch changing more than that is treated as undeterminable rather than paged.
- Script contents for the conflict check come from GitHub's raw content host, which is not subject to the API rate limit; the comparison and the head-commit pin are the only rate-limited requests.
- Unauthenticated GitHub API access (60 requests per hour) remains the only mode; adding a token is out of scope.
- The catalog's custom group keeps its existing short freshness window and in-memory cache.
- Test fixtures come from a real comparison response captured on 2026-09-24 and redacted to example values per the constitution, plus a behind-and-conflicting variant derived from the same shape.
