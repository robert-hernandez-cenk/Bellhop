---

description: "Task list for native OIDC gating (issue #1)"
---

# Tasks: Native OIDC Gating as an Alternative to Forward-Auth

**Input**: Design documents from `specs/002-native-oidc-gating/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/interfaces.md, quickstart.md

**Tests**: Required. Constitution Principle III: every behavior change ships with tests in the same change, using `FakeAuthentikClient`/`FakeSSHClient` and `mkdtempSync` inventories. Write each story's tests first and watch them fail.

**Organization**: Grouped by user story from spec.md. All paths are relative to the worktree root `C:\Users\rcher\Dev\Bellhop-Worktrees\issue-1-native-oidc-gating`.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1–US4 from spec.md

---

## Phase 1: Setup

- [ ] T001 Run `npm install` in the worktree (fresh worktrees have no `node_modules`) and confirm `npm run typecheck` and `npm test` pass on the untouched branch, so later failures are attributable

---

## Phase 2: Foundational (blocks every story)

- [ ] T002 [P] Write tests in test/lib/inventory.test.ts for: `authMode` accepts only `'forward' | 'oidc'`; `oidcRedirectUris` accepts only absolute `http://`/`https://` URLs; both round-trip through `saveInventory`/`loadInventory` on hosts, guests and external sites; a database created without the new columns gains them on open (`ensureColumn`) and loads with both fields undefined; `effectiveAuth` returns `ungated` with no `authGroup`, `forward` with `authGroup` and `authMode` unset or `forward`, `oidc` with `authGroup` and `authMode: 'oidc'`; `parseAuthMode` (null/'' → undefined, bad value throws naming the field); `parseOidcRedirectUris` (`;`-joined or array, dedup keeping order, empty → undefined, non-http(s) throws naming the URL); `oidcConfigErrors` requires ≥1 redirect URI when `effectiveAuth` is `oidc` and the entry has subdomains; `validateInventory` no longer requires an `authentik: true` entry when every gated entry is OIDC
- [ ] T003 Implement in src/lib/inventory.ts: `authMode: z.enum(['forward','oidc']).optional()` and `oidcRedirectUris: z.array(<absolute http(s) URL>).optional()` on `HostEntrySchema`, `GuestEntrySchema`, `ExternalSiteSchema` (next to `authGroup`, with a comment in the `authGroup` style); `auth_mode TEXT` and `oidc_redirect_uris_json TEXT` via `ensureColumn` on `hosts`/`guests`/`external_sites` plus the CREATE TABLE text, row types, load mapping and all three INSERTs; exported `effectiveAuth`, `parseAuthMode`, `parseOidcRedirectUris`, `oidcConfigErrors`; narrow `validateInventory`'s `gatedNames` to entries where `effectiveAuth(entry) === 'forward'` (research R7, R10) — makes T002 pass
- [ ] T004 [P] Add `oidcSigningKeyName` to `AuthentikConfig` in src/lib/authentik-config.ts, read from `AUTHENTIK_OIDC_SIGNING_KEY_NAME`, default `authentik Self-signed Certificate`, with a test in test/lib/authentik-config.test.ts (default, override, empty string counts as unset)
- [ ] T005 Extend the `AuthentikClient` interface in src/lib/authentik-client.ts exactly per contracts/interfaces.md "AuthentikClient additions": `AuthentikOAuth2Provider`, `OAuth2ProviderSettings`, `listOAuth2Providers`, `createOAuth2Provider`, `updateOAuth2Provider`, `deleteOAuth2Provider`, `getOAuth2Credentials`, `updateApplication`, `getSigningKeyId`, `getScopeMappingIds`; add `metaPublisher?: string` to `AuthentikApplication` and map `meta_publisher` in `listApplications`/`createApplication` (and accept `metaPublisher` on `createApplication` input); add rejecting stubs to `UnconfiguredAuthentikClient`
- [ ] T006 Implement the new methods on `RealAuthentikClient` in src/lib/authentik-client.ts against `/api/v3/providers/oauth2/` (create sends `client_type`, `grant_types`, `signing_key`, `property_mappings`, `redirect_uris` as `{matching_mode, url}`, `authorization_flow`, `invalidation_flow`; update sends only the given fields and never `client_id`/`client_secret`), `/providers/oauth2/<pk>/setup_urls/` for `issuer`, `PATCH /core/applications/<slug>/` for `provider`/`meta_publisher`, `/crypto/certificatekeypairs/?name=&has_key=true` (throw naming `AUTHENTIK_OIDC_SIGNING_KEY_NAME` when absent), `/propertymappings/provider/scope/?managed=` (throw naming the missing managed id); page-size guard like `listPolicyBindings` on `listOAuth2Providers`. No automated test (manual verification in T044)
- [ ] T007 Implement the same methods in test/support/fake-authentik-client.ts: in-memory OAuth2 providers keyed by id sharing the existing id counter, deterministic generated `clientId`/`clientSecret` (`client-<id>`/`secret-<id>`), `issuer` `https://auth.example.com/application/o/<assigned slug>/`, seedable `oauth2Providers`, `signingKeys` (name→id) and `scopeMappings` (managed→id) in `FakeAuthentikSeed`, `updateApplication` changing `providerId`/`metaPublisher`, and a `calls` log of mutating calls so tests can assert "nothing changed"

