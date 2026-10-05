---

description: "Task list for running the web service as an LXC container (#67)"
---

# Tasks: Run the web service as an LXC container

**Input**: Design documents from `specs/067-lxc-container-installer/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/self-guard.md, contracts/installer.md, quickstart.md

**Tests**: required. Constitution Principle III makes tests mandatory for every behavior change. Write each test first and watch it fail.

**Two repositories**: Bellhop paths are relative to the worktree `C:/Users/rcher/Dev/Bellhop-Worktrees/issue-67-lxc-container-installer`. Fork paths (marked **fork:**) are relative to `C:/Users/rcher/Dev/ProxmoxVED`, on a new `bellhop` branch created from `main`.

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Setup

- [x] T001 Create the fork branch `bellhop` from `main` in its own fork worktree (`git -C C:/Users/rcher/Dev/ProxmoxVED worktree add -b bellhop <scratch-path> main`), leaving the operator's fork checkout on `local`; `main` and `local` confirmed in sync with origin

---

## Phase 2: Foundational (the `bellhopGuest` setting)

**Purpose**: the setting the installer seeds (US1) and the guard reads (US3).

- [x] T002 Write a failing test in test/commands/set-config.test.ts: `set-config bellhopGuest web-lxc --apply` stores the value, and a subsequent load returns `bellhopGuest: 'web-lxc'`
- [x] T003 Add `bellhopGuest: z.string().min(1).optional()` to `SettingsSchema` in src/lib/inventory.ts, with a comment naming issue #67 and the guard that reads it ("data-model.md: non-empty when set (`z.string().min(1).optional()`), same as `nfsServer`"); fix any key-set tests that enumerate `SETTINGS_KEYS` (e.g. test/lib/inventory.test.ts, test/web/routes/settings.test.ts)
- [x] T004 [P] Add `bellhopGuest?: string` to `SettingsValues` in web-client/src/api/types.ts, add `'bellhopGuest'` to the General tab's `TAB_FIELDS` (after `dnsServer`) in web-client/src/lib/settings-display.ts, and add its `FIELDS` entry in web-client/src/pages/SettingsPage.tsx (label "Bellhop's own guest", placeholder `bellhop`, help: which guest Bellhop runs in; update-app, delete-guest, migrate-guest and start/shutdown refuse it and update-all skips it; unset: nothing is protected)
- [x] T005 Verify any web-client settings test (test/web-client/settings-display.test.ts) still passes or is updated for the new field

**Checkpoint**: `npm run typecheck`, `npm test` and `npm run web:build` pass.

---

## Phase 3: User Story 1 - Install Bellhop as a container (P1) 🎯 MVP

**Goal**: a non-interactive installer that yields a running service, plus a `bellhop` CLI wrapper that works inside the container.

**Independent Test**: `bash -n` on the scripts; the shim runs from outside the repository; a live install, run by the operator, answers on port 3000.

### Tests for User Story 1

- [x] T006 [US1] Write a failing test in test/bin/bellhop-shim.test.ts that spawns `node <repo>/bin/bellhop.js --help` with `cwd` set to an `mkdtempSync` directory and asserts exit code 0 and usage text (research R5)

### Implementation for User Story 1

- [x] T007 [US1] Fix bin/bellhop.js to pass `import.meta.resolve('tsx')` (resolved relative to the shim) to `--import` instead of the bare `tsx` specifier, with a comment explaining why (Node resolves a bare `--import` specifier against the caller's cwd)
- [x] T008 [P] [US1] fork: write install/bellhop-install.sh per contracts/installer.md (steps 1-12): dependencies, `NODE_VERSION="24" setup_nodejs`, `fetch_and_deploy_gh_release "bellhop" "robert-hernandez-cenk/Bellhop" "tarball"`, `npm ci` + `npm run web:build`, data dirs, root ed25519 key only if absent (no service user: fork anti-patterns 9/12), /etc/default/bellhop, /usr/local/bin/bellhop wrapper, bellhop.service (User=root, `EnvironmentFile=/etc/default/bellhop`, `Restart=on-failure`), (the ct footer prints the key and the `bellhop set-config bellhopGuest <hostname> --apply` line, research R7), `motd_ssh`/`customize`/`cleanup_lxc`. Never prompts.
- [x] T009 [P] [US1] fork: write ct/bellhop.sh per contracts/installer.md (header, `var_*` defaults 2/2048/8/debian/13/unprivileged, `start`/`build_container`/`description`, final URL `http://${IP}:3000` and docs pointer). `update_script()` is in T012.
- [x] T010 [P] [US1] fork: write json/bellhop.json following the shelfarr manifest shape (slug `bellhop`, `type` ct, `updateable` true, `privileged` false, `interface_port` 3000, `config_path` /etc/default/bellhop, resources matching ct/bellhop.sh, notes on the SSH key, sign-in and the data location); pick `categories` from the fork's category list
- [x] T011 [US1] Check the seeding order (research R7): verified that set-config fails on a fresh database (no domain) and that import-yaml-inventory replaces settings; seeding moved to a printed command plus a docs step (spec FR-009 and research R7 revised)

