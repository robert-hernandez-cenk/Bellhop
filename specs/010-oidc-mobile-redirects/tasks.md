---

description: "Task list for OIDC mobile-app redirect URIs, mobile consent step, and Access tab"
---

# Tasks: OIDC mobile-app redirect URIs, a mobile consent step, and an Access tab

**Input**: Design documents from `specs/010-oidc-mobile-redirects/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/interfaces.md, quickstart.md

**Tests**: Required. The constitution (Principle III) and the run's TDD mandate apply: each implementation task starts by writing its failing tests, which must be seen failing before the code is written.

**Organization**: Grouped by user story. All paths are relative to the worktree root `C:/Users/rcher/Dev/Bellhop-Worktrees/issue-22-oidc-mobile-redirects`. Never `cd` into it; use absolute paths, `git -C`, `npm --prefix`.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: US1 = mobile redirect list; US2 = consent step; US3 = Access tab

---

## Phase 1: Setup

- [ ] T001 Capture redacted Authentik fixtures from the session scratchpad captures (`C:/Users/rcher/AppData/Local/Temp/claude/C--Users-rcher-Dev-Bellhop/7667a057-827f-4731-a6c3-554d77c73a29/scratchpad/live-shapes.txt`, `live-binding.json`, `live-policybinding.json`) into `test/fixtures/authentik/` as `stages-all-by-name.json`, `stages-consent-list.json`, `flows-bindings-by-target.json`, `policies-all.json`, `policies-bindings-by-target.json`. Keep every field name, type, nesting and array length. Replace every pk/uuid with an obviously fake UUID (e.g. `00000000-0000-4000-8000-00000000000N`), the stage and policy names with `mobile-app-consent`-style example names, expressions with a short example expression, and any hostname with `example.com` (constitution Principle I). `policies-all.json` may be trimmed to 2–3 results, but its `pagination` block must stay consistent with that count. Check the existing fixture location convention first (`test/fixtures/` or wherever `test/lib/authentik-client.test.ts` loads fixtures from) and follow it.

---

## Phase 2: Foundational (blocks US1 and US2)

- [x] T002 In `src/lib/inventory.ts`, add the `oidcMobileRedirectUris` field. Tests go in `test/lib/inventory.test.ts`.
  - **Tests first**: custom scheme `app.example:///oauth-callback` accepted; `https://books.example.com/auth/openid/mobile-redirect` accepted; `javascript:x`, `JavaScript:x`, `data:text/plain,x`, `file:///etc/passwd` and `vbscript:x` rejected; a value with a space or no scheme rejected; save/load round-trip for a host, a guest and an external site; a database created without the column (build one with a raw `CREATE TABLE` from the pre-feature schema, or use `ensureColumn` absence) loads with the field undefined; `oidcConfigErrors` reports a URI present in both lists, naming it.
  - **Validation**: add `isValidMobileRedirectUri(value)` next to `isAbsoluteHttpUrl`. The rule, from research R1: "no whitespace or control characters, `new URL(value)` parses, scheme (lower-cased, minus the colon) not in `javascript`, `data`, `file`, `vbscript`".
  - **Schema**: add `OidcMobileRedirectUriSchema` and an optional `oidcMobileRedirectUris: z.array(OidcMobileRedirectUriSchema).optional()` on `HostEntrySchema`, `GuestEntrySchema` and `ExternalSiteSchema`.
  - **Storage**: a nullable `oidc_mobile_redirect_uris_json TEXT` column in the three `CREATE TABLE` statements plus `ensureColumn` calls; the row interfaces, the load mapping, and the save mapping (`JSON.stringify` or `NULL`).
  - **Parser**: `export function parseOidcMobileRedirectUris(raw)`, with the same input forms as `parseOidcRedirectUris`, deduplicated in authored order, `undefined` when empty. It throws `Invalid mobile redirect URI '<uri>' (...)` naming the reason.
  - **`oidcConfigErrors`**: accept `oidcMobileRedirectUris` and add `oidcMobileRedirectUris: '<uri>' is also a web callback URL; list it in only one` for each overlap. Do NOT add the rule to `validateInventory()` or the zod schema (research R2).

