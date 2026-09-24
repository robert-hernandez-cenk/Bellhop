# Tasks: Custom Script Repository as a First-Class App Source

**Input**: Design documents from `specs/003-custom-script-repo/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/interfaces.md, quickstart.md

**Tests**: Required. Constitution Principle III says every behavior change ships with tests in the same change. Write each story's tests first and confirm they fail before implementing.

**Example values** (Principle I): repo `example-user/ProxmoxVED`, branch `my-apps`, slug `myapp`, host `pve1`, SHA taken from `test/fixtures/github/branch-head-sha.txt`.

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Setup

- [x] T001 Confirm the worktree baseline is green: run `npm run typecheck`, `npm test`, and `npm run web:build` from the worktree root and record any pre-existing failures before changing code (none expected)

---

## Phase 2: Foundational (blocks all user stories)

- [x] T002 Add `customScriptsRepo` and `customScriptsBranch` to `SettingsSchema` in `src/lib/inventory.ts`. `customScriptsRepo`: `z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/, 'must be owner/repo').optional()`. `customScriptsBranch`: a string matching `^[A-Za-z0-9._/-]+$` that also rejects `..`, a leading `/` or `-`, and a trailing `/` or `.lock` (a `.refine` with the message `'must be a valid git branch name'`), `.optional()`. Update the #124 settings comment to mention the new pair and the both-or-neither rule enforced at use.
- [x] T003 [P] Add tests in `test/commands/set-config.test.ts`: both keys round-trip through `set-config --apply` and `--unset`; `customScriptsRepo not-a-repo` and `customScriptsBranch ../x` are rejected with the schema messages; setting only one key succeeds (the pair rule is enforced at use, not at save)
- [x] T004 Create `src/lib/app-source.ts` with types `CustomScriptSource` and `AppSource` exactly as in `data-model.md`, plus `customScriptSource(inv)`: returns `undefined` when both settings are unset, throws `customScriptsRepo and customScriptsBranch must be set together; set the missing one with "bellhop set-config <key> <value> --apply" or on the Settings page` when exactly one is set, and otherwise returns `{ owner, repo, branch, label: '<owner>/<repo>@<branch>' }`
- [x] T005 In `src/lib/app-source.ts` add `resolveHeadSha(source, fetchImpl)`: `GET https://api.github.com/repos/<owner>/<repo>/commits/<encodeURIComponent(branch)>` with headers `User-Agent: bellhop` and `Accept: application/vnd.github.sha`, a 5s AbortController timeout, the body trimmed and required to match `/^[0-9a-f]{40}$/`. Every failure throws an error that starts `Custom script repository <label>:` and ends `-- check customScriptsRepo/customScriptsBranch with "bellhop set-config"`: 404 → `repository not found or not public`; 422 → `branch not found`; other status → `GitHub returned <status>`; thrown or timeout → `could not reach GitHub (<message>)`; bad body → `unexpected response`
- [x] T006 In `src/lib/app-source.ts` add `resolveAppSource(app, inv, fetchImpl)` per data-model.md and research R5/R6. `app` containing `://` returns `{ kind: 'url', shadows: [] }` without network access. A bare slug is lowercased. With no custom source it returns `{ kind: 'upstream', slug, shadows: [] }` without network access. Otherwise it pins the SHA and GETs `https://raw.githubusercontent.com/<owner>/<repo>/<sha>/ct/<slug>.sh`. A 404 returns `upstream`. Any other non-OK status or a thrown error throws with the T005 prefix and suffix. On 200 it probes the ProxmoxVE and ProxmoxVED `main` `ct/<slug>.sh` URLs (a failed probe counts as absent and is logged with `logWarn`) and returns `{ kind: 'custom', slug, custom: {...source, sha}, ctUrl, scriptsBaseUrl: 'https://raw.githubusercontent.com/<owner>/<repo>/<sha>', shadows }`. Also add `formatOverrideWarning(source)`, which returns the exact research R6 text (short SHA = first 7 characters) when `shadows` is non-empty and `undefined` otherwise. Move the ProxmoxVE/ProxmoxVED base URL constants from `install-app.ts` into this module and re-import them there.
- [x] T007 [P] Create `test/lib/app-source.test.ts` with a fetch stub keyed by URL that replays `test/fixtures/github/branch-head-sha.txt`, `branch-head-missing-branch-422.json` (status 422), and `branch-head-missing-repo-404.json` (status 404). Cover: feature off makes no fetch calls; half-config throws the T004 message; URL passthrough; custom hit with no shadows; custom hit shadowing ProxmoxVE only, ProxmoxVED only, and both; custom 404 → upstream; 422 and 404 head lookups throw messages containing `branch not found` and `repository not found`; a thrown fetch throws `could not reach GitHub`; a 500 on the custom ct fetch throws; mixed-case slug lowercased; a branch containing `/` is URL-encoded in the API call; `formatOverrideWarning` text