**Checkpoint**: the shim test passes; `bash -n` passes on both fork scripts.

---

## Phase 4: User Story 2 - Update in place without losing data (P1)

**Goal**: `update_script()` moves to the newest release and leaves /var/lib/bellhop alone.

**Independent Test**: read-through against contracts/installer.md, plus `bash -n`. Live update is for the operator.

- [x] T012 [US2] fork: implement `update_script()` in ct/bellhop.sh: storage/resource checks, "No ${APP} Installation Found!" when /opt/bellhop is missing, `check_for_gh_release "bellhop" "robert-hernandez-cenk/Bellhop"` gate, stop service, `NODE_VERSION="24" setup_nodejs`, `CLEAN_INSTALL=1 fetch_and_deploy_gh_release ... "tarball"`, `npm ci`, `npm run web:build`, start service; never references /var/lib/bellhop or /etc/default/bellhop
- [x] T013 [US2] fork: `bash -n` passes on both scripts; `shellcheck` reports only the SC1090/SC1091/SC2164 findings every fork script shares (dynamic `source`, bare `cd` under errexit); json/bellhop.json parses. Committed "Add Bellhop" (793c6986) on `bellhop` in the fork worktree, merged into `local` in the fork checkout (01cd2e54), pushed both; the fork checkout stayed on `local` throughout. Linux build/run simulated in WSL (research R2)

---

## Phase 5: User Story 3 - Bellhop refuses to disrupt its own container (P2)

**Goal**: contracts/self-guard.md, enforced in the shared command logic.

**Independent Test**: set `bellhopGuest` in a fixture; each guarded action refuses with `FakeSSHClient.history` empty; update-all skips.

### Tests for User Story 3

- [ ] T014 [P] [US3] Write failing tests in test/lib/bellhop-guest.test.ts: `isBellhopGuest` is false when unset, true for an exact name match, false for another name; `assertNotBellhopGuest` throws the contracts/self-guard.md message (naming `bellhopGuest` and `set-config`) only for the match
- [ ] T015 [P] [US3] Write failing tests in test/commands/guest-power.test.ts, test/commands/delete-guest.test.ts, test/commands/migrate-guest.test.ts and test/commands/update-app.test.ts (create any that do not exist): with `bellhopGuest` set to the target, both dry run and apply reject with the refusal, and `ssh.history` is empty (for update-app, also no fetch call); another guest behaves as before
- [ ] T016 [P] [US3] Write failing tests in test/commands/update-all.test.ts: with `bellhopGuest` set, `{ all: true }` processes every other target and returns the own guest in `skippedSelf`; `{ host: <self> }` returns `skippedSelf: [<self>]`, empty `pass`, no failures and no throw; `formatUpdateAll` prints the "Skipped (Bellhop's own guest)" line only when non-empty
- [ ] T017 [P] [US3] Write failing tests for the operations layer (the existing operations test file covering delete-guest and update-all, e.g. under test/operations/ or test/web/routes/): the delete-guest apply refuses before any Authentik call (fake Authentik client records no calls); the update-all preview names the skipped guest; the update-all apply does not throw when only the own guest was skipped

### Implementation for User Story 3

