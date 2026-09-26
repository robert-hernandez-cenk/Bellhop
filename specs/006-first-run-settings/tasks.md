---

description: "Task list for first-run settings without Authentik (issue #20)"
---

# Tasks: First-run settings without Authentik

**Input**: Design documents from `specs/006-first-run-settings/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/ui-and-messages.md, quickstart.md

**Tests**: Included. The constitution (Principle III) requires tests for behavior changes, and this flow implements with TDD. Each test task comes before the implementation it covers.

**Organization**: one phase per user story. All paths are relative to the worktree root.

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Setup

None needed. The worktree, dependencies, and baseline checks are already in place (typecheck clean, 1346 tests passing).

## Phase 2: Foundational

None. The three stories touch disjoint files except README.md and CLAUDE.md, which are edited per story.

---

## Phase 3: User Story 1 - Reach Settings without Authentik (Priority: P1) 🎯 MVP

**Goal**: any admin sees the Admin group with Settings. Users and Permissions still need a user directory.

**Independent Test**: `test/web-client/admin-nav.test.ts` passes. In the browser, with no Authentik, the sidebar shows Admin → Settings only.

- [x] T001 [P] [US1] Write failing tests in test/web-client/admin-nav.test.ts for `adminNavLinks(isAdmin, hasDirectory)`, per contracts/ui-and-messages.md:
  - `(false, false)` and `(false, true)` return `[]`.
  - `(true, false)` returns `[{ to: '/settings', label: 'Settings' }]`.
  - `(true, true)` returns Users, Permissions, and Settings in that order, with paths `/users`, `/permissions`, `/settings`.
- [x] T002 [US1] Implement `adminNavLinks` in web-client/src/lib/admin-nav.ts. It must be framework-free (no React/DOM imports), so it compiles under the root NodeNext config. Make T001 pass.
- [x] T003 [US1] Update web-client/src/components/Sidebar.tsx:
  - Render the Admin group from `adminNavLinks(isAdmin, hasDirectory)`. Show the "Admin" `nav-group-label` only when the list is non-empty, and give each `NavLink` `onClick={close}`.
  - Leave the impersonation picker's `isAdmin && hasDirectory` condition and the `/groups` fetch effect unchanged (FR-003).
- [x] T004 [US1] Update README.md "Running without Authentik": Users and Permissions still disappear from the nav, and Settings stays, since it needs no Authentik. Update CLAUDE.md's "Web UI Settings page" bullet (currently "nav link beside Users and Permissions") to say the link shows for any admin, even without a user directory, via `adminNavLinks` (`web-client/src/lib/admin-nav.ts`).

**Checkpoint**: `npm run typecheck && npm test` pass; US1 is independently shippable.

---

## Phase 4: User Story 2 - Set settings before the first sync (Priority: P2)

**Goal**: every unset-setting message names both `set-config` and the Settings page. The README has operators set settings before the first sync.

**Independent Test**: `test/lib/settings-hint.test.ts` and the tightened command tests pass. The README Setup section shows the settings step before any `sync-inventory` instruction.

- [ ] T005 [P] [US2] Write a failing test in test/lib/settings-hint.test.ts: `settingFix('nfsServer', '<ip>')` returns exactly `run: bellhop set-config nfsServer <ip> --apply, or set it on the web UI's Settings page`.
- [ ] T006 [US2] Implement `settingFix(key: SettingKey, valueHint: string): string` in src/lib/settings-hint.ts. Type `key` from `SETTINGS_KEYS` in src/lib/inventory.ts (`(typeof SETTINGS_KEYS)[number]`, or the existing exported key type if there is one). Make T005 pass.
- [ ] T007 [P] [US2] Tighten these assertions so each also requires `or set it on the web UI's Settings page`, and confirm they fail first:
  - test/commands/sync-inventory.test.ts: the summary line, plus the warning line if one is captured.
  - test/commands/migrate-nfs-mount.test.ts
  - test/commands/set-guest-vpn.test.ts
  - test/commands/migrate-guest.test.ts: also keep asserting `or pass --backup-storage`.
  - test/commands/render-status-page.test.ts: the thrown error, and the skip-line helper if it is exported and tested.
- [ ] T008 [US2] Replace the hand-written fix phrase with `settingFix(...)` in each message below. Keep the lead-ins exactly as in contracts/ui-and-messages.md, then make T007 pass.
  - src/commands/maintenance/sync-inventory.ts: warning (line ~94) and summary (line ~316)
  - src/commands/provisioning/migrate-nfs-mount.ts (~25)
  - src/commands/provisioning/set-guest-vpn.ts (~91)
  - src/commands/provisioning/migrate-guest.ts (~169): `, or pass --backup-storage` tail kept
  - src/commands/networking/render-status-page.ts: skip line (~41) and thrown error (~68)