**Checkpoint**: the resolver is complete and tested; nothing calls it yet.

---

## Phase 3: User Story 1 — Install a fork-only app (P1) 🎯 MVP

**Goal**: A bare slug found only in the custom branch installs from that branch's pinned commit, including its install script.

**Independent Test**: With settings on and a stubbed custom-only slug, the install preview script exports `COMMUNITY_SCRIPTS_URL` at the pinned commit and curls the pinned `ct/` URL. Apply sends the identical script.

- [x] T008 [P] [US1] Tests in `test/commands/install-app.test.ts`. First, a byte-identity test: with the feature off, `buildInstallAppScript(..., { kind: 'upstream', slug: 'plex', shadows: [] })` output equals the current output for the same inputs (capture the expected string from the pre-change function in the test). Second, with a `custom` source, the script contains `export COMMUNITY_SCRIPTS_URL='https://raw.githubusercontent.com/example-user/ProxmoxVED/<sha>'` immediately before the final line `bash -c "$(curl -fsSL 'https://raw.githubusercontent.com/example-user/ProxmoxVED/<sha>/ct/myapp.sh')"` and has no `||` fallback. Third, `runInstallApp` with settings on and a fetch stub: dry run and `apply: true` produce the same `script`; the `FakeSSHClient` history's install exec equals that script; a resolution failure throws before any `pct`/install exec is recorded; a passed-in `opts.source` is used without any fetch call
- [x] T009 [US1] In `src/commands/provisioning/install-app.ts`: add `source?: AppSource` and `fetchImpl?: typeof fetch` to `InstallAppOptions`. Change `buildInstallAppScript(opts, mid, storage, hostKeys, source)` so a non-`custom` source keeps today's exact lines, while a `custom` source adds `export COMMUNITY_SCRIPTS_URL=${shellQuote(source.scriptsBaseUrl)}` before `bash -c "$(curl -fsSL ${shellQuote(source.ctUrl)})"` with no fallback. In `runInstallApp`, resolve `opts.source ?? await resolveAppSource(opts.app, deps.inventory, opts.fetchImpl ?? fetch)` right after the existing argument validation and before `resolveMid`/`checkVmidAvailable`, and `logWarn(formatOverrideWarning(source))` when defined. Return `source` in the result object. Add a comment citing research R1 for why the export exists. Keep `resolveAppUrl`/`resolveDevAppUrl`/`resolveInstallScriptUrl`/`appSlugFor` exported, since other callers use them.
- [x] T010 [P] [US1] Tests in `test/operations/core.test.ts` (create it if absent, following existing `test/operations/*` patterns): `previewAndEnqueue` for `install-app` with settings on calls the head-SHA endpoint exactly once. The job's `apply` receives `input.appSource` with the same SHA even when the stub's head changes after enqueue. A caller-supplied `appSource` in the raw body is overwritten. `expectedPrompts` come from the custom `install/myapp-install.sh` at the pinned SHA.
- [x] T011 [US1] Add `resolvesApp?: boolean` to `Operation` in `src/operations/types.ts`, with a comment. In `src/operations/core.ts` `previewAndEnqueue`: when `op.resolvesApp`, set `input.appSource = await resolveAppSource(input.app, deps.inventory, deps.fetchImpl ?? fetch)` right after parsing and before `op.preview`, and compute `expectedPrompts` from that source via the app-check helper from T012 instead of calling `checkAppUrl(input.app, …)` again. Leave `enqueueWithoutPreview` unchanged.
- [x] T012 [US1] In `src/operations/app-check.ts`: make `checkAppUrl(app, fetchImpl, inventory?, preResolved?)` resolve through `resolveAppSource` when an inventory is given. For a `custom` source, fetch the body from `ctUrl`, get prompts from `<scriptsBaseUrl>/install/<slug>-install.sh`, and return `custom: { label, sha }` plus `shadows` when non-empty. For `upstream`/`url` keep today's VE→VED logic unchanged. A resolver throw becomes `{ exists: false, url: '', error: <message> }`. Export a small `promptsForSource(source, fetchImpl)` used by T011. Update the header comment of `resolveInstallScriptUrl`'s caller accordingly.
- [x] T013 [US1] In `src/operations/provisioning.ts` install-app: set `resolvesApp: true`; pass `source: i.appSource, fetchImpl: deps.fetchImpl` into both `runInstallApp` calls (preview and apply). Update the operation's `description` to mention the optional custom repository.
- [x] T014 [US1] Pass the inventory to `checkAppUrl` in `src/web/routes/provisioning.ts` (`/install-app/check-app`) and `src/mcp/build-server.ts` (`check_install_app`), and update the MCP tool description to mention the custom repository and `shadows`
- [x] T015 [P] [US1] Route and MCP tests: extend the existing check-app route test file under `test/web/routes/` and the MCP test under `test/mcp/` so that, with settings on and a fetch stub, the check response includes `custom.sha`, and with a half-config the response carries `error` and `exists: false`

