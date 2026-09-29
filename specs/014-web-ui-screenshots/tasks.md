---

description: "Task list for web UI screenshots from a demo instance"
---

# Tasks: Web UI screenshots from a demo instance

**Input**: Design documents from `specs/014-web-ui-screenshots/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Required by the spec (FR-018, FR-019, FR-020) and by constitution Principle III. Test
tasks come first within their phase and must fail before the code they cover is written.

**Organization**: US1 (screenshots in the docs) needs the images, and the images come from the
capture script, so the core capture lives in US1. US2 hardens regeneration (failure modes,
cleanup, contributor docs). US3 exposes the demo as its own command. All three sit on the
Phase 2 demo instance.

Paths are relative to the repository root (the worktree).

## Phase 1: Setup

- [x] T001 Add `playwright-core` (^1.63) to `devDependencies` in `package.json` and run `npm install` so `package-lock.json` updates; confirm `npm ci` downloads no browser (research R6)
- [x] T002 Add scripts to `package.json`: `"demo": "tsx scripts/demo/serve.ts"` and `"docs:screenshots": "tsx scripts/capture-screenshots.ts"` (contracts/commands.md)

---

## Phase 2: Foundational (demo instance — blocks every story)

**Purpose**: a demo instance of the real web UI against example-only data, with no access to real data or hosts (FR-001–FR-007).

### Tests first

- [x] T003 [P] Write `test/scripts/demo/demo-inventory.test.ts`: (a) `buildDemoInventory()` saved to a temp `bellhop.db` with `saveInventory` loads back through `loadInventory` without error (FR-018); (b) it meets data-model.md coverage: "at least two Proxmox hosts, at least eight guests covering both container and VM types", several guests with `subdomains`, `authGroup` at two or more different rungs, exactly one guest with `authMode: 'oidc'` plus `oidcRedirectUris`, several with `app`, one `proxy: true`, one `authentik: true`, one with `unauthenticatedPaths`; (c) two calls return independent objects (mutating one leaves the other unchanged)
- [ ] T004 [P] In the same test file add the example-data guard (FR-019, research R8): serialize the demo inventory, every seeded job's log text (from `demo-jobs.ts`'s exported log fixtures), every canned `DemoSSHClient` output, and the demo catalog; extract every IPv4-looking token and every domain-looking token; assert each IPv4 is in `192.0.2.0/24`, `198.51.100.0/24`, or `203.0.113.0/24` and each domain is `example.com`/`example.net`/`example.org` or ends in `.example`, `.test`, or `.invalid`. Include one negative case proving the scanner flags a non-example IP and domain.
- [ ] T005 [P] Write `test/scripts/demo/demo-server.test.ts` (FR-020, FR-006, FR-007): start `startDemoServer({ port: 0, serveClient: false })`; with no identity headers of its own, request `/api/whoami` (username `admin`, admin, not `localOperator`), `/api/inventory` (demo hosts/guests), `/api/guests/status` (both `running` and `stopped` present, no failures), `/api/provisioning` and `/api/provisioning/install-app/apps` (non-empty stable group), `/api/provisioning/install-app/check-app?app=<a demo slug>` (found), `/api/jobs` (four seeded jobs, one `failed`, fixed `createdAt` values), `/api/jobs/<install-app job id>` (log present), `/api/maintenance`, `/api/settings`; each 200. Also assert the demo's inventory path and data dir are inside `os.tmpdir()` and that the temp directory no longer exists after `close()`.
- [ ] T006 [P] Add `DemoSSHClient` tests to `test/scripts/demo/demo-server.test.ts` or a sibling `test/scripts/demo/demo-ssh.test.ts`: `pvesh get /nodes/$(hostname)/lxc --output-format json` on `pve1`'s `ssh_target` returns only `pve1`'s lxc guests with their fixed statuses; `pct status 1050 || qm status 1050` exits non-zero; an unknown command exits 0 with `[demo] simulated: <first line>`; no call throws.

### Implementation

- [x] T007 [P] Create `scripts/demo/demo-inventory.ts` exporting `buildDemoInventory(): Inventory` per data-model.md: `domain: 'example.com'`; settings `backupStorage: 'nas-backup'`, `dnsServer: '198.51.100.53'`, `nfsServer: '198.51.100.5'`; hosts `pve1`/`pve2` (`ssh_user: 'root'`, `ssh_target` in `192.0.2.0/24`, `midScheme` `vmidBase` 1000/2000 with `ipPrefix` `198.51.100.`/`203.0.113.` and a gateway in the same range, bridges, storages covering `vztmpl`, `rootdir`, `images`, and an `nfs` backup storage); 9–10 guests with generic names and public app slugs covering every coverage point in T003. Return a fresh object on every call.
- [ ] T008 [P] Create `scripts/demo/demo-ssh.ts` exporting `DemoSSHClient implements SSHClient` (`exec`, `execInteractive`, `putFile`) built from the demo inventory, answering per research R2 (guest listings with fixed statuses, network/storage listings, VMID check non-zero, a truncated placeholder `authorized_keys` line, `apt-get` for the package-manager probe, catch-all `[demo] simulated: ...`). Stream stdout through `onChunk` like `FakeSSHClient`. Export the canned output strings T004 scans. Never import `ssh2`.
- [ ] T009 [P] Create `scripts/demo/demo-fetch.ts` exporting `demoFetch: typeof fetch` and the catalog slug lists, answering per research R3: the two GitHub `contents/ct` URLs with `{ name: '<slug>.sh', type: 'file' }[]`, raw `ct/<slug>.sh` / `install/<slug>-install.sh` for listed slugs with a short script body, and a 404 `Response` for anything else.
- [ ] T010 [P] Create `scripts/demo/demo-jobs.ts` exporting `seedDemoJobs(store, jobLog, jobsDbPath, owner)` and its log fixtures: jobs `install-app` (target a demo guest, `success`), `update-all` (`success`), `sync-inventory` (`success`), `update-app` (`failed`), all `triggered_by_username: 'admin'`; create through `JobStore.createJob`, append logs through `jobLog.append`, finish through the store's own status methods, then overwrite `created_at`/`started_at`/`finished_at` with fixed ISO timestamps on one date, a few minutes apart (research R5). Logs use only demo names and addresses.
- [ ] T011 Create `scripts/demo/demo-server.ts` exporting `startDemoServer({ port, serveClient = true }): Promise<{ url, port, dir, inventoryPath, close }>` per research R1/R4/R9: set `process.env.WEB_UI_AUTH_MODE = 'authentik'`, `INVENTORY_FILE`/`WEB_DATA_DIR` to the temp dir, delete `WEB_UI_DEV_USER`, `WEB_UI_DEV_GROUPS`, `WEB_UI_LOCAL_USER`, and every `AUTHENTIK_*` variable; `mkdtempSync(os.tmpdir()/bellhop-demo-)`; `saveInventory` the demo inventory; open `JobStore`/`createJobLog`/`JobRunner` with `DemoSSHClient`; seed jobs; `buildApp` with `UnconfiguredAuthentikClient`, `UnconfiguredCloudflareClient`, `demoFetch`, and a stub `goBuilder`; mount it behind an outer Express app whose first middleware sets `x-authentik-username: admin`, `x-authentik-email: admin@example.com`, `x-authentik-groups: bellhop-admins`; when `serveClient`, serve `web-client/dist` with the same SPA fallback as `src/web/server.ts`; create the HTTP server, `prependListener('upgrade')` to set the same headers, `attachJobsWebSocket`; listen and resolve once listening (reject on `EADDRINUSE`). `close()` closes the server, the job store, and removes the temp dir. Never dotenv-load anything. (depends on T007–T010)
- [ ] T012 Run `npm test -- test/scripts/demo` equivalent (`node --import tsx --test "test/scripts/demo/*.test.ts"`) and `npm run typecheck`; all of T003–T006 pass.

**Checkpoint**: the demo instance serves the full API from example data; tests prove it never touches real data.

---

## Phase 3: User Story 1 — A visitor sees the web UI while reading the docs (P1) 🎯 MVP

**Goal**: seven screenshots, captured from the demo, placed next to the text they illustrate.

**Independent test**: open README.md and the three docs pages rendered; every image loads, sits next to its text, has descriptive alt text, and shows example values only.

- [ ] T013 [P] [US1] Create `scripts/screenshots.ts` exporting `SCREENSHOTS` — the seven definitions from contracts/screenshot-set.md (`file`, `path`, `viewport: 'desktop' | 'phone'`, `theme`, `ready` selector, optional `prepare(page)`, optional `target` selector). Key selectors on visible text or accessible names. The OIDC guest's Advanced modal is opened from the Dashboard and switched to its Access tab; the catalog shot types a short prefix into the App field so the suggestion list opens; `job-log.png` opens `/jobs/<id of the seeded install-app job>` (look the id up from `/api/jobs` at capture time, not hardcoded).
- [ ] T014 [US1] Create `scripts/capture-screenshots.ts`: check `web-client/dist/index.html` exists; launch the browser (`chrome`, then `msedge`, then bundled Chromium); `startDemoServer({ port: 0 })`; for each definition, a new context with `locale: 'en-US'`, `timezoneId: 'UTC'`, `reducedMotion: 'reduce'`, the definition's `colorScheme`, and viewport (desktop 1440×900 at scale 1, phone 390×844 at scale 2); navigate, run `prepare`, wait for `ready` (15 s), screenshot the viewport or `target` into a temp file then move it to `docs/images/<file>`; print `  wrote docs/images/<file>`; always close the browser and the demo in `finally` (contracts/commands.md)
- [ ] T015 [US1] Run `npm run web:build` then `npm run docs:screenshots`; iterate on selectors/preparation in `scripts/screenshots.ts` until all seven images are written and each shows the intended screen with representative content; open every PNG and confirm by eye that no non-example value appears; confirm `docs/images/` totals ≤ 3 MB (SC-005), reducing viewport or using the element capture where an image is oversized
- [ ] T016 [P] [US1] Add `dashboard.png` to `README.md` between the introduction paragraphs and `## Prerequisites`, with descriptive alt text; confirm README stays ≤ 200 lines (FR-014)
- [ ] T017 [P] [US1] Add `install-app-catalog.png`, `job-log.png`, `update-page.png`, and `dashboard-phone.png` to `docs/web-ui.md`, each next to the paragraph describing that screen (add one short sentence introducing the phone card layout where the phone shot goes), each with descriptive alt text (FR-015, FR-016)
- [ ] T018 [P] [US1] Add `guest-access-oidc.png` to the `## OIDC mode` section of `docs/authentik.md` next to the text about per-guest settings, with alt text (FR-015)
- [ ] T019 [P] [US1] Add `settings-proxy-driver.png` to `docs/reverse-proxy/README.md` where choosing a driver is described, with alt text (FR-015)
- [ ] T020 [US1] Run `npm test` (the docs link test checks every image link) and view the four pages rendered at desktop and phone width

