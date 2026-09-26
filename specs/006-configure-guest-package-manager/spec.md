# Feature Specification: configure-guest installs packages with the guest's own package manager

**Feature Branch**: `issue-2-configure-guest-package-manager`

**Created**: 2026-09-26

**Status**: Draft

**Input**: Issue #2 — "configure-guest --packages is still apt-only (non-apt guests fail)". The
`--packages` step of `configure-guest` always runs an apt command, so it fails on Alpine,
Fedora, Arch, and openSUSE guests, which the toolkit can now reach. It also ignores the remote
exit status, so a failed install is reported as a success.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Install packages on a non-Debian guest (Priority: P1)

The operator runs `configure-guest --guest <name> --packages "curl vim"` against a guest whose
OS is not Debian/Ubuntu (for example an Alpine container). The toolkit works out which package
manager the guest has and installs the packages with it, the same way `update-all` already
does for upgrades.

**Why this priority**: this is the defect the issue reports. Without it, `--packages` is
unusable on any non-apt guest.

**Independent Test**: run `configure-guest --packages` with `--apply` against a fake guest that
reports each supported package manager in turn, and confirm the install command sent is the
one for that manager, with the package names quoted.

**Acceptance Scenarios**:

1. **Given** a guest whose package manager is apk, **When** the operator applies
   `--packages "curl vim"`, **Then** the packages are installed with apk and nothing apt-related
   is sent.
2. **Given** a guest with apt, dnf, pacman, or zypper, **When** the operator applies
   `--packages`, **Then** the install uses that manager's non-interactive install command.
3. **Given** a Debian/Ubuntu guest, **When** the operator applies `--packages`, **Then** the
   behavior is what it was before this change (index refresh, then non-interactive install).

---

### User Story 2 - See the exact command before applying (Priority: P2)

The operator runs `configure-guest --packages` without `--apply` (CLI dry run, or the web UI's
Preview). The preview names the detected package manager and shows the exact install command
that `--apply` would run, but installs nothing.

**Why this priority**: the dry-run convention exists so the operator can check what will
happen. A preview that says "apt-get" for an Alpine guest would be wrong; one that says only
"would install" hides the command. The operator chose a live lookup at preview time, matching
how `create-lxc` and `install-app` previews already contact the target host.

**Independent Test**: run the dry run against a fake guest and confirm exactly one remote call
(the detection) was made and the printed preview contains the manager-specific command.

**Acceptance Scenarios**:

1. **Given** a reachable apk guest, **When** the operator runs the dry run, **Then** the output
   shows the apk install command for the requested packages and no install is executed.
2. **Given** a guest whose OS is unrecognized, **When** the operator runs the dry run, **Then**
   the preview fails with the same unrecognized-OS error `--apply` would give.

---

### User Story 3 - Failures are reported, never silently passed (Priority: P2)

When anything in `configure-guest` fails remotely, the command fails with a message that says
what went wrong, and the three package failure kinds are distinguishable: the guest's OS is
unrecognized; the detection step itself failed; the install ran and failed.

**Why this priority**: today a failed install exits successfully (CLI exit 0, web job marked
succeeded). With several package managers in play, the operator must be able to tell "this OS
isn't supported" apart from "the package name was wrong".

**Independent Test**: drive a fake guest to each failure and confirm the command rejects with
the matching, distinct message; confirm the `--ssh-key` step likewise rejects when its remote
command exits non-zero.

**Acceptance Scenarios**:

1. **Given** a guest with none of the five supported managers, **When** `--packages` runs,
   **Then** it fails with an error saying no known package manager was found and naming the
   five that were tried; no install is attempted.
2. **Given** a guest where detection exits non-zero, **When** `--packages` runs, **Then** it
   fails with an error naming the guest, the exit status, and the remote error output.
3. **Given** a detected manager whose install exits non-zero (e.g. unknown package), **When**
   `--packages --apply` runs, **Then** it fails with an error naming the guest, the manager,
   the exit status, and the remote error output.
4. **Given** `--ssh-key` whose remote command exits non-zero, **When** applied, **Then** the
   command fails with an error naming the guest and the remote error output.

---

### Edge Cases

- A login banner or message-of-the-day printed ahead of the detection output must not corrupt
  detection (already handled by the existing detection parser; reused unchanged).
- A guest with more than one manager installed (e.g. apt and apk) uses the first in the fixed
  order apt, dnf, apk, pacman, zypper — the same order `update-all` uses.
- A yum-only guest (RHEL 7 era) is reported as unrecognized, not silently driven through a
  compatibility shim — same as `update-all`.
