---

description: "Task list for the Nginx Proxy Manager proxy driver"
---

# Tasks: Nginx Proxy Manager Proxy Driver

**Input**: Design documents from `specs/014-nginx-proxy-manager-driver/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/driver-and-client.md, quickstart.md

**Tests**: Required by constitution Principle III (every behavior change ships with tests). Write each test first and watch it fail.

**Organization**: Grouped by user story. Paths are relative to the worktree root.

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Setup

- [x] T001 Confirm the redacted fixtures in `test/fixtures/nginx-proxy-manager/` parse as JSON and contain no `-----BEGIN`, `eyJ` JWT, or `127.0.0.1` strings (add this as an assertion at the top of `test/lib/npm-client.test.ts` so it keeps holding)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Interface support for a file-less managed driver, and the shared nginx body renderer. Blocks every story.

- [x] T002 Add `'nginx-proxy-manager'` to `PROXY_DRIVER_IDS` in `src/lib/proxy/ids.ts` (order: `['caddy', 'nginx', 'nginx-proxy-manager', 'none']`) and update the ids comment
- [x] T003 Change `DriverDeps.configPath` to `string | null` in `src/lib/proxy/driver.ts`; make `driverDeps()` in `src/lib/proxy/index.ts` return `configPath: null` when `driver.defaultConfigPath === null` (ignoring `proxyConfigPath`) instead of throwing; update both comments. Test in `test/lib/proxy/index.test.ts`: a registered test driver with `defaultConfigPath: null` gets `configPath: null` even when `proxyConfigPath` is set
- [x] T004 In `src/lib/proxy/file-driver.ts`, resolve `deps.configPath` through one helper that throws `"<id> driver requires a config path"` when it is `null` (programming error; unreachable for Caddy/nginx); keep `npm run typecheck` green
- [x] T005 [P] In `web-client/src/lib/settings-display.ts`, `proxyFieldView` returns `showConfigPath: false` for a managed driver whose `defaultConfigPath` is `null` (and drops the "Required: this driver has no default." help path); update `test/web-client/settings-display.test.ts` (new case: managed, null config path, null status page, no shared cert -> all three hidden)
- [x] T006 Extract the nginx server-body renderer into `src/lib/proxy/nginx-locations.ts`: `renderServerBody(route, ctx, vars: { host: string; connection: string }): string[]` returning the lines `renderServerBlock` in `src/lib/proxy/drivers/nginx.ts` emits from `client_max_body_size 0;` through the last location (proxy lines, forward-auth lines, exempt locations, outpost/sign-in locations, all `$bellhop_http_host`/`$bellhop_connection_upgrade` uses replaced by `vars.host`/`vars.connection`; `quote`, `isOutpostPrefixed`, dedupe logic move with it). `nginx.ts` calls it with `{ host: '$bellhop_http_host', connection: '$bellhop_connection_upgrade' }`. The existing `test/lib/proxy/drivers/nginx.test.ts` must pass unchanged (byte-identical output); add `test/lib/proxy/nginx-locations.test.ts` asserting the NPM variables (`$http_host`, `$http_connection`) appear and no `$bellhop_http_host`/`$bellhop_connection_upgrade` remains for a forward-gated route with exempt paths

**Checkpoint**: `npm run typecheck` and `npm test` green; no behavior change for existing drivers.

---

## Phase 3: User Story 1 - Publish inventory sites through NPM (Priority: P1) MVP

**Goal**: `sync-proxy` with `proxyDriver: nginx-proxy-manager` creates, updates and deletes Bellhop proxy hosts in NPM.

**Independent Test**: fake `NpmClient` starting empty; dry run lists creates and changes nothing; apply creates marked hosts; a second run reports `No changes`.

### Client

- [x] T007 [P] [US1] Write `test/lib/npm-client.test.ts` (stubbed `fetch` over the fixtures): login posts `{identity, secret}` to `<base>/api/tokens` once and sends `Authorization: Bearer <token>` afterwards; `listProxyHosts` parses `proxy-hosts-list.json` (`locations: null` -> `[]`, `meta` kept as `{nginx_online, nginx_err}`); `listCertificates` parses `certificates-list.json` and the result has **no `meta`** (private key never surfaced); `createProxyHost` returns `{id}` from `proxy-host-create.json`; `deleteProxyHost` accepts `proxy-host-delete.json`; errors: `token-create-bad-password.json` -> the contract's login message naming `NPM_API_EMAIL/NPM_API_PASSWORD`; `proxy-host-create-duplicate-domain.json` -> `"Nginx Proxy Manager API 400 POST /api/nginx/proxy-hosts: app.example.test is already in use"`; `certificate-request-letsencrypt-failure.json` -> message includes the certbot `debug.stack` reason; a rejected fetch -> `"Could not reach Nginx Proxy Manager at <baseUrl>: ..."`; `buildNpmClient` throws `NPM_UNCONFIGURED_MESSAGE` without credentials, derives `http://<proxy ip>:81` without `NPM_API_URL`, and strips a trailing `/` or `/api` from `NPM_API_URL`
- [x] T008 [US1] Implement `src/lib/npm-client.ts` per contracts/driver-and-client.md: `NpmClient`, zod schemas for `NpmProxyHost`/`NpmCertificate` (fields per data-model.md; certificate schema omits `meta`; `expires_on` a string), `RealNpmClient` (lazy login, `NPM_REQUEST_TIMEOUT_MS = 10_000`, `NPM_CERTIFICATE_TIMEOUT_MS = 180_000`, error mapping incl. `debug.stack`), `NPM_UNCONFIGURED_MESSAGE`, `buildNpmClient(inventory, fetchImpl = fetch)` reading `NPM_API_URL`/`NPM_API_EMAIL`/`NPM_API_PASSWORD`
- [x] T009 [P] [US1] Load `data/nginx-proxy-manager.env` with `dotenv.config({ path: path.join(dataDir(), 'nginx-proxy-manager.env'), quiet: true })` next to the existing `cloudflare-api.env` load in `src/cli.ts`, `src/web/server.ts`, `src/mcp/server.ts`, with a comment matching theirs

