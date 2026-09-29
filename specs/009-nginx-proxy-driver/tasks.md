---

description: "Task list for the nginx proxy driver (issue #30)"
---

# Tasks: nginx Proxy Driver

**Input**: Design documents from `specs/009-nginx-proxy-driver/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/nginx-config.md, quickstart.md

**Tests**: Required. Constitution III: every behavior change ships with tests; write each test first and watch it fail.

**Organization**: Grouped by user story. All paths are relative to the worktree root.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)

---

## Phase 1: Setup

No setup needed: no new dependencies, directories, or tooling. `src/lib/proxy/drivers/` and `test/lib/proxy/drivers/` already exist.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The driver id, the two settings, and `ProxyContext.tls` that every story reads.

- [x] T001 Switch the four tests that use `'nginx'` as an unregistered driver id to `'unknown-provider'` (research R10): `test/lib/inventory.test.ts` (~line 1119), `test/lib/proxy/index.test.ts` (~line 60, including the expected `Unknown proxyDriver 'unknown-provider'` message), `test/commands/set-config.test.ts` (~line 121), `test/web/routes/settings.test.ts` (~line 162). Run them; they must still pass before any source change.
- [x] T002 [P] Write failing tests in `test/lib/inventory.test.ts`: `SettingsSchema` accepts `proxyDriver: 'nginx'`; accepts absolute `proxyTlsCertificate`/`proxyTlsKey`; rejects a relative value for each with `must be an absolute path`; `SETTINGS_KEYS` includes both new keys; a `saveInventory`/`loadInventory` round trip keeps both and clearing one (`undefined`) removes it from `meta`.
- [x] T003 [P] Write failing tests in `test/lib/proxy/routes.test.ts`: `buildProxyContext` returns `tls: { certificatePath: '/etc/letsencrypt/live/example.com/fullchain.pem', keyPath: '/etc/letsencrypt/live/example.com/privkey.pem' }` for domain `example.com` with neither setting; returns the configured paths when `proxyTlsCertificate`/`proxyTlsKey` are set; each defaults independently when only one is set.
- [x] T004 Add `'nginx'` to `PROXY_DRIVER_IDS` in `src/lib/proxy/ids.ts` (update its "Only 'caddy' ships today" comment).
- [x] T005 Add `proxyTlsCertificate` and `proxyTlsKey` to `SettingsSchema` in `src/lib/inventory.ts`, each `z.string().regex(/^\//, 'must be an absolute path').optional()`, with a comment matching `proxyConfigPath`'s style saying what unset means (data-model.md "Settings"). Update the `proxyDriver` comment ("unset means the 'caddy' default").
- [x] T006 Add required `tls: { certificatePath: string; keyPath: string }` to `ProxyContext` in `src/lib/proxy/routes.ts`; `buildProxyContext` resolves `inventory.proxyTlsCertificate ?? \`/etc/letsencrypt/live/${inventory.domain}/fullchain.pem\`` and `inventory.proxyTlsKey ?? \`/etc/letsencrypt/live/${inventory.domain}/privkey.pem\`` (research R1/R2), with a comment saying the Caddy driver ignores it.
- [x] T007 Add `tls` to every hand-built `ProxyContext` literal in tests (`test/lib/proxy/file-driver.test.ts`, `test/lib/proxy/routes.test.ts`, and any other file `npm run typecheck` flags). Run `npm run typecheck` and `node --test test/lib/proxy/drivers/caddy.test.ts test/lib/proxy/routes.test.ts test/lib/inventory.test.ts`: T002/T003 now pass and the Caddy characterization test is unchanged and green (FR-013).

**Checkpoint**: settings and context exist; Caddy output byte-identical.

---

## Phase 3: User Story 1 - Generate and deploy nginx configuration (Priority: P1) 🎯 MVP

**Goal**: `proxyDriver nginx` produces, previews, and deploys one owned nginx file for ungated/OIDC routes, with Caddy-equivalent proxying.

**Independent Test**: render tests plus `sync-proxy`/`syncProxyLive` with a `FakeSSHClient` and `proxyDriver: 'nginx'`; the executed-script test proves restore on a failed `nginx -t`.

### Tests for User Story 1 (write first, confirm they fail)

- [ ] T008 [P] [US1] Create `test/lib/proxy/drivers/nginx.test.ts` with render tests asserting exact text per `contracts/nginx-config.md`, built from `buildRoutes`/`buildProxyContext` over example inventories (`example.com`, RFC 5737 IPs): (a) no routes -> the header comment plus both `map` blocks only; (b) one ungated route with two subdomains -> full `server` block, `server_name` canonical first, quoted certificate paths from `ctx.tls`, `client_max_body_size 0;`, `proxy_buffering off;`, and the proxy lines with `proxy_pass http://<ip>:<port>`; (c) `insecureBackendTls: true` -> `proxy_pass https://...` plus `proxy_ssl_verify off;`; (d) port 443 without it -> `https` plus `proxy_ssl_verify on;` and `proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;`; (e) an `authMode: 'oidc'` gated route -> identical to ungated (no `auth_request`, no outpost location); (f) two routes -> two server blocks separated by one blank line; (g) the returned `FileSpec` is `{ path: configPath, mode: 'owned' }`; (h) `nginxDriver` has `id: 'nginx'`, `defaultConfigPath: '/etc/nginx/conf.d/bellhop.conf'`, `capabilities: { authModes: ['forward', 'oidc'], acmeDns01ViaCloudflare: false }`.
- [ ] T009 [P] [US1] In `test/lib/proxy/drivers/nginx.test.ts`, add the executed-script test (research R9), following the existing pattern in `test/lib/proxy/file-driver.test.ts`: build the script with `buildFileDriverScript([{ path: <tmp>/bellhop.conf, mode: 'owned', content }], 'nginx -t', 'systemctl reload nginx')`, run it under `sh` with a stub `nginx` that exits 1 and a stub `systemctl` that records its args, first with an existing file (assert byte-identical restore, non-zero exit, no reload) and then with no prior file (assert the file is removed); then a stub `nginx` that exits 0 (assert new content written and `reload nginx` recorded). Skip gracefully the same way the existing test does if `sh` is unavailable.
- [ ] T010 [P] [US1] In `test/lib/proxy/index.test.ts`, assert `getDriver` returns the nginx driver for `proxyDriver: 'nginx'` and `driverDeps` resolves `configPath` to `/etc/nginx/conf.d/bellhop.conf` when `proxyConfigPath` is unset.
- [ ] T011 [P] [US1] In `test/commands/sync-proxy.test.ts`, add: with `proxyDriver: 'nginx'`, a dry run returns `driver: 'nginx'` and a preview starting with the generated header; `--apply` sends one `runRemote` script to the proxy host that writes `/etc/nginx/conf.d/bellhop.conf` (owned, via `cat >`), runs `nginx -t`, and ends with `systemctl reload nginx` (assert on `FakeSSHClient.history`).
- [ ] T012 [P] [US1] In `test/web/proxy-sync.test.ts`, add: with the real nginx driver active (`proxyDriver: 'nginx'`, not a registered fake), `syncProxyLive` pushes nginx config and skips the ACME prune with the existing `pruneAcmeDriverSkipMessage` line, never calling the Cloudflare client.

### Implementation for User Story 1

- [ ] T013 [US1] Create `src/lib/proxy/drivers/nginx.ts`: header comment and the two `map` blocks (research R3/R8: `$bellhop_connection_upgrade`, `$bellhop_http_host`); a `quote(value)` helper producing an nginx double-quoted string with `\` and `"` backslash-escaped; a proxy-lines helper per contract "Proxy lines" (R4) including the HTTPS-upstream rule (R5); a server-block renderer for ungated/OIDC routes (listen 443 ssl v4+v6, `server_name`, quoted `ssl_certificate`/`ssl_certificate_key` from `ctx.tls`, `client_max_body_size 0`, `proxy_buffering off`, `location /`); exported `render(routes, ctx, configPath): FileSpec[]` returning one `'owned'` FileSpec; and `nginxDriver = fileDriver({ id: 'nginx', capabilities: { authModes: ['forward', 'oidc'], acmeDns01ViaCloudflare: false }, defaultConfigPath: '/etc/nginx/conf.d/bellhop.conf', render, validateCommand: () => 'nginx -t', reloadCommand: 'systemctl reload nginx' })`. Forward-gated routes may render as ungated in this task; US2 adds gating. Comment density and style match `src/lib/proxy/drivers/caddy.ts`.
- [ ] T014 [US1] Register `nginxDriver` in the `DRIVERS` map in `src/lib/proxy/index.ts` and update comments there and in `src/lib/proxy/file-driver.ts` that say Caddy is the only file driver / nginx is a candidate.
- [ ] T015 [US1] Run `npm run typecheck` and `node --test test/lib/proxy test/commands/sync-proxy.test.ts test/web/proxy-sync.test.ts`; T008–T012 pass (T008 case (e) passes; forward cases belong to US2).

**Checkpoint**: MVP — an nginx proxy host can serve every ungated/OIDC entry through `sync-proxy`.

---

## Phase 4: User Story 2 - Authentik forward-auth gating on nginx (Priority: P1)

**Goal**: forward-gated routes are protected exactly as Authentik's nginx recipe prescribes, with exempt paths.

**Independent Test**: render tests for gated routes with and without exempt paths.

### Tests for User Story 2 (write first, confirm they fail)

- [ ] T016 [P] [US2] In `test/lib/proxy/drivers/nginx.test.ts`, add render tests per contract "Forward-gated route" with outpost `192.0.2.20:9000`: (a) gated route, no exempt paths -> `proxy_buffers 8 16k;`/`proxy_buffer_size 32k;` at server level, the full `auth_request` block in `location /` (five identity headers: username, groups, email, name, uid — no entitlements), then the `/outpost.goauthentik.io` location proxying to `http://192.0.2.20:9000/outpost.goauthentik.io` and the `@goauthentik_proxy_signin` location; (b) exempt `/health` and `/api/*` -> `location = "/health"` and `location ^~ "/api/"` after `location /`, each with only proxy lines, in stored order; (c) duplicate exempt entries -> one location each; (d) exempt `/*` -> `location /` has proxy lines only, no `location ^~ "/"`, outpost and sign-in locations still present; (e) an exempt path containing `"` and a space is emitted quoted and escaped; (f) a forward-gated inventory with no `authentik: true` entry still throws the existing missing-authentik error from `buildRoutes` (no nginx-specific handling).

### Implementation for User Story 2

- [ ] T017 [US2] In `src/lib/proxy/drivers/nginx.ts`, render forward-gated routes per research R3/R7 and the contract: server-level buffer lines; auth lines appended to `location /` unless an exempt pattern is `{ kind: 'prefix', path: '/' }`; one location per unique (`kind`,`path`) exempt pattern from `route.auth.exemptPaths` (exact -> `location = <quote(path)>`, prefix -> `location ^~ <quote(path)>`), skipping the root prefix; then the outpost passthrough location and the sign-in named location using `ctx.outpost` (non-null for a forward route, same justification comment as the Caddy driver). Locations separated by one blank line.
- [ ] T018 [US2] Run `node --test test/lib/proxy/drivers/nginx.test.ts`; all US1 and US2 render tests pass.

**Checkpoint**: gated apps are gated on nginx; no combination yields an ungated site Caddy would gate (SC-002).

---

## Phase 5: User Story 3 - Choose the shared certificate (Priority: P2)

**Goal**: the two certificate settings are usable from every front end.

**Independent Test**: set-config and Settings API round trips; Settings page in a browser.

### Tests for User Story 3 (write first, confirm they fail)

- [ ] T019 [P] [US3] In `test/commands/set-config.test.ts`, add: `set-config proxyTlsCertificate /etc/ssl/example/fullchain.pem --apply` and the same for `proxyTlsKey` persist; `--unset` clears; a relative value throws naming the key and `must be an absolute path`; `set-config proxyDriver nginx --apply` persists.
- [ ] T020 [P] [US3] In `test/web/routes/settings.test.ts`, add: `PATCH /api/settings` writes and returns both keys; `null` clears; a relative value is rejected with `proxyTlsCertificate: must be an absolute path` (same rule set-config uses); `proxyDriver: 'nginx'` is accepted.

### Implementation for User Story 3

- [ ] T021 [US3] Add `proxyTlsCertificate?: string` and `proxyTlsKey?: string` to `SettingsValues` in `web-client/src/api/types.ts`.
- [ ] T022 [US3] In `web-client/src/pages/SettingsPage.tsx`, update the `proxyDriver` field's help to name both drivers (`caddy` default, or `nginx`), and add two fields after `proxyConfigPath`: "Proxy TLS certificate" (placeholder `/etc/letsencrypt/live/example.com/fullchain.pem`) and "Proxy TLS key" (placeholder `/etc/letsencrypt/live/example.com/privkey.pem`), each with help saying it is used by the nginx driver for every site, what unset means (certbot's path for the inventory domain), and that the Caddy driver ignores it.
- [ ] T023 [US3] Run `npm test` for the two route/command test files and `npm run web:build`; then verify the Settings page in a browser (`npm run web:dev`, `/settings`) at desktop width and at ≤640px: both new fields render, save, clear, and show the absolute-path error. Stop the dev server by PID afterwards.