**Checkpoint**: MVP — the docs show the web UI.

---

## Phase 4: User Story 2 — A maintainer regenerates every screenshot with one command (P2)

**Goal**: the capture command is reliable, fails clearly, and leaves nothing running.

**Independent test**: in a checkout with no `data/` and no `inventory/bellhop.db`, run `npm run docs:screenshots` twice; both succeed with the same content; nothing is left running.

- [ ] T021 [US2] In `scripts/capture-screenshots.ts`, when no browser launches, print each attempt with its error and `Install Google Chrome or Microsoft Edge, or run: npx playwright install chromium`, exit 1, and do not start the demo (FR-010)
- [ ] T022 [US2] In `scripts/capture-screenshots.ts`, when a definition fails (navigation, `prepare`, or `ready` timeout), print `Screenshot <file> failed: <reason>`, write no image for it, clean up, exit 1 (FR-012); verify by temporarily pointing one definition's `ready` at a selector that never appears, then revert
- [ ] T023 [US2] Verify cleanup and isolation by hand (quickstart §3): run the capture twice and compare images for identical content; confirm with `Get-Process`/`Get-NetTCPConnection` that no demo port is still listening and no browser process started by the script remains; confirm `git status` shows only intended image changes and `data/`/`inventory/bellhop.db` were never created
- [ ] T024 [P] [US2] Document regeneration in `docs/web-ui.md` (a short "Screenshots" note: `npm run docs:screenshots`, needs Chrome/Edge, writes `docs/images/`) and add to `CONTRIBUTING.md` that a change altering a screenshotted screen should regenerate the screenshots and check them by eye for example-only values (FR-017)