**Checkpoint**: typecheck passes; existing suites still green.

---

## Phase 3: User Story 1 — Gate an OIDC-capable app through its own login (P1) 🎯 MVP

**Goal**: An entry in OIDC mode gets a correctly configured OpenID client and Application with ladder bindings, a plain reverse proxy, and a verified discovery document.

**Independent Test**: quickstart.md §1 suites for sync-caddy/sync-authentik pass; `sync-authentik` dry run then apply on a temp inventory creates exactly the previewed objects; a second apply reports nothing.

### Tests (write first)

- [ ] T008 [P] [US1] In test/commands/sync-caddy.test.ts: an entry with `authGroup` and `authMode: 'oidc'` emits `reverse_proxy` + `header_up` + `tls` only (no `forward_auth`, no `handle /outpost.goauthentik.io/*`, no `@auth_required` even with `unauthenticatedPaths`); a forward-auth entry's block is byte-identical to the existing expectation; an inventory whose only gated entry is OIDC needs no `authentik: true` entry
- [ ] T009 [P] [US1] In test/commands/sync-authentik.test.ts: dry run for an OIDC entry reports it in `oidcToCreate` with the ladder `bindingChanges` and makes no mutating call; apply creates an OAuth2 provider with `clientType: 'confidential'`, `grantTypes` exactly `['authorization_code','refresh_token']`, the configured signing key id, the three scope mapping ids, one strict redirect URI per configured URL, and an Application at the slug with `metaPublisher: 'bellhop'` and the provider NOT added to the outpost; ladder bindings created; second apply returns empty `oidcToCreate`/`oidcUpdates`/`bindingChanges` and `getOAuth2Credentials` returns the same client id and secret as after the first
- [ ] T010 [P] [US1] In test/commands/sync-authentik.test.ts: changing `oidcRedirectUris` yields `oidcUpdates: [{ slug, changes: ['redirect_uris'] }]` in dry run and a PATCH without credential fields on apply (credentials unchanged); drift in grant types or scope mappings is reported and fixed the same way; raising `authGroup` changes bindings only
- [ ] T011 [P] [US1] In test/commands/sync-authentik.test.ts: skips — OIDC entry with no redirect URIs lands in `oidcSkipped` with a reason naming `oidcRedirectUris` and nothing is created for it; missing signing key skips every OIDC entry with a reason naming `AUTHENTIK_OIDC_SIGNING_KEY_NAME` while a forward-auth entry in the same run still reconciles; missing scope mapping likewise; OIDC mode without `authGroup` is inert (no client, not in any list); a `caddyManual` OIDC entry is still reconciled
- [ ] T012 [P] [US1] In test/commands/sync-authentik.test.ts: discovery — apply records `{ slug, issuer, ok: true }` when the injected fetch returns 200 JSON for `<issuer>.well-known/openid-configuration`, `ok: false` with the error on non-200/throw/timeout, never rolls anything back, and dry run records no discovery entries; `formatSyncAuthentik` prints each new section only when non-empty (contracts/interfaces.md CLI output)
- [ ] T013 [P] [US1] In test/operations/edit-guest.test.ts and test/web/routes/dashboard.test.ts: `authMode`/`oidcRedirectUris` are parsed from both string and array input; an edit producing an OIDC-effective entry with subdomains and no redirect URIs is rejected (400) naming the field; a non-admin PATCH that sets or changes `authMode` or `oidcRedirectUris` gets 403 (including an admin impersonating a non-admin group); an admin PATCH succeeds and the response carries `oidcDiscoveryFailures` only for this guest and only when non-empty

