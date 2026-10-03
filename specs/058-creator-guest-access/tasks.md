---

description: "Task list for creator access to guests (#58)"
---

# Tasks: Creator access to guests

**Input**: Design documents from `specs/058-creator-guest-access/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Required — constitution Principle III ("Every behavior change MUST ship with automated tests in the same change"). Write each test first and watch it fail (TDD), then implement.

**Example data only** (constitution Principle I): users `test-user`, `other-user`, `admin`; groups `app-users`, `blocked`; hosts `pve1`, `pve2`; guests `web-lxc`, `demo-vm`, `media`; uids such as `uid-test-user` or 64-char hex strings of your own invention.

**Run commands from the main checkout against the worktree**: `npm --prefix <wt> run typecheck`, `npm --prefix <wt> test`. Never `cd` into the worktree.

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Setup

- [ ] T001 Confirm baseline: `npm run typecheck` and `npm test` pass in the worktree before any change (record the pass count).

---

## Phase 2: Foundational (blocking prerequisites)

**Purpose**: the creator record and caller identity every story reads.

- [ ] T002 Write failing tests in `test/lib/inventory.test.ts`: a guest with `creator: { uid: 'uid-test-user', username: 'test-user' }` round-trips through `saveInventory`/`loadInventory`; a guest with `creator: { username: 'test-user' }` (no uid) round-trips without a `uid` key; a guest without `creator` loads with no `creator` key; an existing DB file created without the new columns opens and gains them (`ensureColumn`); schema rejects `creator: { username: '' }` and `creator: { uid: '', username: 'x' }`.
- [ ] T003 Implement in `src/lib/inventory.ts`: export `GuestCreatorSchema = z.object({ uid: z.string().min(1).optional(), username: z.string().min(1) })` and type `GuestCreator`; add `creator: GuestCreatorSchema.optional()` to `GuestEntrySchema` with a comment in the style of the `app`/`appSource` comments (set only by web-UI creation via `deps.actor` or `backfill-guest-creators`; preserved by sync-inventory/upsert/migrate; drives creator access in `src/lib/permissions.ts`); add `ensureColumn(db, 'guests', 'created_by_uid', 'created_by_uid TEXT')` and `created_by_username` next to the `app_source` one; read them in the guest row mapping (`creator` present iff `created_by_username` non-null, `uid` iff `created_by_uid` non-null); write them in the guests INSERT (`guest.creator?.uid ?? null`, `guest.creator?.username ?? null`).
- [ ] T004 [P] Write failing tests in `test/web/auth.test.ts`: `resolveAuthUser` sets `uid` from a non-empty `x-authentik-uid` header, omits it when the header is absent or empty, and dev/local identities have no `uid`.
- [ ] T005 Implement in `src/web/auth.ts`: add `uid?: string` to `AuthUser` (comment: stable Authentik user id from `X-authentik-uid`, used to match guest creators across username renames); set it in `resolveAuthUser`'s header branch only when the header is a non-empty string.
- [ ] T006 [P] Write failing tests in `test/web/impersonation.test.ts`: `resolveActor` copies `uid` from the real user (also while impersonating, where `req.realUser` carries it) and omits it when absent; local operator still yields `undefined`.
- [ ] T007 Implement: add `uid?: string` to `Actor` in `src/lib/pve-acl.ts`; make `resolveActor` in `src/web/impersonation.ts` include `uid` when the real user has one (keep `email` behavior unchanged). Run `npm run typecheck`.

**Checkpoint**: creator record persists; requests and actors carry `uid`.

---

## Phase 3: User Story 1 — A restricted user keeps access to the guest they create (P1) 🎯 MVP

**Goal**: web-created guests record their creator; the creator passes allow-list rules for that guest everywhere; explicit block wins; impersonation ignores it.

**Independent test**: quickstart "Restricted-user walk-through" and the route tests below.

### Tests (write first, must fail)

- [ ] T008 [P] [US1] Tests in `test/lib/permissions.test.ts` for new `isGuestCreator(creator, caller)`: impersonating → false; no creator → false; both uids → compares uid (same username different uid → false; different username same uid → true); either side lacks uid → compares username.
- [ ] T009 [P] [US1] Tests in `test/lib/permissions.test.ts` for `isAllowed(rules, groups, ref, { isCreator })` covering every row of the table in data-model.md "Access decision": allow-list unlisted + isCreator on a guest ref → allowed; same for a **host** ref → still denied; block-list listing the guest + isCreator → denied; two groups (allow-list unlisted + block-list listing it) + isCreator → denied; omitted opts behaves exactly as before.
- [ ] T010 [P] [US1] Tests in `test/web/access.test.ts`: `filterInventoryForUser` includes a guest whose `creator` matches the caller in an allow-list group listing only host `pve1`, excludes it for `other-user` in the same group, excludes it when the caller is impersonating; `isResourceAllowed` and `requireResourceAccess` allow the creator and 403 `other-user`; admin bypass unchanged.
- [ ] T011 [P] [US1] Tests in `test/web/routes/dashboard.test.ts`: `GET /api/inventory` and `GET /api/guests/status` include the created guest for `WEB_UI_DEV_USER=test-user` with `WEB_UI_DEV_GROUPS=app-users` (allow-list, host only) and not for `other-user`; `PATCH /api/inventory/guests/web-lxc` is allowed for the creator and 403 for `other-user`; a block-list group naming `web-lxc` added to the creator's groups → excluded/403.
- [ ] T012 [P] [US1] Tests in `test/web/routes/jobs.test.ts`: a job whose `target` is `web-lxc` (creator `test-user`) is listed, readable, cancellable/answerable for `test-user` under an allow-list group that doesn't list it, hidden for `other-user`; the `/ws/jobs/:id` upgrade accepts the creator and rejects `other-user`; with an active impersonation of `app-users` by an admin who is the creator, the job is hidden (HTTP and WS).
- [ ] T013 [P] [US1] Tests in `test/operations/provisioning.test.ts`: create-lxc, create-vm and install-app apply with `deps.actor = { username: 'test-user', uid: 'uid-test-user' }` save the new guest with that `creator`; with no `actor` (MCP/CLI) no `creator` is saved; `upsertGuestEntry` keeps an existing `creator` when the new entry has none and replaces it when the new entry has one.
- [ ] T014 [P] [US1] Tests in `test/commands/deploy-vpn-gateway.test.ts` and `test/operations/provisioning.test.ts`: `runDeployVpnGateway` with `creator` saves it on the gateway entry, without it saves none; the `deploy-vpn-gateway` operation passes `deps.actor` through.
- [ ] T015 [P] [US1] Tests (MCP + Dashboard, FR-009): `PATCH /api/inventory/guests/web-lxc` with body `{ creator: { username: 'other-user' } }` leaves the stored creator unchanged (`test/web/routes/dashboard.test.ts`); `runEditGuest({ name: 'web-lxc', creator: {...} })` likewise (`test/operations/edit-guest.test.ts` or the existing edit-guest test file).

### Implementation

- [ ] T016 [US1] In `src/lib/permissions.ts`: add `export interface CreatorCaller { username: string; uid?: string; impersonating?: string }` and `export function isGuestCreator(creator: GuestCreator | undefined, caller: CreatorCaller): boolean` per data-model.md; extend `isAllowed(rules, groups, ref, opts: { isCreator?: boolean } = {})` so an allow-list group counts a `guest` ref as listed when `opts.isCreator`; block-list unchanged. Update the function comments to describe the creator lift and "explicit block wins".
- [ ] T017 [US1] In `src/web/access.ts`: change `isResourceAllowed(inventoryPath, inventory, user, ref)`, `filterInventoryForUser(inventoryPath, user, inventory)`, and `requireResourceAccess(inventoryPath, inventory, resolveRef)` to take the caller (`AuthUser`-shaped: `groups`, `username`, `uid?`, `impersonating?`) and compute `isCreator` for guest refs from `inventory.guests.find(g => g.name === ref.name)?.creator`. Export a helper `guestCreators(inventory): Map<string, GuestCreator>` for job checks.
- [ ] T018 [US1] Update every call site to pass the caller and inventory: `src/web/routes/dashboard.ts` (lines using `filterInventoryForUser`, the guest PATCH `requireResourceAccess`), `src/web/routes/maintenance.ts`, `src/web/routes/networking.ts`, `src/web/routes/provisioning.ts` (host filter, `canSeeGuest`, op target check). Use `req.user` (the overlaid identity, so `impersonating` is set during impersonation).
- [ ] T019 [US1] In `src/web/routes/jobs.ts`: change `isJobVisible(rules, caller, target, creators)` so that when `target` names a guest whose creator matches the caller (`isGuestCreator`), allow-list groups treat it as listed (keep name-only rule matching and the block-list behavior); add `inventory: Inventory` to `jobsRoutes(...)` and `attachJobsWebSocket(...)` and build `creators` per request from it; in the WS handler build the caller as `impersonatedGroup ? { ...user, groups: [impersonatedGroup], impersonating: impersonatedGroup } : user`. Update `src/web/app.ts` and `src/web/server.ts` (and tests' app builders) for the new parameters.
- [ ] T020 [US1] In `src/operations/provisioning.ts`: `recordProvisionedGuest` callers for create-lxc, create-vm, install-app set `creator: creatorFromActor(deps.actor)` (helper returning `{ username, uid? }` or `undefined`); `upsertGuestEntry` merges `creator: entry.creator ?? existing.creator` with a comment in the style of the port/app fallbacks.
- [ ] T021 [US1] In `src/commands/provisioning/deploy-vpn-gateway.ts`: add `creator?: GuestCreator` to its options and include it on the saved gateway entry; pass `creatorFromActor(deps.actor)` from the `deploy-vpn-gateway` operation's `apply` in `src/operations/provisioning.ts`. The CLI passes nothing.
- [ ] T022 [US1] Confirm `applyGuestEdits`/`EDIT_GUEST_SHAPE` (`src/operations/edit-guest.ts`) ignore a `creator` key (T015 passes without code change; if not, strip it explicitly).
- [ ] T023 [US1] Run `npm run typecheck` and `npm test`; all green.

**Checkpoint**: US1 complete — restricted creators keep access, everywhere, with block precedence and impersonation fidelity.

---

## Phase 4: User Story 2 — Creator access survives renames, syncs, and migrations (P1)

**Goal**: prove (and fix if needed) persistence through routine operations and uid-based matching.

- [ ] T024 [P] [US2] Tests in `test/commands/sync-inventory.test.ts`: an existing guest's `creator` is preserved across `runSyncInventory --apply`; a newly discovered guest has none; a guest that disappears from Proxmox is dropped together with its creator.
- [ ] T025 [P] [US2] Tests in `test/commands/migrate-guest.test.ts`: after a successful migration the guest keeps its `creator`.
- [ ] T026 [P] [US2] Test in `test/web/routes/dashboard.test.ts`: guest `creator: { uid: 'uid-test-user', username: 'old-login' }` is visible to a request with headers `x-authentik-username: new-login`, `x-authentik-uid: uid-test-user`, `x-authentik-groups: app-users` (allow-list, host only); and a request with `x-authentik-username: old-login` but a different uid is denied.
- [ ] T027 [US2] Fix any failing preservation in `src/commands/maintenance/sync-inventory.ts` / `src/commands/provisioning/migrate-guest.ts` (expected: none needed — both spread the existing entry). Run tests.

**Checkpoint**: US2 complete.

---

## Phase 5: User Story 3 — Admins can see who created a guest (P2)

- [ ] T028 [P] [US3] Add a help entry for "Created by" in `web-client/src/lib/advanced-field-help.ts` (explains: the user who created this guest from Bellhop always keeps access to it, unless a block-list names it; blank for guests created elsewhere) and extend its pinning test if one asserts the label set.
- [ ] T029 [US3] In `web-client/src/components/AdvancedGuestModal.tsx` General tab: render a read-only "Created by" row showing `guest.creator.username` with `FieldHelp`, only when `guest.creator` is present; add `creator?: { uid?: string; username: string }` to the client guest type. Keep `data-label`/mobile conventions of neighbouring read-only rows. Update `web-client/src/lib/advanced-modal.ts` (`renderedAdvancedFields`) if it enumerates rows.
- [ ] T030 [US3] Give one demo guest a `creator` (example username) in `scripts/demo/demo-inventory.ts`; keep `test/scripts/demo/demo-inventory.test.ts` green.
- [ ] T031 [US3] `npm run web:build`; verify in a browser via `npm run demo` (127.0.0.1:3100) at desktop width and ≤640px that the row appears for the demo guest with a creator and not for others; kill the demo server by PID afterwards. Regenerate `docs/images/` with `npm run docs:screenshots` only if a screenshotted screen changed.

**Checkpoint**: US3 complete.

---

## Phase 6: User Story 4 — Back-fill existing guests (P2)

- [ ] T032 [US4] Capture a live `GET /api/v3/core/users/?page_size=500` response read-only, redact every identifying value to example values (usernames, names, emails, pks optional, uids → invented 64-hex), keep shape and array length, save as `test/fixtures/authentik/core-users.json`. Never commit real values.
- [ ] T033 [P] [US4] Test in `test/lib/authentik-client.test.ts` (stubbed fetch with the fixture): `listUsers()` maps `uid`. Then add `uid: string` to `AuthentikUser` and `RawUser` in `src/lib/authentik-client.ts` (`toUser` maps `raw.uid`), and to `FakeAuthentikClient`'s users in `test/support/` (update any fixture builders).
- [ ] T034 [P] [US4] Tests in `test/commands/backfill-guest-creators.test.ts` (temp inventory + temp `JobStore` + `FakeAuthentikClient`): matches create-lxc/install-app (`hostname`) and create-vm/deploy-vpn-gateway (`name`) by host + `resolveMid` VMID + name; newest successful job wins, older ones reported `superseded`; skips failed/cancelled/interrupted, `mcp`, null-user jobs silently; `unknown-user` without `--map`, resolved with `--map old-login=test-user`; malformed `--map` (no `=`, empty side) throws naming `--map`; `already-has-creator` never overwritten; `no-matching-guest` when VMID or name differs; `unparseable-args` on bad JSON/missing mid; dry run writes nothing; `--apply` saves `creator: { uid, username }` with the current username from Authentik.
- [ ] T035 [US4] Implement `src/commands/maintenance/backfill-guest-creators.ts`: `runBackfillGuestCreators({ maps, apply }, { inventory, inventoryPath, jobStore, authentik })` returning the report shape in data-model.md, plus `formatBackfillGuestCreators(report)` producing the output in `contracts/backfill-guest-creators.md`; apply = `refreshInventory` then one `saveInventory`. Add any read helper needed to `src/web/jobs/job-store.ts` (e.g. list by command) rather than raw SQL in the command.
- [ ] T036 [US4] Register `backfill-guest-creators` in `src/cli.ts` with repeatable `--map <old=new>` and `--apply`, opening `data/jobs.sqlite3` via the same `JobStore` path the web service uses and `buildAuthentikClient()`; unconfigured Authentik fails with the client's existing message.

**Checkpoint**: US4 complete.

---

## Phase 7: Polish & Cross-Cutting

- [ ] T037 [P] Write `docs/permissions.md` (group allow-list/block-list model, intersection, admin bypass, creator access and its limits — block wins, impersonation ignores it, only web-UI creations, uid matching — and the backfill command) and link it from the README documentation index; keep `test/docs/links.test.ts` green and README ≤ 200 lines.
- [ ] T038 [P] Add `backfill-guest-creators` to `docs/commands.md` (dry run, `--map`, skip reasons).
- [ ] T039 [P] Update `CLAUDE.md`: the per-resource permissions bullet (creator lift, block wins, impersonation, `isGuestCreator`), the inventory guest-field list (`creator`, `created_by_uid`/`created_by_username`), the auth bullet (`X-authentik-uid` → `AuthUser.uid`), and the backfill command. Check `CONTRIBUTING.md` needs no change.
- [ ] T040 Run `npm run typecheck`, `npm test`, `npm run web:build`; all pass. Review the full diff for real operational data (constitution workflow gate).
- [ ] T041 Live, read-only: from the deployment checkout run `bellhop backfill-guest-creators` (dry run, with the operator's private `--map` pairs) and record the summary counts (no names) for the PR. Do **not** `--apply` without the user.

---

## Dependencies & Execution Order

- Phase 2 blocks all stories (schema + identity).
- US1 (Phase 3) depends on Phase 2. US2 depends on Phase 2 and on US1's access changes for T026. US3 depends only on Phase 2. US4 depends on Phase 2.
- Polish after all stories.

### Parallel opportunities

- T004/T006 with T002.
- All US1 tests T008–T015 in parallel; then T016 → T017 → T018/T019 → T020/T021.
- US3 and US4 can proceed in parallel after Phase 2.
- T037–T039 in parallel.

## Implementation Strategy

MVP = Phase 2 + US1. Then US2 (verification), US3 (display), US4 (backfill), Polish. Commit per phase/story with `tasks.md` checkboxes updated in the same commit: `<what it delivers> (#58, USn)`.
