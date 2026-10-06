# Tasks: Audience-Named Default Group Ladder

**Input**: Design documents from `specs/097-audience-group-ladder/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/configuration.md, quickstart.md

**Tests**: Required (constitution Principle III: every behavior change ships with tests). TDD: write each test, see it fail, then implement.

Name mapping used throughout (old → new):

| Old | New |
|---|---|
| `bellhop-users` | `bellhop-admin-family` |
| `bellhop-app-users` | `bellhop-friends-family` |
| `bellhop-app-users-open` | `bellhop-public` |
| — | `bellhop-public-readonly` (new bottom rung) |

## Phase 1: Setup

- [x] T001 Confirm baseline: `npm run typecheck` and `npm test` pass in the worktree before any change (recorded at worktree creation: 3133 pass, 0 fail, 2 skipped).

## Phase 2: Foundational

None — the stories share only `src/lib/authentik-config.ts`, which US1 changes first.

## Phase 3: User Story 1 — New operator gets audience-named tiers (P1) 🎯 MVP

**Goal**: With no ladder configured, the ladder is `bellhop-public-readonly,bellhop-public,bellhop-friends-family,bellhop-admin-family,authentik Admins` everywhere (CLI, web UI, MCP).

**Independent Test**: `parseGroupLadder(undefined)` and `authentikConfig().groupLadder` return the five rungs in order; the auth-groups route lists them.

- [x] T002 [US1] In `test/lib/authentik-config.test.ts`, change both default-ladder assertions (the list near line 71 and the `deepEqual` near line 152) to the five new rungs in order; add an assertion that `rungsAtOrAbove(default, 'bellhop-public')` is `['bellhop-public','bellhop-friends-family','bellhop-admin-family','authentik Admins']` (excludes `bellhop-public-readonly`). Run and confirm failure.
- [x] T003 [US1] In `src/lib/authentik-config.ts`, set `DEFAULT_GROUP_LADDER` to the new value and extend the comment above it with one line per tier naming its audience (public-readonly: most constrained; public: public users of an external site, self-created accounts acceptable; friends-family: friends and family to share more with, e.g. external websites; admin-family: household members such as a spouse, close to admin). Confirm T002 passes.
- [x] T004 [P] [US1] Replace old names with new ones (per the mapping table) in every test file that uses them: `test/commands/adopt-oidc-client.test.ts`, `test/commands/configure-web-login.test.ts`, `test/commands/import-yaml-inventory.test.ts`, `test/commands/oidc-credentials.test.ts`, `test/commands/sync-proxy.test.ts`, `test/lib/inventory.test.ts`, `test/lib/proxy/caddy-json.test.ts`, `test/lib/proxy/drivers/caddy-api.test.ts`, `test/lib/proxy/drivers/caddy.test.ts`, `test/lib/proxy/drivers/haproxy.test.ts`, `test/lib/proxy/drivers/nginx-proxy-manager.test.ts`, `test/lib/proxy/drivers/nginx.test.ts`, `test/lib/proxy/file-driver.test.ts`, `test/lib/proxy/nginx-locations.test.ts`, `test/lib/proxy/routes.test.ts`, `test/mcp/build-server.test.ts`, `test/operations/edit-guest.test.ts`, `test/web-client/access-fields.test.ts`, `test/web-client/advanced-modal-help.test.ts`, `test/web/proxy-sync.test.ts`, `test/web/routes/auth-groups.test.ts`, `test/web/routes/dashboard.test.ts`, `test/web/routes/oidc.test.ts`, `test/web/routes/provisioning.test.ts`. Substitute longest-first (`bellhop-app-users-open` before `bellhop-app-users`) so names don't half-rewrite; also check the YAML fixture `inventory/hosts.yaml.example` and any test fixture files the import test reads. Where a test depends on rung position (e.g. dashboard raise/lower tier tests, auth-groups rung count), update expected positions/counts for the five-rung ladder.
- [x] T005 [P] [US1] Update `scripts/demo/demo-inventory.ts` example tiers to the new names; run `test/scripts/demo/demo-inventory.test.ts`.
- [x] T006 [US1] Run `npm run typecheck` and `npm test`; all pass.

**Checkpoint**: Default ladder renamed; fresh deployments see five audience-named tiers.

## Phase 4: User Story 2 — Unpinned operator's stored tiers carried over (P1)

**Goal**: On open, stored `auth_group` values on old default names are renamed to successors when the effective ladder lacks the old name and contains the new one (data-model.md "Rename pairs").

**Independent Test**: A fixture DB with old-named rows, no ladder configured, reads new names after `loadInventory`, logs once, and is silent on reopen.

- [x] T007 [US2] In `test/lib/inventory.test.ts`, add tests (build the fixture with `saveInventory` using old names under a pinned-old env, or raw SQL `UPDATE` after save; clear `AUTHENTIK_GROUP_LADDER` in the test and restore it after): (a) no ladder configured → a host at `bellhop-users`, a guest at `bellhop-app-users`, an external site at `bellhop-app-users-open` load as `bellhop-admin-family`, `bellhop-friends-family`, `bellhop-public`; (b) reopening changes nothing and logs nothing; (c) `authentik Admins`, `NULL` and a custom name (`media-viewers`) are unchanged; (d) the log line matches `Renamed 1 row(s) in 'guests' from auth_group='bellhop-app-users' to 'bellhop-friends-family' (#97, previous default ladder name).` (capture via the existing logInfo capture pattern in that file, if any; otherwise assert on DB state only). Confirm failure.
- [x] T008 [US2] In `src/lib/authentik-config.ts`, export `PREVIOUS_DEFAULT_RUNG_RENAMES: ReadonlyArray<readonly [string, string]>` = `[['bellhop-users','bellhop-admin-family'],['bellhop-app-users','bellhop-friends-family'],['bellhop-app-users-open','bellhop-public']]`, with a comment pointing at the #97 migration.
- [x] T009 [US2] In `src/lib/inventory.ts`, add `migrateDefaultLadderRenames(db)` after the #158 loop at the end of `openInventoryDb`: guard query across `hosts`, `guests`, `external_sites` for any `auth_group IN (old names)` (return if none); resolve the ladder off the handle exactly as `migrateRequiresAuthToAuthGroup` does (`meta.authentikGroupLadder` row → `effectiveValue(..., process.env)` → `parseGroupLadder`); in one `tx.immediate()` transaction, for each pair with `!ladder.includes(old) && ladder.includes(new)`, `UPDATE <table> SET auth_group = ? WHERE auth_group = ?` per table and `logInfo` the contract line when `changes > 0`. Comment in the style of the neighboring migrations (why per-pair condition, why no marker row — research.md R3/R4). Confirm T007 passes.

**Checkpoint**: Unpinned deployments keep every app on its tier across the upgrade.

## Phase 5: User Story 3 — Pinned ladder left alone (P1)

**Goal**: A pinned ladder is honored; renames apply per pair only where the condition holds.

**Independent Test**: With `AUTHENTIK_GROUP_LADDER` set to the old default, old-named rows are unchanged.

- [x] T010 [US3] In `test/lib/inventory.test.ts`, add tests: (a) env `AUTHENTIK_GROUP_LADDER=bellhop-app-users-open,bellhop-app-users,bellhop-users,authentik Admins` → no rows change; (b) stored `authentikGroupLadder` setting with the old value and no env → no rows change; (c) env set to the new names explicitly → rows renamed; (d) env `bellhop-app-users-open,bellhop-friends-family,bellhop-admin-family,authentik Admins` → `bellhop-app-users` and `bellhop-users` renamed, `bellhop-app-users-open` unchanged; (e) a fully custom ladder (`a,b,authentik Admins`) → nothing renamed. Run; these should pass against T009 — if any fails, fix T009.

**Checkpoint**: All three stories pass independently.

## Phase 6: Polish & Cross-Cutting

- [x] T011 [P] `web-client/src/pages/SettingsPage.tsx`: update the `authentikGroupLadder` placeholder and help "Unset:" value to the new default.
- [x] T012 [P] `docs/configuration.md`: update the `authentikGroupLadder` default in the settings table.
- [x] T013 [P] `docs/environment-variables.md` "Group ladder upgrades": state the new default; add a short tier-audience table; replace the upgrade paragraph with the #97 behavior (stored tiers on the previous `bellhop-*` defaults are renamed automatically on open unless the ladder is pinned; operator renames/creates the groups in Authentik; to keep old names, pin the old ladder); keep the older `homelab-*` note brief.
- [x] T014 [P] `docs/authentik.md`: add a short "Access tiers" note pointing to the tier-audience table, mentioning self-enrollment into `bellhop-public` is not set up by Bellhop.
- [x] T015 [P] `src/commands/networking/CLAUDE.md`: update the default ladder statement and mention the #97 rename-on-open migration in `src/lib/CLAUDE.md` where inventory migrations are described (if such a list exists).
- [x] T016 Run `npm run typecheck` and `npm test` (includes `test/docs/links.test.ts`); all pass. `grep -rn "bellhop-app-users\|bellhop-users" src web-client/src docs scripts test` returns only the migration's rename pairs, migration tests, and the upgrade notes.
- [ ] T017 Quickstart §2–§3 run by hand; §4 in the demo at desktop and ≤640px viewports (Settings Authentik tab, Advanced modal tier dropdown). Regenerate `docs/images/` only if a screenshotted screen shows the ladder names.

## Dependencies & Execution Order

- T001 → US1 (T002–T006) → US2 (T007–T009) → US3 (T010) → Polish (T011–T017).
- US2 depends on US1 (the migration's default-ladder case needs the new default). US3 depends on US2's implementation.
- [P] tasks within a phase touch different files.

## Parallel Example

```text
After T003: T004 and T005 in parallel.
Polish: T011, T012, T013, T014, T015 in parallel.
```

## Implementation Strategy

MVP = US1 (default rename). US2 + US3 make the upgrade lossless; ship all three together in one PR.
