---
description: "Task list for Proxmox access for VM creators (#53)"
---

# Tasks: Proxmox Access for VM Creators

**Input**: Design documents from `specs/016-pve-creator-acl/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/pve-acl.md, quickstart.md

**Tests**: Required. Constitution Principle III says every behavior change ships with tests, so each story writes failing tests first (TDD).

**Organization**: Tasks are grouped by user story. US1 and US2 share the same grant step and are both P1. US2's tasks harden the step US1 introduces.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Setup

- [x] T001 Create captured, redacted Proxmox fixtures under `test/fixtures/proxmox/`. Start from the live shapes recorded in research.md R1–R5 and replace every identifying value with example values (emails `alice@example.com`/`bob@example.com`, realm `authentik`, VMIDs `4005`/`4105`). Keep field names, types, nesting and array lengths. Files:
  - `realm-openid-email.json`: `{"type":"openid","username-claim":"email"}`
  - `realm-pve.json`: `{"type":"pve","username-claim":null}`
  - `realm-missing.stderr.txt`: `domain 'nosuchrealm' does not exist` plus the following JSON::PP error line, verbatim
  - `user-missing.stderr.txt`: `no such user ('nobody@authentik')`
  - `acl-list.json`: the 4-entry cluster ACL list with the root `Administrator` entry and three `PVEVMAdmin` `/vms/<id>` entries, redacted
  - `acl-filtered.json`: the filter's output for one VMID, a 1-element array

---

## Phase 2: Foundational (blocking)

- [x] T002 Add failing schema tests for `pveUserRealm` (`^[A-Za-z][A-Za-z0-9._-]+$`, message `must start with a letter and contain only letters, digits, ., - and _`) and `pveCreatorRole` (`^[A-Za-z0-9._-]+$`, message `must contain only letters, digits, ., - and _`), both optional. Cover accept/reject and save/load/clear round-trip through `saveInventory`/`loadInventory`, in `test/lib/inventory.test.ts`
- [x] T003 Add both keys, with comments, to `SettingsSchema` in `src/lib/inventory.ts` so they join `SETTINGS_KEYS` (depends on T002)
- [x] T004 Add `actor?: { username: string; email?: string }` (the `Actor` type, exported from `src/lib/pve-acl.ts`) to `OperationDeps` in `src/operations/types.ts`, with a comment that only the web provisioning router sets it (research R6)

**Checkpoint**: Settings and the actor type exist, so stories can start.

---

## Phase 3: User Story 1 - A VM's creator can use it in Proxmox (P1) 🎯 MVP

**Goal**: A web-created VM is granted to its real creator's Proxmox user, with the user created first when missing.

**Independent Test**: With `pveUserRealm` set, a web Create VM apply sends the realm read and grant script through `FakeSSHClient`, and the job log says `Granted PVEVMAdmin on VM <vmid> to <userid>`.

### Tests (write first, must fail)

- [ ] T005 [P] [US1] Unit tests in `test/lib/pve-acl.test.ts`:
  - `buildRealmReadCommand` prints only the filtered fields (it contains the JSON::PP filter and `pipefail`, and the realm is shell-quoted)
  - `RealmInfoSchema` parses `realm-openid-email.json` and `realm-pve.json`
  - `pveUserIdFor`: username claim gives `alice@authentik`, email claim gives `alice@example.com@authentik`
  - `buildGrantScript` produces the exact two-line script from research R3 with every value `shellQuote`d and the comment `Created by Bellhop for VM <vmid>`
  - `creatorGrantPreview` returns `Would grant <role> on /vms/<vmid> to <username>'s Proxmox account (realm <realm>)`, or undefined when the realm is unset
- [ ] T006 [P] [US1] Operation tests in `test/operations/provisioning.test.ts`, create-vm with `pveUserRealm` set and `actor` in deps:
  - apply sends `qm create`, then the realm read, then the grant script, in that order (realm read answered from `realm-openid-email.json`)
  - the default role is `PVEVMAdmin`, and `pveCreatorRole` overrides it
  - the preview contains the grant line and makes no extra SSH call
  - the grant still runs when `recordProvisionedGuest` throws (stub a failing proxy sync by giving the VM subdomains with no `proxy: true` entry), and the job error is unchanged
- [ ] T007 [P] [US1] Web route tests in `test/web/routes/provisioning.test.ts`:
  - create-vm apply as a normal user sets `actor` from the auth headers, including email
  - while impersonating a group, `actor` is the real admin
  - preview and apply both receive the actor

### Implementation

