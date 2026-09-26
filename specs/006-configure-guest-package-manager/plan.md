# Implementation Plan: configure-guest installs packages with the guest's own package manager

**Branch**: `issue-2-configure-guest-package-manager` | **Date**: 2026-09-26 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/006-configure-guest-package-manager/spec.md`

## Summary

`configure-guest --packages` hardcodes an apt command and ignores the remote exit status. It
will instead detect the target's package manager with the probe `update-all` already uses,
install through a new per-manager install table that sits next to `UPDATE_COMMANDS`, and turn
every non-zero remote exit (probe, install, SSH key) into a thrown error. The probe runs in the
dry run too, so the preview prints the exact command apply sends. The detection step moves
into one shared helper that both commands call; `update-all`'s result buckets and log lines do
not change.

## Technical Context

**Language/Version**: TypeScript (strict), Node.js as pinned by the repo's CI matrix

**Primary Dependencies**: none new — `ssh2` via the existing `SSHClient`/`runRemote` boundary

**Storage**: N/A (no inventory change)

**Testing**: `node:test` with `FakeSSHClient` (`test/support/fake-ssh-client.ts`)

**Target Platform**: Proxmox hosts and their LXC/VM guests, reached over SSH; guest commands
must be POSIX `sh`

**Project Type**: CLI + web UI + MCP server sharing one `Operation` layer

**Performance Goals**: one extra short remote call (the probe) per `--packages` run

**Constraints**: every guest command is POSIX `sh` and fully non-interactive (closed stdin);
preview must equal apply

**Scale/Scope**: two source files changed, one shared helper added, one command's tests
extended; docs touched: README, CLAUDE.md

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Check | Result |
| --- | --- | --- |
| I. No real data | Tests and docs use `pve1`, `media`, `example.com` only | Pass |
| II. Remote execution through `src/lib/` | Probe and install both go through `runRemote`; install table lives in `src/lib/package-manager.ts` | Pass |
| II. POSIX `sh` to guests | All five install commands are plain `sh` (`&&` chains only) | Pass |
| II. Explicit errors | Silent-success bug removed; each failure names target, exit status, remote stderr | Pass |
| II. Shared logic in one place | Detection extracted once, used by `update-all` and `configure-guest` | Pass |
| III. Tests in the same change, bug fix has a failing test | New tests for dispatch, unknown OS, probe failure, install failure, SSH-key failure, dry-run probe; existing `update-all` tests guard FR-008 | Pass |
| III. Captured fixtures for third-party APIs | Probe output is this toolkit's own `echo`, not a third-party API; no fixture capture needed | N/A |
| IV. Dry run matches apply | Preview prints the same command string apply sends (SC-004, tested) | Pass |
| IV. Same behavior across front ends | `configure-guest` stays one `Operation`; web/MCP get the change through it with no shape change | Pass |
| IV. Messages say what to do next | Unknown-OS error says to install by hand; failures include remote stderr | Pass |
| IV. README/CLAUDE.md updated | README `configure-guest` section and CLAUDE.md "Targeting flags" / dry-run bullets updated in the implementing commit | Pass |

Re-check after Phase 1: unchanged, all pass. No Complexity Tracking entries.

## Project Structure

### Documentation (this feature)

```text
specs/006-configure-guest-package-manager/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── configure-guest-cli.md
└── tasks.md             # /speckit-tasks output
```

### Source Code (repository root)

```text
src/
├── lib/package-manager.ts                      # + INSTALL_COMMANDS, detectPackageManager,
│                                                #   UnknownPackageManagerError
├── commands/provisioning/configure-guest.ts    # probe -> dispatch -> check exit codes
└── commands/maintenance/update-all.ts          # switch to detectPackageManager (no behavior change)

test/
├── lib/package-manager.test.ts                 # install table + detection helper
├── commands/configure-guest.test.ts            # dispatch, dry run, failure kinds
└── commands/update-all.test.ts                 # unchanged; guards FR-008

README.md, CLAUDE.md                            # docs in the same change
```

**Structure Decision**: existing single-project layout; no new files outside tests-as-needed.
The web (`src/web/commands-meta.ts`) and operation (`src/operations/provisioning.ts`) entries
for `configure-guest` need no change, because the operation already calls
`runConfigureGuest` for both preview and apply.