### Driver core

- [x] T010 [US1] Write `test/lib/proxy/drivers/nginx-proxy-manager.test.ts` with an in-memory `FakeNpmClient` (records calls, assigns ids, stores hosts/certs, lets a test set `meta.nginx_online=false` on write): (a) empty NPM + two ungated routes + a covering wildcard cert -> preview has two `+ create` lines and the change count; `apply` creates two hosts whose `advanced_config` first line is `NPM_OWNERSHIP_MARKER`, `domain_names` canonical-first, `forward_scheme` `http` (and `https` for a port-443 route and an `insecureTls` route), `ssl_forced/http2_support/allow_websocket_upgrade/enabled` true, `block_exploits/caching_enabled/hsts_enabled/hsts_subdomains/trust_forwarded_proto` false, `access_list_id` 0, `locations` []; (b) re-plan against the result -> `No changes` and apply makes zero writes; (c) port change -> `~ update ... (#id): forward_port, advanced_config`, applied with `updateProxyHost` on the same id; (d) an owned host whose canonical matches no route -> `- delete`, and apply deletes before any update/create; (e) a write whose read-back has `nginx_online: false` -> apply throws the contract message including `nginx_err`; (f) `insecureTls` route's `advanced_config` contains `proxy_ssl_verify off;`, port-443 route contains `proxy_ssl_verify on;`
- [x] T011 [US1] Implement `src/lib/proxy/drivers/nginx-proxy-manager.ts`: `NPM_OWNERSHIP_MARKER`, `isOwned(host)`, `desiredProxyHost(route, ctx, certificate)` (research R9; `advanced_config = [NPM_OWNERSHIP_MARKER, ...renderServerBody(route, ctx, { host: '$http_host', connection: '$http_connection' })].join('\n')`), `planNpmSync(routes, ctx, hosts, certs)` returning `NpmSyncPlan` (data-model.md matching rules 1-4 and field comparison), `formatNpmPlan(plan, baseUrl)` (contract preview), and `createNpmDriver({ clientFor })` with `plan`/`apply` (order: deletes -> updates -> creates; read-back check) per the contract; export `nginxProxyManagerDriver = createNpmDriver({ clientFor: (inventory) => buildNpmClient(inventory) })` with the contract's metadata
- [x] T012 [US1] Register `nginxProxyManagerDriver` in `src/lib/proxy/index.ts` between nginx and none; update `test/lib/proxy/index.test.ts` (listDrivers order Caddy, nginx, Nginx Proxy Manager, No proxy; `getDriver` resolves the new id) and any test pinning the driver list or the Settings `proxyDrivers` response (`test/web/routes/settings*.test.ts`)
- [x] T013 [US1] Test and confirm the `sync-proxy` command path works with the new driver in `test/commands/sync-proxy.test.ts` (register a `createNpmDriver` instance with a fake client via `registerDriverForTests`; dry run returns its preview and `applied: false`; `--apply` returns `applied: true`); fix `src/commands/networking/sync-proxy.ts`/`src/web/proxy-sync.ts` only if they assume a non-null `configPath`

