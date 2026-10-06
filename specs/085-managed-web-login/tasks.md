# Tasks: Bellhop-Managed Web Login

**Input**: Design documents from `/specs/085-managed-web-login/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: required by the constitution (Principle III): each behavior change ships tests in the same change; write each test before the code it covers (TDD). Use Node's test runner under `test/`, temp SQLite fixtures (`mkdtempSync`), and the existing fake `AuthentikClient`. Example values only (`bellhop.example.com`, `bellhop-lxc`, `pve1`, `<client-secret>`).

**Format**: `[ID] [P?] [Story] Description` (`[P]` = different files, no dependency on an incomplete task)

All paths are relative to the worktree root.

## Phase 1: Setup

- [x] T001 Confirm a green baseline in the worktree: `npm --prefix <wt> run typecheck` and `npm --prefix <wt> test` (record any pre-existing failures so later failures can be told apart)

---

## Phase 2: Foundational (the `bellhop` flag; blocks US1)

**Purpose**: the guest flag exists, persists, validates, and is editable.

- [x] T002 [P] Write failing tests in `test/lib/inventory.test.ts`: `GuestEntrySchema` accepts `bellhop: true`; `validateInventory` rejects two flagged guests with `Inventory validation: multiple entries flagged 'bellhop: true' (only one is allowed): a b`; `saveInventory`/`loadInventory` round-trip the flag; an older database without the column loads (additive migration) and the flag is absent
- [x] T003 Implement the flag in `src/lib/inventory.ts`: `bellhop: z.boolean().optional()` on `GuestEntrySchema` only (hosts have none); `ensureColumn(db, 'guests', 'bellhop', 'bellhop INTEGER')`; load as `row.bellhop ? true : undefined`; save as `guest.bellhop ? 1 : null` in the guest insert (add the column to the INSERT statement and the `SELECT`/row type); add the at-most-one rule to `validateInventory()` beside the `authentik` rule
- [x] T004 [P] Write failing tests in `test/operations/edit-guest.test.ts`: `runEditGuest({ name, bellhop: true })` flags the guest and returns `bellhop: true`; `bellhop: false` clears it; omitted leaves it unchanged; flagging a second guest rejects with a `GuestEditValidationError` naming the other guest and saves nothing
- [x] T005 Add `bellhop` to the edit operation in `src/operations/edit-guest.ts`: `EDIT_GUEST_SHAPE.bellhop` (`z.boolean().optional()`, described as admin-only, "this guest is Bellhop itself"), and `applyGuestEdits` (`if ('bellhop' in body) updated.bellhop = body.bellhop === true ? true : undefined`); mention the field in the `edit_guest` description in `src/mcp/build-server.ts`
- [x] T006 [P] Write failing tests in `test/web/routes/dashboard.test.ts`: a non-admin PATCH changing `bellhop` is 403 `Only an admin may change which guest is Bellhop itself`; resending the current value is allowed; an admin may change it
- [x] T007 Extend the admin-only check in `src/web/routes/dashboard.ts` (the block near line 217 that tests `authMode`/`oidcRedirectUris`/`oidcMobileRedirectUris`) to cover `bellhop` per [contracts/guest-edit.md](contracts/guest-edit.md); add `bellhop?: boolean` to the guest type in `web-client/src/api/types.ts`

**Checkpoint**: `npm run typecheck` and the three touched test files pass.

---

## Phase 3: User Story 1 - Mark Bellhop's own guest and sign in (Priority: P1) MVP

**Goal**: with no custom settings, a flagged OIDC-gated guest's client signs people in; secrets rotate without restart.

**Independent Test**: fake Authentik holding the guest's client, flag the guest, custom settings empty, complete a sign-in.

- [x] T008 [P] [US1] Write failing tests in new `test/web/login/managed.test.ts`: (a) `refreshManagedWebLogin` with a qualifying flagged guest caches issuer/clientId/clientSecret/redirectUri (the entry's URL whose pathname is exactly `/auth/callback`; `/auth/callback/extra` does not qualify); (b) no flagged guest, not OIDC-gated, or no callback URL clears the cache and records a fixed-text problem; (c) client not found in Authentik gives the "No OpenID client exists yet for <guest> (run sync-authentik)" problem; (d) an Authentik error keeps the previous value and records `Authentik could not be reached`; (e) a rotated secret in the fake is picked up by the next refresh; (f) captured `logInfo`/`logWarn` output and every problem string never contain the secret
- [x] T009 [US1] Create `src/web/login/managed.ts`: `configureManagedWebLogin({ inventory: () => Inventory, authentik: AuthentikClient })`, `refreshManagedWebLogin()` (R2: find flagged guest, require `effectiveAuth === 'oidc'` and a `/auth/callback` URL (move the `callbackUri` helper here from `src/commands/networking/configure-web-login.ts`, one copy), call `runOidcCredentials(entry.name, { authentik, inventory })`, replace cache / keep last good / clear), `managedWebLogin()` returning the cached `ManagedLogin | undefined`, `managedProblem()`, and a test-only `resetManagedWebLogin()`; shapes per [data-model.md](data-model.md); log warnings without secret material
- [x] T010 [P] [US1] Write failing tests in `test/web/login/config.test.ts`: complete custom set wins over a cached managed value (FR-005); a partial custom set plus a managed value returns the managed config (no mixing); neither returns `{ configured: false, missing }` with the custom missing keys; env-pinned custom values still validated as before
- [x] T011 [US1] Update `webLoginConfig()` in `src/web/login/config.ts` to prefer the complete custom set, else `managedWebLogin()` as `configured: true`, else `configured: false` with the missing custom keys; keep it synchronous and keep the existing env-validation behavior
- [x] T012 [P] [US1] Write failing tests in `test/web/routes/auth.test.ts` and `test/web/login/sessions.test.ts`: `/auth/login` refreshes the managed value first (a secret rotated since startup is used; with the guest un-flagged the page shows the not-configured list plus the fixed-text reason, no secret); the callback also awaits a refresh; a due re-check awaits a refresh and uses the managed client; an unflagged guest at re-check signs the session out as today
- [x] T013 [US1] Wire the refresh: in `src/web/routes/auth.ts` `await refreshManagedWebLogin()` at the start of `/auth/login` and `/auth/callback` (failures swallowed into the module's last-good logic, never thrown); in `src/web/login/sessions.ts` await it in `recheck` before `this.config()`; the not-configured page in `auth.ts` lists the custom missing keys plus `managedProblem()` text when a guest is flagged
- [x] T014 [US1] Wire the service in `src/web/server.ts`: after `buildAuthentikClient()` call `configureManagedWebLogin({ inventory: () => inventory, authentik })` (check how `inventory` is reloaded and read it through the live reference) and fire `void refreshManagedWebLogin()` at startup; the Settings routes refresh the managed value on read (T019/T023), so an edit shows in the status without hooking every edit path (decided during implementation; also updates [contracts/guest-edit.md](contracts/guest-edit.md)); confirm `src/web/mcp/index.ts` needs no change (it reads `webLoginConfig()` synchronously)
- [x] T015 [US1] Add the "This is Bellhop" toggle to `web-client/src/components/AdvancedGuestModal.tsx` (admin only, like the OIDC fields; one-line field help in `web-client/src/lib/advanced-field-help.ts` saying it makes this guest's OIDC client Bellhop's own web login), saving `bellhop` through the existing edit call; add a client test in the existing `test/web-client/` suite for the help text/visibility rule if that suite covers the modal's field list

**Checkpoint**: US1 acceptance scenarios 1-4 pass; `npm run typecheck`, `npm test` green.

---

## Phase 4: User Story 2 - Custom settings on their own tab (Priority: P2)

**Goal**: the four custom values live on a "Web login" tab that names the active source.

**Independent Test**: Settings page at desktop and 640px width.

- [ ] T016 [P] [US2] Write failing tests in `test/lib/settings-defs.test.ts` and `test/web-client/settings-display.test.ts`: the four `webUiOidc*` keys are in group `weblogin` (env vars and files unchanged), `webUiAuthMode` stays `general`, and `fieldsForTab('weblogin')` returns exactly the four fields
- [ ] T017 [US2] In `src/lib/settings-defs.ts` add `'weblogin'` to `SettingGroup` and move the four keys; in `web-client/src/lib/settings-display.ts` add the tab (`SettingsTab`, `fieldsForTab`, tab label "Web login") and remove the four fields from the General list
- [ ] T018 [P] [US2] Write failing tests in `test/web/login/managed.test.ts` (status) and `test/web/routes/settings.test.ts`: `webLoginStatus()` returns `custom` / `managed` (entry, redirectUri) / `none` (missing, managedProblem) per [contracts/settings-api.md](contracts/settings-api.md); GET and PATCH responses include `webLogin`; no secret appears anywhere in the response (compare against the fake's secret string)
- [ ] T019 [US2] Add `webLoginStatus()` to `src/web/login/managed.ts` and include `webLogin` in `settingsResponse` in `src/web/routes/settings.ts`; add the `WebLoginStatus` type to `web-client/src/api/types.ts`
- [ ] T020 [US2] Render the tab in `web-client/src/pages/SettingsPage.tsx`: intro text stating it is intended for installs not managed by Bellhop in Proxmox (e.g. a workstation or outside the inventory), an active-source line (Custom values / Managed by <guest> / Not configured with what is missing and the managed problem), then the four fields; keep `webUiAuthMode` on General; follow the page's existing responsive layout
- [ ] T021 [US2] Update the demo instance data if it names the General-tab fields or `configure-web-login` (`scripts/demo/`, `test/scripts/demo/*.test.ts`); keep example-only values

**Checkpoint**: US2 acceptance scenarios 1-4 pass.

---

## Phase 5: User Story 3 - Require sign-in with the managed login (Priority: P2)

**Goal**: `webUiAuthMode: oidc` accepts a usable managed login.

**Independent Test**: PATCH the mode with only a managed guest configured.

- [ ] T022 [P] [US3] Write failing tests in `test/web/routes/settings.test.ts`: switching to oidc with a usable managed login and an admin session succeeds; with managed usable but no requester session it is refused as before; with neither source it is 409 with the message naming both ways (flag Bellhop's own guest / Web login tab) and no mention of `configure-web-login`; staying in oidc, clearing a custom value is refused only when the complete custom set was in effect and no managed login would take over; an unrelated save is never refused
- [ ] T023 [US3] Update the guards in `src/web/routes/settings.ts` per [research.md](research.md) R7: `await refreshManagedWebLogin()` before evaluating, treat `webLoginStatus().source === 'managed'` as configured, apply the clear-refusal only to an in-effect complete custom set, replace the message text per [contracts/settings-api.md](contracts/settings-api.md); the settings route needs the managed module only (already configured in `server.ts`)

**Checkpoint**: US3 acceptance scenarios 1-4 pass.

---

## Phase 6: User Story 4 - The old command is gone (Priority: P3)

- [ ] T024 [US4] Remove `src/commands/networking/configure-web-login.ts`, `test/commands/configure-web-login.test.ts`, and its registration/help in `src/cli.ts`; update the references found by `git grep -n "configure-web-login\|configureWebLogin"` in `src/commands/maintenance/set-config.ts`, `test/lib/inventory.test.ts`, `test/web/**`, `test/scripts/demo/*.test.ts`; add a CLI test (or extend an existing one) that `configure-web-login` is an unknown command; confirm `warnIfEnvPinned` stays exported for `set-config`

**Checkpoint**: `git grep configure-web-login` finds nothing outside `specs/` history notes.

---

## Phase 7: Polish & cross-cutting

- [ ] T025 [P] Update docs for the behavior change: `docs/authentik.md`, `docs/commands.md`, `docs/configuration.md`, `docs/environment-variables.md`, `docs/mcp-server.md`, `docs/web-ui.md`, `README.md`, and `CONTRIBUTING.md` if it lists the command: describe the flag, precedence, the Web login tab, and removal of the command; example values only; keep `README.md` within its 200-line budget and fix any anchor/links the docs link test (`test/docs/links.test.ts`) checks
- [ ] T026 [P] Update nested guidance: `src/lib/CLAUDE.md` (group `weblogin`, `bellhop` column and at-most-one rule), `src/web/CLAUDE.md` (managed login resolution/refresh points, precedence, status, PATCH guard changes, sync-only `webLoginConfig`), `src/commands/networking/CLAUDE.md` (remove the `configure-web-login` section), `src/operations/CLAUDE.md` (edit-guest `bellhop` field and the refresh after save), `web-client/CLAUDE.md` (Web login tab); record the single-operator assumptions under the relevant "Single-operator assumptions" notes: one Bellhop guest, one web origin, guest-only; keep root `CLAUDE.md` under its 250-line budget (root needs no change unless it lists the command)
- [ ] T027 Browser verification at desktop width and at 640px or narrower using `npm run demo`: the guest Advanced modal toggle and the Settings "Web login" tab (active-source line, fields, intro text, no horizontal overflow, dark theme); capture example-only screenshots only if a documented screenshot changes (then `npm run docs:screenshots` and verify by eye)
- [ ] T028 Run `npm run typecheck`, `npm test`, `npm run web:build` and walk [quickstart.md](quickstart.md); mark these verification tasks complete and list anything needing real infrastructure (a live Authentik rotation, a real sign-in with the production Authentik) as unverified

---

## Dependencies & Execution Order

- Phase 1, then Phase 2 (flag) blocks Phase 3.
- US1 (Phase 3) is the MVP. US2 depends on `managed.ts` (T009) for the status function (T019) but its tab/group work (T016, T017, T020) is independent of US1.
- US3 depends on `webLoginStatus` (T019) and `refreshManagedWebLogin` (T009).
- US4 (T024) is independent but best last so the earlier work can reference the moved `callbackUri` helper.
- Polish after all stories.

Within each story: the failing test task precedes its implementation task.

## Parallel opportunities

- T002, T004, T006 (tests in different files) can be written together.
- T008, T010, T012 are separate test files.
- T016 and T018 touch different files.
- T025 and T026 are documentation-only.

## Implementation strategy

1. Phases 1-2, then Phase 3 for the MVP (managed sign-in works end to end).
2. Phase 4 and 5 add the tab and the guard changes.
3. Phase 6 removes the old command; Phase 7 documents and verifies.
4. Commit per phase, `(#85, USn)`, with `tasks.md` checkboxes in the same commit.
