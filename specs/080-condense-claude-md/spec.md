# Feature Specification: Condense CLAUDE.md

**Feature Branch**: `issue-80-condense-claude-md`

**Created**: 2026-10-05

**Status**: Draft

**Input**: Issue #80. The root `CLAUDE.md` is 4,159 lines (285 KB, roughly 70k tokens) and is loaded in full at the start of every Claude Code session. Most of it is per-subsystem reference detail that matters only when working in that subsystem.

## User Scenarios & Testing *(mandatory)*

The "user" here is the operator, together with the AI assistant that works on this repository on the operator's behalf.

### User Story 1 - A short, always-loaded orientation file (Priority: P1)

The operator opens a new session for any task. The assistant starts out knowing the repository's commands, its testing conventions, how the code is laid out, and the rules that hold everywhere. It does not first pay for tens of thousands of tokens of detail about subsystems the task never touches.

**Why this priority**: this is the cost the issue exists to remove. Every session pays it today.

**Independent Test**: count the lines and bytes of the root file. Then read it alone and confirm that every cross-cutting rule listed in FR-003 is present.

**Acceptance Scenarios**:

1. **Given** a fresh session, **When** the root guidance file loads, **Then** it is at most about 250 lines and states every cross-cutting rule.
2. **Given** the root file, **When** a reader wants detail on a subsystem, **Then** a map in the root file names where that detail lives.

---

### User Story 2 - Subsystem detail arrives when that subsystem is touched (Priority: P1)

The assistant reads a file in a subsystem: a proxy driver, a web route, a provisioning command. The detailed guidance for that subsystem loads automatically, alongside the code, without anyone having to remember to fetch it.

**Why this priority**: shortening the root file is only safe if the detail stays reachable at the moment it matters. Without that, condensing just loses knowledge.

**Independent Test**: for each subsystem directory, confirm that a guidance file sits in that directory or an ancestor directory below the root, and that it covers the topics the original file described for that subsystem.

**Acceptance Scenarios**:

1. **Given** the assistant reads a proxy driver source file, **When** guidance loads, **Then** the proxy driver interface and per-driver detail are available.
2. **Given** the assistant reads a web route, **When** guidance loads, **Then** the authentication, permission, and impersonation rules are available.

---

### User Story 3 - Nothing true is lost (Priority: P2)

Every rule, invariant, gotcha, rationale, and named file or function in the original file still exists somewhere in the new set of files. The only things removed are issue-history narrative ("renamed in #10", "an earlier draft tried...", "discovered live while...") and repeated restatements.

**Why this priority**: the guidance exists to prevent past mistakes from recurring. Dropping a rule quietly reintroduces the bug it was written to prevent.

**Independent Test**: map each top-level topic of the original file to its destination. Then have an independent reviewer compare the original against the new files and list any rule it cannot find.

**Acceptance Scenarios**:

1. **Given** the original file's list of top-level topics, **When** each is looked up, **Then** each has exactly one primary destination.
2. **Given** an independent review, **When** it compares the original against the new files, **Then** it finds no dropped rule (or every finding is fixed).

### Edge Cases

- A topic spans several subsystems (for example, the guest edit flow touches the web route, the operations layer, and Authentik sync). It gets one primary home. Every other affected directory carries a one-line pointer to that home rather than a copy.
- Some rules apply everywhere but are described inside one subsystem's section, such as the POSIX-sh rule for guest commands or the dry-run convention. These stay in the root file. The subsystem file may refer back to them.
- A link elsewhere in the repository points into a moved section of the root file. That link is updated so it still resolves.
- A subsystem file would itself grow very large. It is split along the directory tree, so that reading one file never loads unrelated detail.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The root guidance file MUST be at most about 250 lines.
- **FR-002**: The root guidance file MUST contain:
  - the repository's commands;
  - its testing conventions;
  - a map naming each subsystem guidance file and what it covers;
  - the project philosophy;
  - the workflow conventions;
  - the Windows development notes.
- **FR-003**: The root guidance file MUST state these cross-cutting rules:
  - remote execution has a single path;
  - commands sent to guests are POSIX sh, and the documented exceptions are listed;
  - the dry-run / `--apply` convention;
  - an inventory save is a full replace with deterministic ordering;
  - secrets are write-only and never leave the settings store;
  - web UI authorization is held to correctness standards;
  - single-operator assumptions are recorded;
  - committed files use example data only.
- **FR-004**: Subsystem detail MUST live in guidance files placed in the subsystem's own directory. The tool must load each file automatically when files in that directory are read. Those directories are:
  - core library;
  - reverse-proxy drivers;
  - networking commands;
  - provisioning commands;
  - maintenance commands;
  - shared operations layer;
  - web server;
  - web job runner;
  - MCP server;
  - web client.
- **FR-005**: Moved text MUST keep every rule, invariant, gotcha, rationale, and named file, function, setting, or error message. It MAY drop issue-history narrative and restatements of points made elsewhere. A short issue reference (for example `#10`) MAY stay where it helps a reader find the design record.
- **FR-006**: A topic spanning several subsystems MUST have exactly one primary home. Other affected subsystem files point to it rather than duplicating it.
- **FR-007**: All relative links and heading anchors in the root file, `CONTRIBUTING.md`, `README.md`, and `docs/` MUST still resolve.
- **FR-008**: `CONTRIBUTING.md` MUST stay consistent with any convention it restates. The constitution's reference to recording bash exceptions in `CLAUDE.md` MUST stay true.
- **FR-009**: The change MUST NOT modify source code or tests. User documentation (`README.md`, `docs/`, `CONTRIBUTING.md`) changes ONLY where it describes or links to `CLAUDE.md` content and would otherwise become inaccurate.
- **FR-010**: All guidance files MUST use example values only, per constitution Principle I.

### Key Entities

- **Root guidance file**: the always-loaded orientation file at the repository root.
- **Subsystem guidance file**: a guidance file in one source directory, loaded when that directory's files are read.
- **Topic map**: the record of where each original top-level topic now lives. It is kept in this feature's plan artifacts for review.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The root guidance file is at most about 250 lines, down from 4,159. That is at least a 90% cut in what every session loads before any work.
- **SC-002**: The total size of all guidance files combined is at least 30% smaller than the original 285 KB.
- **SC-003**: 100% of the original file's top-level topics appear in the topic map with a destination.
- **SC-004**: An independent review comparing the original against the new files reports zero unresolved dropped rules.
- **SC-005**: The repository's documentation link check passes.

## Assumptions

- The assistant's tool loads a guidance file named `CLAUDE.md` from a subdirectory when it reads files within that subdirectory. Working in a subsystem therefore surfaces its detail without an explicit pointer.
- The operator chose nested guidance files over a `docs/architecture/` reference set, and chose tightening over a verbatim move (decided during brainstorming).
- This is a documentation-only change. The full automated test suite is not run, at the operator's direction. Only the documentation link check is run.
- Adding an automated line budget for the root guidance file, like the existing README budget, is a follow-up and out of scope here.