**Checkpoint**: screenshots are reproducible on demand.

---

## Phase 5: User Story 3 — Anyone tours the web UI without infrastructure (P3)

**Goal**: `npm run demo` gives a populated, throwaway web UI.

**Independent test**: `npm run demo`, click through every sidebar page, save a guest edit, stop, restart — the edit is gone and the checkout is unchanged.

- [ ] T025 [US3] Create `scripts/demo/serve.ts` per contracts/commands.md: read `PORT` (default `3100`); if `web-client/dist/index.html` is missing print `The web UI has not been built yet. Run: npm run web:build` and exit 1; start the demo; print the running message; on `EADDRINUSE` print the port-in-use message and exit 1; on SIGINT/SIGTERM `close()` and exit 0
- [ ] T026 [US3] Verify by hand (quickstart §2): every sidebar page renders with demo data and no "no authentication configured" banner; an install-app preview and a guest edit succeed; restart restores the original data; a second instance on the same port gets the port-in-use message; stop leaves no process listening
- [ ] T027 [P] [US3] Document `npm run demo` in `docs/web-ui.md` (what it shows, that nothing reaches a real host, that changes vanish on stop, `PORT`) and point to it from `CONTRIBUTING.md`'s setup section as the no-infrastructure way to see the UI; add one line to the README's Documentation or Setup area only if the 200-line budget allows (FR-017, SC-003)

