---

description: "Task list for the first-run setup reverse-proxy step (#87)"
---

# Tasks: First-run setup, reverse-proxy step

**Input**: Design documents from `specs/087-setup-reverse-proxy-step/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/http-setup-proxy.md, quickstart.md

**Tests**: Required. Constitution III says every behavior change ships with tests. Write each test first and see it fail. Remote calls use `FakeSSHClient`; the NPM client uses a fake `fetch`. The check commands' output is only passed through, never parsed, so a `FakeSSHClient` responder with an exit code is enough and no live capture is needed; the Traefik and NPM response shapes reuse the existing captured fixtures.

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Foundational (blocks every story)

- [ ] T001 [P] Write failing tests in `test/lib/setup-state.test.ts` for `uncompleteSetupStep(dbPath, step)`: removes a completed id, is a no-op for an id that is not completed, throws "Setup is not in progress" when finished or absent, leaves other completed ids in order
- [ ] T002 Add `uncompleteSetupStep` to `src/lib/setup-state.ts` (one immediate transaction like `completeSetupStep`)
- [ ] T003 [P] Write failing tests in `test/web/setup/finish.test.ts`: `requiredSteps` is `['proxmox', 'basics', 'proxy']`; Finish answers 409 `Finish step "Reverse proxy" first` when only proxmox and basics are complete; Finish succeeds with all three; update the existing finish tests that assume two required steps
- [ ] T004 In `src/web/setup/service.ts` add `'proxy'` to `REQUIRED_SETUP_STEPS` (after `basics`), `SETUP_STEP_LABELS.proxy = 'Reverse proxy'`, and `SetupService.uncompleteStep(step)`; add the label to the client's `STEP_LABELS` in `web-client/src/pages/SetupPage.tsx`
- [ ] T005 Export `proxyDriversInfo` from `src/web/routes/settings.ts` for reuse by the setup step (no behavior change); `npm run typecheck` and `npm test` green

## Phase 2: User Story 1: Point Bellhop at an existing proxy (P1) 🎯 MVP

**Goal**: Choose a driver and an inventory entry, set the driver's settings, store the NPM password write-only, and read it all back.

**Independent Test**: With a fixture inventory (one host, one guest), `PUT /api/setup/proxy` then `GET /api/setup/proxy`: the setting, the single proxy flag and the secret's `set` status are right, and no response carries the secret.

- [ ] T006 [US1] Write failing tests in `test/web/setup/proxy.test.ts` using `setupTestApp` (cookie header on every request): `GET` lists every registered driver (including `none`) with its label and the host and guest entries (no external sites); `PUT` with a driver and a guest sets `proxyDriver` and `proxy: true` on exactly that entry; a second `PUT` with another entry moves the flag (the first loses it); a nonexistent or external-site `entry` answers 400 naming it; a missing `entry` for a managing driver answers 400; `configPath: 'etc/caddy'` answers 400 naming `configPath` and an absolute-path message; `npmApiPassword` is stored through `writeSecret` and `GET` shows `secrets.npmApiPassword: true` while `JSON.stringify` of every response never contains the value; a blank password on a later `PUT` keeps the stored one; a key pinned by an environment variable answers 409 naming the variable; a rejected `PUT` changes nothing (inventory and secrets); a request without the setup cookie answers 401
- [ ] T007 [US1] Implement `src/web/setup/proxy.ts`: `proxyStepState(opts)` (drivers from `proxyDriversInfo()`, entries, current `ProxyChoice` from the inventory settings, `secrets` set/not set from `storedSecretKeys`/`configValueAt`, `pinned`, `complete`) and `saveProxyChoice(opts, body)`: validate every field with `SettingsSchema.pick`/`MovedSettingsSchema`/`SecretSettingsSchema` (a zod schema for the body), refuse env-pinned keys with 409, set `proxy` on the chosen entry and clear it everywhere else, apply settings with `assignSetting`, one `saveInventory`, then `writeSecret` for each non-empty secret; throws `SetupActionError` with a field-naming message that never echoes a value
- [ ] T008 [US1] Add `GET /api/setup/proxy` and `PUT /api/setup/proxy` to `src/web/routes/setup.ts` (zod body via `parseBody`, `handle` for `SetupActionError`)
- [ ] T009 [US1] Client: add the `ProxyChoice`/`ProxyStepState` types and `setupApi.proxy()`/`setupApi.saveProxy()` to `web-client/src/api/setup.ts`; add `ProxyStep` to `web-client/src/pages/SetupPage.tsx` with the driver `<select>` (`proxyDriverOptions`), the entry `<select>` (with the "no host or guest yet" message pointing back to step 1), the config path, Traefik cert resolver and API URL, and NPM URL/email/password fields shown per driver, password inputs `type="password"` with a set/not-set note and never prefilled, using the Basics step's classes and busy/error pattern; wire it into the step list

**Checkpoint**: choosing and saving a proxy works end to end.

## Phase 3: User Story 2: Choose how certificates are obtained (P1)

**Goal**: Certificate source and its fields, limited to what the driver supports, with the Cloudflare token write-only.

**Independent Test**: For each driver, `PUT` each supported and one unsupported `tlsSource`; the supported ones save, the unsupported one is refused with the supported list.

- [ ] T010 [US2] Write failing tests in `test/web/setup/proxy.test.ts`: for `nginx` (`tlsSources` per `nginxDriver.capabilities`) a supported source saves and an unsupported one answers 400 with the `checkTlsSource` message; `acme-dns` with provider `cloudflare` and no stored token answers 400 naming `cloudflareDnsApiToken`, succeeds with a token in the body, and succeeds with a stored token and a blank body; the token never appears in any response; `files` accepts blank `certificatePath`/`keyPath` (defaults from `domain`) and rejects a relative path; `none` ignores TLS fields and the response offers none; the driver's `defaultTlsSource` is what `GET` reports for an unset source
- [ ] T011 [US2] In `src/web/setup/proxy.ts` apply `tlsSource`, `acmeDnsProvider`, `proxyTlsCertificate`, `proxyTlsKey` through the same validation, run `checkTlsSource(updated, driver)` against the inventory as it would be saved and refuse with its message, and require the Cloudflare token only when `usesCloudflareDns01(updated, driver)` and no stored or environment token exists; `cloudflareDnsApiToken` goes through `writeSecret`
- [ ] T012 [US2] Client: in `ProxyStep` add the TLS source `<select>` (`tlsSourceOptions` from the selected driver's info, default marked), the ACME provider select, the Cloudflare token input (set/not-set note) under `acme-dns`, and the certificate and key path inputs under `files`; none shown for a driver where `managesProxy` is false

**Checkpoint**: the certificate choice is saved and refused consistently with `sync-proxy`.

## Phase 4: User Story 3: Prove the proxy before moving on (P1)

**Goal**: A read-only driver check, then the dry-run preview, completing the step only on a pass.

**Independent Test**: With a `FakeSSHClient` proxy host, a passing check returns the preview and completes the step, a failing one answers 502 with an actionable message and does not, and `ssh.history` holds no write, backup, restore or reload command.

- [ ] T013 [P] [US3] Write failing tests in `test/lib/proxy/file-driver.test.ts` and each `test/lib/proxy/drivers/{caddy,nginx,haproxy,traefik}.test.ts` for `check()`: the Caddy script tests that the Caddyfile exists then runs `caddy validate --adapter caddyfile --config <path>`; nginx tests the config directory then `nginx -t`; HAProxy tests the directory then `haproxy -c -f /etc/haproxy/haproxy.cfg` (adding `-f <path>` only when the file exists); Traefik tests the directory, and with `proxyApiUrl` also curls `<apiUrl>/api/overview` expecting HTTP 200 (curl missing is a named error); each failure throws a message naming the entry and, for a missing path, the `proxyConfigPath` fix; and a shared assertion that no command contains `cp `, `mv `, `trap`, `cat >`, `rm ` or a reload (`systemctl reload`)
- [ ] T014 [US3] Add `check?(deps: DriverDeps): Promise<string>` to `ReverseProxyDriver` in `src/lib/proxy/driver.ts` (documented read-only), add the `check: { target: 'file' | 'directory'; command(configPath, { inventory }): string | null }` definition field and a `check()` implementation to `fileDriver` in `src/lib/proxy/file-driver.ts` (existence test, driver command, `runRemote`, error text per the contract), and supply the definitions in `src/lib/proxy/drivers/{caddy,nginx,haproxy,traefik}.ts` per research R2
- [ ] T015 [P] [US3] Write failing tests for `caddy-api` (`test/lib/proxy/drivers/caddy-api.test.ts`: passes when the admin read answers; Caddyfile mode, missing curl and an unreachable admin endpoint each fail with the existing messages; only the read command is issued) and `nginx-proxy-manager` (`test/lib/proxy/drivers/nginx-proxy-manager.test.ts` with a fake `fetch`: sign-in then `listProxyHosts` passes; a refused sign-in fails with a message naming `npmApiEmail`/`npmApiPassword` and never the password; an unreachable URL names the URL)
- [ ] T016 [US3] Implement `check()` on `src/lib/proxy/drivers/caddy-api.ts` (`readCaddyConfig(deps, { checkService: true })`) and `src/lib/proxy/drivers/nginx-proxy-manager.ts` (`opts.clientFor(inventory).listProxyHosts()` with the sign-in error mapped to the message above)
- [ ] T017 [US3] Write failing tests in `test/web/setup/proxy.test.ts` for `POST /api/setup/proxy/check`: a passing nginx check returns `ok: true`, a `summary`, the same text `runSyncProxy({ apply: false })` returns as `preview`, and completes `proxy`; a failing check answers 502 with the driver message and leaves `proxy` incomplete; a pass with a throwing dry run answers 200 with `previewError` and leaves the step incomplete; `none` answers 400; no proxy entry chosen answers 400; `ssh.history` has no write/backup/restore/reload for every managing driver; the stored NPM password and Cloudflare token appear in no response
- [ ] T018 [US3] Implement `checkProxy(opts, deps)` in `src/web/setup/proxy.ts` (`getDriver`, `driverDeps`, `driver.check`, then `runSyncProxy({ apply: false })`, complete the step only when both succeed; map thrown errors to `SetupActionError` 502 with secrets scrubbed) and add `POST /api/setup/proxy/check` to `src/web/routes/setup.ts`; for `none`, `saveProxyChoice` completes the step
- [ ] T019 [US3] Client: add `setupApi.checkProxy()` and, in `ProxyStep`, a "Check proxy" button (disabled for `none`, shown after a save), the driver's one-line summary, the dry-run text in a scrollable monospace box, the `previewError` and 502 error text, and a "complete" badge; "No proxy" shows "Bellhop will manage no proxy" instead

**Checkpoint**: the step completes only by proving the proxy; nothing is written to it.

## Phase 5: User Story 4: Re-run and resume safely (P2)

**Goal**: Any change reopens the step; the saved values reappear after a reload; Finish waits for the step.

**Independent Test**: Complete the step, change one value, and see `proxy` drop out of `completedSteps` and Finish refuse; repeat the same save and see nothing change.

- [ ] T020 [US4] Write failing tests in `test/web/setup/proxy.test.ts`: after a passing check, a `PUT` that changes the driver, the entry, a setting, a secret (non-empty) or the TLS source removes `proxy` from `completedSteps`; a `PUT` with identical values and blank secrets leaves it complete and the inventory byte-identical; `GET` after a service restart (new `SetupService` over the same DB) returns the saved choice with secrets as set/not set; Finish answers 409 naming "Reverse proxy" while incomplete; two `PUT`s in a row leave at most one entry with `proxy: true`
- [ ] T021 [US4] In `saveProxyChoice` compare the stored `ProxyChoice` and secrets with the request (a non-empty secret counts as a change) and call `SetupService.uncompleteStep('proxy')` only on a difference; `none` re-completes after saving
- [ ] T022 [US4] Client: `ProxyStep` loads the saved choice and secret statuses on open, shows the step as incomplete after a changed save, and `FinishStep` lists "Reverse proxy" among the steps to complete; `STEP_LABELS`/step list order is Proxmox, Domain and basics, Reverse proxy, Finish

**Checkpoint**: the step is safe to repeat and resume.

## Phase 6: Polish and cross-cutting

- [ ] T023 [P] Update `docs/setup.md` (the new step, the check and preview, certificate choices, how to re-run), `src/web/CLAUDE.md` ("First-run setup" section: routes, `proxy` required step, secrets, the single-operator note that the check trusts the operator's chosen entry), `src/lib/proxy/CLAUDE.md` (the optional `check()` method in the interface section) and `src/lib/proxy/drivers/CLAUDE.md` (each driver's check), `web-client/CLAUDE.md` (the Proxy step); keep the root CLAUDE.md within its 250-line budget and `README.md` within 200 lines; run `test/docs/links.test.ts`
- [ ] T024 [P] Update `specs/087-setup-reverse-proxy-step/contracts/http-setup-proxy.md` and `research.md` if implementation changed any shape or message
- [ ] T025 Browser verification on a throwaway install (quickstart.md "Manual"): the full step at a desktop viewport and at ≤640px (no overflow, preview box scrolls, password never shown), saving and checking for NPM and one file driver against simulated hosts; record what was and was not verified for the PR body (a real proxy is not available here)
- [ ] T026 Run `npm run typecheck` and `npm test` from the worktree and paste the real output; mark the verification tasks complete

## Dependencies and order

- Phase 1 blocks everything.
- US1 (Phase 2) is the MVP: it creates `src/web/setup/proxy.ts`, the routes and the client step that US2 to US4 extend, so US2, US3 and US4 follow it. US2 and US3 touch different parts of `proxy.ts` and the client and can be built in either order after US1. US4 comes after US3, since its tests need a completable step.
- Within a story: tests (fail), implementation, client. T013 and T015 are `[P]` (different test files); T023 and T024 are `[P]`.

## Implementation strategy

MVP is Phases 1 and 2 (choose and save). Phases 3 and 4 make the step meaningful (certificates, proof); Phase 5 hardens re-runs. Commit per story: `<what the story delivers> (#87, US1)`, with the `tasks.md` checkbox updates in the same commit.
