# Research: Web UI screenshots from a demo instance

All findings below come from reading the current code on this branch (based on `main` at
`86cf160`, after #41 moved the reference docs into `docs/`).

## R1. How the demo runs the real web UI without real data

**Decision**: Build the demo on `buildApp(deps)` (`src/web/app.ts`), not on `src/web/server.ts`.
A new `scripts/demo/demo-server.ts` exports `startDemoServer({ port })`, which creates a temp
directory with `mkdtempSync`, saves the demo inventory there with `saveInventory`, opens a
`JobStore`/`createJobLog` in the same directory, builds the app with injected fakes, serves
`web-client/dist` the same way `server.ts` does, and attaches `attachJobsWebSocket`. It returns
`{ url, close() }`; `close()` stops the server and removes the temp directory.

**Rationale**: `server.ts` does three things the demo must not do at module load: dotenv-loads
`data/authentik.env` and `data/cloudflare-api.env`, resolves `inventoryPath()`/`dataDir()`
from the checkout, and builds a real `Ssh2SSHClient`. `buildApp` takes all of those as
dependencies (`inventory`, `inventoryPath`, `baseSsh`, `jobStore`, `jobLog`, `jobRunner`,
`authentik`, `cloudflare`, `fetchImpl`, `goBuilder`) — the same seams the web route tests use.
A grep of `src/` for `inventoryPath()`, `dataDir()`, and `REPO_ROOT` finds no call inside the
request path: only `server.ts`, `cli.ts`, `mcp/server.ts`, and `deploy-vpn-gateway.ts`'s Go
source location (read-only, and covered by the injected `goBuilder`). As a second guard the demo
also sets `INVENTORY_FILE` and `WEB_DATA_DIR` to its temp directory, so a future call to either
resolver lands there too.

**Alternatives considered**: Spawning `web:start` with `INVENTORY_FILE`/`WEB_DATA_DIR` set —
still loads the developer's `data/*.env` through dotenv (unless the data dir override is also
honored by dotenv paths, which it is, but the real `Ssh2SSHClient` would then try to reach the
example hosts and every status call would time out). Intercepting API calls in the browser —
bypasses the server entirely, so screenshots could show states the real API never returns, and
it does nothing for `npm run demo`.

## R2. Simulating Proxmox

**Decision**: A small `DemoSSHClient` in `scripts/demo/demo-ssh.ts` implements `SSHClient`
(`exec`, `execInteractive`, `putFile`) over a responder function keyed on the command text:

- `pvesh get /nodes/$(hostname)/lxc|qemu --output-format json` → the demo guests on that host
  with a fixed `running`/`stopped` status each (drives `getGuestStatuses`, the Dashboard's
  status column).
- `pvesh get .../network` and `.../storage` → the host's demo bridges/storages (so a Sync
  Inventory preview in the demo keeps the example inventory rather than emptying it).
- `pct status <vmid> || qm status <vmid>` → non-zero (VMID free), so an install-app preview
  succeeds.
- `cat ~/.ssh/authorized_keys` → one clearly truncated placeholder key.
- The package-manager probe (`command -v ...`) → `apt-get`.
- Anything else → exit 0 with one stdout line, `[demo] simulated: <first line of the command>`.

It never opens a socket. It lives in `scripts/demo/` rather than reusing
`test/support/fake-ssh-client.ts`, so shipping code does not import from `test/`.

