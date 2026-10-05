---

description: "Task list for the first-run setup walkthrough foundation (#86)"
---

# Tasks: First-run setup walkthrough foundation

**Input**: Design documents from `specs/086-setup-walkthrough-foundation/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/http-setup.md, quickstart.md

**Tests**: Required. Constitution III says every behavior change ships with tests. Write each test first and see it fail.

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Setup

- [x] T001 Capture live Proxmox responses with the operator and commit them redacted (RFC 5737 IPs, `pve1`/`pve2`, shape preserved) as `test/fixtures/proxmox/version.json` (`pvesh get /version --output-format json`), `test/fixtures/proxmox/cluster-status.json` (`pvesh get /cluster/status --output-format json` on a clustered node), `test/fixtures/proxmox/cluster-status-standalone.json` (a standalone node, or the clustered capture reduced to its local node entry if no standalone node exists, noted in `test/fixtures/proxmox/README.md`) and `test/fixtures/proxmox/network.json` (`pvesh get /nodes/<node>/network --output-format json`); document provenance in `test/fixtures/proxmox/README.md`

## Phase 2: Foundational (blocks every story)

- [x] T002 Write failing tests in `test/lib/inventory.test.ts`: an inventory with no `domain` loads and saves; `SettingsSchema` accepts `example.com` and rejects `not_a_domain` with "must be a domain name such as example.com"; `validateInventory` reports an entry with subdomains while `domain` is unset, with the `settingFix('domain', '<domain>')` remedy
- [x] T003 Move `domain` into `SettingsSchema` as an optional DNS name (regex and message from research R10), drop `InventorySchema`'s required `domain`, load/save it through `SETTINGS_KEYS` (keep the `meta` row key `domain`), and add the subdomains-need-a-domain rule to `validateInventory` in `src/lib/inventory.ts`
- [x] T004 Add `requireDomain(inventory)` to `src/lib/hostname.ts`, throwing "domain is not set -- " + `settingFix('domain', '<domain>')`; update every `inventory.domain` reader the compiler flags (`src/lib/proxy/routes.ts`, `src/commands/networking/{adopt-oidc-client,prune-acme-challenges,sync-authentik}.ts`, `src/commands/provisioning/set-guest-vpn.ts`, `src/web/routes/dashboard.ts`, `src/lib/hostname.ts`, plus any others) to use it or handle `undefined`; fix the test fixtures that relied on the required field; `npm run typecheck` and `npm test` green

## Phase 3: User Story 1: Open the walkthrough safely (P1) 🎯 MVP

**Goal**: A fresh install logs a setup address with a token; only that token opens the walkthrough; every other route is gated while pending.

**Independent Test**: Start against an empty inventory, then check the log line, the token exchange, and the 401/503/303 gate responses (contracts/http-setup.md, "Gate").

- [x] T005 [P] [US1] Write failing tests in `test/lib/setup-state.test.ts` for `setup_state` ("`id` INTEGER PRIMARY KEY `CHECK (id = 1)`", "`status` `CHECK (status IN ('pending', 'finished'))`", "`token` `NULL` once `finished`", "`completed_steps_json` `'[]'` initially"): phase table from data-model.md (no row + 0 hosts = pending; no row + hosts = not-applicable; pending row; finished row), `ensurePending` creates the row and token once and returns the same token later, `completeStep` is idempotent, `finish` sets finished and nulls the token, and `saveInventory` leaves the table untouched
- [x] T006 [US1] Implement `src/lib/setup-state.ts` (`setupPhase`, `ensurePendingSetup` with a 32-byte base64url token, `completeSetupStep`, `finishSetup`, `loadSetupState`) using `openDb` and its own `CREATE TABLE IF NOT EXISTS`
- [x] T007 [P] [US1] Write failing tests in `test/web/setup/gate.test.ts` with supertest on `buildApp` and a temp DB: while pending, `/api/inventory` and `/auth/login` answer 503 `setupRequired`; a page GET (`/settings`) redirects 303 to `/setup`; a static path with an extension passes through; `GET /setup?token=<valid>` sets `bellhop_setup` (HttpOnly, SameSite=Strict, Path=/, no Secure) and redirects to `/setup`; a wrong token sets no cookie; `/api/setup/state` without the cookie answers 401 and with it 200; `GET /api/setup/status` needs no cookie; when not-applicable or finished, the gate is a no-op, `/api/setup/state` answers 404 and `GET /setup` redirects to `/`
- [x] T008 [US1] Implement `SetupService` in `src/web/setup/service.ts` (phase cached in memory; constant-time token check over SHA-256 digests with `timingSafeEqual`; `completeStep`; `finish`), and `setupGate` plus the cookie helpers in `src/web/setup/gate.ts`, per research R3/R4
- [x] T009 [US1] Implement `src/web/routes/setup.ts`: the `GET /setup` token exchange and the `/api/setup` router with `status` and `state` (state returns completedSteps, requiredSteps `['proxmox', 'basics']`, hosts, settings subset, key info, storages); mount the gate and the setup routes first in `buildApp` (`src/web/app.ts`), with an optional `setup` dep defaulting to a service that reports not-applicable so existing tests are unaffected
- [x] T010 [US1] In `src/web/server.ts`, create the `SetupService` after `importEnvFilesAndUseStore`/`loadInventory`, call `ensurePendingSetup` when pending, and log `Setup is pending: open http://localhost:<port>/setup?token=<token> (use this machine's address from another device)` on every start while pending; pass the service to `buildApp`
- [x] T011 [US1] Refuse the job-log WebSocket upgrade with 503 while setup is pending in `src/web/routes/jobs.ts` (`attachJobsWebSocket` takes the setup service), with a test in `test/web/setup/gate.test.ts` or the existing jobs WS test
- [x] T012 [US1] Client: `web-client/src/api/client.ts` navigates to `/setup` on a 503 with `setupRequired`; `web-client/src/App.tsx` routes `/setup` to `SetupPage` outside the sidebar shell; new `web-client/src/pages/SetupPage.tsx` shows the "open the setup address from the service log" message on a 401 from `/api/setup/state`, otherwise a step list (Proxmox, Domain and basics, Finish) with the first incomplete step open

