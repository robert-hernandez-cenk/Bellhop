# Reverse-proxy driver interface

`src/lib/proxy/` is the driver seam between the inventory and whichever reverse proxy runs in front of the homelab (#10): a new proxy is added by writing one driver, not by untangling Caddy-specific code. Exactly one driver is active per deployment (`proxyDriver`, per-deployment, not per-entry). Per-driver detail (Caddy, nginx, Nginx Proxy Manager, HAProxy, Traefik, Caddy admin API) lives in `src/lib/proxy/drivers/CLAUDE.md`. Cross-cutting rules (`runRemote` is the only remote path, POSIX sh for guest commands, dry-run convention, single-operator assumptions are recorded) are in the root CLAUDE.md.

Seven drivers are registered: six that manage a proxy (`caddy`, `caddy-api`, `nginx`, `nginx-proxy-manager`, `haproxy`, `traefik`) and `none`. An HAProxy Data Plane API driver is the remaining follow-up (`specs/006-reverse-proxy-driver/research.md` checked the interface against all four candidate shapes on paper).

## Single-operator assumptions by driver

Each driver's assumptions are recorded in full in `src/lib/proxy/drivers/CLAUDE.md`; one line each here.

- Caddy (and Caddy admin API): the ACME DNS resolvers (`ACME_DNS_RESOLVERS`) are fixed within `proxyCaddyTls` `cloudflare` mode (the default, one mode among four since #51). See `src/lib/proxy/drivers/CLAUDE.md`.
- nginx (#30): CA-bundle path and `conf.d` default config path assume a Debian/Ubuntu layout; the shared-certificate default is derived from `domain`. See `src/lib/proxy/drivers/CLAUDE.md`.
- Nginx Proxy Manager (#31): tested against NPM 2.16 only. See `src/lib/proxy/drivers/CLAUDE.md`.
- HAProxy (#32): main config path, CA bundle, and reload command are fixed Debian/Ubuntu package defaults. See `src/lib/proxy/drivers/CLAUDE.md`.
- Traefik (#35): entry point is always `websecure`, unset `proxyCertResolver` defaults to `cloudflare`, API-check timeout fixed at 30 checks one second apart. See `src/lib/proxy/drivers/CLAUDE.md`.
- Caddy admin API (#26): admin address fixed at `localhost:2019`, packaged systemd unit names, `curl` on the proxy host. See `src/lib/proxy/drivers/CLAUDE.md`.

## File responsibilities

- `routes.ts`: `buildRoutes(inventory)` derives a proxy-neutral `ProxyRoute[]` from `hosts[]`/`guests[]`/`externalSites[]`: skip `proxyManual` and no-`subdomains` entries; default `port` to `80`; throw the missing-authentik error when a forward-gated route exists but no entry has `authentik: true` with an `ip`. `buildRouteForEntry` derives one entry's route alone.
- `routes.ts`: `buildProxyContext(inventory)` derives the shared `ProxyContext`: the Authentik outpost's `ip`/`port`; the fixed `externalPort` `443`; `tls: { certificatePath, keyPath }` (#30), the shared certificate/key pair a driver that can't obtain its own per-site certificate serves on every route, from `proxyTlsCertificate`/`proxyTlsKey` when set, else certbot's default path for the inventory `domain` (always present because `domain` is mandatory, so a driver never handles "no certificate"; the Caddy driver ignores it outside `files` mode); `certResolver` (Traefik).
- A route never carries its auth tier, only its `mode` (`'ungated' | 'forward' | 'oidc'`, plus a forward route's parsed `PathPattern[]` and raw `string[]` `unauthenticatedPaths` in stored order). Tier enforcement stays entirely Authentik's job (`sync-authentik`).
- `driver.ts`: the `ReverseProxyDriver` interface and `checkCapabilities(routes, driver)`.
- `file-driver.ts`: `fileDriver(...)`, the shared builder for file-configured drivers.
- `index.ts`: `getDriver`, `driverDeps`, `listDrivers`.
- `nginx-locations.ts`: `renderServerBody` plus `candidateExemptPatterns`/`isRootPrefix`, shared by the nginx, Nginx Proxy Manager, and Traefik drivers so the rules they must all obey are defined once. See `src/lib/proxy/drivers/CLAUDE.md` (nginx and NPM sections).
- `caddy-json.ts`/`caddy-admin.ts`: pure JSON renderer/planner and remote half of the Caddy admin-API driver. See `src/lib/proxy/drivers/CLAUDE.md` (Caddy admin API).

## `ReverseProxyDriver` interface

`driver.ts` defines:

- `id`; `label` (the Settings page dropdown's option text).
- `capabilities`: `authModes`, and `acmeDns01ViaCloudflare`, which is `(inventory: Inventory) => boolean` (#51), not a fixed boolean, because a driver's Cloudflare DNS-01 usage can depend on a setting (Caddy's `proxyCaddyTls`, Traefik's `proxyCertResolver`). It decides whether `syncProxyLive` runs `prune-acme-challenges` (see the "Cloudflare prune decision" in `prune-acme-challenges`, `src/commands/networking/CLAUDE.md`).
- `defaultConfigPath: string | null` (`null` = driver uses no configuration file).
- `statusPage: { suggestedPath: string } | null` (`null` = serves no status page).
- Six optional Settings-page hints: `usesSharedCertificate` (page shows `proxyTlsCertificate`/`proxyTlsKey`; nginx only); `usesCertResolver`/`usesApiUrl` (page shows Proxy cert resolver/Proxy API URL; Traefik only, #35); `usesCaddyTls` (page shows the Caddy TLS dropdown and, with value `files`, the TLS path fields; both Caddy drivers, #51); `usesNpmApi` (page shows `npmApiUrl`/`npmApiEmail`/`npmApiPassword` on the Proxy tab; Nginx Proxy Manager only, #73); `configPathNote` (a sentence appended to the Proxy config path help).
- `plan()`/`apply()`/`snapshot()`.

`fileDriver` is the shared builder for file-configured drivers (Caddy, nginx, HAProxy, Traefik); three of the five analysed mechanisms have no file at all (e.g. Caddy's admin API), so the top-level contract is "reconcile these routes", not "render this file".

## `getDriver` / `driverDeps` / `listDrivers` / `managesProxy`

- `getDriver(inventory)` resolves the `proxyDriver` setting to a driver instance. Unset means `DEFAULT_PROXY_DRIVER_ID` (`'caddy'`); the other registered ids are `'caddy-api'`, `'nginx'`, `'nginx-proxy-manager'`, `'haproxy'`, `'traefik'`, `'none'`. An id no driver has (only reachable by hand-editing `bellhop.db`, since the schema's zod enum rejects it at load) throws `"Unknown proxyDriver '<id>' -- run: bellhop set-config proxyDriver caddy --apply"` (names `DEFAULT_PROXY_DRIVER_ID` as the fix).
- `driverDeps(inventory, ssh, driver)` resolves the rest of what `plan()`/`apply()`/`snapshot()` need. `proxyHost` comes from the entry flagged `proxy: true`, throwing `"No inventory entry has 'proxy: true'"` if none. `configPath: string | null` comes from `proxyConfigPath`, else the driver's `defaultConfigPath`; when that default is itself `null` (a driver with no configuration file: Nginx Proxy Manager and Caddy admin API, which reconcile over REST) `configPath` is `null` and any `proxyConfigPath` is silently ignored, not used as a fallback file path. `driverDeps` does not throw for the `none` driver (every real caller short-circuits before it runs). A `fileDriver` never has a null `defaultConfigPath`; it resolves `configPath` through its own helper, which throws a programming-error message if handed `null`.
- `listDrivers()` returns every registered driver in registration order (Caddy, Caddy (admin API), nginx, Nginx Proxy Manager, HAProxy, Traefik, None), the Settings page dropdown's source.
- `managesProxy(driver)` is `driver.id !== NO_PROXY_DRIVER_ID` (constant in `ids.ts`); `false` only for `none`. It is the one signal for "Bellhop manages no proxy": never compare `driver.id === 'none'` and never read `statusPage === null` to mean it (a `null` `statusPage` only means a managed driver serves no status page).

## The `none` driver

`src/lib/proxy/drivers/none.ts`'s `noneDriver` (#33; not every deployment has a Bellhop-managed proxy, whether hand-configured or absent), selected with `proxyDriver: 'none'`:

- `label` `'No proxy'`; `defaultConfigPath` and `statusPage` both `null`.
- `capabilities` accept both `forward` and `oidc` (so `checkCapabilities` never rejects a gated entry; the assumption is the operator's own proxy enforces `forward_auth`) with `acmeDns01ViaCloudflare: () => false`.
- `plan()` returns `{ preview: NO_PROXY_SYNC_MESSAGE, payload: null }` with no routes/context consulted; `apply()` is a no-op; `snapshot()` throws `NO_PROXY_STATUS_PAGE_ERROR`. Both constants live in `driver.ts` beside `managesProxy` so every caller shares the text.
- `runSyncProxy` (`src/commands/networking/sync-proxy.ts`) checks `managesProxy(driver)` right after `getDriver` and, when false, returns `{ proxyHost: null, driver: driver.id, preview: NO_PROXY_SYNC_MESSAGE, applied: false }` (`applied` always `false`, even with `--apply`) before `driverDeps`/`buildRoutes`/`checkCapabilities` run, which would otherwise throw over a missing `proxy: true` entry or missing `authentik` ip. `SyncProxyResult.proxyHost` is therefore `string | null`, and callers key on that, not on `applied`: the CLI and the `sync-proxy` operation (`src/operations/maintenance.ts`) print/log `result.preview` instead of their usual "Generated/Wrote ... for <host>" lines whenever it's `null` (dry run and `--apply` alike); `syncProxyLive` and `migrate-guest`'s post-move push log it via `logInfo`; `migrate-guest` also skips its "Pushing the new IP ... live via the proxy" line when `managesProxy(getDriver(inventory))` is false.

## Capability enforcement

`checkCapabilities` returns one `CapabilityError` per route whose `auth.mode` isn't in the driver's `capabilities.authModes` (an `'ungated'` route is never a candidate). The message suggests switching to the other auth mode only when the driver can enforce it; otherwise it suggests clearing `authGroup` or choosing a `proxyDriver` that supports the mode.

- `runSyncProxy` joins every message into one thrown `Error` and refuses to preview or write anything, dry run and `--apply` alike.
- `commitGuestEdit` (`src/operations/edit-guest.ts`) runs the same check against the edited guest's own route only, derived alone by `buildRouteForEntry`, so nothing about another entry (its own capability mismatch, missing authentik ip, bad exempt path) can block a different guest's edit; it surfaces the next time that entry is synced or edited, or via the push-live step's own `sync-proxy` call, reported as `proxySynced: false`.
- The check runs only where a route is about to become live configuration or a specific entry is being saved, never from `validateInventory()`, so changing `proxyDriver` can never make an already-saved inventory fail to load.
- Caddy, nginx, Nginx Proxy Manager, and Traefik support both modes; HAProxy supports `oidc` only (#32), the first driver where the refusal triggers: a forward-gated entry fails `sync-proxy` and its own guest edit with `Entry '<name>' uses forward-auth gating, but the 'haproxy' proxy driver cannot enforce it -- set its authMode to oidc or clear authGroup`.
- That holds even with no `authentik: true` entry: `runSyncProxy` calls `buildRoutes` before `checkCapabilities`, and `buildRoutes` would otherwise throw its missing-authentik error first, telling the operator to add an outpost a forward-less driver could never use. So `buildRoutes(inventory, { requireOutpost })` takes an option (default `true`) and `runSyncProxy` passes `requireOutpost: driver.capabilities.authModes.includes('forward')`. Every driver that supports forward keeps the missing-authentik error. This is the guarantee every future driver inherits.

## `fileDriver(def)`

`fileDriver` owns the full render -> back up -> write -> validate -> restore-or-reload cycle for a file-configured proxy. A new driver supplies `render()`, its validate command, its reload command, and a required `label` and `statusPage` (no defaults, so a driver can't silently show its bare id in the Settings dropdown or opt out of a status page by omission). `usesSharedCertificate`/`configPathNote` are optional and passed through; `configFiles()` optionally overrides which paths `snapshot()` reads (default `[configPath]`).

Definition shape:

- `def.validateCommand` is a function of `(configPath, { files, inventory })` returning `string | null` (#35): Traefik needs the rendered files (to read back every router/marker name its API check polls) and the live `inventory` (for `proxyApiUrl`). `null` means nothing to check (Traefik with `proxyApiUrl` unset), and `buildFileDriverScript` then renders no validate step at all.
- `def.reloadCommand` is `string | null`; Traefik's is `null` since its file provider reloads the instant the write lands.
- Optional `validateLabel` replaces the validate command's text in the "... failed; restored previous configuration" message when the command isn't fit to echo (Traefik's is a multi-line polling subshell); omitted means the command text itself.
- A `FileSpec` may carry `atomic: true` (Traefik only, #35): the write goes through a same-directory `mktemp`/`mv -f` instead of an in-place `cat >` truncate, and the trap's restore mirrors it, because a file-watching proxy could otherwise see a half-written file (Caddy/nginx/HAProxy reload explicitly only after a successful validate, so don't need it). For an atomic file only, the backup is taken with `cp -p` (a restore brings back the original mode/owner, not `mktemp`'s 0600, which a non-root proxy couldn't read), and `TMP_<i>` starts empty before the trap is armed so the restore can first remove a temp file a failed or interrupted write left in the watched directory. A non-atomic file's script is unchanged. See the Traefik driver in `src/lib/proxy/drivers/CLAUDE.md`.
- A `FileSpec` may carry `ownedHeader` (see below).

`apply()` builds one POSIX `sh` script (`buildFileDriverScript`, run via `runRemote` on the proxy host) that, in order:

1. Refuses, touching nothing, to replace an existing `'owned'` file whose first line isn't that `FileSpec`'s `ownedHeader` (when set).
2. Backs up every target file (or records that it didn't exist).
3. Installs one `trap ... EXIT` once every backup exists, so any non-zero exit from then on (a write-phase command failing under `set -e`, or the validate command failing) restores every backup, removing files that didn't exist before, through that one handler rather than a restore block at each failure site. An EXIT trap does not run when the shell is killed by a signal, so a second trap on HUP/INT/TERM clears every trap, runs the same restore, and exits 1.
4. Writes each file: `'owned'` replaces it whole; `'managed-section'` removes any existing `# BEGIN bellhop-managed`...`# END bellhop-managed` block and appends the new one, creating the file if absent.
5. Runs the validate command, when there is one, printing a named failure message and exiting non-zero if it fails (the trap does the restore). A `null` `validateCommand` skips this block, going straight from writing to disarming.
6. Disarms every trap together (`trap - EXIT HUP INT TERM`), removes the backups, and reloads when there is a reload command (omitted for Traefik's `null`).

Preview and payload:

- The `bellhop-managed` markers are defined once, in `file-driver.ts`. A driver's `render()` returns only a `'managed-section'` file's body; `plan()` wraps it with `wrapManagedSection` before previewing or putting it in the payload, so the preview is exactly what `apply()` writes.
- A driver with more than one file (HAProxy) gets each file labelled in the preview with the same `==> <path> <==` line `snapshot()` uses, separated by a blank line (`previewFiles`); a single-file driver's preview is its content alone and the payload is never labelled.

Failure handling:

- `apply()` throws on a non-zero exit with stderr in the message. This was a behavior fix (#10): the former `sync-caddy` validated a temporary copy before overwriting the real Caddyfile and reported a failed validate as success. Now a failed remote validate or write throws all the way up, so `syncProxyLive` (Dashboard guest edit, provisioning jobs) surfaces it to its caller.
- `migrate-guest`'s post-move push is the exception: by then the source guest is destroyed and inventory saved, so it catches the failure and `logWarn`s that the migration succeeded, the proxy sync failed (with the error), and to retry with `bellhop sync-proxy --apply`.
- For a Dashboard guest edit, the inventory write has already happened (`commitGuestEdit` saves before calling `syncProxyLive`) by the time a proxy failure is caught, so the response reports it separately as `proxySynced: false, proxyError: <message>` rather than rejecting the whole request.
- `snapshot()` never calls `buildRoutes`/`buildProxyContext`/`render`; it only `cat`s the resolved `configFiles()` paths. A read-only status-page request therefore still succeeds when the current inventory is itself invalid (a bad `unauthenticatedPaths` entry, a missing `authentik` ip) in a way a real `sync-proxy` run would fail on.
