---

description: "Task list for the reverse-proxy driver interface"
---

# Tasks: Reverse-Proxy Driver Interface

**Input**: Design documents from `specs/006-reverse-proxy-driver/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/driver-interface.md, contracts/user-surfaces.md, quickstart.md

**Tests**: Required by the constitution (Principle III) and TDD is requested: every
implementation task is preceded by a failing test. Fixtures use example values only
(`example.com`, RFC 5737 addresses such as `192.0.2.10`, generic names such as `web-lxc`,
`pve1`, exempt paths `/health` and `/api/*`).

## Format: `[ID] [P?] [Story] Description`

Paths are relative to the repository root.

## Phase 1: Setup — pin current behaviour

- [x] T001 Write the characterization test in `test/lib/proxy/drivers/caddy.test.ts` against the **current** `buildCaddyBlock` (import from `src/commands/networking/sync-caddy.ts` for now). Build the fixture inventory described in data-model.md "Characterization fixture" (every listed entry shape, still using today's `caddy`/`caddyManual` field names) and assert the output equals a literal expected string captured from the current code, byte for byte (store it inline as an array joined with `'\n'`, like the existing `test/commands/sync-caddy.test.ts` expectations). Add a second case asserting the missing-authentik error text `Entry '<name>' has an 'authGroup' set but no inventory entry has 'authentik: true' with an ip set`. Run `npm test`: the new test passes on the current code. This test must keep passing, with only its import and field names changing, through every later task.

## Phase 2: Foundational — the driver seam, no behaviour change

Inventory field names stay `caddy`/`caddyManual` throughout this phase; the rename is US2.

- [ ] T002 [P] Write failing tests in `test/lib/hostname.test.ts` for `publicHostname(sub, domain)` returning `` `${sub}.${domain}` `` (e.g. `app` + `example.com` → `app.example.com`).
- [ ] T003 [P] Implement `publicHostname` in `src/lib/hostname.ts`; make T002 pass.
- [ ] T004 Write failing tests in `test/lib/proxy/routes.test.ts` for `buildRoutes(inventory)` and `buildProxyContext(inventory)` per data-model.md "ProxyRoute" and contracts/driver-interface.md: manual entries and subdomain-less entries produce no route; `hostnames` are fully qualified in stored order; port defaults to `80`; `backend.insecureTls` mirrors `insecureBackendTls === true`; `auth` is `ungated`/`oidc`/`forward` via `effectiveAuth()`, with `exemptPaths` parsed and `rawExemptPaths` in stored order for forward only; route order is hosts, guests, external sites; forward route with no `authentik: true` entry having an ip throws the exact missing-authentik message; `buildProxyContext` returns `outpost: { ip, port: authentikConfig().outpostPort }` when an authentik entry with an ip exists, else no `outpost`, and `externalPort: 443`. Include `parsePathPattern` cases: `/health` → `{kind:'exact',path:'/health'}`, `/api/*` → `{kind:'prefix',path:'/api/'}`, `/*` → `{kind:'prefix',path:'/'}`.
- [ ] T005 Implement `src/lib/proxy/routes.ts` (`PathPattern`, `ProxyAuth`, `ProxyRoute`, `ProxyContext`, `parsePathPattern`, `buildRoutes`, `buildProxyContext`) using `publicHostname`; move the missing-authentik check here. Make T004 pass.
- [ ] T006 Write failing tests in `test/lib/proxy/file-driver.test.ts`: (a) `buildFileDriverScript` for one `managed-section` file and for two `owned` files contains a backup per file, the marker-stripping `sed` for managed sections, the validate command, a restore-every-backup branch that exits 1, and the reload command last; paths are single-quoted; (b) `fileDriver(...).plan()` returns the single file's content as `preview` (joined with `'\n'` for several) and the `FileSpec[]` as payload; (c) `apply()` sends exactly one `runRemote` call to the proxy host through a `FakeSSHClient` and throws with stderr on a non-zero exit; (d) `snapshot()` `cat`s each file, adding `==> <path> <==` headers only when there is more than one; (e) **executed restore test**: write the script generated for one managed-section file into a `mkdtempSync` dir together with a pre-existing file containing hand-written content plus an old managed block, put stub `caddy` (always exits 1) and `systemctl` (appends its args to a log file) scripts first on `PATH`, run the script with `sh` via `child_process.spawnSync`, and assert exit code 1, the original file restored byte for byte, and no `systemctl` call; a second run with a `caddy` stub that exits 0 asserts the new block replaced the old one, the hand-written content is intact, and `systemctl reload caddy` was called once. Skip (e) with a reason only if `sh` is not found.
- [ ] T007 Implement `src/lib/proxy/file-driver.ts` (`FileSpec`, `fileDriver`, `buildFileDriverScript`) per contracts/driver-interface.md "file-driver.ts" and research.md R6, POSIX `sh` only, delivered through `runRemote`. Make T006 pass.
- [ ] T008 Write failing tests in `test/lib/proxy/driver.test.ts` for `checkCapabilities(routes, driver)`: no errors when every route's mode is in `capabilities.authModes` or is `ungated`; one error per offending route using a fake driver with `authModes: ['oidc']`, with the exact message from contracts/driver-interface.md (`Entry '<name>' uses forward-auth gating, but the '<id>' proxy driver cannot enforce it -- set its authMode to oidc or clear authGroup`), and the mirror message for an OIDC route on a forward-only driver.
- [ ] T009 Implement `src/lib/proxy/driver.ts` (`ProxyAuthMode`, `DriverCapabilities`, `DriverDeps`, `ProxyPlan`, `ReverseProxyDriver`, `CapabilityError`, `checkCapabilities`). Make T008 pass.
- [ ] T010 Implement `src/lib/proxy/drivers/caddy.ts`: move `TLS_BLOCK`, `EXTERNAL_PORT`, the markers, and the block-rendering logic out of `src/commands/networking/sync-caddy.ts` into a `render(routes, ctx, configPath)` over `ProxyRoute[]` that emits one `managed-section` `FileSpec`; exempt paths are emitted from `rawExemptPaths` verbatim; `caddyDriver = fileDriver({ id: 'caddy', capabilities: { authModes: ['forward','oidc'], acmeDns01ViaCloudflare: true }, defaultConfigPath: '/etc/caddy/Caddyfile', validateCommand: (p) => \`caddy validate --adapter caddyfile --config <quoted p>\`, reloadCommand: 'systemctl reload caddy' })`. Point T001's test at the driver's render (`buildRoutes` + `buildProxyContext` + `render`); it must pass unchanged.
- [ ] T011 Write failing tests in `test/lib/proxy/index.test.ts`: `getDriver` returns `caddyDriver` when `proxyDriver` is unset or `'caddy'`; an unknown id (set by bypassing the schema) throws `Unknown proxyDriver '<id>' -- run: bellhop set-config proxyDriver caddy --apply`; `driverDeps` resolves `proxyHost` from the proxy-host entry, `configPath` from the `proxyConfigPath` setting or the driver default, and throws `No inventory entry has 'caddy: true'` (renamed to `'proxy: true'` in US2) when none exists.
- [ ] T012 Implement `src/lib/proxy/index.ts` (`PROXY_DRIVER_IDS = ['caddy'] as const`, `ProxyDriverId`, registry, `getDriver`, `driverDeps`, plus a test-only hook `registerDriverForTests(driver): () => void` that adds a driver under an extra id and returns an unregister function, documented as test-only). Make T011 pass (the `proxyConfigPath` setting itself arrives in T021; until then read it as optional).
- [ ] T013 Rewrite `runSyncCaddy` in `src/commands/networking/sync-caddy.ts` as orchestration only: `getDriver` → `driverDeps` → `buildRoutes` → `buildProxyContext` → `driver.plan` → `driver.apply` on `apply`; return `{ caddyHost, block: plan.preview, applied }` for now. Delete the old `buildCaddyBlock`/`buildRemoteScript`. Update `test/commands/sync-caddy.test.ts` only where it asserted the old temp-file script shape (now the file-driver script); every expected block stays identical.
- [ ] T014 Switch `src/commands/networking/render-status-page.ts` to `driver.snapshot(driverDeps(...))` instead of its own `cat` of the Caddyfile path; update `test/commands/render-status-page.test.ts` for the call and keep its failure message meaningful (`Failed to read the deployed proxy configuration from <host>: …`).
- [ ] T015 Use `publicHostname` in `src/commands/networking/sync-authentik.ts` and `src/commands/networking/adopt-oidc-client.ts` for `externalHost`. Existing tests unchanged and passing.
- [ ] T016 Write a failing test in `test/web/caddy-sync.test.ts` that the prune step is skipped (no Cloudflare calls) when the active driver's `acmeDns01ViaCloudflare` is `false` (inject a fake driver through the registry test hook added in T012), then gate `pruneAcmeChallengesLive` in `src/web/caddy-sync.ts` on `getDriver(inventory).capabilities.acmeDns01ViaCloudflare`.
- [ ] T017 Checkpoint: `npm run typecheck` and `npm test` pass; T001 is unchanged apart from its import. Commit (`Extract reverse-proxy driver seam with Caddy driver (#10)`).

## Phase 3: User Story 2 — Proxy-neutral names everywhere (P1)

**Goal**: one "proxy" vocabulary on every surface; no old names accepted.

**Independent test**: contracts/user-surfaces.md, every row, per front end.

- [ ] T018 [US2] Update tests first, then code, for the inventory rename in `src/lib/inventory.ts` and `test/lib/inventory.test.ts`: `HostEntrySchema`/`GuestEntrySchema` `caddy` → `proxy`, `caddyManual` → `proxyManual`; `CREATE TABLE` columns `caddy`/`caddy_manual` → `proxy`/`proxy_manual`, table `caddy_owner` → `proxy_owner`; row types, `loadInventory`/`saveInventory` SQL and mappings; `ensureColumn(…,'caddy_manual',…)` → `proxy_manual`; `findCaddyEntry` → `findProxyEntry`; `validateInventory` messages (`multiple entries flagged 'proxy: true'`, and the `proxyManual` ip exemption). A test asserts an entry with the old `caddy`/`caddyManual` keys does not become a proxy host (zod strips unknown keys).
- [ ] T019 [US2] Rename the command: `src/commands/networking/sync-caddy.ts` → `sync-proxy.ts` (`runSyncProxy`, `SyncProxyOptions`, result `{ proxyHost, driver, preview, applied }`), `test/commands/sync-caddy.test.ts` → `test/commands/sync-proxy.test.ts`; `src/web/caddy-sync.ts` → `src/web/proxy-sync.ts` (`syncProxyLive`, `SyncProxyLiveResult`), `test/web/caddy-sync.test.ts` → `test/web/proxy-sync.test.ts`; update every importer (`src/operations/edit-guest.ts`, `src/operations/provisioning.ts`, `src/operations/maintenance.ts`, `src/commands/provisioning/migrate-guest.ts`, `src/web/routes/*`, tests). `render-status-page` result field `caddyHost` → `proxyHost`. Use `git mv` so history follows.
- [ ] T020 [US2] Rename the action on every front end per contracts/user-surfaces.md: CLI `sync-caddy` → `sync-proxy` with the new description and log lines in `src/cli.ts`; operation id and web command (`src/operations/maintenance.ts` or wherever `sync-caddy` is registered, `src/web/commands-meta.ts` id `sync-proxy`, label "Sync Proxy"); MCP tool name follows the operation id (`sync_proxy`); `render-status-page` descriptions. Update `test/operations/maintenance.test.ts`, `test/web/routes/maintenance.test.ts`, `test/mcp/build-server.test.ts`, `test/support/mcp-harness.ts` expectations; a test asserts no `sync-caddy`/`sync_caddy` is registered.
- [ ] T021 [US2] Settings, tests first: add to `SettingsSchema` in `src/lib/inventory.ts` `proxyDriver: z.enum(PROXY_DRIVER_IDS).optional()` and `proxyConfigPath: z.string().regex(/^\//, 'must be an absolute path').optional()` (order them after `statusPagePath`); cover `set-config` accept/reject in `test/commands/set-config.test.ts` (or the existing set-config suite) and `PATCH /api/settings` in `test/web/routes/settings.test.ts`. Remove `caddyfilePath()` and every `CADDYFILE_PATH` read from `src/cli.ts`; delete the `caddyfilePath` option from `SyncProxyOptions`/`RenderStatusPageOptions`; update the stale comment in `src/operations/networking.ts`.
- [ ] T022 [US2] `src/web/routes/settings.ts`: `derived.caddy` → `derived.proxy` via `findProxyEntry`; update `test/web/routes/settings.test.ts`.
- [ ] T023 [US2] Guest edit field: `caddyManual` → `proxyManual` in `src/operations/edit-guest.ts` (body parsing, `EDIT_GUEST_SHAPE` with description "Proxy config for this entry is hand-authored outside the managed section", TLS-probe condition, comments) and `src/mcp/build-server.ts`'s `edit_guest` description; tests in `test/operations/edit-guest.test.ts`, `test/web/routes/dashboard.test.ts`, `test/mcp/build-server.test.ts`, including one that a body carrying `caddyManual: true` leaves `proxyManual` unset.
- [ ] T024 [US2] `scripts/windows-service.ts`: `resolveCaddyIp` → `resolveProxyIp` using `findProxyEntry`, error texts name `'proxy: true'`, variable and comment renames.
- [ ] T025 [US2] Sweep the remaining server-side references: `grep -rn -i "caddy" src scripts test` and rename every identifier, user-visible string, and comment that refers to the proxy role rather than Caddy itself (e.g. `src/commands/provisioning/migrate-guest.ts`, `src/web/app.ts`, `src/web/server.ts`, `src/web/auth.ts`, `src/operations/types.ts`, `src/lib/authentik-config.ts`, `src/lib/cloudflare-client.ts`, `test/web/jobs/job-store.test.ts`). Keep references that genuinely describe Caddy (inside `src/lib/proxy/drivers/caddy.ts`, `prune-acme-challenges` explaining Caddy's DNS-01, Authentik's `/auth/caddy` endpoint). Historical `sync-caddy` job types in fixtures may stay where they model old rows.
- [ ] T026 [US2] `inventory/hosts.yaml.example`: `caddy: true` → `proxy: true`, `caddyManual` → `proxyManual`, `sync-caddy` → `sync-proxy`, and add commented `proxyDriver`/`proxyConfigPath` settings next to `statusPagePath`.
- [ ] T027 [US2] Web client: `git mv web-client/src/components/EditableCaddyManual.tsx EditableProxyManual.tsx` and rename the component; `caddyManual` → `proxyManual`, `caddy` → `proxy` in `web-client/src/api/types.ts`, `web-client/src/pages/Dashboard.tsx` (column header and `data-label` "read-only proxy"), `web-client/src/components/AdvancedGuestModal.tsx`, and the other `web-client/src` files `grep -rn -i caddy` finds (e.g. `EditableInsecureBackendTls.tsx`, `EditablePort.tsx`, `EditableSubdomains.tsx`, `EditableUnauthenticatedPaths.tsx`, `SubdomainsInput.tsx`, `guest-display.ts`, `UpdatePage.tsx`), with the same keep-if-it-really-means-Caddy rule as T025. `npm run web:build` passes.
- [ ] T028 [US2] `web-client/src/pages/SettingsPage.tsx`: add "Proxy driver" (`proxyDriver`, placeholder `caddy`) and "Proxy config path" (`proxyConfigPath`, placeholder `/etc/caddy/Caddyfile`) fields following the existing field-definition pattern; derived "Caddy IP" → "Proxy IP" reading `derived.proxy`.
- [ ] T029 [US2] Status page wording in `src/commands/networking/render-status-page.ts`: the configuration section heading becomes "Deployed proxy configuration"; update `test/commands/render-status-page.test.ts`.
- [ ] T030 [US2] Checkpoint: `npm run typecheck`, `npm test`, `npm run web:build` pass; `grep -rn "caddyManual\|findCaddyEntry\|syncCaddyLive\|runSyncCaddy\|CADDYFILE_PATH\|sync-caddy\|sync_caddy" src scripts web-client/src test` returns only intentional historical-job fixtures. Commit (`Rename Caddy-specific names to proxy-neutral ones (#10, US2)`).

## Phase 4: User Story 1 — Upgrading changes nothing (P1) 🎯 MVP

**Goal**: an existing database upgrades itself once; the generated block is unchanged.

**Independent test**: quickstart.md sections 2 and 3.

- [ ] T031 [US1] Write failing tests in `test/lib/inventory.test.ts` per data-model.md "Migration states": build an old-schema database in a `mkdtempSync` dir with raw `better-sqlite3` DDL (the pre-change `hosts`/`guests` definitions with `caddy`/`caddy_manual` and a populated `caddy_owner`, plus `meta` and the other tables), insert a host with `caddy = 1` and a guest with `caddy_manual = 1`; `loadInventory` returns them as `proxy: true`/`proxyManual: true`; the database no longer has `caddy`, `caddy_manual`, or `caddy_owner`; exactly one migration log line was written; reopening logs nothing and changes nothing; a fresh database never logs it; a variant without `caddy_manual` columns migrates and gets `proxy_manual` from `ensureColumn`; `saveInventory` afterwards writes `proxy_owner`.
- [ ] T032 [US1] Implement `migrateCaddyToProxy(db)` in `src/lib/inventory.ts`, called from `openInventoryDb` inside one `db.transaction` **before** the `ensureColumn` calls (research.md R7): per table, `ALTER TABLE <t> RENAME COLUMN caddy TO proxy` if `caddy` is present and, independently, `caddy_manual` → `proxy_manual`; `DROP TABLE IF EXISTS caddy_owner`; log `Migrated <tables/columns> from caddy to proxy naming (#10, one-time, irreversible).` via the same logger #158's migration uses, only when something changed. Make T031 pass.
- [ ] T033 [US1] Checkpoint: T001 still passes; full suite passes. Commit (`Upgrade existing inventories to proxy naming on open (#10, US1)`).

## Phase 5: User Story 3 — Unsupported auth modes are refused (P2)

**Goal**: a driver that cannot enforce a route's auth mode stops sync and edits.

**Independent test**: spec US3 acceptance scenarios with a test-only driver.

- [ ] T034 [US3] Write failing tests in `test/commands/sync-proxy.test.ts`: with a registered fake driver whose `authModes` is `['oidc']` selected, a forward-gated entry makes `runSyncProxy` throw the capability message for both dry run and apply, with zero `FakeSSHClient` calls; the thrown message joins every offending entry.
- [ ] T035 [US3] Call `checkCapabilities` in `runSyncProxy` (`src/commands/networking/sync-proxy.ts`) after `buildRoutes`, before `plan`. Make T034 pass.
- [ ] T036 [US3] Write failing tests in `test/operations/edit-guest.test.ts`: with the fake driver active, an edit leaving the edited guest forward-gated is rejected as a 400-class error with the capability message and the inventory file unchanged; an edit to a different, ungated guest succeeds even though another entry is forward-gated; `loadInventory` with `proxyDriver` pointing at the fake driver still loads (FR-013).
- [ ] T037 [US3] In `commitGuestEdit` (`src/operations/edit-guest.ts`), after the edit is applied in memory and validated and before saving, run `checkCapabilities(buildRoutes(updatedInventory), getDriver(updatedInventory))` filtered to the edited guest's owner and reject with the existing 400 error shape. Make T036 pass; confirm `test/web/routes/dashboard.test.ts` shows the 400 through the route.

## Phase 6: User Story 4 — Portable path exemptions (P3)

**Goal**: only `/exact` and `/prefix/*` forms are accepted.

**Independent test**: spec US4 scenarios through set/edit paths.

- [ ] T038 [US4] Write failing tests in `test/lib/inventory.test.ts` and `test/operations/edit-guest.test.ts`: `/health`, `/api/*`, `/*` accepted; `/a*b`, `*/x`, `/api*`, `/*/x`, `/a/*/b` rejected with `must be an exact path (/health) or a prefix ending in /* (/api/*)`, from the schema and from a guest edit.
- [ ] T039 [US4] Tighten the three `unauthenticatedPaths` element schemas in `src/lib/inventory.ts` (hosts, guests, external sites — one shared `UnauthenticatedPathSchema` rather than three copies) to: starts with `/`; `*` only as the final character and only directly after `/`. Make T038 pass; `parsePathPattern` (T005) and the schema must agree — add a test that every string the schema accepts parses.

## Phase 7: User Story 5 — One driver is enough to add a proxy (P3)

**Goal**: demonstrate the seam with a test-only driver.

**Independent test**: SC-005.

- [ ] T040 [US5] Write a test in `test/lib/proxy/index.test.ts` that registers a test-only file driver (via the registry test hook), selects it, runs `runSyncProxy` dry run and `runRenderStatusPage`, and asserts it received the same `ProxyRoute[]` the Caddy driver would and that its preview/snapshot are what the callers return — with no change outside the test file.
- [ ] T041 [US5] README "Reverse proxy drivers" section in `README.md`: what a driver provides (capabilities, plan/apply/snapshot, `fileDriver` for file-configured proxies), that one driver is active per deployment (`proxyDriver`), that proxies without built-in certificate issuance need an operator-managed certificate tool (certbot, acme.sh), and the upgrade note (automatic migration; restart the service with the new code). Also update every README mention of `sync-caddy`, `caddy: true`, `caddyManual`, `CADDYFILE_PATH`.

## Phase 8: Polish & cross-cutting

- [ ] T042 [P] `CLAUDE.md`: replace the `sync-caddy` bullet with a proxy-driver bullet (layers, capability check, file driver's validate-in-place/restore, Caddy driver as the only one), rename every `caddy: true`/`caddyManual`/`syncCaddyLive`/`CADDYFILE_PATH`/`sync-caddy` mention, document the #10 migration next to #158's (forward-only), and record the changed single-operator assumption (no longer tied to Caddy; `TLS_BLOCK` stays single-operator inside the Caddy driver).
- [ ] T043 [P] `CONTRIBUTING.md`: update any restated convention that names Caddy or `sync-caddy`.
- [ ] T044 File the follow-up issue with `gh issue create` for a Caddy admin-API driver (label `enhancement`), summarising research.md R4 (requires `caddy-api.service` with `--resume`, `@id`-tagged routes, hand-authored sites move to JSON); example values only.
- [ ] T045 Run `npm run typecheck`, `npm test`, `npm run web:build`; paste results.
- [ ] T046 Quickstart section 3: read-only dry-run comparison against a temp copy of the deployment checkout's database; diff the preview against the deployed managed block; record "identical" (output not committed).
- [ ] T047 Quickstart section 4: browser check of Dashboard, Advanced modal, Settings, and Maintenance at desktop width and at ≤640px against a temp inventory.
- [ ] T048 Constitution Principle I scan of the full diff (`git diff main...HEAD`) for real hostnames, domains, IPs, or credentials.

## Dependencies & execution order

- T001 before everything (it guards the refactor).
- Phase 2 before all stories. Within it: T002–T003 and T006–T009 can proceed in parallel; T005 needs T003; T010 needs T005, T007, T009; T012 needs T010; T013–T016 need T012.
- US2 (Phase 3) before US1 (Phase 4): the migration moves data to the names US2 introduces.
- US3, US4, US5 each depend only on Phase 2 + US2 and are independent of one another.
- Polish last; T046/T047 need everything else.

## Parallel opportunities

- Phase 2: `T002/T003` ‖ `T006/T007` ‖ `T008/T009`.
- Phase 3: `T024` ‖ `T026` ‖ `T027/T028` once T018–T023 land.
- After US1: US3 ‖ US4 ‖ US5.
- Polish: `T042` ‖ `T043`.

## Implementation strategy

MVP = Phase 1 + Phase 2 + US2 + US1: the seam, the rename, and the automatic upgrade, with
the generated Caddy block proven unchanged. US3–US5 add the guarantees and documentation
future drivers rely on; all ship in this one PR. Commit at each checkpoint and per story.