**Checkpoint**: The gate and token flow work end to end; the walkthrough shell renders.

## Phase 4: User Story 2: Connect the first Proxmox host and its cluster (P1)

**Goal**: Bellhop's own key, the password or manual key install, the node test, the host save plus sync, cluster peers, and the `midScheme` suggestion.

**Independent Test**: With `FakeSSHClient` answering from the captured fixtures, drive the step-1 routes and assert inventory contents and SSH history (contracts/http-setup.md, "Routes").

- [x] T013 [P] [US2] Write failing tests in `test/lib/bellhop-key.test.ts`: `ensureBellhopKey(dataDir)` creates `ssh/id_ed25519` + `.pub` once and never overwrites; `keyFromFile` accepts an unencrypted OpenSSH key and refuses an encrypted one ("passphrase-protected keys can't be used unattended") and a non-key file; `authorizedKeysLine` is `ssh-ed25519 AAAA… bellhop`
- [x] T014 [P] [US2] Implement `src/lib/bellhop-key.ts` with `ssh2`'s `utils.generateKeyPairSync('ed25519', { comment: 'bellhop' })` and `utils.parseKey` (`getPublicSSH()` for the public half), writing the private key with mode 0o600
- [x] T015 [P] [US2] Write failing tests in `test/lib/pve-discovery.test.ts` against the T001 fixtures: `parseVersion` returns the version and rejects non-JSON; `clusterPeers(status)` returns the non-local `node` entries with name and ip, and none for the standalone fixture; `primaryBridgeAddress(network)` picks the active bridge carrying an address with a gateway
- [x] T016 [P] [US2] Implement `src/lib/pve-discovery.ts` with zod schemas for the three responses (constitution II)
- [x] T017 [P] [US2] Write failing tests in `test/lib/mid-suggest.test.ts`: the prefix, CIDR and gateway come from the bridge address; `vmidBase` is the smallest unused multiple of 1000 starting at 1000; there is no suggestion when no bridge has IPv4; the result passes `MidSchemeSchema`
- [x] T018 [P] [US2] Implement `suggestMidScheme` in `src/lib/mid-suggest.ts`
- [x] T019 [US2] Add an optional `password` to `SshTarget` and the password / keyboard-interactive auth in `Ssh2SSHClient.connectConfig` (`src/lib/ssh-client.ts`, research R6; no key or agent when a password is set); add the optional `sshDir` argument (default `/root/.ssh`) to `buildAuthorizedKeysEnsurePresentScript` in `src/lib/authorized-keys.ts`, with a test in `test/lib/authorized-keys.test.ts` that existing output is unchanged and a custom dir is used
- [x] T020 [US2] Write failing route tests in `test/web/setup/proxmox.test.ts` (setup cookie, `FakeSSHClient` responder on fixtures): `POST /api/setup/key` for generated and file modes; `install-key` sends the ensure-present script over a target carrying the password and never returns or logs the password (assert on response bodies and captured console); a password failure gives 502 with fixed text; `hosts/test` returns nodeName and version and 502 for a non-Proxmox answer; `POST /api/setup/hosts` saves the host under its node name with `ssh_identity_file`, runs the sync-inventory apply (guests land), returns peers from the cluster fixture, and is idempotent on repeat (one host, guests kept); a name collision with a guest gives 409; `PUT hosts/:name/mid-scheme` validates, saves and marks `proxmox` complete; the state route returns the suggested midScheme
- [x] T021 [US2] Implement `src/web/setup/proxmox.ts` (installKey, testHost, saveHost: upsert, then `MAINTENANCE_OPERATIONS['sync-inventory'].apply`, then peers via `/cluster/status` and network for the suggestion) and wire the routes into `src/web/routes/setup.ts` with zod bodies per data-model.md ("`address`: non-empty, no whitespace", "`user` default 'root'", "`port` integer 1–65535 default 22", "`password` non-empty, no control characters")
- [x] T022 [US2] Step 1 panel in `web-client/src/pages/SetupPage.tsx`: key choice and public key with a copy button and the manual `authorized_keys` instructions; endpoint form; install-with-password (masked input, cleared after use); test; save; peer list with add/skip per peer (reusing the same form, prefilled); a `midScheme` editor per host prefilled with the suggestion; errors shown inline
- [ ] T023 [US2] Manual verification of `Ssh2SSHClient`'s password path against a lab Proxmox node (constitution III), recorded for the PR body; if no lab node is available, record it as unverified
  - **Unverified**: no lab Proxmox node was used; the password path in `Ssh2SSHClient` is covered only by `FakeSSHClient` tests and must be checked by the operator.

