---

description: "Task list for the HAProxy proxy driver (issue #32)"
---

# Tasks: HAProxy Proxy Driver

**Input**: Design documents from `specs/015-haproxy-proxy-driver/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/haproxy-config.md, quickstart.md

**Tests**: required — constitution Principle III (every behaviour change ships with tests). Write each test first and watch it fail.

**Organization**: grouped by user story; paths are repository-relative to the worktree.

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Setup

No setup: no new dependency, directory, or configuration. The worktree is already installed and seeded.

---

## Phase 2: Foundational (blocking)

- [x] T001 Add `'haproxy'` to `PROXY_DRIVER_IDS` between `'nginx-proxy-manager'` and `'none'` in `src/lib/proxy/ids.ts` (update its header comment), and update the order assertion at `test/lib/proxy/index.test.ts` (`['caddy', 'nginx', 'nginx-proxy-manager', 'haproxy', 'none']`). The inventory `proxyDriver` enum picks the id up automatically; confirm with an existing-style schema test in `test/lib/inventory.test.ts` that `proxyDriver: 'haproxy'` loads.

**Checkpoint**: typecheck passes; the id exists but no driver is registered yet.

---

## Phase 3: User Story 1 — Generate and deploy HAProxy configuration (P1) 🎯 MVP

**Goal**: `proxyDriver haproxy` + `sync-proxy` previews and applies the backends and map files per `contracts/haproxy-config.md`.

**Independent test**: `sync-proxy` dry run/apply with a `FakeSSHClient` and an example inventory; executed delivery script with stub `haproxy`/`systemctl`.

### Tests (write first)

- [x] T002 [P] [US1] Render tests in `test/lib/proxy/drivers/haproxy.test.ts`: exact text of both files for the contract's example (ungated guest with two hostnames, `insecureTls` host on 8006, port-443 external site with `ssl verify required ca-file /etc/ssl/certs/ca-certificates.crt`, OIDC route rendered identically to ungated); zero routes → each file is exactly the header line; both FileSpecs are `mode: 'owned'` with `ownedHeader` equal to their first line; map path is `bellhop.map` in `configPath`'s directory (e.g. `/opt/haproxy/sites.cfg` → `/opt/haproxy/bellhop.map`); `render()` throws naming `proxyConfigPath` when `configPath` is itself that map path; `X-Forwarded-Port` follows `ctx.externalPort`; hostnames lower-cased in the map.
- [x] T003 [P] [US1] Backend-name tests in `test/lib/proxy/drivers/haproxy.test.ts`: `bellhop_<ownerType>_<name>`; characters outside `[A-Za-z0-9_.:-]` become `_` (e.g. `a/b c` → `bellhop_externalSite_a_b_c`); a host and a guest with the same name get distinct names; two names that sanitise to the same backend name get `_2` on the later route (route order).
- [x] T004 [P] [US1] Driver metadata test in `test/lib/proxy/drivers/haproxy.test.ts`: `id 'haproxy'`, `label 'HAProxy'`, `capabilities { authModes: ['oidc'], acmeDns01ViaCloudflare: false }`, `defaultConfigPath '/etc/haproxy/bellhop.cfg'`, `statusPage null`, no `usesSharedCertificate`, the `configPathNote` text from data-model.md; `getDriver({ proxyDriver: 'haproxy' })` returns it and `listDrivers()` lists it between Nginx Proxy Manager and None (`test/lib/proxy/index.test.ts`).
- [x] T005 [P] [US1] Plan/apply/snapshot tests with `FakeSSHClient` in `test/lib/proxy/drivers/haproxy.test.ts`: `plan()` preview is both files' content (backends then map); `apply()` sends one script to the proxy host that contains the validate command `haproxy -c -f /etc/haproxy/haproxy.cfg -f '<configPath>'` and `systemctl reload haproxy` and writes both paths; `snapshot()` `cat`s both paths with `==> <path> <==` headers.
- [x] T006 [P] [US1] Executed-script test in `test/lib/proxy/drivers/haproxy.test.ts` (pattern: `test/lib/proxy/file-driver.test.ts` / `test/lib/proxy/drivers/nginx.test.ts`): run the generated script under `sh` in a `mkdtempSync` dir with stub `haproxy` and `systemctl` first on `PATH`. (a) stub `haproxy` exits 1 → both pre-existing Bellhop-headed files restored byte for byte, a previously absent map file removed again, `systemctl` never called, non-zero exit; (b) stub exits 0 → both files hold the rendered content and `systemctl reload haproxy` was recorded; (c) an existing map file whose first line is not the header → refused before writing, both files untouched.
- [x] T007 [P] [US1] End-to-end tests in `test/commands/sync-proxy.test.ts`: with `proxyDriver: 'haproxy'`, `runSyncProxy` dry run returns the contract preview and makes no SSH call; `--apply` sends one script to the `proxy: true` host. In `test/web/proxy-sync.test.ts`: `syncProxyLive` under `haproxy` logs the `prune-acme-challenges: skipped` line naming `haproxy`. In `test/commands/render-status-page.test.ts`: `runRenderStatusPage` rejects with `statusPageUnsupportedError('haproxy')` and `statusPageSkipReason` warns when `statusPagePath` is set.

### Implementation

- [x] T008 [US1] Create `src/lib/proxy/drivers/haproxy.ts`: `HEADER` (the exact header text in data-model.md), exported `backendName`-style derivation (research R3), `mapPath(configPath)` (POSIX dirname + `/bellhop.map`, research R9), `render(routes, ctx, configPath)` returning `[backends FileSpec, map FileSpec]` exactly per `contracts/haproxy-config.md`, throwing `HAProxy cannot enforce forward-auth for entry '<name>'` on a `forward` route (backstop), and `haproxyDriver = fileDriver({...})` with the metadata from data-model.md, `validateCommand: (p) => 'haproxy -c -f /etc/haproxy/haproxy.cfg -f ' + singleQuote(p)`, `reloadCommand: 'systemctl reload haproxy'`, `configFiles: (p) => [p, mapPath(p)]`. Match `drivers/nginx.ts`'s comment density and explain each rendered line's parity reason (research R5/R6).
- [x] T009 [US1] Register `haproxyDriver` in `src/lib/proxy/index.ts` between `nginxProxyManagerDriver` and `noneDriver`; update the registry-order comment; update `src/lib/proxy/file-driver.ts`'s "HAProxy is a candidate future driver" comment to say it ships.
- [x] T010 [US1] Run `npm run typecheck` and `npm test`; all of T002–T007 pass.

**Checkpoint**: US1 complete — the driver renders, applies, restores, and snapshots.

---

## Phase 4: User Story 2 — Forward-gated entries are refused (P1)

**Goal**: under `haproxy`, a forward-gated route is refused at `sync-proxy` and guest edit with the standard capability message; never emitted.

**Independent test**: real-driver tests below; no code beyond T008's declaration and backstop is expected.

- [ ] T011 [P] [US2] In `test/commands/sync-proxy.test.ts`: with `proxyDriver: 'haproxy'` and a forward-gated guest with subdomains, `runSyncProxy` (dry run and `--apply`) throws exactly `Entry '<name>' uses forward-auth gating, but the 'haproxy' proxy driver cannot enforce it -- set its authMode to oidc or clear authGroup` and makes no SSH call; a forward-gated `proxyManual` entry and a forward-gated entry with no subdomains are not refused.
- [ ] T012 [P] [US2] In `test/operations/edit-guest.test.ts`: with `proxyDriver: 'haproxy'`, a `commitGuestEdit` that leaves the guest forward-gated with subdomains is rejected (400-shaped result with the same message) and the inventory is unchanged; switching the same guest to `authMode: 'oidc'` (with a callback URL) or clearing `authGroup` is accepted.
- [ ] T013 [P] [US2] In `test/lib/proxy/drivers/haproxy.test.ts`: an OIDC route whose entry carries saved `unauthenticatedPaths` renders byte-identically to one without; `render()` given a `forward` route throws the backstop message naming the entry.
- [ ] T014 [US2] Run `npm test`; fix any gap in `src/lib/proxy/drivers/haproxy.ts` only if a US2 test fails (no new enforcement code is expected — research R8).

**Checkpoint**: US2 complete — SC-002 holds.

---

## Phase 5: User Story 3 — Choose and understand the driver (P2)

**Goal**: the Settings dropdown lists HAProxy with metadata-driven fields; documentation covers prerequisites and limits.

- [ ] T015 [P] [US3] In `test/web/routes/settings.test.ts`: both `proxyDrivers` list assertions gain `{ id: 'haproxy', label: 'HAProxy', defaultConfigPath: '/etc/haproxy/bellhop.cfg', suggestedStatusPagePath: null, managesProxy: true, usesSharedCertificate: false, configPathNote: '<data-model.md text>' }` between Nginx Proxy Manager and None. In `test/web-client/settings-display.test.ts`, add a `proxyFieldView('haproxy', …)` case: config path shown with the placeholder and note, status page and TLS fields hidden.
- [ ] T016 [P] [US3] Create `docs/reverse-proxy/haproxy.md` (follow `docs/reverse-proxy/nginx.md`'s structure): selecting the driver; the two files and what each holds; prerequisites — `EXTRAOPTS="-f /etc/haproxy/bellhop.cfg"` in `/etc/default/haproxy`, the frontend `bind … ssl crt <dir>` + `use_backend %[req.hdr(host),field(1,:),lower,map(/etc/haproxy/bellhop.map)]` rule (contract's prerequisite block), an operator-managed certificate tool; validate/reload; backend behaviour and TLS rule including the chain-only verification note (research R6); limits — no forward-auth (the capability error and its fix), no status page, `unauthenticatedPaths` ignored; single-operator assumptions (main config path, CA bundle, reload command). Example values only.
- [ ] T017 [P] [US3] Update `docs/reverse-proxy/README.md` (driver list, "other drivers that ship", the file-driver paragraph's HAProxy mentions, the certificates paragraph's "future HAProxy driver" sentence, the first driver that can't enforce every auth mode), `docs/configuration.md` (`proxyDriver` values/`proxyConfigPath` default per driver), and `README.md` (driver list; stay within the 200-line budget enforced by `test/docs/links.test.ts`).
- [ ] T018 [P] [US3] Update `CLAUDE.md`: driver-interface bullet (registered drivers and `listDrivers()` order, HAProxy no longer "a candidate"), a new "HAProxy driver" bullet after the nginx/NPM ones summarising files, validate/reload, OIDC-only capability, no status page, and its single-operator assumptions; fix the `prune-acme-challenges` "HAProxy, not yet shipped" wording; the Settings-page bullet's driver list. Check `CONTRIBUTING.md` needs no change.
- [ ] T019 [US3] Browser check (constitution IV): `npm run web:dev` in the worktree, Settings page, select HAProxy; verify dropdown order, config path placeholder + note, hidden status page/TLS fields at desktop width and at ≤640px. Kill the dev server by PID afterwards.

**Checkpoint**: US3 complete.

---

## Phase 6: Polish & verification

- [ ] T020 Run `npm run typecheck`, `npm test`, `npm run web:build`; paste results.
- [ ] T021 Quickstart §2 (CLI dry run against a temp inventory with `proxyDriver haproxy`) and §3 (real `haproxy -c` on the rendered output via Docker, both `haproxy:lts` and `haproxy:2.6`).
- [ ] T022 Review the full diff for real operational data (constitution workflow gate).

---

## Dependencies & execution order

- T001 → everything.
- US1: tests T002–T007 (parallel, same new test file for T002–T006 — write them together) → T008 → T009 → T010.
- US2 depends on T008/T009 (the registered driver); its tests T011–T013 are parallel.
- US3 depends on T009 for T015/T019; docs T016–T018 are parallel and independent of code.
- Polish after all stories.

## Parallel example

```text
US1 tests:  T002, T003, T004, T005, T006 (haproxy.test.ts), T007 (other test files)
US2 tests:  T011 (sync-proxy.test.ts), T012 (edit-guest.test.ts), T013 (haproxy.test.ts)
US3 docs:   T016, T017, T018
```

## Implementation strategy

MVP is US1 (the driver itself). US2 is equal priority but costs only tests,
since enforcement already exists; ship US1+US2 together. US3 makes it
discoverable and documented. Commit per user story.