- [ ] T008 [US1] Create `src/lib/pve-acl.ts` with the `DEFAULT_CREATOR_ROLE`, `Actor`, `RealmInfoSchema`, `buildRealmReadCommand`, `pveUserIdFor` (happy paths), `buildGrantScript`, `creatorGrantPreview`, and `grantCreatorAccess` (realm read, user ID, grant script, the `Granted …` info line) exports, exactly as in `contracts/pve-acl.md` (makes T005 pass)
- [ ] T009 [US1] Add `resolveActor(req)` to `src/web/impersonation.ts`. It uses `req.realUser ?? req.user` and returns `undefined` when there's no user or `localOperator` is true. Change `deps()` in `src/web/routes/provisioning.ts` to take the request and set `actor` for both the `/preview` and `/apply` routes (makes T007 pass)
- [ ] T010 [US1] In `src/operations/provisioning.ts`, the create-vm `preview` appends `creatorGrantPreview(deps.inventory, deps.actor, mid.vmid)` when it's defined, and `apply` wraps `recordProvisionedGuest` in `try { … } finally { await grantCreatorAccess(deps.ssh, deps.inventory, i.host, result.mid.vmid, deps.actor) }` (research R7) (makes T006 pass)

**Checkpoint**: A configured web create-vm grants the creator. Commit `Grant VM creators access in Proxmox (#53, US1)`.

---

## Phase 4: User Story 2 - The grant never breaks VM creation (P1)

**Goal**: Every non-success path logs exactly one line naming the fix, and none of them throws.

**Independent Test**: Realm unset, a non-OpenID realm, a `subject` claim, a missing email, a missing realm, an unsafe username, a failing grant script, and no actor each leave the create-vm job successful with the message from `contracts/pve-acl.md`.

### Tests (write first, must fail)

- [ ] T011 [P] [US2] Extend `test/lib/pve-acl.test.ts`:
  - `pveUserIdFor` skips with the exact contract messages for a non-OpenID realm (`realm-pve.json`), a `subject` claim, a null or missing claim, the email claim with no email, and a username or email containing whitespace, `:` or `/`
  - `grantCreatorAccess` returns and logs `off`, `no-actor`, and `skipped` (missing realm: exit 255 with `realm-missing.stderr.txt`, or unparseable output)
  - `grantCreatorAccess` returns `failed` when the grant script exits non-zero (stderr from `user-missing.stderr.txt`-style output), and the warning contains stderr and the full script
  - no path throws, including when `ssh.exec` itself rejects
  - capture log output with the repo's existing console-capture helper
- [ ] T012 [P] [US2] Extend `test/operations/provisioning.test.ts`:
  - with the realm unset, a create-vm apply sends no realm or grant command and logs the "off" line once
  - with no `actor` (the MCP path), it logs the no-actor line and sends no grant
  - a failing grant script leaves the apply resolved (the job succeeds) and the guest recorded in inventory
  - create-lxc and install-app apply send no realm or grant command even with the realm set (FR-016)

### Implementation

- [ ] T013 [US2] Complete `pveUserIdFor`'s skip branches and `grantCreatorAccess`'s off, no-actor, skipped and failed handling in `src/lib/pve-acl.ts`, using the exact messages in `contracts/pve-acl.md`. Wrap the remote calls so a rejected `exec` becomes `failed` (makes T011 and T012 pass)

**Checkpoint**: Commit `Never fail a VM creation over the creator grant (#53, US2)`.

---

## Phase 5: User Story 3 - Settings from the CLI and the web UI (P2)

**Goal**: Both settings can be set and cleared through `set-config` and the Settings page, with identical validation.

**Independent Test**: `set-config pveUserRealm 'bad realm' --apply` and `PATCH /api/settings {pveUserRealm:'bad realm'}` both fail with the same message, and valid values round-trip.

- [ ] T014 [P] [US3] Tests in `test/commands/set-config.test.ts`: set, clear and reject both keys
- [ ] T015 [P] [US3] Tests in `test/web/routes/settings.test.ts`: PATCH sets, clears and rejects both keys with the same message as T014, and GET returns them
- [ ] T016 [US3] Add `pveUserRealm`/`pveCreatorRole` to `SettingsValues` in `web-client/src/api/types.ts`. Add two always-visible `FIELDS` entries in `web-client/src/pages/SettingsPage.tsx`:
  - "Proxmox realm": placeholder `authentik`. Help: `OpenID realm in Proxmox whose users get access to VMs they create from the web UI. Its username claim must be username or email. Unset: no access is granted.`
  - "VM creator role": placeholder `PVEVMAdmin`. Help: `Proxmox role granted on a VM to the person who created it from the web UI. Unset: PVEVMAdmin.`
  
  Make sure the visibility filter shows them for every driver (fix T014/T015 if `src/web/routes/settings.ts` or `set-config` needs anything beyond the schema)

**Checkpoint**: Commit `Configure the Proxmox creator grant from CLI and Settings (#53, US3)`.

---

## Phase 6: User Story 4 - Permissions survive a migration (P2)

**Goal**: `migrate-guest` copies every `/vms/<old>` permission to the new VMID before destroying the original.

**Independent Test**: A `FakeSSHClient` migrate-guest run whose ACL read returns `acl-filtered.json` sends the copy script after the running check and before `destroy`. An empty list sends no copy script, and a copy failure only warns.

### Tests (write first, must fail)