**Checkpoint**: Step 1 works against the fakes; the host and guests land in inventory.

## Phase 5: User Story 3: Domain and basics, then finish (P2)

**Goal**: Save the domain and the optional basics; Finish ends setup for good.

**Independent Test**: Save basics, finish, then confirm the token is refused, the state route answers 404, and pages are served normally.

- [x] T024 [US3] Write failing tests in `test/web/setup/finish.test.ts`: `PUT /api/setup/basics` validates with `SettingsSchema` (an invalid domain gives 400 naming `domain`), saves, and marks `basics` complete; `POST /api/setup/finish` answers 409 naming the first incomplete step, otherwise 200 `{ redirect: '/' }`, clears the cookie, nulls the token in the DB, and afterwards the gate is off and the old token is refused; a new `SetupService` over the same DB with every host deleted still reports finished
- [x] T025 [US3] Implement the basics and finish routes in `src/web/routes/setup.ts` (basics saved via `loadInventory` + `assignSetting` + `saveInventory`, the same path `set-config` uses)
- [x] T026 [US3] Step 2 panel (domain required; dnsServer, backupStorage with suggestions from the discovered storages, nfsServer) and the Finish panel (disabled until both steps are done; navigates to `/` on success) in `web-client/src/pages/SetupPage.tsx`

## Phase 6: User Story 4: Resume an interrupted walkthrough (P2)

**Goal**: Reopening the walkthrough lands on the first incomplete step with saved values.

**Independent Test**: Complete step 1, rebuild the app over the same DB, and confirm the state shows step 1 complete with its hosts.

- [x] T027 [US4] Test in `test/web/setup/proxmox.test.ts` (or `finish.test.ts`): after step 1, a fresh `buildApp` + `SetupService` over the same DB returns `completedSteps: ['proxmox']` and the saved hosts and `midScheme`
- [x] T028 [US4] `SetupPage.tsx` opens on the first incomplete step, lets the operator go back to a completed one, and shows its saved values

## Phase 7: User Story 5: The domain is an ordinary setting (P3)

**Goal**: `domain` can be edited on the Settings page and through `set-config`, with one rule.

