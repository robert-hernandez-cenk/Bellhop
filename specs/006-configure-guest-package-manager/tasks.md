---

description: "Task list for configure-guest package-manager dispatch"
---

# Tasks: configure-guest installs packages with the guest's own package manager

**Input**: Design documents from `specs/006-configure-guest-package-manager/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/configure-guest-cli.md, quickstart.md

**Tests**: required — constitution Principle III (every behavior change ships with tests; a bug
fix includes a test that fails without it). Write each test first and watch it fail.

**Test conventions**: `node:test` + `FakeSSHClient` (`test/support/fake-ssh-client.ts`), the
responder pattern in `test/commands/update-all.test.ts` (probe calls are recognized by
`command -v apt-get`), example names only (`pve1`, `media`, `example.com`).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)

---

## Phase 1: Setup

- [x] T001 Worktree created from `origin/main`, dependencies installed, baseline `npm run typecheck` and `npm test` green (1346 pass) — done during Stage 1

---

## Phase 2: Foundational (shared detection)

**Purpose**: one detection helper both commands call (research R2); `update-all` behavior must not change (FR-008).

- [x] T002 Add tests in `test/lib/package-manager.test.ts` for `detectPackageManager(ssh, inventory, target)`: returns `{ kind: 'detected', pm: 'apk' }` when the probe prints `apk`; `{ kind: 'unknown' }` when it prints `unknown` or garbage; `{ kind: 'probe-failed', result }` (the probe's own `ExecResult`) when the probe exits non-zero; lets a `runRemote` throw propagate. Also test `UnknownPackageManagerError`: `instanceof Error`, carries `target`, message is exactly `No known package manager on media (tried apt-get, dnf, apk, pacman, zypper); install the packages on media by hand`
- [x] T003 Implement in `src/lib/package-manager.ts`: exported `PROBED_COMMANDS = 'apt-get, dnf, apk, pacman, zypper'`, `DetectionResult` union, `detectPackageManager` (runs `PROBE_COMMAND` via `runRemote`, classifies with `parsePackageManager`), and `UnknownPackageManagerError` (research R3). Import `runRemote` from `./targets.ts`
- [x] T004 Switch `src/commands/maintenance/update-all.ts` to `detectPackageManager`, mapping `unknown` -> `failUnknownPm` and `probe-failed` -> `failCommand` with the existing warning texts unchanged (the unknown-OS warning keeps `(tried ${PROBED_COMMANDS})`); `test/commands/update-all.test.ts` must pass unmodified

**Checkpoint**: `npm test` green; update-all unchanged.

---

## Phase 3: User Story 1 - Install packages on a non-Debian guest (Priority: P1) MVP

**Goal**: `--packages --apply` installs with the detected manager.

**Independent Test**: apply against fake guests reporting each manager; the second remote call is that manager's install command with quoted names.

- [x] T005 [P] [US1] Add tests in `test/lib/package-manager.test.ts` for `INSTALL_COMMANDS`: exact strings per research R1 for `'curl' 'vim'` — apt `DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y 'curl' 'vim'`, dnf `dnf -y install 'curl' 'vim'`, apk `apk update && apk add 'curl' 'vim'`, pacman `pacman -Syu --needed --noconfirm 'curl' 'vim'`, zypper `zypper --non-interactive --gpg-auto-import-keys install 'curl' 'vim'`
- [x] T006 [US1] Add `INSTALL_COMMANDS: Record<PackageManager, (packages: string) => string>` next to `UPDATE_COMMANDS` in `src/lib/package-manager.ts`, with a comment for the pacman `-Syu` and zypper key-import choices (research R1)
- [x] T007 [US1] Add tests in `test/commands/configure-guest.test.ts`: for each of the five managers, apply sends the probe first then that manager's install command (and never `apt-get` for non-apt); a name with a shell metacharacter (e.g. `a;b`) stays one quoted argument. Update the existing "installs quoted packages and adds an SSH key" test for the new call order (probe, install, ssh-key = 3 calls)
- [x] T008 [US1] Rewrite the `--packages` branch of `src/commands/provisioning/configure-guest.ts` to call `detectPackageManager`, then run `INSTALL_COMMANDS[pm](quoted)` on apply

**Checkpoint**: US1 tests green.

---

## Phase 4: User Story 2 - See the exact command before applying (Priority: P2)

**Goal**: dry run probes and prints the exact install command (research R4).

**Independent Test**: dry run makes exactly one remote call and prints the manager-specific command.

- [x] T009 [US2] Replace the test "runConfigureGuest does not call ssh in dry run" in `test/commands/configure-guest.test.ts` with: `--packages` dry run makes exactly one call (the probe) and logs `[DRY RUN] Would install on media (apk): apk update && apk add 'curl' 'vim'`; an `--ssh-key`-only dry run still makes zero calls; the dry-run line's command equals the command apply sends (SC-004). Capture output the way other tests do (see `test/support/` helpers)
- [x] T010 [US2] In `src/commands/provisioning/configure-guest.ts`, run detection before `confirmOrDryRun` so both modes print `Would install on <target> (<pm>): <command>` from the same string apply executes

**Checkpoint**: US2 tests green.

---

## Phase 5: User Story 3 - Failures are reported, never silently passed (Priority: P2)

**Goal**: every remote failure throws a distinct, actionable error (contract failure table).

**Independent Test**: each failure kind rejects with its own message.

- [x] T011 [US3] Add tests in `test/commands/configure-guest.test.ts`: unknown OS rejects with `UnknownPackageManagerError` (dry run and apply) and sends no install; probe exit 127 rejects `Package-manager probe failed on media (exit 127): sh: not found`; install exit 1 rejects `Package install failed on media (apk, exit 1): <stderr>`, and empty stderr reads `no output`; `--ssh-key` exit 1 rejects `Adding SSH key on media failed (exit 1): <stderr>`; with both flags, a failed install means the SSH-key command is never sent
- [x] T012 [US3] In `src/commands/provisioning/configure-guest.ts`, throw on `unknown` / `probe-failed` detection and on non-zero install and SSH-key results, with the messages from `contracts/configure-guest-cli.md`

**Checkpoint**: all story tests green.

---

## Phase 6: Polish & Cross-Cutting

- [x] T013 [P] Update `README.md`'s `configure-guest` section: packages install with the guest's detected manager (apt/dnf/apk/pacman/zypper), the dry run contacts the guest to show the exact command, failures exit 1
- [x] T014 [P] Update `CLAUDE.md`: the "Targeting flags" bullet (package-manager detection is now shared by `update-all` and `configure-guest`), and the "Dry-run convention" bullet (`configure-guest --packages` dry run now makes one live probe call, like `create-lxc`/`install-app`)
- [x] T015 Run `npm run typecheck`, `npm test`, and `npm run web:build`; all pass (quickstart.md, automated section)

---

## Dependencies & Execution Order

- Phase 2 (T002-T004) blocks every story: all three use `detectPackageManager`.
- US1 (T005-T008) before US2 and US3: they modify the same `--packages` branch that T008 creates.
- US2 (T009-T010) and US3 (T011-T012) touch the same two files, so run them in sequence.
- Polish after all stories.

### Parallel Opportunities

- T005 can be written alongside T004 (different files).
- T013 and T014 are independent docs edits.

## Implementation Strategy

MVP is Phase 2 + US1: non-apt guests can install packages. US2 and US3 then make the preview
exact and the failures honest. Commit per phase/story with its `tasks.md` checkboxes.
