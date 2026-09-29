# Tasks: Caddy Admin-API Proxy Driver

**Input**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/commands-and-messages.md](./contracts/commands-and-messages.md)

**Tests**: required by the constitution (Principle III). Each story's tests
are written first and must fail before its implementation.

## Phase 1: Setup

- [x] T001 Add the captured Caddy v2.10.2 fixtures (example data only) to `test/fixtures/caddy/`: `characterization-adapted.json` (`caddy adapt` of `test/lib/proxy/drivers/caddy.test.ts` `EXPECTED_LINES`), `get-config-empty.txt`, `get-config-routes.txt` (headers and body), `patch-412.txt`, `patch-500.txt`, plus a `README.md` naming the Caddy version and how each was produced

## Phase 2: Foundational (driver seam)

- [x] T002 Add `'caddy-api'` to `PROXY_DRIVER_IDS` in `src/lib/proxy/ids.ts`
- [x] T003 Make `DriverDeps.configPath` `string | null` in `src/lib/proxy/driver.ts` (superseded in the merge by issue #31's identical change; research R8)
- [x] T004 `driverDeps()` resolves `configPath: null` for a driver with no config file, in `src/lib/proxy/index.ts`; `fileDriver` rejects a `null` path (both now from issue #31)
- [x] T005 Test that `driverDeps` gives `caddy-api` `configPath: null` in `test/lib/proxy/index.test.ts`

**Checkpoint**: typecheck and the full suite pass; the Caddy characterization test is unchanged.

## Phase 3: User Story 1 — Publish through the admin API (P1) 🎯 MVP

**Goal**: `sync-proxy` under `caddy-api` previews and applies Bellhop routes.
**Independent test**: `FakeSSHClient` serving the captured `GET /config/`; assert preview, PATCH body, and the no-change run.

- [x] T006 [P] [US1] Renderer and adapter-parity tests in `test/lib/proxy/caddy-json.test.ts`: every characterization route deep-equals `characterization-adapted.json`'s route for the same host (ignoring `@id`), and the TLS policy matches too
- [x] T007 [P] [US1] Admin-call tests in `test/lib/proxy/caddy-admin.test.ts`: exact read/write command text per the contract, parsing a captured `GET` (status, `Etag`, body), exit 4, non-200, 412, and 500 messages
- [x] T008 [US1] Implement `renderRoute(route, ctx)`, `renderTlsPolicy(hostnames)`, and the `bellhop-route-<hostname>`/`bellhop-tls` ids in `src/lib/proxy/caddy-json.ts` (research R1)
- [x] T009 [US1] Implement `planCaddyConfig(current, routes, ctx)`: find the single port-443 server (or create `srv0` on an empty config; error on 0 or >1 per the contract), strip `bellhop-` objects, prepend desired routes and policy, drop the policy when empty, detect add/replace/remove, compare structurally ignoring key order, and `formatCaddyPreview`, in `src/lib/proxy/caddy-json.ts` (R5, R6)
- [x] T010 [US1] Implement `buildReadCommand({ checkService })`, `buildWriteCommand(config, etag)`, `parseAdminResponse`, `readCaddyConfig(deps, opts)`, and `writeCaddyConfig(deps, config, etag)` (zod-validated config) in `src/lib/proxy/caddy-admin.ts` (R2, R3)
- [x] T011 [US1] Driver tests in `test/lib/proxy/drivers/caddy-api.test.ts`: dry run makes one read and no write; apply sends exactly the planned config with `If-Match`; a second run is "No changes" and sends no write; a replaced and a removed route
- [x] T012 [US1] Implement `caddyApiDriver` (`label 'Caddy (admin API)'`, capabilities `forward`/`oidc` + `acmeDns01ViaCloudflare: true`, `defaultConfigPath: null`, status page `/usr/share/caddy/index.html`) in `src/lib/proxy/drivers/caddy-api.ts`, registered right after `caddyDriver` in `src/lib/proxy/index.ts`
- [x] T013 [US1] `runSyncProxy` test with `proxyDriver: 'caddy-api'` in `test/commands/sync-proxy.test.ts`, and a `syncProxyLive` push-live test in `test/web/proxy-sync.test.ts` (FR-012)

## Phase 4: User Story 2 — Never touch operator objects (P1)

**Independent test**: untagged routes (unrelated host, conflicting host, wildcard) and an untagged policy; assert order kept, conflicts reported, and apply throws after writing.

- [x] T014 [P] [US2] Planner tests in `test/lib/proxy/caddy-json.test.ts`: untagged routes kept in original order after Bellhop's; conflict by route in any server and by policy subject (case-insensitive); a wildcard host is not a conflict; the conflicting route and its hostnames are omitted
- [x] T015 [US2] Implement conflict detection in `planCaddyConfig` (`src/lib/proxy/caddy-json.ts`) and the `!` preview lines
- [x] T016 [US2] Driver test and implementation: `apply()` writes the non-conflicting config, then throws the joined conflict message (contract), in `src/lib/proxy/drivers/caddy-api.ts` / `test/lib/proxy/drivers/caddy-api.test.ts`

## Phase 5: User Story 3 — Forward-auth parity (P1)

- [x] T017 [US3] Parity tests for the gated shapes in `test/lib/proxy/caddy-json.test.ts`: forward with no exempt paths (`app`), with exempt paths (`api`), OIDC (`dash`), and gate removal changing the route to ungated. Covered by T006's fixture; add explicit assertions per shape
- [x] T018 [US3] Complete the forward-auth branch of `renderRoute` (outpost `reverse_proxy` with `rewrite`, `handle_response`, sorted copy-headers, `not path` matcher, outpost passthrough subroute) in `src/lib/proxy/caddy-json.ts`

## Phase 6: User Story 4 — Refuse a Caddyfile-mode Caddy (P2)

- [x] T019 [US4] Tests in `test/lib/proxy/drivers/caddy-api.test.ts`: exit 3 gives the Caddyfile-mode error for both dry run and apply with no write sent; exit 7 (curl can't connect) gives the unreachable error naming the host and `localhost:2019`
- [x] T020 [US4] Map exit codes 3/4/other in `readCaddyConfig` (`src/lib/proxy/caddy-admin.ts`) to the contract messages

## Phase 7: User Story 5 — Convert from the Caddyfile driver (P2)

**Independent test**: `FakeSSHClient` returning a captured adapted hand-authored config plus a live config; assert preview, the PATCH body, refusal when already converted, and next steps.

- [x] T021 [P] [US5] Capture `caddy adapt` of an example Caddyfile with a managed section plus one hand-authored site (the managed section stripped) as `test/fixtures/caddy/convert-adapted.json`
- [x] T022 [US5] Tests in `test/commands/convert-caddyfile.test.ts`: adapt command text (temp file beside the Caddyfile, managed section removed); dry run writes nothing; apply PATCHes the planned config with the live `Etag`; refuses when the live config has `bellhop-` objects; missing Caddyfile (exit 5); adapt failure; empty remainder gives `null`; conflict reported like sync-proxy; `--caddyfile` default is `proxyConfigPath ?? /etc/caddy/Caddyfile`
- [x] T023 [US5] Implement `buildAdaptCommand`, `runConvertCaddyfile`, and `formatConvertCaddyfile` in `src/commands/networking/convert-caddyfile.ts`, reusing `planCaddyConfig`/`readCaddyConfig`/`writeCaddyConfig`
- [x] T024 [US5] Wire `bellhop convert-caddyfile [--caddyfile <path>] [--apply]` in `src/cli.ts` (exit 1 on error or remaining conflicts); CLI test in `test/cli.test.ts` if that file covers command registration

## Phase 8: User Story 6 — Status-page snapshot (P3)

- [x] T025 [US6] Tests and implementation: `snapshot()` reads without the service check and pretty-prints; works with an inventory whose forward route has no authentik ip, in `src/lib/proxy/drivers/caddy-api.ts` / `test/lib/proxy/drivers/caddy-api.test.ts`

## Phase 9: Settings page (FR-014)

- [x] T026 [P] List `caddy-api` in the settings route tests (`test/web/routes/settings.test.ts`)
- [x] T027 [P] `proxyFieldView` test: `caddy-api` hides the config path and keeps the status page (`test/web-client/settings-display.test.ts`); the hiding itself comes from issue #31's `defaultConfigPath: null` rule
- [x] T028 Verify the Settings page in a browser at desktop and ≤640px with `caddy-api` selected (constitution IV)

## Phase 10: Polish & cross-cutting

- [x] T029 [P] New `docs/reverse-proxy/caddy-api.md` (prerequisites, `caddy-api.service` with the Cloudflare token in its environment, conversion steps, hand-authored sites, switching away, no file of record, 128 KiB note, known limits); link it from `docs/reverse-proxy/README.md`; add `convert-caddyfile` to `docs/commands.md`; add `caddy-api` to `proxyDriver` in `docs/configuration.md`
- [x] T030 [P] `CLAUDE.md`: a "Caddy admin-API driver" bullet under the proxy bullets, including the single-operator assumptions (FR-017); update "Caddy and nginx are the two drivers that ship" statements
- [x] T031 Run `npm run typecheck`, `npm test`, and `npm run web:build`
- [x] T032 Manual end-to-end run against a real local Caddy per [quickstart.md](./quickstart.md); record the results for the PR description

## Dependencies

Setup → Foundational → US1 → (US2, US3, US4, US6 in any order; they all
extend US1's files) → US5 (reuses the planner and admin calls) → Settings →
Polish. T026/T027/T029/T030 can run in parallel with each other.

## Implementation strategy

MVP is US1 + US2 + US3, since a driver that could overwrite operator routes
or ungate an app is not shippable. US4 and US5 make adoption safe; US6 is
cosmetic. Everything ships in one PR.