**Checkpoint**: US1 works end to end with a fake client.

---

## Phase 4: User Story 2 - Never touch proxy hosts Bellhop did not create (Priority: P1)

**Goal**: unmarked hosts are never modified; overlaps are conflicts.

**Independent Test**: fake NPM with an unmarked host on a route hostname and another on an unrelated hostname; neither is written; the conflict is previewed and apply throws after applying the rest.

- [x] T014 [US2] Add tests to `test/lib/proxy/drivers/nginx-proxy-manager.test.ts`: (a) an unmarked host for an unrelated hostname is never updated or deleted; (b) an unmarked host claiming a route's non-canonical hostname -> `! conflict` preview line naming hostname and `#id`; apply creates the other routes, never writes that host, then throws the contract's conflict message; (c) an owned host whose marker line was removed is treated as unmarked; (d) matching is case-insensitive on hostnames
- [x] T015 [US2] Implement the conflict path in `src/lib/proxy/drivers/nginx-proxy-manager.ts` (matching rule 3; conflict routes skipped in apply; final throw) until T014 passes

**Checkpoint**: US1 + US2 green.

---

## Phase 5: User Story 3 - Authentik forward-auth (Priority: P2)

**Goal**: forward-gated routes carry the Authentik recipe; OIDC/ungated carry none.

**Independent Test**: sync a forward-gated route with `/api/*` and `/health` exempt; `advanced_config` holds `auth_request /outpost.goauthentik.io/auth/nginx;`, `location ^~ "/api/"`, `location = "/health"`, `location /outpost.goauthentik.io`, `location @goauthentik_proxy_signin`, all using `$http_host`; an OIDC route has none of these; removing the gate is previewed as an `advanced_config` update.

- [x] T016 [US3] Add those assertions to `test/lib/proxy/drivers/nginx-proxy-manager.test.ts`, plus: the outpost `proxy_pass` targets `ctx.outpost` ip:port; a `/*` exemption leaves no `auth_request` line; an exempt path under `/outpost.goauthentik.io/` is skipped
- [x] T017 [US3] Make T016 pass (expected to need no driver changes beyond T006/T011; fix `src/lib/proxy/nginx-locations.ts` or the driver if not)

---

## Phase 6: User Story 4 - Certificates without manual steps (Priority: P2)

**Goal**: reuse a covering unexpired certificate, else request one.

**Independent Test**: wildcard present -> both hosts use it and no request; no covering certificate -> preview says request, apply calls `requestCertificate(hostnames)` before creating, and the host uses the new id.