- When both `--packages` and `--ssh-key` are given and the package step fails, the SSH key step
  does not run; the command fails at the first failure.
- A package name containing shell metacharacters is still passed as a single quoted argument.
- A VM guest command that outlives `qm guest exec`'s wait is reported as a failure naming
  the timeout, not a success — this applies to every command routed to a VM through `runRemote`,
  including `update-all`, not just `configure-guest`. That wait is 60s for an ordinary command
  and 30 minutes (1800s) for a package install/upgrade command specifically — package operations
  routinely outlast 60s, and a wait that short would report a still-running apt/dnf/etc. as
  failed while leaving its lock held for the next attempt.
- A VM guest command killed by a signal (e.g. `kill -9`) returns an `exited: 1` envelope with a
  `signal` number and no `exitcode` at all — a shape distinct from the pid-only "still running"
  timeout envelope above. This is reported as a failure naming the killing signal, with whatever
  stdout/stderr the command produced before being killed, not misreported as a timeout with the
  output dropped.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `configure-guest --packages` MUST detect the target's package manager at run time
  using the same detection `update-all` uses, before sending any install command.
- **FR-002**: The toolkit MUST provide one non-interactive install command per supported
  manager (apt, dnf, apk, pacman, zypper), kept alongside the existing upgrade commands, and
  each MUST refresh package metadata as needed so a fresh guest can install.
- **FR-003**: Each requested package name MUST be passed to the install command as its own
  shell-quoted argument.
- **FR-004**: Detection MUST also run during the dry run/preview, and the preview MUST show the
  exact install command `--apply` would run. The dry run MUST NOT execute the install.
- **FR-005**: An unrecognized OS MUST produce a distinct error, identifiable as such by callers,
  naming the managers tried; it MUST NOT be reported as a generic command failure.
- **FR-006**: A detection step that exits non-zero, and an install that exits non-zero, MUST
  each fail the command with an error naming the guest, the exit status, and the remote error
  output.
- **FR-007**: The `--ssh-key` step MUST fail the command when its remote command exits non-zero.
- **FR-008**: `update-all` MUST keep its existing behavior and result buckets; it may share the
  detection logic with `configure-guest` but its outputs MUST NOT change.
- **FR-009**: The web UI and MCP `configure-guest` operation MUST pick up the new behavior
  without an interface change: preview shows the manager-specific command, and a failure fails
  the job.
- **FR-010**: A VM guest command that outlives `qm guest exec`'s wait MUST be reported as a
  failure naming the timeout, never as a success — `runRemote`'s `vm` branch MUST NOT treat a
  timeout envelope (pid only, no `exitcode`) the same as a completed one. That wait MUST be
  configurable per call (`runRemote`'s optional `vmTimeoutSeconds`), defaulting to 60s for an
  ordinary command; `update-all`'s update command and `configure-guest`'s install command MUST
  pass 30 minutes (1800s) instead, since package operations routinely outlast 60s. A VM guest
  command killed by a signal (an `exited: 1` envelope carrying a `signal` number and no
  `exitcode`) MUST be reported as a failure naming the signal, with whatever output the command
  produced, rather than being treated as the timeout case above.

### Key Entities

- **Package manager**: one of apt, dnf, apk, pacman, zypper; each has an upgrade command
  (existing) and an install command (new).
- **Detection outcome**: a recognized manager, an unrecognized OS, or a failed detection step.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: `configure-guest --packages` succeeds on guests of all five supported package
  manager families, up from one.
- **SC-002**: 100% of remote failures in `configure-guest` (detection, install, SSH key) result
  in a failed command or failed web job; zero are reported as successes.
- **SC-003**: For an unrecognized OS, the operator can tell from the message alone that the OS
  is unsupported, without reading remote error output.
- **SC-004**: The preview's printed install command is identical to the command `--apply` sends
  for the same guest and packages.

## Assumptions

- Out of scope: `update-app`'s apt-specific preamble — it re-runs a community-scripts
  installer, and those guests are Debian by construction.
- Out of scope: yum support, and any inventory field recording a guest's OS; detection stays a
  run-time probe for the reasons `update-all` already documents.
- Arch's install uses a full sync-and-upgrade alongside the install, because Arch supports no
  partial upgrade path — the same reasoning its existing upgrade entry records.
- A preview now needs the guest to be running and reachable, accepted in exchange for an exact
  preview (operator decision during design).
- `configure-guest` is also reachable against a Proxmox host entry (its name lookup accepts
  hosts); detection applies there the same way.
