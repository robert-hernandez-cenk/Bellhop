---
description: "Task list for the ProxmoxVED to DevScripts rename"
---

# Tasks: Follow community-scripts' rename of ProxmoxVED to DevScripts

**Input**: Design documents from `specs/101-devscripts-rename/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/interfaces.md, quickstart.md

**Tests**: TDD. Retarget the tests to the new name first, watch them fail, then rename the code.

**Example values** (Principle I): custom fork `example-user/DevScripts` (also `example-owner/DevScripts`, `example/DevScripts` where tests already use those owners), branch `my-apps`.

## Phase 1: Setup

None. The worktree, dependencies and baseline (3212 pass, 0 fail) are already in place.

## Phase 2: Foundational

None.

## Phase 3: User Story 1 - Development-repo apps resolve from the renamed repository (Priority: P1) 🎯 MVP

**Goal**: every upstream development-repo request addresses `community-scripts/DevScripts` (FR-001, FR-002, FR-003).

**Independent Test**: `npm test` with fetch stubs keyed only by `DevScripts` URLs passes. Before the code change, the same tests fail.

- [ ] T001 [US1] Replace `ProxmoxVED` with `DevScripts` across `test/**/*.ts` (URLs, `CUSTOM_REPO`, example forks, expected messages, `shadows` assertions, fake-fetch repo keys), and fix the one regex alternation `community-scripts\/ProxmoxVED?\/ct` in `test/lib/script-catalog.test.ts` to `community-scripts\/(ProxmoxVE|DevScripts)\/ct`
- [ ] T002 [US1] Replace `ProxmoxVED` with `DevScripts` in the URL fields of `test/fixtures/github/compare-ahead-3-apps.json` and `test/fixtures/github/compare-diverged-conflict.json` (research R4)
- [ ] T003 [US1] Run `npm test` and confirm the retargeted tests fail against the unchanged code (the RED step)
- [ ] T004 [US1] In `src/lib/app-source.ts`: set `UPSTREAM_DEV_BASE` to `https://raw.githubusercontent.com/community-scripts/DevScripts/main` and `COMPARE_UPSTREAM` to `community-scripts/DevScripts`, change `ShadowedRepo` to `'ProxmoxVE' | 'DevScripts'`, and rename the probe/shadow name, the conflict message and the fork-network error ("a fork of DevScripts?") and all comments, per contracts/interfaces.md
- [ ] T005 [P] [US1] In `src/lib/script-catalog.ts`: `DEV_REPO = 'DevScripts'`, the `shadowedBy` name, and the comments
- [ ] T006 [P] [US1] In `scripts/demo/demo-fetch.ts`: `DEV_REPO = 'DevScripts'`
- [ ] T007 [US1] `npm run typecheck` and `npm test` pass (GREEN)

**Checkpoint**: US1 is complete. Commit `Point upstream dev-repo requests at DevScripts (#101, US1)`.

## Phase 4: User Story 2 - Every surface names the repository DevScripts (Priority: P2)

**Goal**: no operator-facing string or doc names `ProxmoxVED` (FR-004, FR-005, FR-006).

**Independent Test**: `git grep -n ProxmoxVED -- ':!specs/003-*' ':!specs/004-*' ':!specs/101-*'` prints nothing, and the demo's Install App suggestion list shows "DevScripts (development)".

- [ ] T008 [P] [US2] `web-client/src/components/AppCheckInput.tsx`: group header `DevScripts (development)`, the conflict notice ("Upstream DevScripts also changed…"), the dev-only notice ("community-scripts' DevScripts repo"), and the comments
- [ ] T009 [P] [US2] `web-client/src/pages/SettingsPage.tsx` help ("laid out like DevScripts") and `web-client/src/api/types.ts` comments
- [ ] T010 [P] [US2] `src/mcp/build-server.ts` catalog tool description. Update the comments in `src/lib/inventory.ts` and `src/commands/provisioning/install-app.ts`
- [ ] T011 [P] [US2] Docs: `docs/commands.md`, `docs/configuration.md` (the repository link becomes `https://github.com/community-scripts/DevScripts`, the example `example-user/DevScripts`), `docs/web-ui.md` (image alt text), and `src/commands/provisioning/CLAUDE.md`
- [ ] T012 [US2] `npm run docs:screenshots` regenerates `docs/images/` (only `install-app-catalog.png` should change). Check by eye: the label reads "DevScripts (development)" and every value is example-only
- [ ] T013 [US2] `npm run typecheck`, `npm test` and the quickstart grep pass

**Checkpoint**: commit `Name the dev repo DevScripts on every surface (#101, US2)`.

## Phase 5: Polish & Verification

- [ ] T014 Quickstart step 3, live and read-only: real-network `checkAppUrl` for a dev-only slug and `fetchCatalog` resolve against `community-scripts/DevScripts`
- [ ] T015 Quickstart step 4: in the demo, the Install App suggestion list shows the DevScripts group at desktop width and at ≤640px

## Dependencies

- T001–T003 come before T004–T006. T007 gates US1.
- US2 (T008–T013) comes after US1 because the screenshot needs the renamed demo fetch. T008–T011 can run in parallel.
- Phase 5 comes after both stories.

## Implementation Strategy

US1 alone removes the dependency on GitHub's redirect (the MVP). US2 finishes the user-facing rename in the same PR.