**Rationale**: Constitution II allows only `Ssh2SSHClient` to open SSH connections; a fake that
opens none is consistent with it (the same way `FakeSSHClient` is). Keying on command text
mirrors how every existing `FakeSSHClient` responder in `test/` works. The catch-all success
line keeps every job in the demo completing instead of failing, which the spec accepts ("a
preview or a job log is enough").

**Alternatives considered**: A per-command registry mirroring each command's exact output —
far more code for no screenshot benefit.

## R3. The app catalog and app checks

**Decision**: `scripts/demo/demo-fetch.ts` exports a `fetchImpl` passed to `buildApp`. It
answers:

- `https://api.github.com/repos/community-scripts/ProxmoxVE/contents/ct` and
  `.../ProxmoxVED/contents/ct` with a fixed JSON array of `{ name: '<slug>.sh', type: 'file' }`
  entries (about 25 well-known public app slugs in stable, a handful in dev). This is the exact
  shape `fetchRepoSlugs` (`src/lib/script-catalog.ts`) parses.
- raw `ct/<slug>.sh` and `install/<slug>-install.sh` URLs for a slug in the list → 200 with a
  short shell body (so the install-app form's app check reports the app as found).
- everything else → a 404 `Response`.

**Rationale**: `getScriptCatalog` and `checkAppUrl` both take `fetchImpl` from `buildApp`'s
`testDeps`. The catalog is cached in the temp inventory database, which disappears with the
demo. Public app slugs are not operational data (constitution Principle I restricts hostnames,
domains, IPs, credentials); they make the catalog screenshot recognizable.

## R4. Signed-in identity and the "no authentication" banner

**Decision**: The demo forces `WEB_UI_AUTH_MODE=authentik`, deletes `WEB_UI_DEV_USER`,
`WEB_UI_DEV_GROUPS`, `AUTHENTIK_API_URL`, `AUTHENTIK_API_TOKEN` and the other `AUTHENTIK_*`
overrides from `process.env`, and mounts `buildApp`'s app behind an outer Express app whose
first middleware sets `X-authentik-username: admin`, `X-authentik-email: admin@example.com`,
and `X-authentik-groups: bellhop-admins` on every request. The HTTP server also gets a
`prependListener('upgrade', ...)` that sets the same headers on WebSocket upgrades, since
`/ws/jobs/:id` runs outside Express.

**Rationale**: With `auto` or `none` mode and no headers, the Sidebar shows a warning banner
("No authentication configured — everyone who can reach this page has full access"), which is
the right warning for a real deployment and wrong for a screenshot. Supplying the headers a
reverse proxy's forward-auth would add makes the demo look exactly like a signed-in admin on a
real deployment. The Users and Permissions pages stay hidden because Authentik's API is
unconfigured (`requireUserDirectory`), matching the spec's non-goal.

**Alternatives considered**: Hiding the banner with injected CSS during capture — screenshots
would no longer show what the real UI renders. Using `WEB_UI_DEV_USER` — documented as
test/dev-only, and it would not cover the WebSocket path.

## R5. Seeded jobs with fixed timestamps

**Decision**: The demo creates each seeded job through `JobStore.createJob`, writes its log with
`jobLog.append`, marks it finished through the store's own methods, then overwrites
`created_at`/`started_at`/`finished_at` with fixed ISO timestamps through the store's database
file. Seeded jobs: an `install-app` job (the Job page screenshot), an `update-all` job, a
`sync-inventory` job, and one `failed` job so Job History shows both outcomes. Owner is set to
the demo runner's own owner, so `reconcileOrphanedJobs` never touches them (they are terminal
anyway).

**Rationale**: `createJob` stamps `Date.now()`; overwriting afterward is the least invasive
way to get deterministic times without adding a test-only parameter to `JobStore`.

## R6. Browser automation

**Decision**: `playwright-core` as a dev dependency (1.63.x at planning time). It downloads no
browser. `scripts/capture-screenshots.ts` tries `chromium.launch({ channel })` for `chrome`,
then `msedge`, then Playwright's own Chromium (present only after an explicit
`npx playwright install chromium`). If all three fail it exits 1 before starting the demo,
listing what it tried and the install command.

Capture settings, fixed for every run: `locale: 'en-US'`, `timezoneId: 'UTC'`,
`reducedMotion: 'reduce'`, `colorScheme: 'light'` (or `'dark'` for the dark shot, which the
web UI's default `system` theme follows). Desktop shots use a 1440×900 viewport at device scale
1; the phone shot uses 390×844 at device scale 2. Each shot waits for a named selector that only
exists once its data has loaded, with a 15-second timeout, and failure names the shot.

**Rationale**: Chrome and Edge are both commonly installed (both are present on the
maintainer's machine); `playwright-core`'s `colorScheme`, `locale`, `timezoneId`, and element
screenshots cover every determinism need. The user chose this over full `playwright` (a
~150 MB browser download on every `npm ci`, CI included) and `puppeteer-core`.

## R7. Where each screenshot goes

**Decision** (see `contracts/screenshot-set.md` for the full table): the README gets the
Dashboard between the introduction and Prerequisites; `docs/web-ui.md` gets the install-app
catalog, the Job page (dark theme), the Update page, and the phone Dashboard next to the
paragraphs describing them; `docs/authentik.md`'s OIDC mode section gets the Access tab;
`docs/reverse-proxy/README.md` gets the Settings page's proxy driver setting. Seven images, one
of them dark. The existing `test/docs/links.test.ts` already fails on a broken relative link,
so it also checks every image reference.

## R8. Keeping the demo data example-only

**Decision**: A test scans the demo inventory (serialized), every seeded job log, the
`DemoSSHClient` canned outputs, and the fake catalog for IPv4 addresses and domain names. Every
IPv4 must fall in `192.0.2.0/24`, `198.51.100.0/24`, or `203.0.113.0/24`; every domain must be
`example.com`/`.net`/`.org` or end in `.example`, `.test`, or `.invalid`. Host names follow
the constitution's generic `pve1`/`pve2` pattern. Each host's `midScheme` also uses a
documentation range (the spec's assumption), so the scanner needs no RFC 1918 exception.

**Rationale**: Principle I makes a real value in a tracked file a defect; the scanner turns a
future slip into a failing test rather than a leaked image.

## R9. Ports and process cleanup

**Decision**: `npm run demo` listens on `PORT`, defaulting to `3100` — not the web UI's `3001`,
which a developer's own running instance may already hold. `EADDRINUSE` prints the port and how
to pick another. SIGINT/SIGTERM close the server and remove the temp directory.
`docs:screenshots` starts the demo on port 0 (the OS picks a free one) and always closes the
browser and the demo in a `finally`. Both run in-process under `tsx`, so there is no child
process tree to kill on Windows.
