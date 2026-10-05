---

description: "Task list for the driver-independent TLS source setting (#72)"
---

# Tasks: One TLS source setting, independent of the proxy driver

**Input**: Design documents from `specs/072-tls-source-setting/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Required (constitution Principle III, TDD per task): every behavior task below is preceded by or includes a failing test first.

**Organization**: One phase per user story. Each phase ends with `npm run typecheck` and `npm test` green (paths are relative to the worktree root). US1 must land before US2–US5 because it swaps the setting the others read. Docs and nested `CLAUDE.md` text describing a behavior are updated in the phase that changes it.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: User story the task belongs to (US1–US5)

---

## Phase 1: Setup

- [x] T001 Confirm baseline in the worktree: `npm run typecheck` and `npm test` pass (2800 pass / 2 skipped recorded at worktree creation); no code change

---

## Phase 2: Foundational (blocking, additive only — nothing existing changes behavior)

- [x] T002 Add to `src/lib/proxy/ids.ts`: `TLS_SOURCES = ['acme-dns', 'acme-http', 'internal', 'files', 'external'] as const`, `type TlsSource`, `ACME_DNS_PROVIDERS = ['cloudflare'] as const`, `type AcmeDnsProvider`, `DEFAULT_ACME_DNS_PROVIDER: AcmeDnsProvider = 'cloudflare'`; move `DEFAULT_PROXY_DRIVER_ID` here from `src/lib/proxy/index.ts` and re-export it from `index.ts` so existing imports keep working. Comment each the way the existing constants are commented.
- [x] T003 Add `tlsSources: TlsSource[]` and `defaultTlsSource: TlsSource` to `DriverCapabilities` in `src/lib/proxy/driver.ts` (keep `acmeDns01ViaCloudflare` for now) and declare them on every driver per data-model.md: `caddy`/`caddy-api` [acme-dns, acme-http, internal, files] default acme-dns (`src/lib/proxy/drivers/caddy.ts`, `caddy-api.ts`); `traefik` [acme-dns, acme-http, files, external] default acme-dns (`traefik.ts`); `nginx` [files] default files (`nginx.ts`); `nginx-proxy-manager` [acme-http] default acme-http (`nginx-proxy-manager.ts`); `haproxy` [external] default external (`haproxy.ts`); `none` all five, default external (`none.ts`). Add a test in `test/lib/proxy/index.test.ts` asserting every registered driver's `defaultTlsSource` is in its `tlsSources` and pinning the table above.
- [x] T004 Add `tlsSource: z.enum(TLS_SOURCES).optional()` and `acmeDnsProvider: z.enum(ACME_DNS_PROVIDERS).optional()` to `SettingsSchema` in `src/lib/inventory.ts` (keep `proxyCaddyTls` for now), with comments; test in `test/lib/inventory.test.ts` that both round-trip through `saveInventory`/`loadInventory` and that an out-of-list value is rejected on load.
- [x] T005 [P] Create `src/lib/proxy/tls.ts` with `effectiveTlsSource(inventory, driver)` (`inventory.tlsSource ?? driver.capabilities.defaultTlsSource`), `acmeDnsProvider(inventory)` (`?? DEFAULT_ACME_DNS_PROVIDER`), `checkTlsSource(inventory, driver): string | null` (message exactly as contracts/rendering-and-messages.md "Refusal", built with `settingFix` from `src/lib/settings-hint.ts`, fix value = the driver's `defaultTlsSource`), and `usesCloudflareDns01(inventory, driver)` (`acme-dns` && `cloudflare`). TDD in new `test/lib/proxy/tls.test.ts`: unset resolves to each driver's default; supported → null; unsupported → exact message; `none` driver accepts everything; prune predicate truth table.
- [x] T006 [P] Create `src/lib/proxy/legacy-tls.ts` with pure `convertLegacyTlsSettings({ proxyDriver?, proxyCaddyTls?, proxyCertResolver?, tlsSource? }): { tlsSource?: TlsSource; remove: Array<'proxyCaddyTls' | 'proxyCertResolver'>; description?: string }` implementing the data-model.md "Legacy conversion" table exactly (active driver = `proxyDriver ?? DEFAULT_PROXY_DRIVER_ID`; caddy/caddy-api map `cloudflare`→`acme-dns`, `letsencrypt`→`acme-http`, `internal`→`internal`, `files`→`files`; traefik maps `proxyCertResolver: 'none'`→`external`; never overwrite an existing `tlsSource`; always remove `proxyCaddyTls`; remove `proxyCertResolver` only when it is `'none'`; `description` is the `<details>` text for the log line). Imports only `ids.ts`. TDD in new `test/lib/proxy/legacy-tls.test.ts` covering every table row plus "both legacy values present" and "nothing to do" (returns no tlsSource, empty remove, no description).

**Checkpoint**: typecheck + tests green; no behavior change. Commit `Add TLS source constants, capability and helpers (#72)`.

---

## Phase 3: User Story 1 — Choose where certificates come from with one setting (P1) 🎯 MVP

**Goal**: Renderers read the effective `tlsSource`; `proxyCaddyTls` and the reserved `proxyCertResolver: none` are gone; Traefik gains `files`.

**Independent Test**: dry-run `sync-proxy` per driver and per supported source produces the expected (byte-identical where applicable) output.

- [x] T007 [US1] In `src/lib/proxy/routes.ts`: replace `ProxyContext.caddyTls` with `tlsSource: TlsSource` and add `acmeDnsProvider: AcmeDnsProvider`; change `buildProxyContext(inventory)` to `buildProxyContext(inventory, driver: ReverseProxyDriver)` filling them via `effectiveTlsSource`/`acmeDnsProvider` from `tls.ts` (type-only import of the driver type to avoid a cycle); delete `DEFAULT_CADDY_TLS`, `caddyTlsMode`, `NO_CERT_RESOLVER`; keep `certResolverName`/`DEFAULT_CERT_RESOLVER`. Update callers `src/commands/networking/sync-proxy.ts` and `src/commands/networking/convert-caddyfile.ts` to pass the driver they already resolve. Update `test/lib/proxy/routes.test.ts`.
- [x] T008 [US1] Caddyfile renderer `src/lib/proxy/drivers/caddy.ts`: `tlsClause` switches on `ctx.tlsSource` — `acme-dns` → `CLOUDFLARE_TLS_BLOCK` (only provider `cloudflare` exists; keep the switch exhaustive over `AcmeDnsProvider`), `acme-http` → none, `internal` → `tls internal`, `files` → `tls <cert> <key>`, `external` → throw `Error("caddy driver cannot render tlsSource 'external' (checkTlsSource should have refused it)")`. Reimplement `caddyAcmeDns01ViaCloudflare` temporarily as `(inv) => (inv.tlsSource ?? 'acme-dns') === 'acme-dns'` (removed in US3). Update `test/lib/proxy/drivers/caddy.test.ts` and `test/lib/proxy/file-driver.test.ts`: every former `proxyCaddyTls` case becomes the matching `tlsSource` case with the expected output strings unchanged (byte-identical, FR-007).
- [x] T009 [US1] Caddy admin API `src/lib/proxy/caddy-json.ts`: `renderTlsObjects` and `planCaddyConfig`'s `writesPolicy` switch on `ctx.tlsSource` (`acme-dns`/`internal` write a policy; `files` load_files + connection policy; `acme-http` nothing; `external` throws a programming error). Update `test/lib/proxy/caddy-json.test.ts` and `test/lib/proxy/drivers/caddy-api.test.ts`; the `test/fixtures/caddy/*-adapted.json` parity fixtures must stay byte-for-byte unchanged.
- [x] T010 [US1] Traefik `src/lib/proxy/drivers/traefik.ts`: `routerTls(ctx)` returns `{ certResolver: ctx.certResolver }` for `acme-dns`/`acme-http`, `{}` for `files`/`external`, throws for `internal`; for `files` add a top-level `tls: { certificates: [{ certFile: ctx.tls.certificatePath, keyFile: ctx.tls.keyPath }] }` after `http:` in both `stringify` passes of `render()` (so the generation hash covers it). Reimplement `traefikAcmeDns01ViaCloudflare` temporarily as `(inv) => effective source is 'acme-dns' or 'acme-http'` (preserves old "any named resolver" behavior until US3). Update `test/lib/proxy/drivers/traefik.test.ts`: old `proxyCertResolver: 'none'` expectations become `tlsSource: 'external'` with identical output; new `files` test pins the exact YAML (example.com certbot paths) and that routers have `tls: {}`.
- [x] T011 [US1] Remove `proxyCaddyTls` from `SettingsSchema` and `CADDY_TLS_MODES`/`CaddyTlsMode` from `src/lib/proxy/ids.ts`; update the `proxyCertResolver` schema comment in `src/lib/inventory.ts` (no reserved `none`). Remove the `usesCaddyTls` and `usesSharedCertificate` hints from `ReverseProxyDriver` (`src/lib/proxy/driver.ts`), `fileDriver` pass-through (`src/lib/proxy/file-driver.ts`), and the drivers that set them. Check `loadInventory` tolerates a leftover `proxyCaddyTls` meta row until US4 migrates it (add a test if it does not already ignore unknown meta keys, or note that US4 runs before load). Update `test/lib/inventory.test.ts`, `test/commands/set-config.test.ts`, `test/lib/proxy/index.test.ts`, `test/lib/proxy/driver.test.ts`, `test/commands/render-status-page.test.ts`, `test/operations/edit-guest.test.ts`, `test/commands/sync-proxy.test.ts`, `test/web/proxy-sync.test.ts` wherever they set the removed setting.
- [x] T012 [US1] Settings API `src/web/routes/settings.ts` per contracts/settings-api-and-ui.md: driver info drops `usesSharedCertificate`/`usesCaddyTls`, gains `tlsSources`/`defaultTlsSource`; response drops `caddyTlsModes`/`defaultCaddyTls`, gains `acmeDnsProviders: [...ACME_DNS_PROVIDERS]`/`defaultAcmeDnsProvider`. Update `test/web/routes/settings.test.ts` (including PATCH `tlsSource`/`acmeDnsProvider` accepted, PATCH `proxyCaddyTls` rejected as unknown, PATCH `tlsSource: internal` accepted while driver is nginx — no write-time driver check).
- [x] T013 [P] [US1] Docs: `docs/configuration.md` (settings table: add `tlsSource`, `acmeDnsProvider`; remove `proxyCaddyTls`; `proxyCertResolver` no reserved `none`), `docs/reverse-proxy/README.md` (TLS source support matrix), `docs/reverse-proxy/caddy.md`, `caddy-api.md`, `traefik.md` (incl. `files`), `nginx.md`, `haproxy.md`, and the comment in `inventory/hosts.yaml.example` (line ~116, `proxyDriver/proxyCaddyTls` → `proxyDriver/tlsSource`). Example values only.
- [x] T014 [P] [US1] Nested guidance: `src/lib/proxy/CLAUDE.md` (interface: `tlsSources`/`defaultTlsSource`, removed hints, `ProxyContext.tlsSource`/`acmeDnsProvider`, `buildProxyContext(inventory, driver)`, new `tls.ts`/`legacy-tls.ts` file responsibilities; single-operator line for Caddy scoped to `tlsSource: acme-dns` + `acmeDnsProvider: cloudflare`; Traefik line no longer says "unset proxyCertResolver defaults to cloudflare" only — keep it, it is still true) and `src/lib/proxy/drivers/CLAUDE.md` (replace "Caddy certificate modes (`proxyCaddyTls`)" with "TLS source by driver"; Traefik cert-resolver paragraph incl. `files`; single-operator assumptions per FR-017). Run `npm test` (the docs link test checks anchors).

**Checkpoint**: typecheck + tests green. Commit `Render proxy TLS from one tlsSource setting (#72, US1)`.

---

## Phase 4: User Story 2 — Unsupported combinations are refused with a fix (P1)

**Independent Test**: unsupported `tlsSource` makes `sync-proxy` refuse (dry run and apply) before any SSH call; the inventory still loads.

- [x] T015 [US2] In `src/commands/networking/sync-proxy.ts` (`runSyncProxy`), call `checkTlsSource(inventory, driver)` right after the `managesProxy` short-circuit and before `driverDeps`/`buildRoutes`, throwing its message. TDD in `test/commands/sync-proxy.test.ts`: nginx + `internal` refuses with the exact contract message for dry run and `--apply`, `FakeSSHClient.history` empty; `none` driver with any `tlsSource` still returns `NO_PROXY_SYNC_MESSAGE`; unset `tlsSource` on every driver passes.
- [x] T016 [US2] Call `checkTlsSource` in `src/commands/networking/convert-caddyfile.ts` before rendering; test in its existing test file that `tlsSource: external` with `caddy-api` refuses before any SSH call.
- [x] T017 [US2] Tests proving the check never runs on load/edit: in `test/lib/inventory.test.ts` an inventory with nginx + `tlsSource: internal` loads and `validateInventory` returns no error; in `test/operations/edit-guest.test.ts` a guest edit under that combination saves and reports `proxySynced: false` with the refusal message.
- [x] T018 [P] [US2] Document the refusal in `src/lib/proxy/CLAUDE.md` "Capability enforcement" (TLS source check: where it runs, where it never runs, message) and in `docs/reverse-proxy/README.md`.

**Checkpoint**: green. Commit `Refuse a TLS source the proxy driver cannot serve (#72, US2)`.

---

## Phase 5: User Story 3 — Stale ACME challenge cleanup follows the TLS setting (P2)

**Independent Test**: `syncProxyLive` with fake clients prunes only for effective `acme-dns` + `cloudflare`.

- [x] T019 [US3] In `src/web/proxy-sync.ts`, replace `driver.capabilities.acmeDns01ViaCloudflare(inventory)` with `usesCloudflareDns01(inventory, driver)`; replace `pruneAcmeDriverSkipMessage(driverId)` with `pruneAcmeTlsSkipMessage(tlsSource)` producing exactly `prune-acme-challenges: skipped, the TLS source is '<x>' (only acme-dns with the cloudflare DNS provider leaves challenge records)`. Remove `acmeDns01ViaCloudflare` from `DriverCapabilities` and every driver, and delete `caddyAcmeDns01ViaCloudflare`/`traefikAcmeDns01ViaCloudflare`. TDD in `test/web/proxy-sync.test.ts`: Caddy unset/`acme-dns` prunes; Caddy `acme-http`/`internal`/`files` skip with the message; Traefik `acme-http` skips (behavior change, spec US3 scenario 3); Traefik `acme-dns` prunes; nginx/NPM/HAProxy skip.
- [x] T020 [P] [US3] Update `src/commands/networking/CLAUDE.md` "prune-acme-challenges › When it runs" (line ~133) and `src/web/CLAUDE.md` if it describes the decision.

**Checkpoint**: green. Commit `Decide the ACME challenge prune from the TLS source (#72, US3)`.

---

## Phase 6: User Story 4 — Existing deployments migrate without any change in output (P1)

**Independent Test**: fixture DBs with each legacy value open to the expected `tlsSource`, and render identically.

- [x] T021 [US4] In `src/lib/inventory.ts`, add `migrateLegacyTlsSettings(db)` called from `openInventoryDb` after `migrateCaddyToProxy`: read the `meta` rows `proxyDriver`, `proxyCaddyTls`, `proxyCertResolver`, `tlsSource`, apply `convertLegacyTlsSettings`, write/delete rows in one transaction, and `logInfo` exactly `Migrated TLS settings to tlsSource (#72, one-time, irreversible): <description>` only when something changed. TDD in `test/lib/inventory.test.ts` with temp DBs (insert raw meta rows, then `loadInventory`): each data-model.md table row; existing `tlsSource` not overwritten; second open logs nothing; DB with no legacy rows logs nothing.
- [x] T022 [US4] Byte-identical proof: in `test/commands/sync-proxy.test.ts` (or a new `test/lib/proxy/legacy-tls-render.test.ts`), for each legacy combination (Caddy × 4 modes, caddy-api × 4, Traefik `none`), render with a pre-#72 expected-output literal copied from the existing driver tests and assert the post-migration `sync-proxy` preview equals it (SC-001).
- [x] T023 [US4] In `src/commands/maintenance/import-yaml-inventory.ts`, apply `convertLegacyTlsSettings` to the parsed YAML object (set/delete keys) before `InventorySchema.safeParse`; test in its test file that a YAML with `proxyCaddyTls: letsencrypt` imports as `tlsSource: acme-http` and one with traefik + `proxyCertResolver: none` imports as `external`.
- [x] T024 [P] [US4] Record the migration in `src/lib/CLAUDE.md` (the migrations/SQLite section, alongside #10/#158) and the `DEFAULT_PROXY_DRIVER_ID` move in `src/lib/proxy/CLAUDE.md`.

**Checkpoint**: green. Commit `Migrate legacy TLS settings to tlsSource (#72, US4)`.

---

## Phase 7: User Story 5 — The Settings page shows TLS fields by TLS source (P2)

**Independent Test**: Settings → Proxy at desktop and ≤640px shows the right fields/options/warning per driver and source.

- [x] T025 [US5] `web-client/src/api/types.ts`: `ProxyDriverInfo` drops `usesSharedCertificate`/`usesCaddyTls`, gains `tlsSources: string[]`, `defaultTlsSource: string`; `SettingsResponse` drops `caddyTlsModes`/`defaultCaddyTls`, gains `acmeDnsProviders: string[]`, `defaultAcmeDnsProvider: string`; `SettingsValues` gains `tlsSource?`, `acmeDnsProvider?`, loses `proxyCaddyTls?`.
- [x] T026 [US5] `web-client/src/lib/settings-display.ts`: replace `caddyTlsOptions` with `tlsSourceOptions(driver, shownSource)` (driver order, ` (default)` suffix on its default, unsupported shown value appended as `<value> (not supported)`); change `proxyFieldView(selectedId, drivers, draftOrStoredTlsSource)` to resolve the shown source (`draft || stored || driver.defaultTlsSource`) and return `showTlsSourceField`, `showAcmeDnsProviderField` (`acme-dns`), `showTlsFields` (`files`), `showCertResolverField` (`usesCertResolver` && `acme-dns`/`acme-http`), `showApiUrlField`, `showNpmApiFields`, `tlsSourceOptions`, and `tlsSourceWarning` (`The <label> driver does not support '<value>'. It supports: <a>, <b>.` or null); TAB_FIELDS proxy order per contracts/settings-api-and-ui.md (`tlsSource`, `acmeDnsProvider` replace `proxyCaddyTls`). TDD in `test/web-client/settings-display.test.ts` covering every visibility row, options, and warning.
- [x] T027 [US5] `web-client/src/pages/SettingsPage.tsx` (and wherever field labels/help live, e.g. a field-help map): render the TLS source `<select>` from `tlsSourceOptions`, the ACME DNS provider `<select>` from `acmeDnsProviders`, the warning under the TLS source field using existing warning styles, remove the Caddy TLS dropdown; help text for both new fields. `npm run web:build` passes.
- [ ] T028 [US5] Browser verification with `npm run demo` (127.0.0.1:3100) at desktop width and ≤640px per quickstart.md "Web UI"; kill the demo process tree by PID afterwards and confirm the port is free (PowerShell `Get-NetTCPConnection`).
- [x] T029 [US5] Regenerate `docs/images/settings-proxy-driver.png` with `npm run docs:screenshots` (only that image if the script allows; otherwise review every changed image) and check it by eye for example-only values; update `web-client/CLAUDE.md` Settings page section (TLS fields by source, removed per-driver TLS flags).

**Checkpoint**: typecheck, tests, web:build green. Commit `Show Settings TLS fields by TLS source (#72, US5)`.

---

## Phase 8: Polish & Cross-Cutting

- [ ] T030 Grep the tree for leftovers: `proxyCaddyTls`, `caddyTls`, `CADDY_TLS_MODES`, `NO_CERT_RESOLVER`, `acmeDns01ViaCloudflare`, `usesCaddyTls`, `usesSharedCertificate` outside `specs/0*` historical specs; fix any in `src/`, `web-client/`, `docs/`, `test/`, `scripts/`, `README.md`, `CONTRIBUTING.md`.
- [ ] T031 Run quickstart.md CLI walk-through against a temp fixture (`INVENTORY_FILE`), including the migration step; paste outputs into the verification notes.
- [ ] T032 Final `npm run typecheck`, `npm test`, `npm run web:build`; root `CLAUDE.md` stays ≤250 lines and README ≤200 (enforced by `test/docs/links.test.ts`).

---

## Dependencies & Execution Order

- Phase 2 → Phase 3 (US1) → {US2, US3, US4, US5}. US2–US5 touch mostly separate files but share `test/commands/sync-proxy.test.ts` (US2, US4) and `src/lib/proxy/CLAUDE.md` (US2, US4); run them sequentially in the order listed to avoid conflicts.
- Within a phase: tests first (failing), then implementation, then docs.

## Parallel Opportunities

- T005 and T006 (separate new modules).
- T013 and T014 (docs vs nested guidance) after T007–T012.
- T018, T020, T024 docs tasks alongside their phase's code once the behavior is settled.

## Implementation Strategy

- MVP = Phase 2 + US1 (one setting drives rendering). US2 (refusal) and US4 (migration) are required before the PR because the old settings are removed outright. US3 and US5 complete the issue.
- One commit per phase (per user story), pushed after each.