**Checkpoint**: all three stories independently functional.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [ ] T024 [P] Update `README.md`: document the nginx driver (selecting it, the owned `/etc/nginx/conf.d/bellhop.conf` file and `proxyConfigPath`, what each site does, forward-auth support), the shared-certificate prerequisite (operator issues/renews a wildcard for the domain, e.g. `certbot certonly --dns-cloudflare -d example.com -d '*.example.com'`, and reloads nginx after renewal via a deploy hook), the two new settings in the settings list, out-of-scope items (port-80 redirect, HTTP/2), and that switching from Caddy leaves the old Caddyfile section for the operator to retire. Replace any "Caddy is the only driver" wording.
- [ ] T025 [P] Update `CLAUDE.md`: add an "nginx driver" bullet next to the "Caddy driver" bullet (file, capabilities, default path, validate/reload, render summary with the Authentik recipe and the `$bellhop_*` naming reason, HTTPS-upstream rule, exempt-path mapping); update every "Caddy is the only driver that ships" / "nginx ... neither ships today" statement; add `ProxyContext.tls` to the driver-interface bullet; add the two settings to the `meta` settings list (now ten); update the Settings page bullet's field list.
- [ ] T026 [P] Check `CONTRIBUTING.md` for statements this change makes stale (driver list, settings); update only if it restates them.
- [ ] T027 Run the full verification: `npm run typecheck`, `npm test`, `npm run web:build`, and quickstart.md §2 against a temp inventory built from `inventory/hosts.yaml.example` (dry runs only). Record output for the PR.

---

## Dependencies & Execution Order

- **Foundational (T001–T007)** blocks everything: US1 needs `'nginx'` in the enum and `ctx.tls`; US3 needs the schema keys.
- **US1 (T008–T015)** before **US2 (T016–T018)**: US2 extends the same render function and test file.
- **US3 (T019–T023)** depends only on Foundational; it can run alongside US1/US2 (different files).
- **Polish (T024–T027)** after all stories.

### Parallel Opportunities

- T002 and T003 (different test files).
- T008–T012 (tests in different files; T008/T009 share `nginx.test.ts` — write them in one pass).
- T019 and T020; T024, T025, T026.
- US3 as a whole in parallel with US1/US2.

## Implementation Strategy

MVP is Phase 2 + US1: an nginx host serving ungated and OIDC entries. US2 makes it safe for gated entries (P1, so it ships in the same PR). US3 exposes the certificate settings in the UI; the CLI can set them as soon as Foundational lands. Commit per phase: Foundational, US1, US2, US3, Polish.
