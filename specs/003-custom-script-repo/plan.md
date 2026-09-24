# Implementation Plan: Custom Script Repository as a First-Class App Source

**Branch**: `issue-11-custom-script-repo` | **Date**: 2026-09-24 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/003-custom-script-repo/spec.md`

## Summary

Add a third, operator-configured app source: a public ProxmoxVED-shaped GitHub repository and branch, set as two inventory settings. A bare slug resolves custom → ProxmoxVE → ProxmoxVED. The custom branch is pinned to its head commit once per operation, and every later step reads that commit. That includes the installer engine's own download of `install/<slug>-install.sh`, which Bellhop redirects by exporting `COMMUNITY_SCRIPTS_URL` (research R1). Overriding an upstream copy produces a warning at the top of every front end's output. The catalog gains a custom group with a 5-minute in-memory TTL, and custom-installed guests record `appSource: 'custom'` so the Dashboard can link to the fork.

## Technical Context

**Language/Version**: TypeScript (strict), Node ≥ 24 (CI matrix); web client is React + Vite

**Primary Dependencies**: existing only: `zod`, `better-sqlite3`, `commander`, Express, `@modelcontextprotocol/sdk`, global `fetch`. No new dependencies.

**Storage**: inventory SQLite (`meta` key/value for the two settings; one new nullable `guests.app_source` column via `ensureColumn`); custom catalog listing in process memory only (research R4)

**Testing**: `node --test` under `test/`; `FakeSSHClient`; `fetch` stubs replaying captured fixtures in `test/fixtures/github/`

**Target Platform**: Bellhop host (Windows service / CLI / MCP stdio); remote commands run on Proxmox hosts (bash) and inside guests (`sh -c` wrapper around `bash -c "$(curl …)"`, unchanged)

**Project Type**: CLI + web service + MCP server sharing `src/lib` and `src/operations`

**Performance Goals**: at most 1 extra GitHub API call (head SHA) plus up to 3 raw GETs per custom-configured app resolution; catalog custom listing at most once per 5 minutes per process

**Constraints**: unauthenticated GitHub API (60/h); feature-off behavior byte-identical (FR-002, SC-005); preview == apply (constitution IV, SC-004)

**Scale/Scope**: one operator, one custom repository

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | How |
| --- | --- | --- |
| I. No real operational data | PASS | Repo/branch are operator settings in `bellhop.db`, never defaults in code. Specs, tests and fixtures use `example-user/ProxmoxVED`/`my-apps`. The captured fixtures are public community-scripts responses. Half-configured and missing settings fail with an error naming `set-config`. |
| II. Code quality | PASS | One resolver in `src/lib/app-source.ts`, reused by install-app, update-app, app-check, catalog and operations. Remote execution is unchanged (`runRemote`/`execInteractive`). GitHub responses are validated (SHA is 40-hex; the listing goes through the existing contents filter). Errors are explicit, with no fallback to upstream on resolution failure (FR-008). The new export line goes into host-side bash (install-app) and into the `bash -c` payload inside the guest's `sh -c` (update-app), and is POSIX-valid either way. |
| III. Testing | PASS | Each behavior gets `node --test` coverage using `FakeSSHClient` plus fetch stubs built from captured fixtures (R2/R4). No live network in tests. Time is injected (`now`) for the TTL tests. |
| IV. UX consistency | PASS | Dry run shows the exact script apply sends. Pinning once per operation keeps preview == apply. CLI, web and MCP share one resolver and one `SettingsSchema`. There are no new flags. Warnings name the fix (`set-config`). README and CLAUDE.md get updated. The web changes are verified at desktop width and at ≤640px. |
| Workflow | PASS | Worktree `issue-11-custom-script-repo`, PR to `main`. This introduces no single-operator assumption: the custom source is optional and operator-supplied. |

Post-design re-check (after Phase 1): still PASS. The design adds no table rebuild, no new dependency and no hardcoded operator value. The only new persisted field is optional.

## Project Structure

### Documentation (this feature)

```text
specs/003-custom-script-repo/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/interfaces.md
├── checklists/requirements.md
└── tasks.md            # /speckit-tasks
```

### Source Code (repository root)

```text
src/lib/app-source.ts                     # NEW: customScriptSource, resolveHeadSha, resolveAppSource, formatOverrideWarning
src/lib/inventory.ts                      # SettingsSchema (+2 keys), GuestEntrySchema.appSource, app_source column
src/lib/script-catalog.ts                 # getScriptCatalog(dbPath, fetch, now, inventory?) → custom group, in-memory TTL
src/commands/provisioning/install-app.ts  # buildInstallAppScript/runInstallApp take AppSource; export COMMUNITY_SCRIPTS_URL
src/commands/maintenance/update-app.ts    # same for buildUpdateAppScript/runUpdateApp
src/operations/app-check.ts               # checkAppUrl via resolveAppSource; custom/shadows/error fields
src/operations/core.ts                    # previewAndEnqueue resolves once for op.resolvesApp
src/operations/types.ts                   # Operation.resolvesApp
src/operations/provisioning.ts            # install-app: pass source, record appSource; upsertGuestEntry carries appSource
src/operations/maintenance.ts             # update-app: pass source, resolvesApp
src/web/routes/provisioning.ts            # check-app/apps pass inventory
src/web/routes/dashboard.ts               # GET /api/inventory adds customScripts
src/mcp/build-server.ts                   # check_install_app/list_install_apps pass inventory
src/cli.ts                                # print override warning path (via runInstallApp/runUpdateApp logs; no new flags)
web-client/src/components/AppCheckInput.tsx   # custom group, override tags/banner, custom notice, error text
web-client/src/lib/guest-display.ts            # communityScriptsUrl(guest, customScripts)
web-client/src/pages/SettingsPage.tsx          # two fields
web-client/src/pages/UpdatePage.tsx, components/AdvancedGuestModal.tsx  # pass customScripts to link helper
web-client/src/api/types.ts                    # response types
README.md, CLAUDE.md                            # docs