**Checkpoint**: `npm --prefix <wt> run typecheck` and `npm --prefix <wt> test` pass.

---

## Phase 3: User Story 1 — Register a mobile app's callback (Priority: P1) 🎯 MVP

**Goal**: The mobile list is editable from the Dashboard (admin-only), MCP `edit_guest` and YAML import, and becomes part of the OpenID client's callback set.

**Independent Test**: Set a mobile URI via `runEditGuest` on an OIDC guest, run `runSyncAuthentik` against `FakeAuthentikClient`, assert the provider's `redirectUris` = web ∪ mobile (strict), and assert a second run reports no `oidcUpdates`.

- [x] T003 [US1] In `src/commands/networking/sync-authentik.ts`, export `clientRedirectUris(entry)`, returning the deduplicated `[...oidcRedirectUris ?? [], ...oidcMobileRedirectUris ?? []]` in first-seen order.
  - Add `oidcMobileRedirectUris` to `CandidateEntry`/`SubdomainOwner` and copy it in `candidateEntries`.
  - In `planOidc`, pass `clientRedirectUris(entry)` to `desiredOAuth2Settings`, but keep the `missing-redirect-uris` skip testing the web list only (FR-004).
  - **Tests first**, in `test/commands/sync-authentik.test.ts`:
    - a new client gets web + mobile;
    - a mobile-only change on an owned client is reported as `redirect_uris` drift and patched;
    - an unchanged second run reports no update;
    - an OIDC entry with only mobile URIs is still skipped as `missing-redirect-uris`;
    - a forward-mode entry's mobile list is ignored.
- [x] T004 [P] [US1] In `src/commands/networking/adopt-oidc-client.ts`, use `clientRedirectUris(entry)` wherever the entry's redirect URIs feed `desiredOAuth2Settings`, and pass `oidcMobileRedirectUris` through wherever the entry is re-shaped (around lines 108 and 139). **Tests first**, in `test/commands/adopt-oidc-client.test.ts`: adopting an entry with mobile URIs previews and applies `redirect_uris` drift that includes them.
- [x] T005 [US1] In `src/operations/edit-guest.ts`, wire the field into both edit paths.
  - `applyGuestEdits` handles `'oidcMobileRedirectUris' in body` via `parseOidcMobileRedirectUris(asDelimited(...))`.
  - Add `oidcMobileRedirectUris: z.union([z.string(), z.array(z.string())]).optional()` to `EDIT_GUEST_SHAPE`. Describe it as "Mobile app redirect URIs (array or ';'-separated; custom schemes allowed; javascript:, data:, file:, vbscript: rejected). Adds a consent click to mobile sign-ins only. Admin only."
  - Make sure `commitGuestEdit`'s `oidcConfigErrors` call receives the updated entry, so the cross-list rule fires.
  - **Tests first**, in `test/operations/edit-guest.test.ts`: array and `;`-string inputs parse; `javascript:` is rejected with an error naming it; a cross-list duplicate is rejected; an empty string clears the field.
- [x] T006 [US1] In `src/web/routes/dashboard.ts`, extend the admin gate to the mobile list.
  - `oidcEditChangeError` also compares `oidcMobileRedirectUris`, order-sensitive like `sameOidcRedirectUris`.
  - The route's trigger condition includes `'oidcMobileRedirectUris' in req.body`.
  - The 403 message becomes "Only an admin may change an app's auth mode, callback URLs or mobile redirect URLs".
  - **Tests first**, in `test/web/routes/dashboard.test.ts`: a non-admin changing the mobile list gets 403; a non-admin re-submitting the unchanged list is allowed; an admin change succeeds and persists.