**Checkpoint**: MVP. A fork-only app installs from all three front ends with the fork's install script.

---

## Phase 4: User Story 2 — Loud override warning (P1)

**Goal**: Overriding an upstream copy is announced in every front end.

**Independent Test**: A slug in both the custom branch and ProxmoxVE yields `shadows: ['ProxmoxVE']` in check results, and the preview text and job log start with the warning.

- [x] T016 [P] [US2] Tests: in `test/commands/install-app.test.ts`, the captured console output of a dry run with an overriding source starts with the R6 warning. In `test/operations/provisioning.test.ts`, `install-app` `preview()` text starts with the warning. In the check-app route test, `shadows` equals `['ProxmoxVE']` for a slug present upstream.
- [x] T017 [US2] In `web-client/src/api/types.ts`, add `custom?: { label: string; sha: string }`, `shadows?: string[]`, and `error?: string` to the check response type. In `web-client/src/components/AppCheckInput.tsx`, store them from `runCheck`. After an OK check with `custom`, show an `app-custom-notice` naming `label` and the 7-character SHA. When `shadows` is non-empty, show a warning banner (reuse the `dev-app-warning` styling pattern with a new `custom-override-warning` class): `This installs your custom copy from <label>, overriding the upstream copy in <shadows joined>.` When `error` is set, show it under the field and leave the status `missing`. Clear all three on edit, just like `devWarning`.
- [x] T018 [US2] Add CSS for `.app-custom-notice` and `.custom-override-warning` in `web-client/src/index.css`, using existing theme variables so `:root[data-theme='dark']` works, and wrapping cleanly at ≤640px

**Checkpoint**: US1 and US2 both work.

---

## Phase 5: User Story 3 — Configure, change, turn off (P2)

**Goal**: The settings are editable from CLI, web and MCP with identical validation.

**Independent Test**: `PATCH /api/settings` accepts/rejects the same values as `set-config`, and the Settings page shows both fields.

- [x] T019 [P] [US3] Tests in the settings route test under `test/web/routes/`: `GET` includes both keys; `PATCH` with `not-a-repo` returns 400 with the same message `set-config` produces; `''` clears the key
- [x] T020 [US3] Add the two fields to `web-client/src/pages/SettingsPage.tsx`'s key list, with labels `Custom script repository` (placeholder `owner/repo`) and `Custom script branch` (placeholder `branch`) and help text saying both must be set together and that apps there override upstream copies of the same slug. Confirm `src/web/routes/settings.ts` needs no change beyond what `SETTINGS_KEYS` already drives (edit only if it hardcodes keys).