- [ ] T017 [P] [US4] Extend `test/lib/pve-acl.test.ts`:
  - `buildGuestAclReadCommand` filters to exactly `/vms/<vmid>` on the host
  - `AclEntrySchema` parses `acl-list.json`
  - `aclsForVmid` keeps only the exact path, so `/vms/40050` and `/` are excluded
  - `buildAclCopyScript` maps user, group and token to `--users`, `--groups` and `--tokens`, keeps `--roles` and `--propagate 0|1`, and quotes every value
  - `copyGuestAcls` returns `copied` with a count line, `none`, or `failed` (on a read failure, a parse failure, or a copy-script failure), and never throws
- [ ] T018 [P] [US4] Extend `test/commands/migrate-guest.test.ts`:
  - the ACL read and copy commands are sent after the running verification and before `<tool> destroy <old>`, for both `qm` and `pct`
  - an empty ACL list sends no copy
  - a copy failure warns and the migration still completes (destroy, cleanup, inventory save)
  - the dry-run `sourceScript` contains `# then copy any ACLs on /vms/<old> to /vms/<new>`
  - update existing exact `sourceScript` assertions accordingly

### Implementation

- [ ] T019 [US4] Add `AclEntrySchema`, `buildGuestAclReadCommand`, `aclsForVmid`, `buildAclCopyScript` and `copyGuestAcls` to `src/lib/pve-acl.ts` (makes T017 pass)
- [ ] T020 [US4] In `src/commands/provisioning/migrate-guest.ts`:
  - after `waitForGuestRunning` and before the destroy log line, call `await copyGuestAcls(ssh, inventory, guest.host, guest.vmid, mid.vmid)`
  - add the `# then copy any ACLs on /vms/<old> to /vms/<new>` line to `sourceScript` before the destroy comment
  
  (makes T018 pass)

**Checkpoint**: Commit `Copy guest permissions across migrate-guest (#53, US4)`.

---

## Phase 7: User Story 5 - A reused VMID never inherits old permissions (P3)

**Goal**: Confirm and record that no code is needed (research R4).

- [ ] T021 [US5] Add a short comment above the destroy calls in `src/commands/provisioning/delete-guest.ts` and `src/commands/provisioning/migrate-guest.ts`. It notes that Proxmox's destroy removes the VMID's ACLs and pool membership itself (`remove_vm_access`, verified on PVE 9.2.10, see specs/016-pve-creator-acl/research.md R4), which is why there's no cleanup step

**Checkpoint**: Commit together with T022–T025 if trivial, otherwise `Record VMID ACL cleanup on destroy (#53, US5)`.

---

## Phase 8: Polish & Cross-Cutting

- [ ] T022 [P] Write `docs/proxmox-access.md`, covering:
  - what the feature does
  - Proxmox realm prerequisites (OpenID, username claim `username` or `email`, same identity provider)
  - both settings
  - what `PVEVMAdmin` allows, and how to narrow it to `PVEVMUser`
  - user pre-creation
  - web-only (MCP and CLI never grant)
  - ACL copy on migration, and that pool membership is not copied
  - destroy cleanup (research R4)
  - the job-log messages and their fixes

  Link it from the docs index in `README.md`, keeping README at 200 lines or fewer
- [ ] T023 [P] Add `pveUserRealm`/`pveCreatorRole` to the settings reference in `docs/configuration.md`
- [ ] T024 [P] Add a CLAUDE.md architecture bullet for the creator grant and ACL copy, covering:
  - `src/lib/pve-acl.ts`
  - `OperationDeps.actor` (set only by the web provisioning router, via `resolveActor`)
  - the on-host JSON::PP filtering and why (the realm read carries `client-key`, and job logs capture stdout)
  - `finally`-ordering after `recordProvisionedGuest`
  - migrate-guest copy before destroy
  - destroy already cleaning ACLs

  Mention the two new settings in the existing `meta` settings list
- [ ] T025 Run `npm run typecheck`, `npm test`, `npm run web:build` in the worktree; all must pass
- [ ] T026 Verify the Settings page in a browser at desktop width and at ≤640px against the demo (`npm run demo`): both new fields render, wrap correctly, and save
- [ ] T027 Regenerate screenshots with `npm run docs:screenshots` and check `docs/images/` by eye for example-only values (the Settings screenshot gains two fields)
- [ ] T028 Live verification per `quickstart.md` steps 1–7 against a real cluster. This needs the operator (it creates and destroys a real VM), so record it as unverified in the PR unless it's done

---

## Dependencies & Execution Order

- Phase 1 (T001) → Phase 2 (T002–T004) → user stories.
- US1 (T005–T010) before US2 (T011–T013): US2 extends the same functions.
- US3 (T014–T016) depends only on T003, and can run alongside US1/US2.
- US4 (T017–T020) depends only on T001, and can run alongside US1–US3. T019/T020 touch `pve-acl.ts`, so serialize them with T008/T013.
- US5 (T021) is independent.
- Polish (T022–T028) last.

### Parallel opportunities

- T005, T006, T007 (different test files).
- T014, T015 (different test files).
- T017, T018 (different test files).
- T022, T023, T024 (different docs).

## Implementation Strategy

MVP = Phases 1–4 (US1 + US2): a configured web create-vm grants its creator
and never breaks. Then US3 (operator UX), US4 (migration), US5 (comment
only), then polish and verification. Commit per story, as listed at each
checkpoint.