- [x] T007 [P] [US1] In `src/mcp/build-server.ts`, add `oidcMobileRedirectUris` to the `edit_guest` tool description's field list. **Test** in `test/mcp/build-server.test.ts`: an `edit_guest` call with `oidcMobileRedirectUris: ['app.example:///oauth-callback']` saves it (follow the existing `oidcRedirectUris` edit test).
- [x] T008 [P] [US1] In `inventory/hosts.yaml.example`, add a commented `oidcMobileRedirectUris` example under the existing OIDC example guest, `app.example:///oauth-callback`, with a one-line comment on when to use it. **Test** in `test/commands/import-yaml-inventory.test.ts`: importing a YAML with `oidcMobileRedirectUris` on a host, a guest and an external site round-trips all three. Also check that the example file itself still imports, if an existing test does that.
- [x] T009 [P] [US1] In `web-client/src/api/types.ts`, add `oidcMobileRedirectUris?: string[]` to `GuestEntry` (and to the host/external-site types if they carry `oidcRedirectUris`).
- [x] T010 [US1] Confirm `sync-inventory` preserves the field. **Test** in the existing `sync-inventory` test file (find it under `test/commands/`): an existing guest with `oidcMobileRedirectUris` keeps it after a sync that refreshes its ip. Make a code change only if the test fails.

**Checkpoint**: US1 is complete and independently testable. Commit `Add mobile redirect URIs to OIDC clients (#22, US1)`.

---

## Phase 4: User Story 2 — Mobile consent step (Priority: P2)

**Goal**: While any OIDC entry has mobile URIs, `sync-authentik` owns a consent stage, flow binding, expression policy and policy binding that show consent only for exact mobile hand-offs. It removes them when none remain, reports conflicts, and isolates failures.

**Independent Test**: Against `FakeAuthentikClient`: the first mobile URI plans and then creates the 4 objects; a URI change updates only the policy; drift is repaired; the last URI removed deletes all 4; a same-named foreign object is a conflict with nothing touched; a thrown client error gives `mobileConsent.error`, the rest of the run still applies, and `syncAuthentikFailed` is true only on apply.