**Checkpoint**: all three stories done.

---

## Phase 6: Polish & cross-cutting

- [ ] T028 [P] Add a short `CLAUDE.md` note under Workflow conventions: the demo instance (`scripts/demo/`) is how screenshots are made, it must stay example-data-only (guarded by `test/scripts/demo/demo-inventory.test.ts`), and a UI change that alters a screenshotted screen regenerates them
- [ ] T029 Run the full gate: `npm run typecheck`, `npm test`, `npm run web:build`
- [ ] T030 Review the full branch diff (`git diff main...HEAD`), images included, for any real operational data (constitution workflow gate)

---

## Dependencies & execution order

- Phase 1 → Phase 2 → US1 → US2; US3 depends only on Phase 2 and can run in parallel with US1/US2.
- Within Phase 2: T003–T006 (tests) and T007–T010 (independent modules) are each parallel; T011 needs T007–T010; T012 last.
- Within US1: T013 → T014 → T015; T016–T019 parallel once T015 has produced the images; T020 last.
- US2's T021/T022 edit `scripts/capture-screenshots.ts` after T014; T024 is docs-only.
- Polish runs after all stories.

## Parallel examples

```text
Phase 2 tests:  T003, T004, T005, T006
Phase 2 code:   T007, T008, T009, T010
US1 docs:       T016, T017, T018, T019
```

## Implementation strategy

MVP is Phase 1 + Phase 2 + US1: the docs show the web UI, produced by the capture script from
the demo. US2 makes regeneration trustworthy; US3 is a cheap extra on the same demo server.
Commit per phase/story.
