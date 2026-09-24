# Feature Specification: Custom Script Repository as a First-Class App Source

**Feature Branch**: `issue-11-custom-script-repo`

**Created**: 2026-09-24

**Status**: Draft

**Input**: User description: "GitHub issue #11: allow a third configurable repo with a branch, alongside ProxmoxVE and ProxmoxVED, that has the same structure as ProxmoxVED and that apps can be deployed from. The operator keeps a branch on a personal fork of ProxmoxVED and wants it to be a first-class citizen for app deployments."

## Clarifications

### Session 2026-09-24

Settled while drafting issue #11, before this spec was written:

- Q: When a slug exists in both the custom repository and upstream, which wins? → A: The custom repository wins, and the operator is told loudly, in every front end, which upstream copy it is overriding.
- Q: Where is the custom repository configured? → A: As two inventory settings (repository and branch), editable through `set-config` and the admin Settings page. Unset means the feature is off.
- Q: How are freshness problems handled for a branch that changes while the operator iterates on it? → A: The branch is pinned to its current head commit when an app is checked, and every later step (preview, prompt scan, install, the installer's own download of the install script) reads that exact commit. The custom repository's catalog listing is refreshed far more often than the upstream listings.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Install an app that exists only on my fork branch (Priority: P1)

The operator has written a new app script on a branch of their ProxmoxVED fork. They configure that fork and branch once, then install the app by its bare slug from the CLI, the web UI's Install App form, or the MCP server, exactly as they would install an upstream app. The container that gets created runs the fork branch's own install script, not upstream's.

**Why this priority**: This is the whole reason for the feature. Without it, a fork-only app can only be installed by pasting a raw script URL, and even then the container silently runs upstream's install script (or fails because upstream has none).

**Independent Test**: With the settings pointing at a fork and branch that carry a slug upstream lacks, preview an install of that slug and confirm that the preview names the custom repository at a specific commit, and that the generated install script tells the installer to read from that same commit.

**Acceptance Scenarios**:

1. **Given** the custom repository and branch are configured and the branch has `ct/myapp.sh` and `install/myapp-install.sh`, **When** the operator checks or previews an install of `myapp`, **Then** the result reports the custom repository as the source, names the commit it is pinned to, and marks it as custom.
2. **Given** the same configuration, **When** the operator applies the install, **Then** the command sent to the host downloads `ct/myapp.sh` from the pinned commit of the custom repository and directs the installer to fetch `install/myapp-install.sh` from that same commit.
3. **Given** the custom-repository settings are unset, **When** the operator installs any app, **Then** behavior is identical to today: ProxmoxVE first, then ProxmoxVED.
4. **Given** the web UI's install is watching for interactive prompts, **When** the app resolves to the custom repository, **Then** the expected-prompt pre-scan reads the custom repository's install script at the pinned commit.

---

### User Story 2 - Override an upstream app with my branch's version, and be told about it (Priority: P1)

The operator patches an existing upstream app on their branch. Installing that slug uses the branch's version, and every front end warns clearly that an upstream copy exists and is being overridden, so a stale fork copy never silently shadows upstream fixes.

**Why this priority**: Custom-first precedence is only safe if the override is always visible. Without the warning, a forgotten branch copy could shadow an upstream fix indefinitely.

**Independent Test**: Configure a custom branch carrying a slug that also exists in ProxmoxVE, check that slug, and confirm the result carries a shadowing warning naming ProxmoxVE, and that the CLI output, the web App check, the install preview and job log, and the MCP check result all show it.

**Acceptance Scenarios**:

1. **Given** a slug exists in the custom repository and in ProxmoxVE, **When** the operator checks the app, **Then** the custom copy is chosen and the result lists ProxmoxVE as overridden.
2. **Given** a slug exists in the custom repository and in ProxmoxVED only, **When** the operator checks the app, **Then** the custom copy is chosen and the result lists ProxmoxVED as overridden.
3. **Given** the overriding case, **When** the operator previews or applies the install from any front end, **Then** a warning naming the overridden upstream repository appears before anything else in the preview and in the job log.
4. **Given** a slug exists only in upstream, **When** the operator checks it with the custom repository configured, **Then** upstream is used and no override warning is shown.

---

### User Story 3 - Configure, change, and turn off the custom repository (Priority: P2)

The operator sets the repository and branch from the CLI or from the admin-only Settings page, switches to a different branch later, or clears both settings to turn the feature off.

**Why this priority**: Required for Stories 1 and 2 to be reachable, but it is a small, well-trodden path that follows the existing settings pattern.

**Independent Test**: Set, change, and clear the two settings through `set-config` and the Settings page, confirming that the same values are accepted and rejected by both, and that the app catalog reflects the new configuration on its next read.

**Acceptance Scenarios**:

1. **Given** no custom repository is configured, **When** the operator sets the repository to `owner/repo` and the branch to a branch name, **Then** both are saved and the next catalog read lists that branch's apps.
2. **Given** only one of the two settings is set, **When** any app is checked or installed, **Then** the operation fails with an error naming the missing setting and the command that sets it.
3. **Given** a malformed repository value (not `owner/repo`), **When** the operator saves it from either front end, **Then** it is rejected with the same rule by both.
4. **Given** the settings change to a different repository or branch, **When** the catalog is next read, **Then** apps from the previous branch no longer appear.

---

### User Story 4 - Browse my branch's apps in the catalog (Priority: P2)

The web UI's App field suggestion list shows the custom branch's apps in their own group, listed first, with apps that override upstream visibly marked. The MCP catalog listing carries the same information. A newly pushed app appears within minutes rather than the next day.

**Why this priority**: Makes the fork discoverable in the same place as upstream apps, but installing by typing the slug already works without it.

**Independent Test**: With a stubbed catalog source, read the catalog and confirm a third group labelled with the repository and branch appears first, each overriding slug is annotated with the repository it overrides, and the custom listing is refetched after its short freshness window while the upstream listings are not.

**Acceptance Scenarios**:

1. **Given** the custom repository is configured, **When** the catalog is read, **Then** a group labelled `<owner>/<repo>@<branch> (custom)` appears above ProxmoxVE (stable) and ProxmoxVED (development).
2. **Given** a slug is in both the custom group and an upstream group, **When** the catalog is shown, **Then** that slug is listed in the custom group, marked with the upstream repository it overrides, and no longer listed in the upstream group.
3. **Given** the custom listing was fetched more than the short freshness window ago, **When** the catalog is read, **Then** the custom listing is refetched even though the upstream listings are still fresh.
4. **Given** the custom repository cannot be reached, **When** the catalog is read, **Then** the upstream groups still appear and the failure is logged, rather than the whole catalog failing.

---

### User Story 5 - Know where a guest came from, and update it from the same place (Priority: P3)

A guest installed from the custom repository records that fact. The Dashboard's app link for that guest points at the custom repository rather than the community-scripts site, and updating that guest's app re-runs the script from the custom repository.

**Why this priority**: Rounds out "first-class citizen", but installs work without it.

**Independent Test**: Install a custom-sourced app through the web UI's apply path, confirm the inventory entry records the custom source, confirm the Dashboard link targets the custom repository's script, and preview an update of that guest to confirm it resolves to the custom repository and directs the installer there.

**Acceptance Scenarios**:

1. **Given** an app was installed from the custom repository through the web UI or MCP apply path, **When** its inventory entry is read, **Then** it records the custom source alongside the app slug.
2. **Given** a guest records the custom source, **When** the Dashboard renders it, **Then** its app link points at the app's script in the configured custom repository and branch.
3. **Given** a guest's app slug exists in the custom repository, **When** the operator previews or applies an update, **Then** the update resolves the same way an install would (custom first), directs the installer at the pinned custom commit, and shows the override warning if upstream also has the slug.

### Edge Cases

- The configured branch does not exist, or the repository does not exist or is private: checking or installing an app fails with an error naming the configured repository and branch and the `set-config` keys to fix, instead of falling back to upstream.
- The custom repository is unreachable (network failure or GitHub rate limit) while checking a bare slug: the check fails with an explicit error rather than silently installing the upstream copy, since custom-first precedence means upstream cannot be assumed correct.
- The custom repository is unreachable while reading the catalog: upstream groups still show; the custom group is omitted and a warning is logged.
- A pasted full script URL: used exactly as given, as today. It is never rewritten to the custom repository, and it never triggers an override warning.
- A slug exists in the custom repository's `ct/` but it has no matching `install/<slug>-install.sh`: the install proceeds (the installer reports its own failure), and the prompt pre-scan finds no expected prompts, the same as an upstream app with no conventional install script today.
- The branch moves between the check and the apply: the apply uses the commit pinned when Apply was clicked (a fresh pin of its own, independent of any earlier standalone check), which the job log's own preview line shows.
- A guest records the custom source but the custom repository is later unset: the Dashboard link falls back to showing no community-scripts link for it, and updating it resolves through upstream only.
- A slug in the custom repository's catalog differs from upstream only by case: slugs are lowercased the same way as today.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST support two optional inventory settings, a custom script repository (in `owner/repo` form) and a custom script branch. Both are editable through `set-config` and the admin Settings page, validated by the same rule in both.
- **FR-002**: When both settings are unset, every install, update, catalog, and app-check behavior MUST be unchanged from today.
- **FR-003**: When exactly one of the two settings is set, any operation that resolves an app slug MUST fail with an error naming the missing setting and how to set it.
- **FR-004**: A bare app slug MUST resolve in the order: custom repository, then ProxmoxVE, then ProxmoxVED. A pasted full script URL MUST be used exactly as given.
- **FR-005**: When the custom repository is configured, resolving a slug MUST first pin the configured branch to its current head commit, and every later step of that operation (preview, expected-prompt pre-scan, apply) MUST read the custom repository at that commit.
- **FR-006**: When an app resolves to the custom repository, the install and update commands sent to the host MUST direct the community-scripts installer to download the app's install script (and any other per-app script files) from the custom repository at the pinned commit, rather than from upstream.
- **FR-007**: When an app resolves to the custom repository and the same slug also exists in ProxmoxVE or ProxmoxVED, the app-check result MUST list each overridden upstream repository, and the CLI output, web App check, install and update previews, job logs, and MCP app-check result MUST each show a warning naming them.
- **FR-008**: If the custom repository, branch, or commit cannot be resolved while resolving a slug, the operation MUST fail with an error naming the configured repository and branch; it MUST NOT fall back to upstream.
- **FR-009**: The app catalog MUST include a third group for the custom repository, labelled with the repository and branch, ordered before the upstream groups. Slugs that also exist upstream MUST appear only in the custom group, annotated with the upstream repository they override.
- **FR-010**: The custom repository's catalog listing MUST be refreshed after a short freshness window (on the order of minutes), independently of the upstream listings' existing 24-hour window, and MUST be discarded when the configured repository or branch changes.
- **FR-011**: A failure to list the custom repository MUST NOT prevent the upstream catalog groups from being shown; it MUST be logged as a warning.
- **FR-012**: A guest installed through the web UI or MCP apply path from the custom repository MUST record that fact alongside the existing app slug, preserved across inventory syncs the same way the slug is. Guests installed from ProxmoxVE or ProxmoxVED record nothing new; their existing behavior is unchanged.
- **FR-013**: The Dashboard's app link for a guest whose recorded source is custom MUST point at that app's script in the configured custom repository and branch.
- **FR-014**: Updating an app MUST resolve the slug the same way installing does (FR-004 through FR-008).
- **FR-015**: The custom repository MUST be public and laid out like ProxmoxVED (`ct/<slug>.sh` and `install/<slug>-install.sh` at its root); supporting other layouts or authenticated access is out of scope.
- **FR-016**: The README and CLAUDE.md MUST describe the new settings, the resolution order, the override warning, and the pinning behavior.

### Key Entities

- **Custom script source**: the operator's configured repository (`owner/repo`) and branch. Absent means the feature is off.
- **Pinned commit**: the commit the configured branch pointed at when an app was checked; the single version read by every later step of that install or update.
- **App resolution result**: which source an app slug resolved to (custom, ProxmoxVE, or ProxmoxVED), the script location, the pinned commit when custom, and the list of upstream repositories it overrides.
- **Catalog group**: a named list of slugs from one source; the custom group carries per-slug override annotations.
- **Guest app provenance**: a marker, stored alongside the app slug, that the guest's app came from the custom repository.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An app that exists only on the operator's fork branch can be installed by its bare slug from each of the three front ends (CLI, web UI, MCP) with no pasted URL, and the created container runs the fork branch's install script in 100% of such installs.
- **SC-002**: In 100% of installs and updates where a custom copy overrides an upstream one, a warning naming the overridden repository appears in the front end the operator used, before the install runs.
- **SC-003**: An app pushed to the configured branch is installable immediately after the push and appears in the catalog suggestion list within 5 minutes.
- **SC-004**: For every install and update, the preview and the applied command read the identical script version.
- **SC-005**: With the feature unconfigured, the existing automated test suite passes unchanged and no existing user-visible behavior changes.

## Assumptions

- The operator's fork is public on GitHub and keeps ProxmoxVED's layout; its `ct/` scripts use the shared community-scripts installer engine, which reads the location of per-app scripts from an environment variable Bellhop can set.
- Unauthenticated GitHub API access (60 requests per hour) is enough for one operator; resolving the branch head adds roughly one request per app check.
- ProxmoxVE and ProxmoxVED continue to be read from their `main` branches, unpinned, exactly as today.
- Only one custom repository is supported; a list of extra repositories is out of scope.
- Guests installed before this feature, or installed through the CLI (which does not write inventory), record no source; for them the Dashboard behaves as today.