---

## Phase 6: User Story 4 — Catalog group (P2)

**Goal**: The custom branch's apps are listed first in suggestions, override tags are shown, and new apps appear within 5 minutes.

**Independent Test**: `getScriptCatalog` with settings on returns a `custom` group, strips its slugs from `stable`/`dev`, and refetches only after 5 minutes.

- [x] T021 [P] [US4] Tests in `test/lib/script-catalog.test.ts`, using a stub that replays `test/fixtures/github/contents-ct-listing.json` for the custom repo's `contents/ct?ref=my-apps` URL: the `custom` group's `label`/`slugs` come from the fixture's `.sh` files (directories dropped); a slug also in `stable` is removed from `stable` and `shadows[slug]` is `['ProxmoxVE']`; no second custom fetch before 5 minutes (inject `now`) and one after; changing the branch setting triggers a fetch under the new key; a custom listing failure returns upstream groups unchanged, omits `custom`, and logs a warning; half-config omits `custom` without throwing; feature off makes no custom fetch. Call `resetCatalogFetchState()` between tests.
- [x] T022 [US4] In `src/lib/script-catalog.ts`: add `CUSTOM_CATALOG_MAX_AGE_MS = 5 * 60 * 1000` and a module-scope `Map<label, { slugs: string[]; fetchedAt: number }>` plus a custom failure timestamp, both cleared by `resetCatalogFetchState()`. Generalise `fetchRepoSlugs` to take `{ owner, repo, ref? }` without changing upstream behavior. Change `getScriptCatalog(dbPath, fetchImpl, now, inventory?)` so the unchanged upstream result is post-processed with the custom group (data-model.md "Catalog response"). Wrap half-config (`customScriptSource` throwing) and listing failures in `logWarn`. It must never throw. Add `custom?` to `ScriptCatalog`.
- [x] T023 [US4] Pass the inventory to `getScriptCatalog` in `src/web/routes/provisioning.ts` (`/install-app/apps`) and `src/mcp/build-server.ts` (`list_install_apps`), and update that tool's description
- [x] T024 [US4] In `web-client/src/components/AppCheckInput.tsx`, extend the `Catalog` type with `custom?` and render its group first with the header `<label> (custom)` (class `app-suggestions-group app-suggestions-group-custom`). Each overriding slug gets a small `overrides ProxmoxVE`/`ProxmoxVED` tag inside its option. Apply the same `MAX_ROWS_PER_GROUP` cap, `rankMatches`, and flat keyboard indexing (custom rows come first in `flatMatches`). Add the CSS for the group header and tag to `web-client/src/index.css`.

---

## Phase 7: User Story 5 — Provenance, link, update (P3)

**Goal**: Custom-installed guests are marked and linked, and `update-app` uses the custom repository.

**Independent Test**: A web install apply of a custom slug records `appSource: 'custom'`, the link helper returns the GitHub blob URL, and an update preview exports the pinned `COMMUNITY_SCRIPTS_URL`.