- [ ] T011 [US2] In `src/lib/authentik-client.ts`, add the client methods and types from `contracts/interfaces.md` §1 to the `AuthentikClient` interface, `RealAuthentikClient` and `UnconfiguredAuthentikClient`. The endpoints and bodies are in research R4, verbatim:
  - Stage lookup: `GET /api/v3/stages/all/?name=`. The name filter works.
  - Consent stage CRUD: `/api/v3/stages/consent/`.
  - Policy lookup: `GET /api/v3/policies/all/?page_size=500`, matching `name` client-side, because the name filter is ignored.
  - Expression policy CRUD: `/api/v3/policies/expression/`.
  - Flow-stage bindings: `GET /api/v3/flows/bindings/?target=<flowPk>`. `target__slug` is ignored.
  - Binding CRUD: create with `{target, stage, order, evaluate_on_plan, re_evaluate_policies, policy_engine_mode: 'any', invalid_response_action: 'retry'}`.
  - Policy bindings: `GET /api/v3/policies/bindings/?target=<policybindingmodel_ptr_id>`. Create with `{target: <policybindingmodel_ptr_id>, policy, order: 0, enabled: true, negate: false, timeout: 30, failure_result: false}`.
  - Cache clear: `POST /api/v3/flows/instances/cache_clear/`.
  - Map `policybindingmodel_ptr_id` → `policyBindingModelId`. Handle pagination the way existing list methods do.
  - **Tests first**, in `test/lib/authentik-client.test.ts` with `withStubbedFetch` and the T001 fixtures: every method's URL, method and body, plus the response mapping, including that a listed policy binding's `target` (reported as the flow-stage binding's own pk) maps to `targetId`.
- [ ] T012 [P] [US2] In `test/support/fake-authentik-client.ts`, implement the same methods in memory: stages with a model string, consent stage mode, policies with model and expression, flow-stage bindings with generated `pk` and a distinct `policyBindingModelId`, target-policy bindings, and a `cacheClears` counter.
  - Extend `FakeAuthentikSeed` with `stages`, `policies`, `flowStageBindings`, `targetPolicyBindings`, and `authorizationFlowId`. `getDefaultAuthorizationFlowId` already exists; make it return the seed value.
  - Add an optional per-method failure injection (e.g. `failOn?: Set<string>`) if the fake doesn't have one yet.
  - Keep existing behavior unchanged; the whole existing suite must still pass.
- [ ] T013 [P] [US2] In `src/commands/networking/sync-authentik.ts`, add `pythonStringLiteral(value)` and `renderMobileConsentExpression(uris)`, plus the constants `MOBILE_CONSENT_STAGE_NAME = 'bellhop-mobile-app-consent'`, `MOBILE_CONSENT_POLICY_NAME = 'bellhop-consent-on-mobile-redirect'` and `MOBILE_CONSENT_MARKER = '# Managed by Bellhop (sync-authentik).'`. Rules are in research R5:
  - Iterate code points.
  - Escape `\\`, `\"`, `\n`, `\r`, `\t`.
  - Printable ASCII 0x20–0x7E stays literal; everything else becomes `\xHH`, `\uHHHH`, or `\UHHHHHHHH` above U+FFFF.
  - URIs are sorted and one per line inside the set literal, in exactly the layout shown in R5.
  - **Tests first**, in `test/commands/sync-authentik-mobile-consent.test.ts`:
    - exact rendered text for two URIs;
    - sorting makes input order irrelevant;
    - a URI with `"`, `\`, a newline, `é` and `😀` escapes to the expected Python literal (`"\U0001f600"` for the emoji, not two surrogates);
    - the expression starts with the marker.
  - If `python3` is available on the machine, also add a test that runs the literal through `python3 -c 'import sys,ast; print(ast.literal_eval(sys.stdin.read()))'` and compares, skipped when python is absent (`test.skip` guarded by a `spawnSync` probe). This keeps the suite deterministic without depending on python.
- [ ] T014 [US2] In `src/commands/networking/sync-authentik.ts`, implement the consent reconcile (research R6–R9, data-model "Mobile consent step").
  - **Wanted set**: `mobileUriSet(desired)` is the sorted, deduplicated union of `oidcMobileRedirectUris` over `desired` candidates whose `effectiveAuth` is `'oidc'`.
  - **Planning**: `planMobileConsent(uris, authentik)` resolves the flow pk via `getDefaultAuthorizationFlowId()`, finds the stage and policy by name, and applies the ownership rules (R7). A conflict stops the plan. It then finds the stage binding (the binding on the flow whose stage is ours) and the policy binding (ours, matched on either target id). It returns `{ changes, conflicts, actions }`, following R8's create/drift/delete rules.
  - **Applying**: `applyMobileConsent(plan, authentik)` executes the actions in R8 order and calls `clearFlowCache()` after any binding or policy change.
  - **Reads when nothing is wanted**: when `uris` is empty, a read failure is swallowed and gives an empty plan (R9).
  - **Wiring**: call both from `runSyncAuthentik` after the group-binding pass and before discovery, each wrapped in its own try/catch that sets `mobileConsent.error` with the R9 message. Fill `mobileConsent` (data-model "Sync result addition") on both dry-run and apply results.
  - **`syncAuthentikFailed`**: also true when `applied && mobileConsent?.error`.
  - **Tests first**, in `test/commands/sync-authentik-mobile-consent.test.ts`, one test per acceptance scenario of US2 and each edge case in spec.md:
    - no URIs means no objects and no calls beyond reads;
    - the first URI gives a dry run listing 4 creates, and apply creates them with the right settings (stage mode `always_require`; binding `evaluate_on_plan: false`, `re_evaluate_policies: true`, order 10; policy expression equal to the render; policy binding targeting `policyBindingModelId`) plus 1 cache clear;
    - a URI change gives exactly 1 policy update;
    - a second identical run gives zero changes and zero cache clears (SC-005);
    - drift on stage mode or binding flags is repaired;
    - a partial prior state (stage only) creates the other 3, not duplicates;
    - the last URI removed deletes all 4 in order;
    - a foreign same-named stage (non-consent model) or policy (no marker) is a conflict with zero writes, and the rest of the run is still applied;
    - a thrown error on create sets `error`, the forward/OIDC work in the same run is still applied, and `syncAuthentikFailed` is true;
    - the same error on a dry run gives `syncAuthentikFailed` false;
    - no URIs plus a failing read gives no error;
    - a mobile URI on a forward-mode entry contributes nothing.
- [ ] T015 [US2] In `src/commands/networking/sync-authentik.ts`, make `formatSyncAuthentik` print the consent sections exactly as in `contracts/interfaces.md` §2 (change lines `+`/`~`/`-`, conflicts `!`, the failure line), each only when non-empty. **Tests first**, in `test/commands/sync-authentik-mobile-consent.test.ts`: the formatter output for creates, updates, deletes, conflicts and error; and a result with an empty `mobileConsent` formats byte-identically to one without the field.
- [ ] T016 [US2] In `src/web/proxy-sync.ts`, have `syncProxyLive` `logWarn` each `mobileConsent.conflicts` entry and any `mobileConsent.error`, prefixed `sync-authentik: mobile consent — `. `SyncProxyLiveResult` is unchanged. **Tests first**, in `test/web/proxy-sync.test.ts`, using the existing warning-capture helper: a conflict and an error each produce a warning, and the call still resolves successfully.

**Checkpoint**: US2 is complete. Commit `Reconcile a mobile-only consent step in sync-authentik (#22, US2)`.

---

## Phase 5: User Story 3 — Access tab (Priority: P3)

**Goal**: The Advanced dialog has General and Access tabs. Access shows only the current mode's fields, and the new mobile field has help text.

**Independent Test**: `accessFieldsFor` unit tests, plus a browser check at desktop width and at ≤640px (quickstart §3).

- [ ] T017 [P] [US3] In `web-client/src/lib/oidc.ts`, add `export type AccessField = 'authGroup' | 'authMode' | 'unauthenticatedPaths' | 'callbackUrls' | 'mobileRedirectUrls' | 'oidcClient'` and `export function accessFieldsFor(authMode?: 'forward' | 'oidc'): AccessField[]`. Forward or undefined returns `['authGroup','authMode','unauthenticatedPaths']`; `'oidc'` returns `['authGroup','authMode','callbackUrls','mobileRedirectUrls','oidcClient']`. **Tests first**, in `test/web-client/access-fields.test.ts`, following `test/web-client/admin-nav.test.ts`'s import style; if `oidc.ts` imports anything that stops it loading under plain node, put the helper in a new framework-free `web-client/src/lib/access-fields.ts` instead.
- [ ] T018 [US3] In `web-client/src/components/EditableAuthMode.tsx`, add `EditableOidcMobileRedirectUris({ guest, onSaved })`, modelled on `EditableOidcRedirectUris`. It uses the same edit/save/error/admin handling and PATCHes `{ oidcMobileRedirectUris }`, shows the saved list, and renders one help line: "For a native app's sign-in callback (custom scheme or its mobile-redirect page). Adds one consent click to mobile sign-ins only." Factor shared bits with `EditableOidcRedirectUris` only if that stays simple.
- [ ] T019 [US3] In `web-client/src/components/AdvancedGuestModal.tsx`, split the dialog into two tabs.
  - A `role="tablist"` strip with `General` and `Access` buttons (`role="tab"`, `aria-selected`); General is the default and one panel renders at a time.
  - **General**: type, ip, subdomains, host, vmid, port, read-only proxy, insecure backend tls, vpn, app.
  - **Access**: rows chosen by `accessFieldsFor(guest.authMode)`, in the order auth group, auth mode, unauthenticated paths / callback urls, mobile app redirect urls, oidc client. The oidc client row keeps its extra `isOidcEffective(guest)` condition. Any Authentik banners already rendered by the Editable* components stay with them.
  - Label the mobile row "mobile app redirect urls".
- [ ] T020 [US3] In `web-client/src/index.css`, add tab strip styles: an active-tab indicator; colors from the existing CSS variables, so dark mode works via `:root[data-theme='dark']`; wrapping, and no overflow at ≤640px. `.advanced-modal-fields` keeps its current layout.
- [ ] T021 [US3] Build and verify in a browser.
  - Run `npm --prefix <wt> run web:build`.
  - Start `npm --prefix <wt> run web:dev` (server on 3001 plus the vite client) and use the Chrome tools to walk quickstart §3 steps 2–6 at a desktop width and at 390px wide, in light and dark theme.
  - Screenshot each state for the PR.
  - Stop the dev servers afterwards by PID (`taskkill /PID <pid> /T /F`, then confirm with `Get-Process -Name node` / `Get-NetTCPConnection -State Listen`). Never kill Chrome by image name.
  - Note: `npm run web:dev` sets `WEB_UI_DEV_GROUPS=bellhop-admins`. If the worktree's `data/authentik.env` sets a different `AUTHENTIK_ADMIN_GROUP`, override `WEB_UI_DEV_GROUPS` so the session is admin (CLAUDE.md). Don't save anything that would push to real infrastructure: the worktree's `inventory/bellhop.db` is a copy of production, and a guest edit triggers `syncProxyLive` against the real proxy and Authentik. Run the dev server against a temp inventory instead (`INVENTORY_FILE=<tmp>/bellhop.db`, seeded with `import-yaml-inventory` from `inventory/hosts.yaml.example`) and with `AUTHENTIK_API_URL`/`AUTHENTIK_API_TOKEN` unset, so sync is skipped.

**Checkpoint**: US3 is complete. Commit `Split the guest Advanced dialog into General and Access tabs (#22, US3)`.

---

## Phase 6: Polish & documentation

- [ ] T022 [P] In `README.md`, update the "OIDC mode" section:
  - the mobile app redirect URLs field (when to use it; custom schemes allowed; the rejected schemes; the no-overlap rule);
  - the consent step (object names, exact-match behavior, fails closed, removed when no mobile URIs remain, flow cache cleared);
  - the extra API token permissions once any mobile URI is set (read/write on consent stages, flow-stage bindings, expression policies and policy bindings; flow cache clear);
  - a note that an existing hand-made consent stage and policy on the same flow should be deleted, or mobile logins show two consent pages;
  - the Access tab.
- [ ] T023 [P] In `CLAUDE.md`, describe `oidcMobileRedirectUris` in the inventory field description next to `oidcRedirectUris` (write-time-only cross-list rule, why). Describe the consent step in the `sync-authentik` bullet: ownership rules; the live-verified API quirks (`policies/all` ignores `name`, `flows/bindings` ignores `target__slug`, a policy binding targets `policybindingmodel_ptr_id`); failure isolation and the no-mobile-URI read-failure swallow; the cache clear. Also update the "Changing `authMode`/`oidcRedirectUris` through the Dashboard" paragraph to include the mobile list, and the MCP bullet's `edit_guest` field list. `CONTRIBUTING.md` needs no change unless a convention it restates changed; check.
- [ ] T024 Run `npm --prefix <wt> run typecheck`, `npm --prefix <wt> test` and `npm --prefix <wt> run web:build`, and paste the real output. Then walk quickstart §1–§3. Quickstart §4 (live Authentik plus a phone) is left for the operator and recorded as unverified in the PR.
- [ ] T025 Review the full `git -C <wt> diff origin/main...HEAD` for real operational data (constitution Principle I): no real hostnames, domains, IPs, UUIDs from the live capture, or the operator's real stage or policy names in fixtures, specs or commit messages.

---

## Dependencies & Execution Order

- **Setup (T001)** → needed by T011 only.
- **Foundational (T002)** blocks US1 and US2 (the field). US3 depends only on T009 (types) and T002's field existing server-side.
- **US1**: T003 → T004, T005 → T006; T007, T008, T009, T010 in parallel after T002/T005.
- **US2**: T011 and T012 (parallel) → T014; T013 is independent → T014 → T015 → T016.
- **US3**: T017 → T019; T018 → T019 → T020 → T021.
- **Polish** after all stories.

## Parallel Example: User Story 2

```text
Task: "T011 AuthentikClient consent methods + stubbed-fetch tests in src/lib/authentik-client.ts"
Task: "T012 FakeAuthentikClient consent methods in test/support/fake-authentik-client.ts"
Task: "T013 pythonStringLiteral / renderMobileConsentExpression in src/commands/networking/sync-authentik.ts"
```

(T013 and T014 touch the same file, so execute them sequentially even if planned in parallel.)

## Implementation Strategy

1. T001–T002, then US1 (MVP: custom-scheme callbacks survive the sync).
2. US2 (the consent step that makes Android hand-offs reliable).
3. US3 (Access tab).
4. Docs and verification; one commit per story, `tasks.md` checkboxes updated in the same commit.