### Implementation

- [ ] T014 [US1] Update `buildCaddyBlock` in src/commands/networking/sync-caddy.ts to gate on `effectiveAuth(entry) === 'forward'` instead of `entry.authGroup` (both the outpost-ip check and the forward_auth emission); add `authMode` to `CaddyTarget` — makes T008 pass
- [ ] T015 [US1] Extend src/commands/networking/sync-authentik.ts for OIDC create/update/skip/discovery: `CandidateEntry` gains `authMode`/`oidcRedirectUris`; fetch OAuth2 providers alongside proxy providers; OAuth2-backed ownership = candidate slug + OAuth2 provider + `metaPublisher === 'bellhop'` (research R1), merged into `managedBySlug`; resolve signing key and scope mappings once when any OIDC entry is actionable; compute `oidcToCreate`, `oidcUpdates` (set comparison per research R4), `oidcSkipped`; on apply create provider (self-heal: reuse an OAuth2 provider named after the slug only when it has no assigned Application) then Application with `metaPublisher: 'bellhop'`; PATCH drift; never touch the outpost for OIDC; bindings via the existing `planBindingChanges` path unchanged; then run the discovery check with an injectable `fetchImpl` and 10 s `AbortSignal.timeout`; add the new result fields per data-model.md with `[]` defaults and extend `formatSyncAuthentik` — makes T009–T012 pass
- [ ] T016 [US1] In src/cli.ts `sync-authentik`: set a non-zero exit code on apply when any `discovery` entry has `ok: false` or any `oidcSkipped` reason is a missing signing key or scope mapping; add a test in test/cli.test.ts (or the file's existing sync-authentik coverage)
- [ ] T017 [US1] In src/web/caddy-sync.ts: log each failed discovery entry with `logWarn` and each OIDC skip, and return `authentikOidcDiscoveryFailures` on `SyncCaddyLiveResult`; update test/web/caddy-sync.test.ts
- [ ] T018 [US1] In src/operations/edit-guest.ts: `applyGuestEdits` handles `authMode` (via `parseAuthMode`) and `oidcRedirectUris` (via `parseOidcRedirectUris`, accepting arrays through `asDelimited`); `commitGuestEdit` rejects with `GuestEditValidationError` when `oidcConfigErrors(updated)` is non-empty; the result carries `oidcDiscoveryFailures` scoped to this guest's `subdomains[0]` with the same conditional-spread convention; `EDIT_GUEST_SHAPE` gains both fields with `.describe()` text
- [ ] T019 [US1] In src/web/routes/dashboard.ts: 403 "Only an admin may change an app's auth mode or callback URLs" when a non-admin's body contains `authMode` or `oidcRedirectUris` whose parsed value differs from the current one (admin check via `isAdminUser(req.user.groups)`, so impersonation applies) — makes T013 pass
- [ ] T020 [P] [US1] Add `authMode?: 'forward' | 'oidc'` and `oidcRedirectUris?: string[]` to `GuestEntry` in web-client/src/api/types.ts
- [ ] T021 [US1] Create web-client/src/components/EditableAuthMode.tsx: a Forward-auth / OIDC select and a Callback URLs input (`;`-separated, saved on blur) that PATCH `authMode`/`oidcRedirectUris`; disabled with an explanatory title for non-admins (read `isAdmin` from `/whoami` the way other components do); shows save status, caddy errors and `oidcDiscoveryFailures` as a warning banner in the existing banner style; notes when the entry has no auth group that the mode has no effect
- [ ] T022 [US1] Wire `EditableAuthMode` into web-client/src/components/AdvancedGuestModal.tsx as "auth mode" and "callback urls" rows after "auth group"; in web-client/src/components/EditableUnauthenticatedPaths.tsx show a short note that path exemptions do nothing in OIDC mode

**Checkpoint**: US1 complete and testable alone.

---

## Phase 4: User Story 2 — Hand the client credentials to the app (P1)

**Goal**: Admins read issuer, client ID and secret on demand; the MCP server shows issuer and client ID only.

**Independent Test**: with a seeded fake OAuth2 provider, the credentials command, web route and MCP tool return the right values to the right callers and the secret appears nowhere it must not.

### Tests (write first)

- [ ] T023 [P] [US2] Create test/commands/oidc-credentials.test.ts for `runOidcCredentials(entryName, deps)`: returns `{ issuer, clientId, clientSecret }` for an owned client; throws naming `sync-authentik --apply` when no owned client exists; throws for an unknown entry, an entry that is not OIDC-effective, and an unowned (conflict) Application; propagates the unconfigured error
- [ ] T024 [P] [US2] Create test/web/routes/oidc.test.ts: `GET /api/oidc/:entry/credentials` returns 200 with all three values for an admin; 403 for a non-admin and for an admin impersonating a non-admin group; 404 unknown entry; 409 not OIDC / no client; 503 unconfigured; the response body never appears in anything captured by the test's log capture
- [ ] T025 [P] [US2] In test/mcp/build-server.test.ts: `get_oidc_client` returns issuer and client ID and the `secretAvailableFrom` text; its serialized result never contains the fake secret string; no other tool (`get_inventory`, `edit_guest`) result contains it either

### Implementation

- [ ] T026 [US2] Create src/commands/networking/oidc-credentials.ts exporting `runOidcCredentials` (resolves the entry across hosts/guests/external sites, checks `effectiveAuth`, finds the owned Application with the same ownership rule as sync-authentik — export and reuse the helper from sync-authentik.ts rather than duplicating it — then `getOAuth2Credentials`) and `formatOidcCredentials` — makes T023 pass
- [ ] T027 [US2] Add CLI command `oidc-credentials <entry>` in src/cli.ts printing `formatOidcCredentials` output (contracts/interfaces.md)
- [ ] T028 [US2] Create src/web/routes/oidc.ts with `GET /:entry/credentials` behind `requireAdminGroup`, mapping errors to 404/409/502/503 per contracts/interfaces.md, and mount it at `/api/oidc` in src/web/app.ts after the impersonation middleware — makes T024 pass
- [ ] T029 [US2] Register `get_oidc_client` in src/mcp/build-server.ts returning `{ issuer, clientId, secretAvailableFrom }` built from `runOidcCredentials` with the secret dropped before serialization — makes T025 pass
- [ ] T030 [US2] Create web-client/src/components/OidcCredentials.tsx: admin-only "Show client credentials" button that fetches `/oidc/<guest>/credentials` on click (never on mount, never cached across closes), renders issuer, client ID and client secret each with a copy button (`navigator.clipboard.writeText`, with a copied indicator), and renders the 409/503 messages as text; add it as a "oidc client" row in web-client/src/components/AdvancedGuestModal.tsx shown only for OIDC-effective guests; non-admins see "OIDC (credentials visible to admins)"

**Checkpoint**: US1 and US2 both work independently.

---

## Phase 5: User Story 3 — Switch an existing app between forward-auth and OIDC (P2)

**Goal**: Mode changes swap the provider under the same Application; deleting an OpenID client needs confirmation everywhere.

**Independent Test**: seeded forward-auth Application switches to OIDC and back with bindings intact and outpost membership correct; edits leaving OIDC are refused without the confirmation flag.

### Tests (write first)

- [ ] T031 [P] [US3] In test/commands/sync-authentik.test.ts: forward → OIDC on an owned proxy Application: dry run lists `modeSwitches` and no binding changes; apply creates the OAuth2 provider, repoints the same Application (same pk) with `metaPublisher: 'bellhop'`, removes the proxy provider from the outpost and deletes it, bindings untouched. OIDC → forward: `oidcDeletions` contains the slug, dry run output includes the deletion warning, apply creates a proxy provider on the outpost, repoints the Application, clears `metaPublisher`, deletes the OAuth2 provider. Clearing the gate on an OIDC entry: Application and OAuth2 provider deleted, slug in `toRemove` and `oidcDeletions`, outpost untouched
- [ ] T032 [P] [US3] In test/operations/edit-guest.test.ts and test/mcp/build-server.test.ts: an edit from OIDC-effective to forward, or clearing `authGroup` on an OIDC-effective entry, throws `GuestEditValidationError` naming `confirmOidcClientDeletion` unless it is `true`; other edits never need it; `edit_guest` over MCP enforces the same rule

### Implementation

- [ ] T033 [US3] Implement mode switches and OIDC deletions in src/commands/networking/sync-authentik.ts per research R5 (compute `modeSwitches`/`oidcDeletions` in the shared planning section so dry run and apply agree; extend `toRemove` handling to delete OAuth2 providers without touching the outpost); add the deletion-warning line to `formatSyncAuthentik` — makes T031 pass
- [ ] T034 [US3] Add `confirmOidcClientDeletion` to `EDIT_GUEST_SHAPE` and the confirmation check to `commitGuestEdit` in src/operations/edit-guest.ts (compare `effectiveAuth(current)` with `effectiveAuth(updated)`; the flag itself is never persisted); make src/web/routes/dashboard.ts pass it through — makes T032 pass
- [ ] T035 [US3] In web-client/src/components/EditableAuthMode.tsx and web-client/src/components/EditableAuthGroup.tsx: before saving an edit that takes an OIDC-effective guest out of OIDC, open a confirmation modal (reuse the existing modal styles from web-client/src/components/ConfirmDeleteModal.tsx) naming the app and saying its OIDC login stops working until new credentials are entered; Cancel restores the previous value without a request; Confirm sends the edit with `confirmOidcClientDeletion: true`

**Checkpoint**: US1–US3 work independently.

---

## Phase 6: User Story 4 — Never disturb an OIDC client Bellhop did not create (P2)

**Goal**: Unowned OpenID Applications are reported, never touched, and adoptable on explicit request.

**Independent Test**: seeded hand-made OAuth2 Application at an inventory slug survives sync in every mode and is reported; the adopt action previews then takes it over with unchanged credentials.

### Tests (write first)

- [ ] T036 [P] [US4] In test/commands/sync-authentik.test.ts: a hand-made OAuth2 Application (no `metaPublisher`) at an OIDC entry's slug is in `conflicts`, its provider and bindings are unchanged, and the fake client's `calls` log has no mutation against it; same when the entry is forward-auth or ungated; an OAuth2 provider named after the slug but assigned to a different Application is never reused
- [ ] T037 [P] [US4] Create test/commands/adopt-oidc-client.test.ts for `runAdoptOidcClient({ entry, apply }, deps)`: dry run lists `meta_publisher` plus every drifted setting and binding change and mutates nothing; apply sets `metaPublisher: 'bellhop'`, fixes drift, reconciles bindings, and `getOAuth2Credentials` returns the pre-adoption client id and secret; refuses (naming why) an entry that is not OIDC-effective, a slug with no Application, an already-owned Application, and a non-OAuth2-backed Application; a subsequent `runSyncAuthentik` treats it as owned
- [ ] T038 [P] [US4] Extend test/web/routes/oidc.test.ts: `POST /api/oidc/:entry/adopt/preview` returns the preview text for an admin and 403 for a non-admin; `/adopt/apply` enqueues a job for an admin; extend test/mcp/build-server.test.ts to assert an `adopt_oidc_client` tool exists and previews by default

### Implementation

- [ ] T039 [US4] Create src/commands/networking/adopt-oidc-client.ts with `runAdoptOidcClient` and `formatAdoptOidcClient`, reusing sync-authentik's exported settings-diff and binding-plan helpers (export them from src/commands/networking/sync-authentik.ts; do not copy); update the conflict explanation text in sync-authentik.ts to point at `adopt-oidc-client` for OAuth2-backed conflicts — makes T036/T037 pass
- [ ] T040 [US4] Add the `adopt-oidc-client` Operation (`fleetWide: true`, shape `{ entry: z.string() }`) to src/operations/networking.ts, and CLI command `adopt-oidc-client <entry> [--apply]` in src/cli.ts with the standard dry-run footer
- [ ] T041 [US4] Add `POST /:entry/adopt/preview` and `/:entry/adopt/apply` to src/web/routes/oidc.ts behind `requireAdminGroup`, using `op.preview` and `previewAndEnqueue` with `resolveTriggeredBy(req)`; pass `jobRunner` into the route module — makes T038 pass
- [ ] T042 [US4] In web-client/src/components/EditableAuthGroup.tsx and EditableAuthMode.tsx, when the conflict banner is for an OIDC-mode guest and the viewer is admin, add an "Adopt existing client" button that shows the preview text, then applies and links to the job

**Checkpoint**: all four stories work independently.

---

## Phase 7: Polish & Cross-Cutting

- [ ] T043 [P] Document `authMode` and `oidcRedirectUris` (with one example OIDC entry using `example.com` names) in inventory/hosts.yaml.example, and make sure import-yaml-inventory accepts them (test in test/commands/import-yaml-inventory.test.ts)
- [ ] T044 Manual verification of `RealAuthentikClient` against the live Authentik per quickstart.md §3, using a throwaway slug on a copy of the real inventory in the worktree; clean up every object created; record what was verified (without real hostnames) for the PR description
- [ ] T045 [P] Update README.md: OIDC mode, when to choose it, what to paste into the app, the account-linking note (FR-023), `oidc-credentials`/`adopt-oidc-client`, `AUTHENTIK_OIDC_SIGNING_KEY_NAME`
- [ ] T046 [P] Update CLAUDE.md: the `authMode`/`oidcRedirectUris` fields in the Inventory bullet, OIDC ownership (`meta_publisher`) and mode switches in the `sync-authentik` bullet, `sync-caddy`'s OIDC exception, the new web route and MCP tool, and the single-operator note on the signing-key default; check CONTRIBUTING.md for any restated rule that changed
- [ ] T047 Run `npm run typecheck`, `npm test`, `npm run web:build`; all must pass
- [ ] T048 Browser verification per quickstart.md §4 at desktop width and at ≤640px (375px), light and dark theme, as admin and as a non-admin (`WEB_UI_DEV_GROUPS`); kill the dev server by PID afterward
- [ ] T049 Review the full branch diff for real operational data (constitution Principle I), then push and open the PR against `main`

---

## Dependencies & Execution Order

- Phase 1 → Phase 2 → stories. T003 before anything reading the new fields; T005 before T006/T007; T007 before every sync/command test runs green.
- **US1** (T008–T022) needs Phase 2 only.
- **US2** (T023–T030) needs Phase 2 and the ownership helper from T015.
- **US3** (T031–T035) needs T015 (planning section) and T018.
- **US4** (T036–T042) needs T015 and the web route module from T028.
- Polish after the stories; T044 needs T006 and T015; T049 last.

Within a story: tests first (they fail), then implementation in listed order. Tasks touching the same file (sync-authentik.ts: T015, T033, T039; edit-guest.ts: T018, T034; oidc.ts: T028, T041; EditableAuthMode.tsx: T021, T035, T042) are sequential.

## Parallel Example: User Story 1

```text
T008 sync-caddy tests    | T009–T012 sync-authentik tests (one file, write together) | T013 edit/dashboard tests
then T014 (sync-caddy) in parallel with T015 (sync-authentik) and T020 (web types)
```

## Implementation Strategy

1. **MVP**: Phases 1–3 (US1). An operator can gate an app with OIDC from CLI or Dashboard and read the secret from Authentik by hand.
2. Add US2 (credentials surfaces), then US3 (mode switches + confirmation), then US4 (adoption).
3. Polish, live verification, PR.