- [x] T018 [US4] Add tests to `test/lib/proxy/drivers/nginx-proxy-manager.test.ts` for `certificateCovers`/selection (research R8): exact match and one-level wildcard (`*.example.com` covers `app.example.com`, not `a.b.example.com` nor `example.com`); case-insensitive; a certificate covering only some of a route's hostnames is not used; an expired (`expires_on` in the past, UTC) or unparseable one is not used; the current certificate is kept while it still qualifies; otherwise latest `expires_on` then lowest id; no candidate -> `{ kind: 'request' }`, preview `[certificate: request Let's Encrypt for ...]`, apply calls `requestCertificate` right before that route's create/update and uses the returned id; a failed request throws with the route named and no host created for that route
- [x] T019 [US4] Implement certificate coverage/selection/request in `src/lib/proxy/drivers/nginx-proxy-manager.ts` (take "now" as an injectable parameter of `planNpmSync` for deterministic tests) until T018 passes

---

## Phase 7: User Story 5 - Configure and inspect (Priority: P3)

**Goal**: clear configuration errors, Settings page hides unused fields, snapshot, status page.

**Independent Test**: missing credentials error names the file; Settings view hides fields; `render-status-page` reports no status page.

- [x] T020 [P] [US5] Implement and test `snapshot()` (contract format, never any PEM) in `src/lib/proxy/drivers/nginx-proxy-manager.ts` / `test/lib/proxy/drivers/nginx-proxy-manager.test.ts`
- [x] T021 [P] [US5] Test in `test/commands/render-status-page.test.ts` that with the NPM driver active `runRenderStatusPage` throws `statusPageUnsupportedError('nginx-proxy-manager')` and `statusPageSkipReason` returns the managed-but-no-status-page reason
- [x] T022 [US5] Verify `syncProxyLive` skips `prune-acme-challenges` for this driver (`acmeDns01ViaCloudflare: false`) — covered by an assertion in `test/web/proxy-sync.test.ts` or confirm existing generic coverage and note it in the test

---

## Phase 8: Polish & Cross-Cutting Concerns

- [ ] T023 [P] Write `docs/reverse-proxy/nginx-proxy-manager.md` (selection, `data/nginx-proxy-manager.env`, URL default, ownership marker and conflicts, certificate behavior incl. HTTP-01 needs public port 80 and wildcard reuse, forward-auth, what NPM settings Bellhop forces, `nginx_online` failures, no status page, single-deployment assumptions); link it from `docs/reverse-proxy/README.md` and wherever the README/docs index lists drivers; add the three variables to `docs/environment-variables.md`; keep README within 200 lines (`test/docs/links.test.ts`)
- [ ] T024 [P] Update `CLAUDE.md`: driver-interface bullet (four registered drivers; NPM is the first file-less managed driver; `configPath: string | null`; Settings hides config path for `defaultConfigPath: null`), a new "Nginx Proxy Manager driver" bullet (client, env file loaded by the three entry points, marker, matching, certificates, read-back, timeouts, private-key stripping, single-deployment assumptions); mention the new env file where `cloudflare-api.env` is listed for new worktrees; check `CONTRIBUTING.md` for anything restated
- [ ] T025 Run `npm run typecheck`, `npm test`, `npm run web:build`
- [ ] T026 Run quickstart.md §2-§4 against the local NPM container through the real CLI with a temp inventory (scenarios a-i, k) and record results
- [ ] T027 Browser-check the Settings page with the NPM driver selected at desktop width and at ≤640px (scenario j)

---

## Dependencies & Execution Order

- Phase 2 blocks everything. T006 (renderer) blocks T011.
- US1 (T007-T013) before US2-US5 (they extend the same driver file and test file).
- US2, US3, US4 are independent of each other after US1; US5 after US1.
- Polish after all stories; T026/T027 last.

## Parallel Opportunities

- T005 alongside T002-T004/T006.
- T007 and T009 alongside each other; T020/T021 alongside each other.
- T023/T024 alongside each other.

## Implementation Strategy

MVP = Phases 1-3 (a working driver with a fake client). Then US2 (safety for existing NPM installs), US3, US4, US5, polish, live verification.
