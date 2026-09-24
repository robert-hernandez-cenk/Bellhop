---

description: "Task list for renaming the default Authentik group ladder to Bellhop names"
---

# Tasks: Rename the Default Group Ladder to Bellhop Names

**Input**: Design documents from `specs/001-bellhop-group-ladder/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/configuration.md, quickstart.md

**Tests**: Included. Constitution Principle III requires every behavior change to ship with tests in the same change.

**Organization**: Grouped by user story. All paths are relative to the repository root of the worktree `C:\Users\rcher\Dev\Bellhop-Worktrees\issue-8-bellhop-group-ladder`. Never `cd` the session into it; use absolute paths, `git -C`, and `npm --prefix`.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)

## Old and new names (used throughout)

| Old default rung | New default rung |
| --- | --- |
| `homelab-app-users-open` | `bellhop-app-users-open` |
| `homelab-app-users` | `bellhop-app-users` |
| `homelab-users` | `bellhop-users` |
| `authentik Admins` | `authentik Admins` (unchanged) |

---

## Phase 1: Setup

**Purpose**: Make the worktree runnable.

- [x] T001 Run `npm --prefix C:\Users\rcher\Dev\Bellhop-Worktrees\issue-8-bellhop-group-ladder install` (a fresh worktree has no `node_modules`), then run `npm test` there once to record the pre-change baseline as all passing.

---

## Phase 2: Foundational

None. The change has no shared prerequisite beyond Setup.

---

## Phase 3: User Story 1 - New operator gets Bellhop-named groups by default (Priority: P1) 🎯 MVP

**Goal**: With `AUTHENTIK_GROUP_LADDER` unset, the ladder is `bellhop-app-users-open,bellhop-app-users,bellhop-users,authentik Admins` everywhere (CLI, web UI, MCP).

**Independent Test**: `authentikConfig({}).groupLadder` returns the four new names in order, and the whole suite passes with fixtures on the new names.

### Tests for User Story 1 (write first, confirm they fail)

- [x] T002 [US1] In `test/lib/authentik-config.test.ts`, change the default-ladder assertion (lines ~60-66, currently listing `homelab-app-users-open`, `homelab-app-users`, `homelab-users`, `authentik Admins`) to expect `bellhop-app-users-open`, `bellhop-app-users`, `bellhop-users`, `authentik Admins`, in that order. Run `npm test` and confirm this test fails against the unchanged source.

### Implementation for User Story 1

- [x] T003 [US1] In `src/lib/authentik-config.ts`, set `DEFAULT_GROUP_LADDER` to `'bellhop-app-users-open,bellhop-app-users,bellhop-users,authentik Admins'`. Replace the two comment lines above it ("This default names one deployment's own Authentik groups; any other operator sets AUTHENTIK_GROUP_LADDER to their own rungs.") with a comment saying the default rungs are product-named groups an operator creates in Authentik, the top rung is Authentik's built-in admin group, and `AUTHENTIK_GROUP_LADDER` overrides the whole list. Keep the existing "Ordered low ... to high" comment. Confirm T002 now passes.
- [x] T004 [P] [US1] Replace old rung names with new ones in `test/commands/sync-caddy.test.ts` (7 occurrences, all `homelab-users` → `bellhop-users`).
- [x] T005 [P] [US1] Replace old rung names with new ones in `test/lib/inventory.test.ts` (9 occurrences, lines ~103, 116, 131, 438, 449, 988, 993, 1001, 1009; all `homelab-users` → `bellhop-users`, including the `parseAuthGroup('  homelab-users  ')` input and its expected value).
- [x] T006 [P] [US1] Replace old rung names with new ones in `test/operations/edit-guest.test.ts` (1 occurrence, line ~40).
- [x] T007 [P] [US1] Replace old rung names with new ones in `test/web/caddy-sync.test.ts` (3 occurrences, lines ~74, 116, 139).
- [x] T008 [P] [US1] Replace old rung names with new ones in `test/web/routes/auth-groups.test.ts` (1 occurrence, line ~41: the `x-authentik-groups` header value `homelab-app-users` → `bellhop-app-users`).
- [x] T009 [P] [US1] Replace old rung names with new ones in `test/web/routes/dashboard.test.ts` (11 occurrences: `homelab-users` → `bellhop-users` at lines ~189, 191, 196, 205, 229, 247, 269, 707, 737, 751; `homelab-app-users` → `bellhop-app-users` in the `x-authentik-groups` header at line ~805).
- [x] T010 [P] [US1] Replace old rung names with new ones in `test/web/routes/provisioning.test.ts` (2 occurrences, lines ~852, 896).
- [x] T011 [US1] Run `npm run typecheck` and `npm test` in the worktree; all pass. Run `grep -rn "homelab-app-users\|homelab-users" test src web-client/src scripts` and confirm no hits remain outside the new US3 test (T013).

**Checkpoint**: The new default is in effect and every existing test exercises it.

---

## Phase 4: User Story 2 - Existing operator keeps their current group names (Priority: P1)

**Goal**: An explicitly set `AUTHENTIK_GROUP_LADDER` with the old names behaves exactly as before.

**Independent Test**: `authentikConfig({ AUTHENTIK_GROUP_LADDER: '<old ladder>' }).groupLadder` returns the old names in order.

- [x] T012 [US2] In `test/lib/authentik-config.test.ts`, add a test that `authentikConfig({ AUTHENTIK_GROUP_LADDER: 'homelab-app-users-open,homelab-app-users,homelab-users,authentik Admins' }).groupLadder` deep-equals those four names in that order, with a one-line comment that this is the documented upgrade path for a deployment on the pre-rename default. No source change is expected; run `npm test` and confirm it passes.

**Checkpoint**: The keep-old-names upgrade path is pinned by a test.

---

## Phase 5: User Story 3 - Existing operator who skips the upgrade step is told what happened (Priority: P2)

**Goal**: Under the new default, an entry stored as `homelab-users` loads, is reported off-ladder, and its Authentik Application and bindings are untouched.

**Independent Test**: The new test below passes without any source change beyond T003.

- [x] T013 [US3] In `test/commands/sync-authentik.test.ts`, add a test next to "runSyncAuthentik never deletes an existing Application whose authGroup went off-ladder" (line ~491), modeled on it, that uses the default ladder (no `AUTHENTIK_GROUP_LADDER` override) and a guest with `authGroup: 'homelab-users'` plus an existing proxy-backed Application for its slug. Run with `apply: true` and assert: `result.offLadder` equals `[{ slug: '<slug>', authGroup: 'homelab-users' }]`; no Application, Provider, or binding delete call is made; no binding create call is made for that Application. Name it so it reads as the upgrade case, e.g. "an entry still on a pre-rename default rung is reported off-ladder and its Application is kept".
- [x] T014 [US3] In `test/lib/inventory.test.ts`, add a test that `saveInventory` then `loadInventory` round-trips a guest with `authGroup: 'homelab-users'` unchanged with `AUTHENTIK_GROUP_LADDER` unset, proving the inventory still loads and the stored tier is not rewritten (FR-004, FR-005). Place it next to the existing authGroup round-trip test (line ~438).

**Checkpoint**: The skipped-upgrade-step behavior is pinned by tests.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [ ] T015 [P] In `README.md`, in the `AUTHENTIK_GROUP_LADDER` entry (line ~452-458), change the stated default to `bellhop-app-users-open,bellhop-app-users,bellhop-users,authentik Admins`, and add an upgrade note: a deployment that relied on the previous default (`homelab-app-users-open,homelab-app-users,homelab-users,authentik Admins`) either sets `AUTHENTIK_GROUP_LADDER` to that old value in `data/authentik.env` before upgrading, or renames those groups in Authentik and re-tiers each gated entry; stored `authGroup` values are never rewritten, and until one of these is done `sync-authentik` reports affected entries under "Entries with an unknown authGroup" and leaves their Applications alone.
- [ ] T016 [P] In `CLAUDE.md`, update the `sync-authentik` bullet (line ~478-480) to state the new default ladder. In the `requires_auth` migration paragraph (search "happens to match"), remove the sentence about "this operator's own database" and the "four gated Applications", keeping only the product-level point that the migration assigns the top rung, which is `authentik Admins` in the default ladder. Leave the historical `homelaboratory-app-users` mentions and the `homelab.example.com` example as they are.
- [ ] T017 Review the full branch diff (`git -C <worktree> diff origin/main`) for real operational data per constitution Principle I: no real hostnames, domains, IPs, usernames, or tokens in code, tests, docs, or specs.
- [ ] T018 Run the validation in `specs/001-bellhop-group-ladder/quickstart.md` steps 1-4: `npm run typecheck`, `npm test`, `npm run web:build`, the grep, and the two `authentikConfig` checks. All pass.

---

## Dependencies & Execution Order

- **Setup (T001)**: first.
- **US1 (T002-T011)**: T002 before T003 (test-first). T004-T010 can run in parallel with each other after T003, since each edits a different file. T011 after all of them.
- **US2 (T012)**: after T003; independent of US1's fixture edits. Edits the same file as T002, so run after T002.
- **US3 (T013-T014)**: after T003. T014 edits the same file as T005, so run after T005.
- **Polish (T015-T018)**: T015 and T016 can run any time after T003 and in parallel with each other. T017 and T018 last.

## Parallel Example: User Story 1

```text
After T003:
Task: "Replace old rung names in test/commands/sync-caddy.test.ts"
Task: "Replace old rung names in test/lib/inventory.test.ts"
Task: "Replace old rung names in test/operations/edit-guest.test.ts"
Task: "Replace old rung names in test/web/caddy-sync.test.ts"
Task: "Replace old rung names in test/web/routes/auth-groups.test.ts"
Task: "Replace old rung names in test/web/routes/dashboard.test.ts"
Task: "Replace old rung names in test/web/routes/provisioning.test.ts"
```

## Implementation Strategy

### MVP First (User Story 1 Only)

1. T001 setup.
2. T002-T011: the new default, with every test on it.
3. Stop and validate: `npm test` green, `authentikConfig({})` shows the new names.

### Incremental Delivery

1. US1: the rename itself.
2. US2: pin the keep-old-names path.
3. US3: pin the skipped-step path.
4. Polish: docs, data review, quickstart validation. Then open the PR against `main`.

## Notes

- No schema change and no migration (decided on issue #8).
- Commit after each phase; push freely per CLAUDE.md.