- [x] T025 [P] [US5] Tests: `test/lib/inventory.test.ts`: `appSource: 'custom'` round-trips through `saveInventory`/`loadInventory`, and an existing DB without `app_source` gains the column. `test/operations/provisioning.test.ts`: install-app apply with a custom source upserts `appSource: 'custom'`, and a repeat upstream apply for the same host+vmid keeps it. `test/commands/update-app.test.ts`: with the feature off the output is byte-identical to today; a `custom` source exports `COMMUNITY_SCRIPTS_URL` and curls the pinned `ctUrl` with no fallback; `runUpdateApp` logs the override warning; a resolution failure records no exec. Dashboard route test: `GET /api/inventory` returns `customScripts` (null when off).
- [x] T026 [US5] In `src/lib/inventory.ts`: add `appSource: z.literal('custom').optional()` to `GuestEntrySchema`, with a comment modelled on `app`'s; add `ensureColumn(db, 'guests', 'app_source', 'app_source TEXT')`; read and write `app_source` in `loadInventory`/`saveInventory`'s guest SELECT/INSERT and row type.
- [x] T027 [US5] In `src/operations/provisioning.ts`: install-app's apply passes `appSource: i.appSource?.kind === 'custom' ? 'custom' : undefined` into `recordProvisionedGuest`, and `upsertGuestEntry` carries `appSource` forward like `app` (with a matching comment).
- [x] T028 [US5] In `src/commands/maintenance/update-app.ts`: add `source?: AppSource` and `fetchImpl?` to `UpdateAppOptions`; change `buildUpdateAppScript(app, source)` with the same custom/non-custom split as T009; `runUpdateApp` resolves (unless given) after the argument checks, before any exec, and logs the override warning. In `src/operations/maintenance.ts`, give update-app `resolvesApp: true` and pass `source: i.appSource, fetchImpl: deps.fetchImpl` in preview/apply. `src/cli.ts` needs no flag changes; confirm the CLI prints the warning through `logWarn`.
- [x] T029 [US5] In `src/web/routes/dashboard.ts`, add `customScripts` to the `GET /api/inventory` response (`{ repo, branch }` only when both settings are set, else `null`). Add the type in `web-client/src/api/types.ts`. Change `communityScriptsUrl(guest, customScripts)` in `web-client/src/lib/guest-display.ts` to return `https://github.com/<repo>/blob/<branch>/ct/<app>.sh` for `appSource === 'custom'` when `customScripts` is set, `undefined` for a custom guest when it is null, and today's URL otherwise. Update the callers in `web-client/src/pages/UpdatePage.tsx` and `web-client/src/components/AdvancedGuestModal.tsx`, including the link label (`Open <app> in <repo>` for custom).

---

## Phase 8: Polish & Cross-Cutting

- [x] T030 [P] Update `README.md`: the settings, resolution order, override warning, commit pinning, the `/usr/bin/update` pinning and community-scripts.org helper limitations (research R1), and that the fork must be public and VED-shaped
- [x] T031 [P] Update `CLAUDE.md`: extend the `meta` settings list, the install-app/update-app bullet (custom source, `COMMUNITY_SCRIPTS_URL` export, pin-once in `previewAndEnqueue` via `resolvesApp`), the catalog paragraph (custom group, in-memory 5-minute TTL, why it isn't persisted), and the guest `app` field paragraph (`appSource`). Check `CONTRIBUTING.md` and change it only if a restated convention changed (none expected).
- [x] T032 Run `npm run typecheck`, `npm test`, and `npm run web:build`, and fix any failures
- [x] T033 Browser verification (constitution IV): run the web UI against a temp inventory with the settings on, and check at desktop width and at ≤640px, in light and dark theme: the Settings fields, the custom catalog group and override tag, the override banner, the custom notice, the error text, and the Dashboard/Update custom link
- [x] T034 Review the full branch diff for real operational data (constitution workflow gate): no real hostnames, IPs, fork names or tokens in code, tests, specs or commit messages
- [ ] T035 Live check (operator-approved, results recorded only in the PR description): a CLI dry run against the operator's real fork and branch shows the pinned commit and export line; if the operator approves, one `--apply` install of a fork-only app confirms the container ran the fork's install script

## Dependencies & Execution Order

- Phase 1 → Phase 2 (T002 before T004; T004 → T005 → T006) → all stories.
- US1 (T008–T015) first: it establishes the builder/runner/operation threading that US2 and US5 reuse. T009 before T011/T013; T012 before T011's prompt use.
- US2 depends on US1 (warning emitted from `runInstallApp`, check fields from T012).
- US3 depends only on T002 (it can run in parallel with US1).
- US4 depends only on Phase 2.
- US5 depends on US1 (T013's `appSource` input) for T027; T026/T029 can start after Phase 2.
- Phase 8 last.

## Parallel Opportunities

- T003 and T007 alongside T004–T006 (test files only).
- After Phase 2: US3 (T019–T020) and US4 (T021–T024) can run beside US1.
- Within stories, tasks marked [P] touch only test files.

## Implementation Strategy

MVP = Phases 1–3 (fork-only install, fully pinned). Then US2 (safety of overriding), US3/US4 (usability), and US5 (provenance and update). Commit after each phase with typecheck and tests green.
