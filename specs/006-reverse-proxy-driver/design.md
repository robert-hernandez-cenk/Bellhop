# Reverse-proxy driver interface — design

Issue: #10. Status: design approved in brainstorming, 2026-09-26.

## Goal

Put a driver seam between Bellhop's inventory and the reverse proxy that
fronts it, with Caddy as the only implementation this round, and remove
every Caddy-specific name from the inventory, database, settings, CLI, web
UI, and MCP surfaces. Generated Caddy configuration does not change.

Out of scope this round: any second driver. The interface is checked on
paper against nginx, Nginx Proxy Manager (NPM), HAProxy, and a future Caddy
admin-API driver (see "Validation against other proxies" below), so the
boundary is not designed around Caddy alone.

## Decisions

| Question | Decision |
|---|---|
| Interface shape | One `ReverseProxyDriver` interface (plan/apply/snapshot + capabilities). File-based drivers share a `fileDriver` helper; API-based drivers implement plan/apply directly. |
| Drivers per deployment | One active driver, selected by the `proxyDriver` setting. |
| TLS for proxies without built-in ACME | Operator's responsibility (certbot/acme.sh is a documented prerequisite). The core only needs to know whether the driver issues certificates via Cloudflare DNS-01, which gates `prune-acme-challenges`. |
| Caddy mechanism this round | Caddyfile (file driver). A Caddy admin-API driver is a follow-up issue. |
| Renames | Full rename, no aliases or fallbacks (pre-release). |
| Existing databases | Self-idempotent on-open migration, same pattern as #158's `requires_auth` migration. |
| Tailscale Serve | Dropped from consideration: routes are keyed by tailnet name rather than subdomain, it has no forward-auth, and it is tailnet-only — too specialized. |

## Section 1 — Route model and validation

New `src/lib/proxy/routes.ts`. The only view of inventory a driver gets:

```ts
interface ProxyRoute {
  owner: { type: 'host' | 'guest' | 'externalSite'; name: string };
  hostnames: string[];            // fully qualified, canonical first
  backend: { ip: string; port: number; insecureTls: boolean };
  auth:
    | { mode: 'ungated' }
    | { mode: 'oidc' }
    | { mode: 'forward'; exemptPaths: PathPattern[] };
}
type PathPattern = { kind: 'exact'; path: string } | { kind: 'prefix'; path: string };

interface ProxyContext {
  outpost?: { ip: string; port: number };  // the authentik: true entry + configured outpost port
  externalPort: 443;
}
```

- Routes carry no `authGroup`. Tier enforcement is entirely Authentik's
  policy bindings; a proxy only needs ungated / forward / oidc.
- `buildRoutes(inventory)` owns what `buildCaddyBlock` does today before
  emitting text: skip `proxyManual` entries and entries with no
  subdomains, default port 80, fold `effectiveAuth()`, and throw when a
  forward-gated route exists but no entry has `authentik: true` with an ip.
- `publicHostname(sub, domain)` in `src/lib` replaces the repeated
  `${sub}.${domain}` in the Caddy generator, `sync-authentik`, and
  `adopt-oidc-client`. `web-client/src/lib/guest-display.ts` keeps its own
  copy (separate build).
- `unauthenticatedPaths` stays a string array in storage. The schema is
  tightened to two forms: an exact path with no `*` (`/health`), or a path
  ending `/*` (`/api/*`). Any other `*` placement is rejected, since not
  every proxy can express it. `buildRoutes` parses strings into
  `PathPattern`. Every value in current use already fits.
