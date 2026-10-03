---

description: "Task list for MID suggestions that account for hidden guests"
---

# Tasks: MID suggestions that account for hidden guests

**Input**: Design documents from `specs/016-mid-suggestion-hidden-guests/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/used-mids.md, quickstart.md

**Tests**: requested (TDD). Each story writes its failing tests first.

**Example data only** (constitution Principle I): hosts `pve1`/`pve2`, guests `secret`/`media`,
`midScheme.vmidBase` 4000, group `family`.

## Phase 1: Setup

- [x] T001 Confirm baseline: `npm run typecheck` and `npm test` pass in the worktree before any change (no files changed)

---

## Phase 2: Foundational (occupied-MID data, blocks US1 and US2)

**Purpose**: the server-side occupied-MID set and the route that serves it (contracts/used-mids.md).

- [x] T002 [P] Write failing tests for `usedMidsByHost(inventory, hostNames)` in test/lib/targets.test.ts: returns MIDs `vmid - midScheme.vmidBase` limited to 1-254, ascending and unique; hosts without `midScheme` omitted; hosts not in `hostNames` omitted; a visible host with no in-range guests maps to `[]`
- [x] T003 Implement `usedMidsByHost` in src/lib/targets.ts next to `resolveMid` (reuse the same 1-254 bounds; export it)
- [x] T004 Write failing route tests in test/web/routes/provisioning.test.ts for `GET /api/provisioning/used-mids`: admin gets every host with a `midScheme`; restricted group `family` (allow-list: host `pve1`, guest `media`) gets `pve1` only, and its list includes the MID of hidden guest `secret`; response body has only the `usedMids` key and contains no guest name
- [x] T005 Implement the route in src/web/routes/provisioning.ts: hosts filtered with `isResourceAllowed(inventoryPath, req.user?.groups ?? [], { type: 'host', name })`, then `usedMidsByHost(inventory, allowedNames)`, respond `{ usedMids }`; register it before the `/:id/...` routes; no `requireAdminGroup`

**Checkpoint**: `npm test` passes; the endpoint matches contracts/used-mids.md.

---

## Phase 3: User Story 1 - Restricted user gets a free MID (Priority: P1) 🎯 MVP

**Goal**: every MID-bearing form suggests an MID free across the whole inventory (FR-003, FR-004, FR-008).

**Independent Test**: restricted user picks `pve1` in Create VM; suggestion skips hidden guest `secret`'s MID.

- [x] T006 [P] [US1] Write failing tests in test/web-client/mid.test.ts for the new `nextAvailableMid(host, usedMids)` signature (usedMids: `number[] | undefined`): returns lowest MID in `MID_MIN`..`MID_MAX` not in the list; `null` for no host, no `midScheme`, `usedMids` undefined, or a full range
- [x] T007 [US1] Change `nextAvailableMid` in web-client/src/lib/mid.ts to take the host's occupied-MID list instead of `GuestEntry[]`; add `isMidUsed(usedMids, mid)` (false when unknown) for the migrate-guest preferred-MID check
- [x] T008 [US1] In web-client/src/pages/ProvisioningForm.tsx: load `GET /provisioning/used-mids` alongside `/inventory` into `usedMids` state (`Record<string, number[]> | null`); on failure set the form's `error` to a message naming the failed load and keep `usedMids` null (FR-008: never fall back to the filtered guest list); compute the suggestion with `nextAvailableMid(selectedHost, usedMids?.[host])`; for migrate-guest treat the preferred MID as colliding when `isMidUsed(usedMids?.[toHost], preferredMid)`. Update the comment block above the mid loop to say why the occupied set comes from the server
- [x] T009 [US1] Run `npm run typecheck`, `npm test`, `npm run web:build`

**Checkpoint**: US1 complete and independently verifiable.

---

## Phase 4: User Story 2 - Collision warning covers hidden guests without naming them (Priority: P2)

**Goal**: FR-005.

**Independent Test**: restricted user types MID 2 on `pve1`: warning without a name; MID 3: names `media`.

- [x] T010 [P] [US2] Write failing tests in test/web-client/mid.test.ts for `midCollisionMessage(host, mid, usedMids, visibleGuests)`: `null` when the MID is free, `usedMids` undefined, or no host/scheme; `MID 3 is already used by media (vmid 4003) on pve1.` when a visible guest holds it; `MID 2 is already in use on pve1.` when it is occupied but no visible guest holds it
- [x] T011 [US2] Implement `midCollisionMessage` in web-client/src/lib/mid.ts
- [x] T012 [US2] Update web-client/src/components/MidInput.tsx to take `usedMids: number[] | undefined` and render `midCollisionMessage(...)` on blur (state holds the message string, cleared on change); update web-client/src/components/FieldInput.tsx to accept a `usedMids?: Record<string, number[]> | null` prop and pass the selected host's list; pass it from web-client/src/pages/ProvisioningForm.tsx
- [x] T013 [US2] Run `npm run typecheck`, `npm test`, `npm run web:build`

---

## Phase 5: User Story 3 - Create errors don't name hidden guests (Priority: P3)

**Goal**: FR-006, FR-007.

**Independent Test**: restricted install-app preview with a taken MID: error lacks `secret`; CLI still names it.

- [x] T014 [P] [US3] Write failing tests in test/lib/targets.test.ts for `checkVmidAvailable(ssh, inv, host, vmid, canSeeGuest?)` with a `FakeSSHClient` reporting the VMID live: no predicate → message contains `by 'secret'` (unchanged); predicate returning true → contains it; predicate returning false → `VMID 4002 on 'pve1' is already in use -- choose a different --mid` with no guest name
- [x] T015 [P] [US3] Write a failing route test in test/web/routes/provisioning.test.ts: group `family` (allow-list host `pve1`, guest `media`) previews `install-app` on `pve1` with the MID of hidden guest `secret` while the fake SSH client reports the VMID in use → 400 whose error does not contain `secret`; the same request as admin → error contains `secret`
- [x] T016 [US3] Add optional `canSeeGuest` parameter to `checkVmidAvailable` in src/lib/targets.ts (name omitted only when the predicate exists and returns false)
- [x] T017 [US3] Add `canSeeGuest?: (guestName: string) => boolean` to `OperationDeps` in src/operations/types.ts with a comment (web provisioning only; CLI/MCP omit it = full trust); add the same optional field to the deps parameter types of `runInstallApp` (src/commands/provisioning/install-app.ts) and `runMigrateGuest` (src/commands/provisioning/migrate-guest.ts) and pass `deps.canSeeGuest` to `checkVmidAvailable`
- [x] T018 [US3] In src/web/routes/provisioning.ts change `deps()` to `deps(req)` and set `canSeeGuest: (name) => isResourceAllowed(inventoryPath, groups, { type: 'guest', name })` from the caller's groups; update both preview and apply call sites
- [x] T019 [US3] Run `npm run typecheck`, `npm test`

---

## Phase 6: Polish & Cross-Cutting

- [ ] T020 Update CLAUDE.md "Web UI per-resource group permissions" bullet: MID suggestion/warning use the server's occupied-MID set (`GET /api/provisioning/used-mids`, numbers only), and web-triggered `checkVmidAvailable` errors omit guests the caller can't see; check docs/ for any page describing MID suggestion and update it if present
- [ ] T021 Browser check per quickstart.md with a temp inventory and `npm run web:dev`: impersonate `family`, verify suggestion and both warning texts at desktop width and at ≤640px; kill the dev server tree by PID afterwards
- [ ] T022 Final `npm run typecheck`, `npm test`, `npm run web:build`; review the full diff for real operational data (Principle I)

---

## Dependencies & Execution Order

- Phase 1 → Phase 2 → US1 → US2 (US2 edits the same client files as US1) → Polish.
- US3 depends only on Phase 1 and can run in parallel with Phase 2/US1/US2 (server-only files, but T018 and T005 both edit src/web/routes/provisioning.ts, so sequence those two).
- Within each story: tests (fail) → implementation → checks.

## Parallel Opportunities

- T002 with T014 (different describe blocks; same file, so coordinate or sequence).
- T006 and T010 both live in test/web-client/mid.test.ts: sequential.
- US3's T014-T017 can proceed while US1 client work runs.

## Implementation Strategy

MVP is Phase 2 + US1 (the reported bug). US2 and US3 close the remaining disclosure gaps.
Commit per story: `<what it delivers> (#54, USn)`.