- [ ] T009 [US2] Grep the other test and source files (`test/`, `src/`) for the old exact strings (e.g. `set-config nfsServer <ip> --apply'`, or full-string equality on these messages) and update any that the new suffix breaks.
- [ ] T010 [US2] README.md Setup: after the import-inventory step, add a short "Inventory-wide settings (before your first sync)" step. It shows `bellhop set-config nfsServer <ip> --apply`, says the web UI's Settings page sets the same values, explains that setting `nfsServer` first lets the first `sync-inventory` discover NFS mounts, and links to the full "Inventory-wide settings" section (research R5). In CLAUDE.md, where it says the commands reading these settings "fail with a named error pointing at `set-config`", add that the message also names the web UI's Settings page, via `settingFix` in `src/lib/settings-hint.ts`.

**Checkpoint**: `npm run typecheck && npm test` pass.

---

## Phase 5: User Story 3 - A Settings page a newcomer can read (Priority: P3)

**Goal**: the page says every setting is optional, marks each field Optional, and uses clear empty states for derived values.

**Independent Test**: `test/web-client/settings-display.test.ts` passes. In the browser, against a fixture with no `caddy: true` and no `midScheme`, the page shows both empty-state sentences.

- [ ] T011 [P] [US3] Write failing tests in test/web-client/settings-display.test.ts:
  - `caddyHostText({ name: 'proxy', ip: '10.0.0.2' })` returns `'proxy (10.0.0.2)'`.
  - `caddyHostText(null)` returns `'not set — no inventory entry has caddy: true with an IP yet'`.
  - `LAN_GATEWAYS_EMPTY_TEXT` equals `'LAN gateways: none yet — no host has a midScheme'`.
- [ ] T012 [US3] Implement web-client/src/lib/settings-display.ts (framework-free) and make T011 pass.
- [ ] T013 [US3] Update web-client/src/pages/SettingsPage.tsx:
  - Reword the intro `PageDescription`. Every setting is optional, and each field says what happens while it is unset. Keep the `bellhop set-config <key> <value> --apply` pointer. Remove the "fails with a named error until it is set" claim.
  - Add an "Optional" marker to each field label (e.g. `<span className="settings-optional">Optional</span>`).
  - Render `LAN_GATEWAYS_EMPTY_TEXT` as a list item when `derived.lanGateways` is empty.
  - Render the Caddy line with `caddyHostText(data.derived.caddy)`.
- [ ] T014 [US3] Add a muted, non-wrapping-safe `.settings-optional` style in web-client/src/index.css next to the existing `.settings-*` rules, using existing theme variables (dark mode via `:root[data-theme='dark']` if a new color is needed).

**Checkpoint**: `npm run typecheck && npm test` pass.

---

## Phase 6: Polish & Verification

- [ ] T015 Run `npm run typecheck`, `npm test`, and `npm run web:build`. All must pass.
- [ ] T016 Run quickstart.md §2 against a temp fixture: the CLI message shows the Settings-page wording.
- [ ] T017 Run quickstart.md §3 in a browser against a temp fixture with no `caddy: true` and no `midScheme`, in no-Authentik mode, at desktop width and ≤640px. Check the sidebar Admin → Settings only, the intro, the Optional markers, both empty states, and that nothing overflows.
- [ ] T018 Re-read README Setup and "Running without Authentik" (quickstart §4). Confirm CONTRIBUTING.md needs no change.

---

## Dependencies & Execution Order

- US1 (T001–T004), US2 (T005–T010), and US3 (T011–T014) are independent of each other. Within each story, tests come first, then implementation, then docs.
- T008 depends on T006. T009 follows T008.
- Polish (T015–T018) comes after all stories.

## Parallel Opportunities

- T001, T005, T007, and T011 are test-writing tasks in different files and can run together.
- The stories can be implemented in parallel by separate workers. Their only shared files are README.md and CLAUDE.md, which get edits in different sections.

## Implementation Strategy

1. MVP: US1 alone fixes the most visible problem (Settings unreachable without Authentik).
2. Add US2 for the first-sync ordering and message wording.
3. Add US3 for the page polish.
4. Commit per story: `<what the story delivers> (#20, USn)`.
