---

description: "Task list for TLS Without Cloudflare (issue #51)"
---

# Tasks: TLS Without Cloudflare

**Input**: Design documents from `specs/051-tls-without-cloudflare/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/rendering-and-settings.md

**Tests**: Required (constitution Principle III). Write each story's tests first and watch them fail.

**Organization**: Tasks are grouped by user story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Setup

- [x] T001 Capture Caddy v2.10.2 adapter output per mode into `test/fixtures/caddy/tls-{letsencrypt,internal,files}-adapted.json` and document them in `test/fixtures/caddy/README.md` (done during planning, research R1)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the setting, the context field, and the contract change every story builds on.

- [ ] T002 Add tests in `test/lib/inventory.test.ts` and `test/commands/set-config.test.ts`: `proxyCaddyTls` accepts exactly `cloudflare`, `letsencrypt`, `internal`, `files` ("Validation: `z.enum(['cloudflare','letsencrypt','internal','files'])`"), rejects any other value, round-trips through `saveInventory`/`loadInventory`, and clears with `--unset`
- [ ] T003 Add `proxyCaddyTls: z.enum(CADDY_TLS_MODES).optional()` to `SettingsSchema` in `src/lib/inventory.ts`, with `CADDY_TLS_MODES = ['cloudflare','letsencrypt','internal','files'] as const` and type `CaddyTlsMode` exported from `src/lib/proxy/ids.ts` (inventory.ts already imports from there without a cycle); comment in the existing style
- [ ] T004 Add tests in `test/lib/proxy/routes.test.ts`: `buildProxyContext(inv).caddyTls` is `'cloudflare'` when unset and the setting's value otherwise; `caddyTlsMode(inv)` matches
- [ ] T005 Add `DEFAULT_CADDY_TLS = 'cloudflare'`, exported `caddyTlsMode(inventory)`, and `ProxyContext.caddyTls` (always present) in `src/lib/proxy/routes.ts`
- [ ] T006 Change `DriverCapabilities.acmeDns01ViaCloudflare` to `(inventory: Inventory) => boolean` and add `usesCaddyTls?: boolean` (doc comment following `usesSharedCertificate`/`usesCertResolver`) in `src/lib/proxy/driver.ts`; give `nginx`, `nginx-proxy-manager`, `haproxy`, `none` `() => false` and `traefik`/`caddy`/`caddy-api` `() => true` for now; update every test literal and `deepEqual` on `capabilities` across `test/` (see `grep -rn acmeDns01ViaCloudflare test`) so `npm run typecheck` and `npm test` pass unchanged

**Checkpoint**: typecheck and the full suite green; no rendered output has changed.

---

## Phase 3: User Story 1 - Caddy without Cloudflare (Priority: P1) 🎯 MVP

**Goal**: both Caddy drivers render each `proxyCaddyTls` mode; unset is byte-identical to today.

**Independent Test**: `sync-proxy` dry run under each Caddy driver per mode (quickstart §2).

### Tests for User Story 1

- [ ] T007 [P] [US1] In `test/lib/proxy/drivers/caddy.test.ts`: unset and `cloudflare` render exactly `EXPECTED_LINES` (existing characterization); `letsencrypt` renders the same block with every TLS clause removed; `internal` with `    tls internal`; `files` with `    tls /etc/letsencrypt/live/example.com/fullchain.pem /etc/letsencrypt/live/example.com/privkey.pem`, and with `proxyTlsCertificate`/`proxyTlsKey` set uses those; a path containing a space or `"` is emitted as a double-quoted token with `\`/`"` escaped (research R6); `caddyDriver.usesCaddyTls === true`
- [ ] T008 [P] [US1] In `test/lib/proxy/caddy-json.test.ts`: for each mode, the Bellhop TLS objects `planCaddyConfig(null, routes, ctx, host)` writes equal the corresponding objects in `test/fixtures/caddy/{characterization,tls-internal,tls-files,tls-letsencrypt}-adapted.json` under `canonicalJson`, ignoring Bellhop `@id`s and with tag `bellhop-cert` in place of `cert0` (contract "Caddy JSON"); `letsencrypt` writes no `apps.tls` at all; routes are identical across modes
- [ ] T009 [P] [US1] In `test/lib/proxy/caddy-json.test.ts`: reconciliation — switching a live config from `cloudflare` to `files` removes `bellhop-tls` and adds `bellhop-tls-files`/`bellhop-tls-connection`/`bellhop-tls-default`; switching `files` to `internal` removes all three, prunes empty `tls_connection_policies`/`load_files`/`certificates`, and adds the internal policy; untagged automation policies, `load_files` entries and connection policies are never altered; `bellhop-tls-default` is omitted when the target server already has an untagged policy with no `match`; zero kept routes writes no TLS objects in any mode; untagged automation policies claim hostnames (conflicts) only in `cloudflare`/`internal` (research R4); an unchanged config plans `config: null` in every mode
- [ ] T010 [P] [US1] In `test/lib/proxy/caddy-json.test.ts`: `formatCaddyPreview` prints the contract's `+`/`-`/`~` lines for `tls certificate files` and `tls connection policy`; `test/lib/proxy/drivers/caddy-api.test.ts` asserts `caddyApiDriver.usesCaddyTls === true`

### Implementation for User Story 1

- [ ] T011 [US1] In `src/lib/proxy/drivers/caddy.ts`: replace the fixed `TLS_BLOCK` push with a per-mode clause from `ctx.caddyTls` (contract table), add the Caddyfile path-quoting helper, set `usesCaddyTls: true` on `caddyDriver`; rewrite the TLS_BLOCK comment so it no longer calls Cloudflare DNS-01 the only, non-configurable path
- [ ] T012 [US1] In `src/lib/proxy/caddy-json.ts`: replace `renderTlsPolicy` with mode-aware rendering of the Bellhop TLS objects (`bellhop-tls` policy for `cloudflare`/`internal`; `bellhop-tls-files` + `bellhop-tls-connection` + conditional `bellhop-tls-default` for `files`; nothing for `letsencrypt`), extend `ConfigObjectSchema` to type `apps.tls.certificates.load_files` and servers' `tls_connection_policies` (passthrough), extend `planCaddyConfig` to strip/add/prune these objects on the target server per research R3 and gate policy conflicts per R4, add `CaddyChange.object` values `'tls-files'`/`'tls-connection'` with their change detection, and extend `formatCaddyPreview`
- [ ] T013 [US1] In `src/lib/proxy/drivers/caddy-api.ts`: set `usesCaddyTls: true`; confirm `plan()` passes `ctx` (carrying `caddyTls`) into `planCaddyConfig`; check `src/commands/networking/convert-caddyfile.ts` still compiles and behaves with the new planner signature
- [ ] T014 [US1] Run `npm run typecheck` and `npm test`; all of T007–T010 pass and the pre-existing Caddy characterization and parity tests are unchanged

**Checkpoint**: US1 delivers Caddy without Cloudflare through the CLI.

---

## Phase 4: User Story 2 - Settings page shows the Caddy TLS option (Priority: P2)

**Goal**: dropdown for Caddy drivers; certificate/key fields in `files` mode.

**Independent Test**: quickstart §4 at desktop and ≤640px.

### Tests for User Story 2

- [ ] T015 [P] [US2] In `test/web/routes/settings.test.ts`: GET/PATCH responses carry `caddyTlsModes: ['cloudflare','letsencrypt','internal','files']`, `defaultCaddyTls: 'cloudflare'`, and `proxyDrivers[].usesCaddyTls` (true only for `caddy`/`caddy-api`); PATCH `proxyCaddyTls: 'bogus'` → 400 with the same zod message `set-config` gives; PATCH `null` clears it
- [ ] T016 [P] [US2] In `test/web-client/settings-display.test.ts`: `proxyFieldView` gains a Caddy TLS argument; `showCaddyTlsField` true only for a `usesCaddyTls` driver; `showTlsFields` true for `usesSharedCertificate`, or `usesCaddyTls` with mode `files`, false for Caddy in any other mode and for Traefik; a `caddyTlsOptions(modes, defaultMode)` helper labels only the default `cloudflare (default)`

### Implementation for User Story 2

- [ ] T017 [US2] In `src/web/routes/settings.ts`: add `usesCaddyTls` to `proxyDriversInfo()` and `caddyTlsModes`/`defaultCaddyTls` to `settingsResponse()`
- [ ] T018 [US2] In `web-client/src/api/types.ts` and `web-client/src/lib/settings-display.ts`: add the response fields, `caddyTlsOptions`, `showCaddyTlsField`, and the new `showTlsFields` rule
- [ ] T019 [US2] In `web-client/src/pages/SettingsPage.tsx`: add a `proxyCaddyTls` FIELDS entry (label "Caddy TLS", help naming the four modes and what each needs) rendered as a `<select>` like `proxyDriver` (disabled until loaded), shown per `showCaddyTlsField`; pass `drafts.proxyCaddyTls || data.defaultCaddyTls` to `proxyFieldView`; certificate/key fields' help mentions Caddy `files` mode; hiding never edits stored values
- [ ] T020 [US2] Run `npm run typecheck`, `npm test`, `npm run web:build`; verify the Settings page in a browser at desktop width and at ≤640px via `npm run demo` (quickstart §4)

**Checkpoint**: US2 complete.

---

## Phase 5: User Story 3 - Traefik with no certificate resolver (Priority: P3)

**Goal**: `proxyCertResolver: none` renders `tls: {}`.

### Tests for User Story 3

- [ ] T021 [P] [US3] In `test/lib/proxy/drivers/traefik.test.ts`: with `proxyCertResolver: 'none'`, every router (main, exempt, outpost) has `tls: {}`; with a named or unset resolver output is unchanged

### Implementation for User Story 3

- [ ] T022 [US3] In `src/lib/proxy/drivers/traefik.ts` (or `routes.ts` beside `DEFAULT_CERT_RESOLVER`): export `NO_CERT_RESOLVER = 'none'` and render `tls: {}` at all three router sites when `ctx.certResolver === NO_CERT_RESOLVER`; update the `proxyCertResolver` comment in `src/lib/inventory.ts` to say `none` is reserved

**Checkpoint**: US3 complete.

---

## Phase 6: User Story 4 - Stale challenge cleanup follows the TLS mode (Priority: P3)

**Goal**: the Cloudflare prune runs only when the active driver is configured for Cloudflare DNS-01.

### Tests for User Story 4

- [ ] T023 [P] [US4] In `test/lib/proxy/index.test.ts` (or `driver.test.ts`): `caddyDriver`/`caddyApiDriver.capabilities.acmeDns01ViaCloudflare(inv)` is true for unset/`cloudflare` and false for the other three modes; `traefikDriver`'s is false only for resolver `none`; the other four drivers always false
- [ ] T024 [P] [US4] In `test/web/proxy-sync.test.ts`: Caddy with `proxyCaddyTls: 'internal'` skips the prune with the driver skip message and never calls Cloudflare; Caddy unset still prunes; Traefik with `none` skips; update any assertion on the skip message text to the contract's new wording

### Implementation for User Story 4

- [ ] T025 [US4] Implement the real capability functions in `src/lib/proxy/drivers/caddy.ts`, `caddy-api.ts`, `traefik.ts` (contract "Cloudflare prune decision"), and in `src/web/proxy-sync.ts` call `driver.capabilities.acmeDns01ViaCloudflare(inventory)` and change `pruneAcmeDriverSkipMessage` to "is not configured to use ACME DNS-01 via Cloudflare"; update the comments there and in `src/lib/proxy/index.ts` that describe a fixed capability

**Checkpoint**: US4 complete.

---

## Phase 7: User Story 5 - Every driver documents both routes (Priority: P2)

**Goal**: documentation per FR-014/FR-015.

- [ ] T026 [P] [US5] `docs/reverse-proxy/README.md`: per-driver TLS options table (Let's Encrypt without Cloudflare / self-signed), replace "Caddy issues its own via Cloudflare DNS-01" as the only path and the fixed-capability description at line ~31, and add the driver-authoring rule that every driver's page documents both routes
- [ ] T027 [P] [US5] `docs/reverse-proxy/caddy.md` and `docs/reverse-proxy/caddy-api.md`: the four `proxyCaddyTls` modes with requirements (`letsencrypt`: ports 80/443 reachable from the internet; `internal`: Caddy's root CA trusted on clients; `cloudflare`: a Caddy build with `caddy-dns/cloudflare`; `files`: the certificate/key settings and their certbot defaults), and that switching modes needs only a sync
- [ ] T028 [P] [US5] `docs/reverse-proxy/traefik.md`: `proxyCertResolver: none` (reserved name; routers get `tls: {}`; certificates from the file provider or Traefik's default) and an example HTTP-01 resolver in static configuration
- [ ] T029 [P] [US5] `docs/reverse-proxy/nginx.md`: a `certbot --webroot`/`--standalone` recipe and an `openssl` self-signed recipe alongside the Cloudflare one
- [ ] T030 [P] [US5] `docs/reverse-proxy/nginx-proxy-manager.md`: HTTP-01 is the default request; an uploaded custom certificate (self-signed or otherwise) covering every hostname of a route, unexpired, is reused instead (research R10)
- [ ] T031 [P] [US5] `docs/reverse-proxy/haproxy.md`: the frontend certificate is the operator's; pointers to a non-Cloudflare Let's Encrypt route (certbot HTTP-01) and a self-signed route
- [ ] T032 [P] [US5] `docs/configuration.md`: a `proxyCaddyTls` row and the reserved `none` note on `proxyCertResolver`; `inventory/hosts.yaml.example`: replace "Cloudflare DNS-01 TLS regardless" wording

**Checkpoint**: `npm test` (includes `test/docs/links.test.ts`) passes.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [ ] T033 Update `CLAUDE.md`: the Caddy driver, Caddy admin-API driver, reverse-proxy driver-interface (single-operator assumption: Cloudflare DNS-01 now the default, not unavoidable), Traefik, `prune-acme-challenges`, and Settings page bullets; the driver contract's capability is now a function and `usesCaddyTls` exists
- [ ] T034 [P] Mark the out-of-scope line in `specs/006-reverse-proxy-driver/spec.md` (Cloudflare DNS-01 configuration) as superseded by issue #51; update `CONTRIBUTING.md` only if it restates proxy-driver or TLS rules
- [ ] T035 Regenerate `docs/images/settings-proxy-driver.png` with `npm run docs:screenshots` and check it by eye for example-only values
- [ ] T036 Run quickstart.md §1–§2 against a temp inventory and record results; full `npm run typecheck`, `npm test`, `npm run web:build`

---

## Dependencies & Execution Order

- Phase 2 blocks every story (setting, `ProxyContext.caddyTls`, contract type).
- US1 (Phase 3) is the MVP and independent of US2–US5.
- US2 depends on Phase 2 only (reads `usesCaddyTls`, set in T011/T013 — if US2 runs first, set the two flags as part of T017).
- US3 and US4 depend on Phase 2 only; US4's Caddy assertions rely on `caddyTlsMode` (T005).
- US5 can run any time; its content should match the final behaviour, so finish it after US1–US4.
- Polish last.

## Parallel Opportunities

- T007–T010 are all test files and can be written together.
- T015/T016, T021, T023/T024 are independent test tasks.
- T026–T032 are separate doc files.

## Implementation Strategy

MVP = Phase 2 + US1: Caddy usable without Cloudflare from the CLI. Then US2
(Settings), US3 and US4 (small), US5 docs, then polish. Commit per story.
