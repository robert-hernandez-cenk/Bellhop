# Feature Specification: Condense the README into a docs/ folder

**Feature Branch**: `issue-41-condense-readme-docs`

**Created**: 2026-09-29

**Status**: Draft

**Input**: Issue #41, "README has outgrown itself: condense it and move the reference material into `docs/`". The README is about 1,160 lines, and a new user scrolls past roughly 900 lines of reference material to learn what Bellhop is and how to run it. There is no `docs/` folder, and issues #26, #31, #32 and #35 will each add a reverse-proxy driver that needs its own documentation.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A newcomer learns what Bellhop is and gets it running (Priority: P1)

Someone who has just found the repository opens the README. Within one short page they read what Bellhop is, what it needs, and the handful of steps to get a working copy with an inventory and the web UI running. They can see which commands exist and where to go for more.

**Why this priority**: This is the problem the issue names. Every other story is in service of it.

**Independent Test**: Open `README.md` and confirm it is 200 lines or fewer, contains the intro, prerequisites, a quickstart, a main-commands table and a documentation index, and that every step of the quickstart can be followed without leaving the page (links are for detail, not for required steps).

**Acceptance Scenarios**:

1. **Given** the new README, **When** a reader reaches the end of the Setup section, **Then** they have installed dependencies, created an inventory from the example file, set the NAS setting, run a first inventory sync and started the web UI, in that order.
2. **Given** the new README, **When** a reader wants the full reference for any command, **Then** the main-commands table links them to the commands page.
3. **Given** the new README, **When** a reader looks for a topic (proxy drivers, settings, environment variables, web UI, MCP server, Authentik, troubleshooting), **Then** the Documentation index names a page for it.

---

### User Story 2 - An operator finds reference material by topic (Priority: P1)

An existing operator who used to search the long README now finds each topic on its own page under `docs/`, with the same content they relied on and working links between related pages.

**Why this priority**: The move must not cost existing readers anything. "No content is lost" is an acceptance criterion of the issue.

**Independent Test**: For every section of the old README, find its text on the named `docs/` page. Only the seams (cross-references such as "see X below") differ.

**Acceptance Scenarios**:

1. **Given** the old README's Usage section, **When** the operator opens `docs/commands.md`, **Then** every command example and explanatory paragraph is there.
2. **Given** a moved paragraph that said "see 'Inventory-wide settings' below", **When** it is read on its new page, **Then** it links to the settings section on `docs/configuration.md`.
3. **Given** the proxy-driver material, **When** a future driver is added, **Then** it gets its own page in `docs/reverse-proxy/` without editing the other drivers' pages.

---

### User Story 3 - Links stay correct over time (Priority: P2)

A contributor who renames a heading or moves a docs page finds out from the test suite, not from a reader, that a link broke. The same check stops the README from quietly growing back past its budget.

**Why this priority**: The acceptance criterion requires a passing link check. Making it part of the regular test run keeps it passing after this change lands.

**Independent Test**: Break one relative link or anchor in any docs page and run the test suite. It fails and names the file and the broken target. Add lines to the README until it passes 200. The suite fails.

**Acceptance Scenarios**:

1. **Given** all relative links and anchors resolve, **When** the tests run, **Then** the link check passes.
2. **Given** a link to a missing file or a heading anchor that does not exist, **When** the tests run, **Then** the check fails and reports the source file, the link and why it is broken.

---

### User Story 4 - Every pointer to an old README section still leads somewhere (Priority: P2)

Messages, comments and contributor docs that told readers to look in a named README section now point at the page where that section lives.

**Why this priority**: A stale pointer sends a user to a section that no longer exists, which is worse than no pointer.

**Independent Test**: Search the tracked files (source, tests, web client, CLAUDE.md, CONTRIBUTING.md, the constitution, the pull request template and the example inventory) for references to README sections, and confirm each one either still resolves in the README or names the new page.

**Acceptance Scenarios**:

1. **Given** the mobile-consent sync error that tells the operator to check the API token's permissions, **When** it is shown, **Then** it names the Authentik page (`docs/authentik.md`) rather than a README section.
2. **Given** the contributor rule "a user-visible behavior change updates `README.md`", **When** it is read in CONTRIBUTING.md, the constitution or the pull request template, **Then** it says `README.md` or the relevant `docs/` page.