- `checkCapabilities(routes, driver)` returns named errors, e.g. "`app`
  uses forward-auth, but the `haproxy` proxy driver doesn't support it —
  switch it to `authMode: oidc`." Enforced in `sync-proxy` (throws before
  preview/apply) and in `commitGuestEdit` for the edited entry's route only
  (400). Deliberately not in `validateInventory()`, so changing
  `proxyDriver` can never make a saved inventory unloadable (the same
  reasoning as #158's off-ladder handling).

## Section 2 — Driver interface and the Caddy driver

New `src/lib/proxy/driver.ts`:

```ts
interface ReverseProxyDriver {
  id: ProxyDriverId;                                   // 'caddy'
  capabilities: {
    authModes: Array<'forward' | 'oidc'>;
    acmeDns01ViaCloudflare: boolean;
  };
  plan(routes: ProxyRoute[], ctx: ProxyContext, deps: DriverDeps): Promise<ProxyPlan>;
  apply(plan: ProxyPlan, deps: DriverDeps): Promise<void>;
  snapshot(deps: DriverDeps): Promise<string>;
}
interface ProxyPlan { preview: string; payload: unknown }
interface DriverDeps { ssh: SSHClient; inventory: Inventory; proxyHost: string; configPath?: string }
```

- `plan` is async because an API driver must read live state to diff
  against; a file driver's plan is pure rendering.
- The Authentik outpost endpoint (`/outpost.goauthentik.io/auth/caddy`)
  and the outpost passthrough are driver internals, not interface fields.
- `getDriver(inventory)` (`src/lib/proxy/index.ts`) resolves
  `proxyDriver` (unset = `caddy`) and throws on an unknown id.

`fileDriver(...)` (`src/lib/proxy/file-driver.ts`):

```ts
fileDriver({
  id, capabilities,
  render(routes, ctx): FileSpec[],   // { path, content, mode: 'owned' | 'managed-section' }
  validateCommand: string,           // runs against the real paths
  reloadCommand: string,
})
```

One remote script: back up each target; write each file (`managed-section`
preserves everything outside the `bellhop-managed` markers and replaces or
appends the block; `owned` replaces the file); run the validate command; on
failure restore every backup and exit non-zero; otherwise reload.
Validating in place, rather than validating a temp copy first as today,
is what lets one helper serve Caddy, nginx (`nginx -t`), and HAProxy
(`haproxy -c`), which check the config tree as the service loads it. The
running proxy is never reloaded with a bad config either way. `snapshot()`
prints each file, with a header line when there is more than one.

Caddy driver (`src/lib/proxy/drivers/caddy.ts`): `buildCaddyBlock`
rewritten over `ProxyRoute[]`. One `managed-section` file at `configPath`
(default `/etc/caddy/Caddyfile`); `TLS_BLOCK`, the `X-Forwarded-Port`
header, `tls_insecure_skip_verify`, `forward_auth` with the
`@auth_required` matcher, and the outpost passthrough move over unchanged.
Capabilities: both auth modes, `acmeDns01ViaCloudflare: true`.
`validateCommand`: `caddy validate --adapter caddyfile --config <path>`;
`reloadCommand`: `systemctl reload caddy`.

**Acceptance: for the same inventory, the rendered block is byte-identical
to today's `buildCaddyBlock` output.**

## Section 3 — Renames, settings, and migration

| Old | New |
|---|---|
| `caddy: true` (hosts, guests) | `proxy: true` |
| `caddyManual` | `proxyManual` |
| columns `caddy`, `caddy_manual` | `proxy`, `proxy_manual` |
| table `caddy_owner` | `proxy_owner` |
| `findCaddyEntry()` | `findProxyEntry()` |
| `hosts.yaml.example` / `import-yaml-inventory` keys | `proxy:` / `proxyManual:` |
| CLI `sync-caddy`, operation/web command `sync-caddy` ("Sync Caddy"), MCP `sync_caddy` | `sync-proxy` ("Sync Proxy"), `sync_proxy` |
| `runSyncCaddy` / `SyncCaddyOptions` | `runSyncProxy` / `SyncProxyOptions` |
| `syncCaddyLive` / `SyncCaddyLiveResult` (`src/web/caddy-sync.ts`) | `syncProxyLive` / `SyncProxyLiveResult` (`src/web/proxy-sync.ts`) |
| guest PATCH / MCP `edit_guest` field `caddyManual` | `proxyManual` |
| `EditableCaddyManual.tsx`, "read-only caddy" column | `EditableProxyManual.tsx`, "read-only proxy" |
| Settings page derived "Caddy IP" | "Proxy IP" |
| `windows-service.ts` `resolveCaddyIp` | `resolveProxyIp` |
| status page "active Caddyfile" section | "Deployed proxy config", from `driver.snapshot()` |
| result field `caddyHost` | `proxyHost` |

New settings (`SettingsSchema`/`SETTINGS_KEYS`, so both `set-config` and
the web Settings page get them): `proxyDriver` (enum, `caddy` only this
round; unset = `caddy`) and `proxyConfigPath` (optional absolute path;
unset = driver default). The `CADDYFILE_PATH` env var and `cli.ts`'s
`caddyfilePath()` are removed. Today only the CLI honored that env var;
the web UI and MCP always used the default, so moving it to a setting also
makes every entry point agree.

Unchanged: `bellhop-managed` markers; `insecureBackendTls`,
`unauthenticatedPaths`, `authentik: true`; historical job rows keep their
recorded `sync-caddy` type; `prune-acme-challenges` keeps its name and now
runs only when the active driver's `acmeDns01ViaCloudflare` is true.

**Migration** (`migrateCaddyToProxy(db)`, called from `openInventoryDb`
before the `ensureColumn` calls, in one transaction):

- `hosts`/`guests`: if a `caddy` column exists, `RENAME COLUMN caddy TO
  proxy`; independently, `caddy_manual` to `proxy_manual`. A database that
  predates `caddy_manual` gets `proxy_manual` from the following
  `ensureColumn`.
- `DROP TABLE IF EXISTS caddy_owner` rather than renaming it: `openDb` runs
  the schema first, so an empty `proxy_owner` already exists by the time
  the migration runs. Dropping is safe because `saveInventory` fully
  rewrites that table on every save and `loadInventory` never reads it.
- The two existing `ensureColumn(..., 'caddy_manual', ...)` calls become
  `proxy_manual` and must run after the rename, or they would add a
  second column and make the rename fail.
- Logs one line naming what it renamed. Runs once: the guard is false
  forever after, and a fresh database never has anything to migrate.
- Forward-only, like #158: older code cannot open a migrated database.
  Deploying means pulling the new code and restarting the service together.

## Section 4 — Callers, docs, testing

Callers:

- `runSyncProxy` (`src/commands/networking/sync-proxy.ts`): find the
  `proxy: true` entry (else throw), `getDriver`, `buildRoutes`,
  `checkCapabilities`, build the context, `driver.plan`, and on `--apply`
  `driver.apply`. Returns `{ proxyHost, driver, preview, applied }`.
- `syncProxyLive`: same sequence as today (proxy, status page,
  `sync-authentik`, prune), with the prune gated on the capability flag.
- `render-status-page` uses `driver.snapshot()`.
- `migrate-guest` calls `runSyncProxy`.
- `sync-authentik` and `adopt-oidc-client` use `publicHostname()`.
- `commitGuestEdit` runs `checkCapabilities` on the edited entry's route.

Tests, in order:

1. Characterization test first, committed and passing against the current
   code: an example-data fixture exercising every `buildCaddyBlock` branch
   (multiple subdomains; hosts, guests, external sites;
   `insecureBackendTls`; forward-auth with and without exempt paths, exact
   and `/*`; OIDC; manual and subdomain-less entries; the missing-authentik
   error). The Caddy driver must match its captured output byte for byte.
2. `buildRoutes`, path-pattern parsing and the tightened schema (rejects
   `/a*b`, `*/x`), and `checkCapabilities` using a fake driver without
   forward-auth, from `sync-proxy` (throws, nothing written) and
   `commitGuestEdit` (400).
3. `fileDriver`: script and `FakeSSHClient` history assertions for owned
   and managed-section files, including the first-run append. Plus one
   test that runs the generated script under `sh` with stub `caddy` and
   `systemctl` on `PATH`, forcing validation to fail and asserting the
   original file is restored byte for byte.
4. Migration: an old-schema fixture migrates and loads with `proxy`/
   `proxyManual`; reopening is a no-op; a fresh database never migrates; a
   fixture without `caddy_manual` still migrates.
5. Existing suites moved and renamed: `sync-caddy.test.ts` becomes
   `sync-proxy.test.ts` plus `drivers/caddy.test.ts`; `caddy-sync.test.ts`
   becomes `proxy-sync.test.ts`; `render-status-page`, `migrate-guest`,
   `edit-guest`, `settings`, and MCP tests updated.

Live verification before the PR: a read-only `sync-proxy` dry run against
the deployment checkout must print a managed block byte-identical to the
one currently deployed. The renamed Dashboard column, the Settings page's
new fields, and Sync Proxy on the Maintenance page are checked in a browser
at desktop and mobile widths.

Docs: CLAUDE.md, README, and CONTRIBUTING are updated in the same change,
including a "Reverse proxy drivers" section and the "a certificate tool is
a prerequisite" rule for future file drivers. This removes a
single-operator assumption (Bellhop is tied to one specific proxy), and
the branch records that.

Follow-ups: file one issue for a Caddy admin-API driver. This change
closes #10. nginx, NPM, and HAProxy drivers are not filed; per #10's own
guidance they wait for a real request, with the analysis below ready.

## Validation against other proxies

How each concept maps, and what it forced into the interface.

| Concept | Caddy (file) | Caddy (API) | nginx | NPM | HAProxy |
|---|---|---|---|---|---|
| Apply mechanism | Managed section in Caddyfile | `@id`-tagged routes via admin API on localhost:2019, reached over SSH | Owned `conf.d` file | REST objects (proxy hosts) | Owned map + backends files (extra `-f`), or Data Plane API |
| Validate | `caddy validate` | Atomic load, auto-rollback | `nginx -t` | Server-side | `haproxy -c` |
| TLS | Built-in DNS-01 (Cloudflare) | Same | External tool | Built-in Let's Encrypt, Cloudflare DNS supported | External tool (built-in ACME in newer releases is limited) |
| Authentik forward-auth | `forward_auth` → `/outpost…/auth/caddy` | Same, as JSON | `auth_request` → `/outpost…/auth/nginx` | `auth_request` in per-host advanced config | No native support (community Lua script only) |
| Exempt paths | `not path` globs | JSON matchers | `location =` / prefix `location` | Same as nginx | `path` / `path_beg` ACLs |
| Insecure backend TLS | `tls_insecure_skip_verify` | Same, as JSON | `proxy_ssl_verify off` | Per-host setting | `ssl verify none` |

What this forced:

- A capability declaration for auth modes (HAProxy cannot do forward-auth;
  silently emitting nothing would leave a gated app ungated).
- A reconcile-shaped top-level contract (`plan`/`apply`), since NPM, the
  HAProxy Data Plane API, and the Caddy admin API have no file to write.
- A file-driver helper supporting both a managed section and wholly owned,
  possibly multiple, files.
- Exempt paths restricted to exact and prefix forms, the common subset.
- TLS reduced to one capability flag; certificate file locations belong to
  whichever future driver needs them.

Caddy admin-API notes for the follow-up: API changes are discarded by a
Caddyfile reload, so that driver requires running Caddy without a
Caddyfile (the packaged `caddy-api.service`, which resumes from
`autosave.json`), and hand-authored site configuration moves to JSON or
stays untagged.
