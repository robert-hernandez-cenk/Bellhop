# Feature Specification: Follow community-scripts' rename of ProxmoxVED to DevScripts

**Feature Branch**: `issue-101-devscripts-rename`
**Created**: 2026-10-11
**Status**: Draft
**Input**: GitHub issue #101: community-scripts renamed their development repository `community-scripts/ProxmoxVED` to `community-scripts/DevScripts`. Bellhop still uses the old name and keeps working only because GitHub redirects renamed repositories. Use the new name everywhere.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Development-repo apps resolve from the renamed repository (Priority: P1)

The operator installs or updates an app that exists only in community-scripts' development repository. Bellhop fetches that app's scripts, lists the development catalog, and (with a custom script repository configured) compares the operator's fork branch against upstream, all addressed to `community-scripts/DevScripts` directly, without relying on GitHub's rename redirect.

**Why this priority**: GitHub's redirect for a renamed repository disappears as soon as anyone creates a new repository under the old name, so continued use of the old name is a latent outage.

**Independent Test**: Run the app-check, install/update preview, catalog listing and custom-branch comparison against a stubbed GitHub that answers only `community-scripts/DevScripts` URLs. Each succeeds and none requests a `ProxmoxVED` URL.

**Acceptance Scenarios**:

1. **Given** an app present only in the development repository, **When** the operator checks or installs it by bare slug, **Then** the script location Bellhop uses and the fallback in the generated install command both name `community-scripts/DevScripts`.
2. **Given** the app catalog is refreshed, **When** the development group is listed, **Then** it is read from `community-scripts/DevScripts`.
3. **Given** a custom script repository is configured, **When** Bellhop works out which apps the fork branch changed, **Then** it compares against `community-scripts/DevScripts` `main`, and a fork-network error names `community-scripts/DevScripts`.

---

### User Story 2 - Every surface names the repository DevScripts (Priority: P2)

Wherever Bellhop names community-scripts' development repository to the operator, it says DevScripts. That covers the web UI catalog group ("DevScripts (development)"), the "still in development" notice, override and conflict warnings and the overridden-repository list in app checks, the Settings help, the MCP tool descriptions, the docs, the demo instance, and the install-app catalog screenshot.

**Why this priority**: A stale name sends the operator looking for a repository that no longer exists under that name, but it does not break anything.

**Independent Test**: Search the shipped code, docs and screenshots. No user-facing string names `ProxmoxVED`, and an app check of a slug overriding the development copy lists `DevScripts`.

**Acceptance Scenarios**:

1. **Given** a custom-repo app that also exists upstream in the development repository, **When** the operator checks it, **Then** the overridden list and the warning text name `DevScripts`.
2. **Given** the Install App form's suggestion list, **When** a development-only app matches, **Then** its group header reads "DevScripts (development)".

### Edge Cases

- The operator's own custom fork may still be named `ProxmoxVED` (forks keep their names). That is the operator's setting: it is still accepted as-is and compared against `community-scripts/DevScripts` through the shared fork network.
- Historical specification documents (`specs/003-*`, `specs/004-*`) describe the repository by its name at the time and are left as written.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Every request Bellhop makes to community-scripts' development repository (raw script content, the `ct/` catalog listing, branch comparison) MUST address `community-scripts/DevScripts`.
- **FR-002**: Bare-slug resolution MUST be unchanged apart from the name: an app comes from the custom repository only when the configured branch changes it relative to upstream (or only the fork has it); otherwise ProxmoxVE, then DevScripts.
- **FR-003**: The upstream repository name reported in an app check's overridden-repository list, and in override/conflict warnings, MUST be `DevScripts` for the development repository.
- **FR-004**: Every operator-facing label, help text, notice and tool description naming the development repository MUST call it DevScripts.
- **FR-005**: The user documentation, demo instance and install-app catalog screenshot MUST use the new name. Example custom-fork values in docs become `example-user/DevScripts`. Tests use a neutral fork name (`example-user/my-scripts`) so the fork can never be confused with upstream `DevScripts` (example data only).
- **FR-006**: Bellhop MUST NOT keep `ProxmoxVED` as an alias anywhere in code (pre-release; breaking renames are acceptable).

### Key Entities

- **Upstream development repository**: community-scripts' repository of not-yet-graduated app scripts, now `community-scripts/DevScripts`, read from its `main` branch.
- **Overridden-repository name**: the name an app check reports for each upstream repository a custom app overrides: `ProxmoxVE` or `DevScripts`. Computed per check, never stored.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Zero requests to any `community-scripts/ProxmoxVED` URL across the automated test suite's stubbed GitHub interactions.
- **SC-002**: Zero occurrences of `ProxmoxVED` in shipped code, user documentation, the demo instance and the screenshots. Historical specs are excluded.
- **SC-003**: Installing, updating and checking development-repo apps behaves exactly as before apart from the repository name. All existing tests pass once updated for the name.

## Assumptions

- GitHub's rename redirect still works today, so existing deployments are not broken. This change removes the dependency on it.
- The development repository's layout (`ct/<slug>.sh`, `install/<slug>-install.sh`, `main` branch) and its fork network are unchanged by the rename.
- No persisted data contains the old name: overridden-repository lists are computed per check, and a guest installed from the development repository records no source name.
- The community-scripts installer engine's own default base URL is upstream's concern, not Bellhop's.
