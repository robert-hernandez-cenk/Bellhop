---

description: "Task list for the Traefik proxy driver"
---

# Tasks: Traefik Proxy Driver

**Input**: Design documents from `specs/015-traefik-proxy-driver/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/traefik-driver.md, quickstart.md

**Tests**: Required by constitution Principle III (every behavior change ships with tests). Write each test first and watch it fail.

**Organization**: Grouped by user story. Paths are relative to the worktree root.

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Setup

- [x] T001 Add `test/lib/proxy/traefik-fixtures.test.ts` asserting every file in `test/fixtures/traefik/` parses as JSON, that `router-enabled.json` has `"status":"enabled"`, that `router-disabled.json` has `"status":"disabled"` and a non-empty `error` array, that `marker-present.json` has `name` starting `bellhop-generation-`, and that no fixture contains an address outside `192.0.2.0/24`/`127.0.0.1` or a domain other than `example.com` (constitution I)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: `fileDriver` support for a hot-reloading proxy, the new id, and the two settings. Blocks every story. Caddy/nginx output must stay byte-identical (FR-016).

- [x] T002 In `src/lib/proxy/file-driver.ts`, make `buildFileDriverScript(files, validateCommand: string | null, reloadCommand: string | null, validateLabel?: string)`: with a `null` validate command, emit no `if ! ...` block; with a `null` reload command, emit no reload line (the trap disarm and backup removal are last); the validate-failure `printf` uses `validateLabel` when given, else the command (unchanged text for Caddy/nginx). Tests in `test/lib/proxy/file-driver.test.ts`: null validate has no `if !`; null reload ends with the last `rm -f "$BAK_...`; a label replaces the command in the failure message; the existing Caddy/nginx-shaped assertions stay unchanged
- [x] T003 In `src/lib/proxy/file-driver.ts`, add `FileSpec.atomic?: boolean` (`'owned'` only). For an atomic owned file the write step is `TMP_i="$(mktemp '<dir>/.<base>.XXXXXX')"`, then `cp -p '<path>' "$TMP_i"` if the file exists else `chmod 644 "$TMP_i"`, then `cat > "$TMP_i" <<'BELLHOP_FILE_i'` ... then `mv -f "$TMP_i" '<path>'`; the trap's restore for an existing file copies the backup to a same-dir temp the same way and `mv -f`s it (a previously absent file is still `rm -f`'d). Non-atomic files are unchanged. Tests: script shape; and an executed-script case under `sh` (the file's existing pattern) proving the new content lands, the mode of a pre-existing `0640` file survives, no `.<base>.*` temp file remains after success, and a failing validate restores the old content with no temp file left
- [x] T004 In `src/lib/proxy/file-driver.ts`, change the `fileDriver` definition to `validateCommand(configPath: string, ctx: { files: FileSpec[]; inventory: Inventory }): string | null`, add optional `validateLabel?: string`, and make `reloadCommand: string | null`; `apply()` passes the plan's files and `deps.inventory`. Caddy (`src/lib/proxy/drivers/caddy.ts`) and nginx (`src/lib/proxy/drivers/nginx.ts`) keep their existing single-arg arrow functions (compatible). Existing driver tests must pass unchanged
- [x] T005 [P] Add `'traefik'` to `PROXY_DRIVER_IDS` in `src/lib/proxy/ids.ts` (order `['caddy', 'nginx', 'nginx-proxy-manager', 'haproxy', 'traefik', 'none']`) and update the ids comment
- [x] T006 [P] Add `usesCertResolver?: boolean` and `usesApiUrl?: boolean` to `ReverseProxyDriver` in `src/lib/proxy/driver.ts` (documented like `usesSharedCertificate`: absent = false, Settings-page hints only), and pass them through `fileDriver`'s definition in `src/lib/proxy/file-driver.ts` the same conditional-spread way
- [x] T007 [P] In `src/lib/inventory.ts` `SettingsSchema`, add `proxyCertResolver: z.string().regex(/^[A-Za-z0-9_-]+$/, ...)` ("must contain only letters, digits, - and _") and `proxyApiUrl` (an `http://` or `https://` URL parsed with `new URL`, containing no `'`; message "must be an http:// or https:// URL"), both optional, with comments like the TLS pair's. Tests in `test/lib/inventory.test.ts` (accept/reject cases, round-trip through `saveInventory`/`loadInventory`) and `test/commands/set-config.test.ts` (set, reject `ftp://x`, unset)
- [x] T008 [P] Add `certResolver: string` to `ProxyContext` in `src/lib/proxy/routes.ts`; `buildProxyContext` sets it to `inventory.proxyCertResolver ?? 'cloudflare'` (constant `DEFAULT_CERT_RESOLVER`, exported). Tests in `test/lib/proxy/routes.test.ts`; fix any test that builds a `ProxyContext` literal by hand

**Checkpoint**: `npm run typecheck` and `npm test` green; no behavior change for existing drivers.

---

## Phase 3: User Story 1 - Publish inventory sites through Traefik (Priority: P1) MVP

**Goal**: `proxyDriver traefik` + `sync-proxy` previews and writes the owned YAML file for ungated/OIDC routes.

**Independent Test**: `test/lib/proxy/drivers/traefik.test.ts` renders example routes and asserts the parsed YAML; `test/commands/sync-proxy.test.ts` runs dry run and apply with a `FakeSSHClient`.

- [x] T009 [US1] Create `src/lib/proxy/drivers/traefik.ts` with `HEADER` ("# Generated by Bellhop sync-proxy. Do not edit: this file is replaced on every apply."), `encodeHostname` (lowercase, `-` -> `--`, then `.` -> `-`), name helpers `routeName`/`exemptName`/`outpostName` (`bellhop-route-<enc>`/`bellhop-exempt-<enc>`/`bellhop-outpost-<enc>`), `ruleValue(v)` (backticks unless `v` contains a backtick, else `JSON.stringify(v)`), and `render(routes, ctx, configPath)`: per route a router (`rule` `Host(..) || Host(..)` canonical first, `entryPoints: [websecure]`, `service`, `middlewares: [bellhop-forwarded-port]`, `tls.certResolver: ctx.certResolver`) and a service (`loadBalancer.servers[0].url` `https://` when `insecureTls` or port 443 else `http://`, plus `serversTransport: bellhop-insecure-backend-tls` when `insecureTls`); always `bellhop-forwarded-port` (`headers.customRequestHeaders.X-Forwarded-Port: String(ctx.externalPort)`); `serversTransports.bellhop-insecure-backend-tls.insecureSkipVerify: true` only when used; empty `routers`/`services` maps omitted; YAML via the `yaml` package; generation marker `bellhop-generation-<first 12 hex of sha256(file without marker)>` (headers middleware `X-Bellhop-Generation: <hash>`, always last middleware); returns `[{ path: configPath, content, mode: 'owned', ownedHeader: HEADER, atomic: true }]`. Export `generationMarkerName(content)` and `routerNames(content)` (parse the YAML, return `http.routers` keys in order, marker name from `http.middlewares` keys) for the validate step
- [x] T010 [US1] Tests in `test/lib/proxy/drivers/traefik.test.ts`: ungated two-hostname route (rule order, entry point, resolver from `ctx.certResolver`, service URL http), port-443 route -> https without transport, `insecureTls` route -> https + transport; OIDC route renders identically to ungated; zero routes -> header + only `bellhop-forwarded-port` and marker middlewares; header is line 1; marker hash stable across two renders and changes when a route changes; `encodeHostname('a.b-c.example.com') !== encodeHostname('a-b.c.example.com')`; `ruleValue` with a backtick path; output equals the contract example's shape for the *wiki* entry
- [x] T011 [US1] Export `traefikDriver = fileDriver({...})` from `src/lib/proxy/drivers/traefik.ts` per `contracts/traefik-driver.md` (label `Traefik`, `capabilities: { authModes: ['forward', 'oidc'], acmeDns01ViaCloudflare: true }`, `defaultConfigPath: '/etc/traefik/dynamic/bellhop.yml'`, `statusPage: null`, `usesCertResolver: true`, `usesApiUrl: true`, the `configPathNote`, `validateCommand` returning `null` for now, `reloadCommand: null`); register it in `src/lib/proxy/index.ts` between HAProxy and None (update the order comment). Tests: `test/lib/proxy/index.test.ts` (`listDrivers()` order, `getDriver` for `traefik`); `test/commands/sync-proxy.test.ts` (dry run previews the file and makes no write; `--apply` sends one script containing the header check, `mv -f`, and no `systemctl`); `test/commands/render-status-page.test.ts` (traefik -> `statusPageUnsupportedError`)

**Checkpoint**: US1 works end to end with no API check.

---

## Phase 4: User Story 2 - Gate sites with Authentik forward-auth (Priority: P1)

**Goal**: forward-gated routes get forward-auth, the outpost router and exempt routers.

**Independent Test**: renderer tests on forward-gated routes.

- [x] T012 [US2] In `render()` (`src/lib/proxy/drivers/traefik.ts`), for a `'forward'` route: add `bellhop-authentik` to the main router's middlewares (after `bellhop-forwarded-port`) unless the route's exempt patterns include the bare `/*` (prefix `/`); add router `bellhop-outpost-<enc>` (rule `(<hosts>) && PathPrefix(`/outpost.goauthentik.io/`)`, service `bellhop-authentik-outpost`, forwarded-port middleware, same entry point/TLS); for exempt patterns — deduped on kind+path in stored order, dropping `/*` and any path equal to `/outpost.goauthentik.io` or under `/outpost.goauthentik.io/` — add router `bellhop-exempt-<enc>` (rule `(<hosts>) && (Path(..) || PathPrefix(..))`, main route's service, forwarded-port middleware only) when any remain; emit shared middleware `bellhop-authentik` (`forwardAuth.address` `http://<outpost ip>:<port>/outpost.goauthentik.io/auth/traefik`, `trustForwardHeader: true`, `authResponseHeaders` `X-authentik-username`, `X-authentik-groups`, `X-authentik-email`, `X-authentik-name`, `X-authentik-uid`) and service `bellhop-authentik-outpost` (`http://<outpost ip>:<port>`) once, only when some forward route exists. Router key order per route: route, outpost, exempt
- [x] T013 [US2] Tests in `test/lib/proxy/drivers/traefik.test.ts`: the contract example's *media* entry (exact YAML structure), `/*`-only exemption (no `bellhop-authentik` on main, no exempt router, outpost router kept), outpost-namespace pattern skipped (and no exempt router when it was the only one), duplicate patterns deduped, OIDC route has no forward-auth objects, and the whole contract example renders to the documented structure

**Checkpoint**: US1 + US2 cover everything a sync writes.

---

## Phase 5: User Story 3 - Catch a configuration Traefik rejects (Priority: P2)

**Goal**: with `proxyApiUrl` set, apply waits for the marker, checks routers, restores on failure.

**Independent Test**: executed-script tests with stubbed `curl`/`sleep` on `PATH`.

- [ ] T014 [US3] In `src/lib/proxy/drivers/traefik.ts`, implement `buildApiCheck(apiUrl, configPath, content)` returning the subshell from `contracts/traefik-driver.md` (trailing `/` stripped from the URL, single-quoted via `singleQuote`; marker polled with `curl -s -o /dev/null -w '%{http_code}' --max-time 5`, 30 attempts, `sleep 1` between; timeout message `Traefik did not load <path> within 30 seconds (<"unreachable" for 000, else "HTTP <code>"> at <api>)`; then one `curl -s --max-time 5` + `case` block per router name reporting `Traefik router <name> is not healthy: <body>`, all routers checked before `exit "$bellhop_failed"`; POSIX sh only). Wire `validateCommand: (path, { files, inventory }) => inventory.proxyApiUrl ? buildApiCheck(inventory.proxyApiUrl, path, files[0].content) : null` and `validateLabel: 'Traefik API check'`
- [ ] T015 [US3] Tests in `test/lib/proxy/drivers/traefik.test.ts`: no `proxyApiUrl` -> the apply script contains no `curl`; with it -> the script contains the marker URL and one router URL per router. Executed-script tests (follow `test/lib/proxy/file-driver.test.ts`'s `sh` + stub pattern; stub `curl` answers from `test/fixtures/traefik/*.json` by URL, stub `sleep` is a no-op, stub `mktemp`-free since real `mktemp` is used): (a) marker 200 + all routers enabled -> exit 0, new file kept; (b) marker never 200 -> exit non-zero, stderr names the timeout and `HTTP 404`, previous file restored; (c) curl returns `000` -> stderr says `unreachable`, restored; (d) one router answers `router-disabled.json` -> stderr names that router and includes its error text, restored; (e) no previous file + failure -> file removed
- [ ] T016 [US3] Test in `test/commands/sync-proxy.test.ts`: with `proxyApiUrl` set and the `FakeSSHClient` returning code 1 with the check's stderr, `sync-proxy --apply` throws with that stderr and the `Traefik API check failed; restored previous configuration` line

**Checkpoint**: validation behaves per FR-012/FR-013.

---

## Phase 6: User Story 4 - Configure the Traefik-only settings (Priority: P2)

**Goal**: Settings page shows the two fields only for Traefik.

**Independent Test**: settings route test + `proxyFieldView` unit tests + browser check.

- [ ] T017 [P] [US4] In `src/web/routes/settings.ts` `proxyDriversInfo()`, add `usesCertResolver: driver.usesCertResolver ?? false` and `usesApiUrl: driver.usesApiUrl ?? false`; add both to `ProxyDriverInfo` and `SettingsValues` in `web-client/src/api/types.ts`. Tests in `test/web/routes/settings.test.ts`: GET lists traefik with both true (others false), PATCH sets/clears both, PATCH `proxyApiUrl: 'ftp://x'` -> 400 with the schema message
- [ ] T018 [P] [US4] In `web-client/src/lib/settings-display.ts`, add `showCertResolverField`/`showApiUrlField` to `ProxyFieldView` (from `usesCertResolver`/`usesApiUrl`; false for unmanaged/unknown drivers). Tests in the existing settings-display test file
- [ ] T019 [US4] In `web-client/src/pages/SettingsPage.tsx`, add FIELDS entries `proxyCertResolver` (label "Proxy cert resolver", placeholder `cloudflare`, help: the Traefik certificate resolver every Bellhop router names; defined in Traefik's static configuration; unset: `cloudflare`) and `proxyApiUrl` (label "Proxy API URL", placeholder `http://127.0.0.1:8080`, help: Traefik's API as reachable from the proxy host; when set every apply waits for Traefik to load the file and checks Bellhop's routers, restoring the previous file on failure; unset: no check), shown only when `view?.showCertResolverField`/`view?.showApiUrlField` (hidden before load, like the TLS fields); update the page description sentence listing driver-dependent fields
- [ ] T020 [US4] Browser check per quickstart "Settings page" at desktop and ≤640px width (web:dev against a temp inventory): Traefik shows both fields and hides status page/TLS fields; Caddy hides both; values persist across switching; `ftp://x` rejected

---

## Phase 7: Polish & Cross-Cutting Concerns

- [ ] T021 [P] Write `docs/reverse-proxy/traefik.md` (static config the operator owns: `websecure` entry point, certificate resolver, file provider directory with `watch: true`, optional API; what Bellhop writes; forward-auth; exempt paths; settings; limits: hot reload means a rejected file was briefly live, the API check cannot detect an undefined resolver (only Traefik's log shows it), 30s load timeout, no status page, Traefik v3 only); link it from `docs/reverse-proxy/README.md` and update that page's driver list and any "drivers that reload" wording
- [ ] T022 [P] Update `docs/configuration.md` (settings table: `proxyDriver` values, `proxyConfigPath` default for traefik, new `proxyCertResolver`/`proxyApiUrl` rows, TLS rows mention traefik ignores them) and `README.md` (driver list line; stay within the 200-line budget)
- [ ] T023 [P] Update `CLAUDE.md`: driver-interface bullet (Traefik is a shipped driver; `fileDriver`'s nullable validate/reload, `validateLabel`, validate ctx, `atomic`), a new "Traefik driver" bullet (rendering, naming, marker, API check, research findings, single-operator assumptions: `websecure`, `cloudflare` default, 30s), settings bullets for the two keys, Settings page bullet (`usesCertResolver`/`usesApiUrl`); `CONTRIBUTING.md` fixture list gains Traefik
- [ ] T024 Run quickstart "Against a local Traefik": load the rendered example file into a local Traefik v3 binary and confirm every router is `enabled` and the marker is served; run the validate block against it for a passing and a broken file
- [ ] T025 Run `npm run typecheck`, `npm test`, `npm run web:build` and record the results

---

## Dependencies & Execution Order

- Phase 2 blocks everything. T002 -> T003 -> T004 are sequential (same file); T005–T008 are parallel with each other and with T002–T004.
- US1 (T009–T011) needs Phase 2. US2 (T012–T013) needs T009. US3 (T014–T016) needs T011. US4 (T017–T020) needs T006/T007 only, so it can run alongside US1–US3.
- Polish needs all stories.

## Parallel Example

```text
After Phase 2: [US1 T009–T011] then [US2 T012–T013] and [US3 T014–T016] in sequence (same file),
while [US4 T017, T018] run in parallel on separate files.
```

## Implementation Strategy

MVP = Phase 2 + US1 (ungated/OIDC sites through Traefik). US2 makes it usable for gated sites; US3 adds the safety net; US4 exposes the settings in the web UI. Commit per phase/story.
