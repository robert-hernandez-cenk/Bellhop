# Tasks: Custom Script Repository — Only the Apps the Branch Changes

**Input**: Design documents from `specs/004-changed-apps-only/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/interfaces.md, quickstart.md

**Tests**: Required. Constitution Principle III: every behavior change ships with `node --test` coverage, and fixtures are the captured, redacted `test/fixtures/github/compare-ahead-3-apps.json` (8 ahead / 0 behind / 3 apps: `demo-shop`, `demo-shop-storefront`, `demo-books`) and `compare-diverged-conflict.json` (1 ahead / 251 behind / 1 app `demo-wiki`, absent upstream at the merge base, present on upstream main). Tests use example values only (`example-user/ProxmoxVED@my-apps`). Write each test first and watch it fail.

**Organization**: grouped by user story (spec.md). US1 and US2 are both P1; US2 builds on US1's resolution.

## Phase 1: Setup

- [ ] T001 Confirm the worktree builds before changes: run `npm run typecheck` and `npm test` from `C:\Users\rcher\Dev\Bellhop-Worktrees\issue-15-changed-apps-only` and record the baseline pass count

## Phase 2: Foundational (blocks all stories)

- [ ] T002 Write failing tests in `test/lib/app-source.test.ts` for `changedSlugsFromFiles` (research R3): the ahead fixture's `files` yields exactly `{demo-shop, demo-shop-storefront, demo-books}`; `json/*` alone never adds a slug; a `removed` `ct/x.sh` adds nothing; a `renamed` entry adds both `filename` and `previous_filename` slugs; an `install/<slug>-install.sh`-only change adds the slug
- [ ] T003 Write failing tests in `test/lib/app-source.test.ts` for `compareBranch` (contracts/interfaces.md): requests exactly `https://api.github.com/repos/community-scripts/ProxmoxVED/compare/main...example-user:ProxmoxVED:<sha>` with `User-Agent: bellhop`; returns `{ sha, mergeBase, aheadBy: 8, behindBy: 0, changedSlugs }` from the ahead fixture and `{ aheadBy: 1, behindBy: 251 }` from the diverged fixture; throws messages ending in `-- check customScriptsRepo/customScriptsBranch with "bellhop set-config"` for 404 ("not found in community-scripts/ProxmoxVED's fork network"), 403 and 429 ("rate limit"), 500 ("GitHub returned 500"), a thrown fetch ("could not reach GitHub"), a body missing `merge_base_commit` ("unexpected compare response"), and a response whose `files` array has 300 entries ("300 or more files")
- [ ] T004 Implement `changedSlugsFromFiles`, the `zod` compare-response schema and `compareBranch` in `src/lib/app-source.ts` (reuse `ERROR_SUFFIX`, `GITHUB_FETCH_TIMEOUT_MS`; read the body inside the timeout the way `resolveHeadSha` does) until T002–T003 pass

**Checkpoint**: the changed set can be computed from a pinned commit.

## Phase 3: User Story 1 — Only the apps I'm working on come from my branch (P1) 🎯 MVP

**Goal**: changed apps resolve to the fork; everything else resolves as feature-off; fork-only apps still install from the fork.

**Independent Test**: with the ahead fixture, `resolveAppSource('demo-shop')` → `kind: 'custom'`, `changed: true`; an app upstream has → `kind: 'upstream'` with no notice; feature off makes no fetch.

- [ ] T005 [US1] Rewrite the `resolveAppSource` tests in `test/lib/app-source.test.ts` for research R6: (a) changed slug → `kind: 'custom'`, `changed: true`, `ctUrl`/`scriptsBaseUrl` at the pinned sha, `custom.mergeBase` set, and no fork `ct/` probe is made; (b) unchanged slug present in ProxmoxVE or ProxmoxVED → `{ kind: 'upstream', slug, shadows: [] }` and no fork probe; (c) unchanged slug whose upstream probe throws (network error) → `kind: 'upstream'`; (d) unchanged slug absent upstream but fork `ct/` 200 → `kind: 'custom'`, `changed: false`, `conflict: false`, `shadows: []`; (e) unchanged, absent everywhere (fork 404) → `kind: 'upstream'`; (f) fork probe 500 → named error; (g) compare failure → named error, never upstream; (h) feature off and pasted URL still make no fetch (keep `throwingFetch`); (i) a changed slug that also exists upstream carries `shadows`
- [ ] T006 [US1] Update `resolveAppSource` in `src/lib/app-source.ts`: after `resolveHeadSha`, call `compareBranch`; branch per research R6; make the upstream probe distinguish present / absent / error (a new internal helper returning a tri-state, keeping `detectShadows`' `ShadowedRepo[]` for the changed path); extend `AppSource` with `changed?`, `conflict?` and `custom.mergeBase` exactly as in data-model.md (set `conflict: false` in this task; US2 fills it in)
- [ ] T007 [P] [US1] Update fixtures/expectations in `test/commands/install-app.test.ts` and `test/commands/update-app.test.ts` wherever a hand-built `AppSource` or the resolution fetch routes assumed a fork `ct/` hit meant custom (add the compare route to any stub that resolves with custom settings on)
- [ ] T008 [P] [US1] Update `test/operations/core.test.ts`, `test/operations/provisioning.test.ts`, `test/web/routes/provisioning.test.ts` and `test/mcp/build-server.test.ts` fetch stubs so custom-configured resolutions route the compare call (ahead fixture), and assert a changed slug still reaches `promptsForSource` with the pinned `scriptsBaseUrl` while an unchanged upstream slug uses `checkAppUrl`'s VE→VED path
- [ ] T009 [US1] Run `npm run typecheck` and `npm test`; fix until green

**Checkpoint**: MVP — the reported defect is fixed for every front end.

## Phase 4: User Story 2 — Be warned when upstream changed the same app (P1)

**Goal**: conflict warning (non-blocking), info line for a plain override, nothing for fork-only.

**Independent Test**: with the diverged fixture and raw stubs (404 at merge base, 200 on main for `demo-wiki`), `resolveAppSource('demo-wiki')` → `conflict: true`, and `runInstallApp` logs the rebase warning as its first line while still curling the fork.

- [ ] T010 [US2] Write failing tests in `test/lib/app-source.test.ts` for `detectConflict` (research R5): returns `false` with **no** fetch when `behindBy === 0`; with the diverged comparison, fetches `https://raw.githubusercontent.com/community-scripts/ProxmoxVED/<mergeBase>/ct/demo-wiki.sh`, `…/<mergeBase>/install/demo-wiki-install.sh`, `…/main/ct/demo-wiki.sh`, `…/main/install/demo-wiki-install.sh`; 404-vs-200 → `true`; identical bodies on both sides → `false`; 404 on both sides → `false`; differing bodies on only the install script → `true`; a thrown fetch → `false` and one `logWarn`, never a throw
- [ ] T011 [US2] Implement `detectConflict` in `src/lib/app-source.ts` and call it from `resolveAppSource` for changed slugs only; add a `resolveAppSource` test that the diverged fixture yields `conflict: true` for `demo-wiki`
- [ ] T012 [US2] Write failing tests in `test/lib/app-source.test.ts` for `formatSourceNotice` (research R7 wording): conflict → `{ level: 'warn' }` naming the slug, `ProxmoxVED`, the label, the short merge base and short sha, and telling the operator to rebase the branch onto upstream main; changed + shadows, no conflict → `{ level: 'info' }` naming the slug, label, short sha and the shadowed repos; changed without shadows, fork-only, upstream and url → `undefined`
- [ ] T013 [US2] Replace `formatOverrideWarning` with `formatSourceNotice` in `src/lib/app-source.ts`; update `src/commands/provisioning/install-app.ts` and `src/commands/maintenance/update-app.ts` to emit `logWarn` for `warn` and `logInfo` for `info` at the same spot (first output line); update the existing "R6 override warning" tests in `test/commands/install-app.test.ts` and `test/commands/update-app.test.ts` to the new notices and add a conflict case asserting the install script still curls the fork `ctUrl`
- [ ] T014 [P] [US2] Add `conflict: true` to a conflicting custom resolution in `checkAppUrl` in `src/operations/app-check.ts` (absent otherwise); cover it in `test/operations/core.test.ts` or the existing check-app tests, and update the `check_install_app` description in `src/mcp/build-server.ts` to say only apps the branch changes resolve to the fork and that `conflict: true` means upstream also changed the app
- [ ] T015 [P] [US2] Web: add `conflict?: boolean` to the check response type in `web-client/src/api/types.ts`; in `web-client/src/components/AppCheckInput.tsx` render a `custom-override-warning` line when `conflict` is true ("Upstream ProxmoxVED also changed this app since your branch point — rebase {branch} onto upstream main. Installing your custom copy.") and keep the existing overrides line only for the non-conflicting case
- [ ] T016 [US2] Run `npm run typecheck`, `npm test`, `npm run web:build`; fix until green

## Phase 5: User Story 3 — The catalog shows only what I'm working on (P2)

**Goal**: custom group = changed slugs, with `shadows` and `conflicts`.

**Independent Test**: with the ahead fixture, `getScriptCatalog(..., inventory)` returns `custom.slugs` of length 3 and every other slug stays in `stable`/`dev`.

- [ ] T017 [US3] Rewrite the custom-group tests in `test/lib/script-catalog.test.ts`: route head-sha + compare (ahead fixture) → `custom.slugs` equals the 3 changed slugs sorted, `conflicts: []`, no fork `contents/ct` listing fetched; diverged fixture + raw stubs → `conflicts: ['demo-wiki']`; a compare failure omits the group, logs a warning and starts the cooldown; cache/TTL/label-keyed behavior unchanged; a changed slug present upstream is removed from `stable`/`dev` and listed in `shadows`
- [ ] T018 [US3] Update `getCustomGroup`/`withCustomGroup` in `src/lib/script-catalog.ts` to use `resolveHeadSha` + `compareBranch` + `detectConflict` and add `conflicts: string[]` to `ScriptCatalog.custom`; remove the now-unused fork `ct/` listing call if nothing else uses it; update the `list_install_apps` description in `src/mcp/build-server.ts` if it describes the custom group
- [ ] T019 [US3] Web: add `conflicts: string[]` to `Catalog.custom` in `web-client/src/components/AppCheckInput.tsx`; render a `conflicts upstream` tag next to a conflicting option (new `app-suggestion-conflict-tag` class in `web-client/src/index.css`, styled like `app-suggestion-override-tag` with a warning color that has a `:root[data-theme='dark']` override); tolerate a response without `conflicts`
- [ ] T020 [US3] Run `npm run typecheck`, `npm test`, `npm run web:build`; fix until green

## Phase 6: Polish & Cross-Cutting

- [ ] T021 Update `README.md` (custom script repository section: only changed apps come from the fork, fork-only fallback, conflict warning, catalog group, named compare errors, 300-file limit, rate-limit note) and `CLAUDE.md` (`install-app`/`update-app` bullet: `resolveAppSource` rules, `compareBranch`/`detectConflict`, `formatSourceNotice` replacing `formatOverrideWarning`, catalog custom group now the changed set) — record the single-operator assumption that the upstream base is `community-scripts/ProxmoxVED@main`
- [ ] T022 Check `CONTRIBUTING.md` for anything restating the custom-repo behavior and update it if so
- [ ] T023 Browser verification of the App field at desktop width and ≤640px: conflict tag in the popup and conflict warning line render legibly in light and dark themes (use a stubbed catalog/check response or the local dev server with the operator's real settings)
- [ ] T024 Live read-only verification per `quickstart.md`: CLI dry run of `install-app` for one changed app and one unchanged upstream app against the operator's real configured branch (no `--apply`); record results in the PR description with example values only
- [ ] T025 Review the full diff for real operational data (constitution Principle I) before opening the PR

## Dependencies & Execution Order

- Phase 2 (T002–T004) blocks everything.
- US1 (T005–T009) before US2 (T010–T016): US2 extends the resolution US1 builds.
- US3 (T017–T020) depends on Phase 2 and on T011 (`detectConflict`); it can run in parallel with T012–T016.
- Polish after all stories.

## Parallel Opportunities

- T007 and T008 (different test files).
- T014 and T015 (server vs. web client).
- T017–T019 alongside T012–T016 once T011 lands.

## Implementation Strategy

MVP is US1: after T009 the defect in issue #15 is fixed everywhere (wrong source for unchanged apps). US2 restores a warning only where it is real; US3 cleans up the catalog. Commit after each phase checkpoint and push.