test/lib/app-source.test.ts               # NEW
test/lib/script-catalog.test.ts           # custom group cases
test/commands/install-app.test.ts, update-app.test.ts, set-config.test.ts
test/operations/*.test.ts                 # previewAndEnqueue pin-once, app-check, provenance
test/web/routes/*.test.ts                 # settings/check-app/apps/inventory responses
test/fixtures/github/                     # captured responses (already added)
```

**Structure Decision**: Existing single-repo layout. The new logic lives in one `src/lib` module. Everything else is threading an `AppSource` through existing call sites.

## Key Design Decisions

1. **Resolver contract** (`src/lib/app-source.ts`):
   - `customScriptSource(inv)` → `undefined` | source | throws on half-config.
   - `resolveHeadSha(source, fetchImpl)` → 40-hex, or throws an error naming the settings (404 → "repository not found or private", 422 → "branch not found", other → "could not reach GitHub").
   - `resolveAppSource(app, inv, fetchImpl)` → `AppSource` (data-model.md). No network for `kind: 'url'` or when the feature is off.
   - `formatOverrideWarning(source)` → the R6 text.
2. **Script builders stay synchronous and pure.** `buildInstallAppScript(opts, mid, storage, hostKeys, source)` and `buildUpdateAppScript(app, source)` take the resolved source. For `kind !== 'custom'` they emit exactly today's output. For `kind === 'custom'` they add `export COMMUNITY_SCRIPTS_URL=<quoted base>` just before the curl line and curl the pinned `ctUrl` with no fallback.
3. **Pin once per operation.** `Operation.resolvesApp?: true` on install-app and update-app. `previewAndEnqueue` sets `input.appSource = await resolveAppSource(...)` after parsing (it overwrites any caller-supplied value) and computes expected prompts from that source. `preview()`/`apply()` pass `source: i.appSource` through. The plain preview route and the CLI resolve inside `runInstallApp`/`runUpdateApp`.
4. **Warning placement.** `runInstallApp`/`runUpdateApp` `logWarn` the override warning immediately after resolution, before the VMID check and any SSH call. Captured preview text and CLI output therefore start with it, and the job log repeats it inside the preview block and again at apply time.
5. **Catalog.** `getScriptCatalog` keeps its upstream logic unchanged, then (when an inventory is passed and the feature is on) merges a custom listing from an in-memory `Map<label, {slugs, fetchedAt}>` with `CUSTOM_CATALOG_MAX_AGE_MS = 5 min` and a 60s failure cooldown, both reset by `resetCatalogFetchState()`. The merge removes custom slugs from `stable`/`dev` and fills `shadows`.
6. **Provenance.** `recordProvisionedGuest` receives `appSource: 'custom'` from install-app's apply when `i.appSource?.kind === 'custom'`. `upsertGuestEntry` falls back to `existing.appSource` when the new entry has none, the same pattern as `app`.

## Risks

- **Upstream engine changes** the variable name or precedence. Mitigation: the research cites the exact functions, and the builder test asserts the export line, so a future breakage shows up in the live check recorded in the PR.
- **Rate limit** (60/h) during a burst of checks. Mitigation: the error names the cause, and the catalog has a cooldown. An authenticated token is out of scope (spec).
- **A fork `ct/` script that hardcodes an upstream build.func URL** instead of the core engine one-liner. That's out of scope (FR-015 requires the VED layout). The live check in the PR confirms the operator's fork follows it.

## Complexity Tracking

No constitution violations. No entries.