- [ ] T018 [US3] Create src/lib/bellhop-guest.ts with `isBellhopGuest(inventory, name)` and `assertNotBellhopGuest(inventory, name, action)` producing the exact contracts/self-guard.md message (`action` is one of `update`, `delete`, `migrate`, `start`, `shut down`)
- [ ] T019 [US3] Call `assertNotBellhopGuest` first thing in `runGuestPower` (src/commands/maintenance/guest-power.ts; action `start` or `shut down` by state), `runDeleteGuest` (src/commands/provisioning/delete-guest.ts), `runMigrateGuest` (src/commands/provisioning/migrate-guest.ts) and `runUpdateApp` (src/commands/maintenance/update-app.ts, before `resolveAppSource`)
- [ ] T020 [US3] In src/commands/maintenance/update-all.ts: add `skippedSelf: string[]` to `UpdateAllResult`, filter the own guest out after `selectUpdateTargets` (log a warning naming it), throw "No targets matched" only when nothing at all was selected, and add the skipped line to `formatUpdateAll` when non-empty; update any CLI/MCP code that builds an `UpdateAllResult`
- [ ] T021 [US3] In src/operations/provisioning.ts, call `assertNotBellhopGuest` at the start of the delete-guest operation's apply, beside the existing `proxy: true` refusal; in src/operations/maintenance.ts, append `Skipping <self>: Bellhop's own guest (bellhopGuest setting).` to the update-all preview when the own guest is among the selected targets

**Checkpoint**: all US3 tests pass, with the full suite green.

---

## Phase 6: User Story 5 - Documented first run (P2)

**Goal**: one page that takes a fresh container to a working deployment.

- [ ] T022 [US5] Write docs/lxc-container.md: what the installer does, defaults and `var_*` overrides; layout (/opt/bellhop vs /var/lib/bellhop, /etc/default/bellhop); trusting the SSH key (append to /root/.ssh/authorized_keys on a Proxmox node, cluster-shared via /etc/pve/priv/authorized_keys; re-read with `cat /root/.ssh/id_ed25519.pub`); inventory bootstrap with `bellhop import-yaml-inventory --yaml-path <file> --db-path /var/lib/bellhop/inventory/bellhop.db --apply` and `sync-inventory`; settings (`set-config`, Settings page); sign-in (configure-web-login, webUiAuthMode oidc) before exposing the UI, and why no firewall rule is needed (#69); updating (in-container `update` / Bellhop's own custom script source); the `bellhopGuest` step right after the import (set-config, or a `bellhopGuest:` key in hosts.yaml), and the guard; the prerequisite that a GitHub release exists. Example values only (`pve1`, `192.0.2.10`, `web-lxc`)
- [ ] T023 [US5] Update README.md (keep it within 200 lines): the Setup section points to docs/lxc-container.md as the recommended way to run the web service, and the documentation index lists the page
- [ ] T024 [P] [US5] Add `bellhopGuest` to docs/configuration.md's inventory-wide settings list, and mention `INVENTORY_FILE`/`WEB_DATA_DIR` being set by the container in docs/environment-variables.md
- [ ] T025 [P] [US5] Update CLAUDE.md (root: mention the container deployment and the `bellhopGuest` guard in the mental model or rules, staying within 250 lines), src/lib/CLAUDE.md (the setting and `bellhop-guest.ts`), src/commands/maintenance/CLAUDE.md and src/commands/provisioning/CLAUDE.md (the guarded commands), and CONTRIBUTING.md if it describes deployment

---

## Phase 7: User Story 4 - The Windows service is marked deprecated (P3)

- [ ] T026 [US4] In scripts/windows-service.ts `main()`, print the research R9 deprecation notice before argument parsing and elevation, and export or factor the notice text so test/scripts/windows-service-notice.test.ts (new) can assert it names docs/lxc-container.md and #68 without importing the module's side effects (put the constant in scripts/firewall-rule.ts's sibling module or a new scripts/windows-service-notice.ts)
- [ ] T027 [P] [US4] Mark the Windows service deprecated (removal tracked in #68) wherever docs describe it: docs/web-ui.md, docs/configuration.md, docs/environment-variables.md, docs/authentik.md, src/web/CLAUDE.md

---

## Phase 8: Polish & Verification

- [ ] T028 Run `npm run typecheck`, `npm test`, `npm run web:build` and paste the results
- [ ] T029 Run quickstart.md's manual checks: the shim from a temp directory; the guard via a fixture `INVENTORY_FILE`; the Settings page General tab in `npm run demo` at a desktop width and a ≤640px mobile width
- [ ] T030 Review the full diff (`git diff main...HEAD`) and the fork commit for real operational data (constitution Principle I)

---

## Dependencies & Execution Order

- Phase 1 → Phase 2 → stories. US1 (T008) depends on the setting existing (T003) only by name. US2 (T012) extends the T009 file. T013 needs T008-T012. US3 depends on Phase 2. US5 docs depend on US1/US3 facts being settled (T011). US4 is independent.
- Within US3: T014-T017 (tests) before T018-T021.

## Parallel Opportunities

- T004 alongside T003's test fixes.
- T008, T009, T010 (separate fork files).
- T014-T017 (separate test files).
- T024, T025, T027 (separate docs).

## Implementation Strategy

Inline execution, one commit per phase or story: Phase 2, then US1 Bellhop side (shim), the fork scripts (US1+US2, committed in the fork), then US3, US5, US4, then verification. The MVP is US1+US2 (the container itself); US3 makes it safe for daily use.