### Edge Cases

- A heading that appears twice on one page (GitHub suffixes the second anchor with `-1`). The link check must use the same anchor rules GitHub uses, or it will reject valid links or accept broken ones.
- Links inside fenced code blocks are examples, not links, and must be ignored by the check.
- External (`http`/`https`/`mailto`) links are not checked, so the test never depends on the network.
- A link from a page in `docs/reverse-proxy/` to a sibling page or back to the parent must resolve relative to the linking file, not the repository root.
- CONTRIBUTING.md links to `README.md#prerequisites` and `README.md#setup`. Those headings must keep their exact names.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `README.md` MUST be 200 lines or fewer.
- **FR-002**: `README.md` MUST contain, in order: the intro (including the Proxmox trademark notice), Prerequisites, Setup (a quickstart linking to the configuration page), a main-commands table of 10 to 15 rows linking to the commands page, a Documentation index linking every `docs/` page, and the Contributing, Security and License sections.
- **FR-003**: The headings `## Prerequisites` and `## Setup` MUST keep their names so existing anchors still work.
- **FR-004**: The old README's content MUST move to these pages, largely verbatim:
  - `docs/commands.md`: Usage.
  - `docs/reverse-proxy/README.md`: the reverse-proxy driver overview, the "No proxy" driver, and the upgrade notes for installations from before the driver interface.
  - `docs/reverse-proxy/caddy.md`: the Caddy-specific statements, gathered.
  - `docs/reverse-proxy/nginx.md`: the nginx driver.
  - `docs/configuration.md`: the hand-edited `hosts.yaml` schema notes from Setup, both inventory-wide settings sections, and the custom script repository.
  - `docs/environment-variables.md`: environment variable overrides.
  - `docs/web-ui.md`: Web UI.
  - `docs/mcp-server.md`: MCP server.
  - `docs/authentik.md`: running without Authentik, and the whole OIDC mode section.
  - `docs/troubleshooting.md`: validation, and known hardware issues.
- **FR-005**: No content MUST be lost. Rewording MUST be limited to the seams: cross-references become relative links, and a sentence introducing a moved block may be adjusted so it reads correctly on its new page.
- **FR-006**: Every relative link and `#anchor` in `README.md` and `docs/**/*.md` MUST resolve to an existing file and, for anchors, an existing heading.
- **FR-007**: The test suite MUST include a check that enforces FR-001 and FR-006 and fails with a message naming the file and the broken link.
- **FR-008**: Every reference to a README section in tracked files (source messages and comments, tests, the example inventory, CLAUDE.md, CONTRIBUTING.md, the constitution and the pull request template) MUST point at the section's new location.
- **FR-009**: The contributor rule that a user-visible behavior change updates `README.md` MUST be restated as "`README.md` or the relevant `docs/` page" in CONTRIBUTING.md, the constitution and the pull request template.
- **FR-010**: No runtime behavior MUST change, except the wording of the one error hint that named a README section.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The README shrinks from about 1,160 lines to 200 lines or fewer.
- **SC-002**: Every one of the old README's sections can be found on a named page, and the Documentation index lists all ten `docs/` pages.
- **SC-003**: The link check reports zero broken relative links or anchors across `README.md` and `docs/`.
- **SC-004**: Adding a new proxy driver's documentation means adding one page and one index line, with no edits to other drivers' pages.
- **SC-005**: A search of tracked files finds no remaining pointer to a README section that no longer exists.

## Assumptions

- Headings keep their current wording where possible, so anchors readers may have bookmarked inside a topic keep working on the new page.
- `docs/reverse-proxy/README.md` is used as the folder's index page because GitHub renders it when the folder is opened.
- The quickstart documents today's steps. The ordered first-run walkthrough asked for in #21 stays in that issue; the quickstart leaves room for it.
- The project's `specs/` directories are historical records and are not updated to point at the new pages.
- The link check uses GitHub's heading-anchor rules (lower-case, punctuation removed apart from hyphens and underscores, spaces to hyphens, `-N` suffix for duplicates) and needs no new dependency.
