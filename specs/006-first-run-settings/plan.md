# Implementation Plan: First-run settings without Authentik

**Branch**: `issue-20-first-run-settings` | **Date**: 2026-09-26 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/006-first-run-settings/spec.md`

## Summary

Three small fixes for a new operator running without Authentik:

1. **Navigation.** The Sidebar's admin links come from a new pure function,
   `adminNavLinks(isAdmin, hasDirectory)` in `web-client/src/lib/admin-nav.ts`:
   - Settings is returned for any admin.
   - Users and Permissions are returned only when a user directory is present.
   - The Sidebar renders the "Admin" label only when the list is non-empty.
   - The impersonation picker keeps its own `isAdmin && hasDirectory` condition.
2. **Unset-setting messages.** A new `settingFix(key, valueHint)` in
   `src/lib/settings-hint.ts` returns
   `run: bellhop set-config <key> <valueHint> --apply, or set it on the web UI's Settings page`.
   The seven existing "`<key>` is not set -- run: bellhop set-config …" messages call it:
   - sync-inventory's warning and summary line
   - migrate-nfs-mount
   - set-guest-vpn
   - migrate-guest (which keeps its `, or pass --backup-storage` tail)
   - render-status-page's skip line and its thrown error

   The README Setup section gets a settings step before the first `sync-inventory`. "Running without Authentik" says Settings remains in the navigation.
3. **Settings page.** The intro is reworded: every setting is optional, and each field says what happens while it is unset. Each field label gets an "Optional" marker. The derived-values section uses text from a new pure `web-client/src/lib/settings-display.ts`, which gives explicit empty states:
   - No Caddy entry with an IP: "not set — no inventory entry has `caddy: true` with an IP yet".
   - No host with a MID scheme: "none yet — no host has a `midScheme`".

   The server and API response shape are unchanged.

## Technical Context

**Language/Version**: TypeScript (strict), Node ≥ 24; web client React 19 + Vite

**Primary Dependencies**: existing only; no new dependencies

**Storage**: none changed

**Testing**:
- `node --test` via the root `npm test` glob.
- New `test/lib/settings-hint.test.ts`, plus `test/web-client/admin-nav.test.ts` and `test/web-client/settings-display.test.ts`. These import the framework-free web-client modules directly, the same way `whoami-store.test.ts` does.
- The existing message assertions in `test/commands/*` are tightened to check the Settings-page wording.
- Rendering is verified in a browser (constitution IV).

**Target Platform**: Bellhop CLI, web service, and browsers served by it

**Project Type**: existing CLI + web service + MCP project

**Performance Goals**: n/a

**Constraints**:
- No change to the settings API response, validation, or permission gating (FR-011).
- Web-client helper modules must compile under both the bundler config and the root NodeNext config: no DOM or React imports, and explicit `.ts` extensions on type imports.

**Scale/Scope**: 3 new small modules, 6 edited source files, the Sidebar and SettingsPage, README, CLAUDE.md, and 3 new test files plus tightened assertions

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | How |
| --- | --- | --- |
| I. No real operational data | PASS | Tests and docs use example values (`10.0.0.5`, `pve1`, `proxy`). |
| II. Code quality | PASS | One shared helper replaces seven hand-copied fix phrases. Nav visibility and derived-value text move into pure, tested functions instead of inline JSX conditions. |
| III. Testing | PASS | Every behavior change has a deterministic `node --test` test. No network is used, and no component-test tooling is added. |
| IV. UX consistency | PASS | Error/warning messages keep naming the `set-config` key and now also name the Settings page form ("MUST tell the user what to do next"). Browser check at desktop and ≤640px. README updated for the user-visible changes; CLAUDE.md updated where it describes the Settings nav link and the unset-setting message wording. CONTRIBUTING.md restates none of this, so it needs no change. |
| Workflow | PASS | Worktree `issue-20-first-run-settings`, PR to `main`. No single-operator assumption is introduced or changed. |

Post-design re-check: PASS. No persisted state, dependency, API, or auth change.

## Project Structure

### Documentation (this feature)

```text
specs/006-first-run-settings/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/ui-and-messages.md
├── checklists/requirements.md
└── tasks.md            # /speckit-tasks
```

### Source Code (repository root)

```text
src/lib/settings-hint.ts                          # NEW: settingFix()
src/commands/maintenance/sync-inventory.ts        # warning + summary use settingFix
src/commands/provisioning/migrate-nfs-mount.ts    # uses settingFix
src/commands/provisioning/set-guest-vpn.ts        # uses settingFix
src/commands/provisioning/migrate-guest.ts        # uses settingFix (+ --backup-storage tail)
src/commands/networking/render-status-page.ts     # skip line + thrown error use settingFix
web-client/src/lib/admin-nav.ts                   # NEW: adminNavLinks()
web-client/src/lib/settings-display.ts            # NEW: caddyHostText(), lanGatewaysEmptyText
web-client/src/components/Sidebar.tsx             # renders adminNavLinks()
web-client/src/pages/SettingsPage.tsx             # intro, Optional markers, empty states
web-client/src/index.css                          # .settings-optional marker style (if needed)
README.md                                         # Setup settings step; Running without Authentik
CLAUDE.md                                         # Settings nav + message wording notes
test/lib/settings-hint.test.ts                    # NEW
test/web-client/admin-nav.test.ts                 # NEW
test/web-client/settings-display.test.ts          # NEW
test/commands/{sync-inventory,migrate-nfs-mount,set-guest-vpn,migrate-guest,render-status-page}.test.ts  # tightened
```

**Structure Decision**: follow the existing split. Server-side helpers go in `src/lib/`. Framework-free client logic goes in `web-client/src/lib/`, tested from `test/web-client/`, the same way `whoami-store.ts` is.

## Complexity Tracking

No violations.