**Independent Test**: `set-config domain` valid/invalid/unset-with-subdomains; Settings PATCH the same.

- [x] T029 [P] [US5] Tests in `test/commands/set-config.test.ts`: `set-config domain example.net --apply` saves it; an invalid value is refused with the schema message; `--unset` while an entry has subdomains is refused with the subdomain rule
- [x] T030 [P] [US5] Tests in `test/web/routes/settings.test.ts`: GET includes `domain`; a PATCH with an invalid domain gives 400; a PATCH clearing it while subdomains exist is refused
- [x] T031 [US5] Make the Settings route return and accept `domain` (`src/web/routes/settings.ts`; it may need nothing beyond T003), and add the domain field with help text to `web-client/src/pages/SettingsPage.tsx` (and `web-client/src/lib/settings-display.ts` if field metadata lives there)

## Phase 8: User Story 6: `import-yaml-inventory` is gone (P3)

**Goal**: Remove the command and the example file; add the demo seed script; update the docs.

**Independent Test**: The command is unknown, the seed script writes a loadable DB, and the docs link test passes.

- [x] T032 [P] [US6] Write a failing test in `test/scripts/demo/seed-db.test.ts`: `seedDemoDb(path)` writes a DB that `loadInventory` accepts and that matches the demo inventory's hosts and guests; a second call without `force` refuses to overwrite
- [x] T033 [US6] Implement `scripts/demo/seed-db.ts` (exporting `seedDemoDb`, with a CLI entry taking `<path> [--force]`) and an `npm run demo:seed` script in `package.json`
- [x] T034 [US6] Delete `src/commands/maintenance/import-yaml-inventory.ts`, `test/commands/import-yaml-inventory.test.ts` and `inventory/hosts.yaml.example`; remove the CLI registration in `src/cli.ts`; remove the remaining code references (`src/lib/config-import.ts`, `src/lib/proxy/legacy-tls.ts`, `src/commands/maintenance/sync-inventory.ts` comments, `test/web/routes/provisioning.test.ts`)
- [x] T035 [US6] Update the docs: the README quickstart says to install, then open the setup address with the setup token (stay under 200 lines); `CONTRIBUTING.md` and `docs/environment-variables.md` use `npm run demo:seed`; `docs/configuration.md` and `docs/reverse-proxy/README.md` lose their import references, and `docs/configuration.md` documents `domain` as a setting; the root `CLAUDE.md` testing bullet and fresh-worktree bullet; `src/commands/maintenance/CLAUDE.md`; `src/lib/CLAUDE.md` (setup_state table, domain setting, Bellhop key); `src/web/CLAUDE.md` gets a "First-run setup" section (gate, token, cookie, single-operator note: one service process, setup over plain HTTP)

## Phase 9: Polish and cross-cutting

- [x] T036 Add a setup walkthrough doc page `docs/setup.md` (what each step does, where the token comes from, the security notes) and link it from the README documentation index
- [x] T037 `npm run typecheck`, `npm test`, `npm run web:build`, all green
- [x] T038 Browser verification of `/setup` (every step state, errors, peer list, key box) and the Settings domain field at desktop width and at ≤640px, against a demo/fake-backed instance; confirm no horizontal overflow
- [x] T039 Principle I sweep of the full diff (`git diff main...HEAD`): example values only in fixtures, specs, docs and commit messages
- [x] T040 Run the quickstart.md scenarios that need no real hosts, and record the rest as unverified for the PR

## Dependencies

- T001 blocks T015/T016 (fixtures), and so the step-1 route tests (T020).
- Phase 2 (T002–T004) blocks everything: a fresh DB must load without a domain.
- US1 (T005–T012) blocks US2–US4 (the setup routes and service).
- US2 blocks US3's finish test only through `proxmox` being a required step (tests can mark steps directly).
- US5 depends only on Phase 2. US6 is independent of US1–US5 except for the README wording.

## Parallel opportunities

- T005 ∥ T007 (different test files); T013/T015/T017 and their implementations T014/T016/T018 run in parallel; T029 ∥ T030; T032 runs alongside US5.

## Implementation strategy

MVP = Phase 2 + US1 (the gate and token on a fresh install), then US2 (the first real step), then US3/US4 (finish and resume), then US5/US6 (the setting and the removal), then polish. Commit per phase/story.
