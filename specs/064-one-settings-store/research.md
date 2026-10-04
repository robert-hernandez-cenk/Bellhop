# Research: One settings store (#64)

## R1 -- Where moved values live

- **Decision**: Moved non-secret values join `SettingsSchema`/`SETTINGS_KEYS` (so they are `meta`
  rows and fields on `Inventory`, loaded/validated/saved exactly like today's settings). Secrets
  get their own `SecretSettingsSchema`/`SECRET_SETTINGS_KEYS` and a new `secret_settings` table
  (`key TEXT PRIMARY KEY, value TEXT NOT NULL`) in `bellhop.db`, created by the same schema
  string `openInventoryDb` runs. `saveInventory`'s delete-and-reinsert never touches it (same
  precedent as `permission_groups`, `script_catalog`, `task_schedules`).
- **Rationale**: non-secret moved values need nothing new -- validation, round-trip,
  `refreshInventory`, `set-config`, the MCP tool and the Settings page already handle every
  `SETTINGS_KEYS` entry. Keeping secrets off `Inventory` is what keeps them out of
  `render-status-page` (which YAML-dumps `deps.inventory`), inventory snapshots, and every route
  that serializes the inventory.
- **Alternatives**: one `settings` table with a `secret` column (rejected: secrets would ride
  along with every `loadInventory`); a separate file (rejected: the point is one store).

## R2 -- Avoiding an import cycle

- **Decision**: a new leaf module `src/lib/settings-defs.ts` holds the zod schemas for the moved
  keys and secrets plus their metadata (env var, integration group, secret flag, default). It
  imports nothing from `inventory.ts`. `inventory.ts` spreads its schemas into `SettingsSchema`;
  `config.ts` (the accessor) imports only `settings-defs.ts` and `better-sqlite3`.
- **Rationale**: `inventory.ts` already imports `authentik-config.ts` (for the #158 migration),
  and `authentik-config.ts` will import the accessor. If the accessor imported `inventory.ts`,
  the cycle would hit a temporal-dead-zone on the schema constants at module load.

## R3 -- Read cost and caching (measured)

- **Measured**: opening `bellhop.db` read-only with better-sqlite3, reading `meta`, closing:
  **~6.9 ms** per round trip on the operator's Windows host (500 iterations). `authentikConfig()`
  is called several times per web request (`isAdminUser` from `requireAuth`, `requireAdminGroup`,
  permission checks), so a fresh read per call would add tens of milliseconds per request.
- **Decision**: the accessor keeps one in-process snapshot (all `meta` rows for moved keys plus
  all `secret_settings` rows) with a **2-second TTL**. It is invalidated (a) at the start of every
  `/api` request, right next to `refreshInventory` in `src/web/app.ts`, (b) by every in-process
  write through the store or `saveInventory`. So within the web service a save is visible on the
  very next request; a write from another process (CLI, MCP) is visible on the web service's next
  request, and to a long-running MCP server within 2 seconds.
- **Alternatives**: a long-lived read connection (rejected: holds a file handle on Windows, which
  breaks every test's temp-dir cleanup); file-mtime invalidation (rejected: in WAL mode the main
  file's mtime does not change until a checkpoint).

## R4 -- The accessor's shape, and keeping existing tests

- **Decision**: `configValue(key, env = process.env): { value?: string; source }` with
  `source` = `'environment' | 'settings' | 'none'`. Environment wins when the variable is set and
  non-empty (empty = unset, today's rule). Stored values come from a process-wide store
  registered once per entry point with `useConfigStore(inventoryPath)` (`useConfigStore(null)` in
  tests to reset). With no store registered the accessor reads the environment only -- exactly
  today's behaviour -- so the ~25 existing tests that pass a custom `env` object to
  `authentikConfig`/`authMode`/`isAdminUser`/`buildCloudflareClient` keep passing unchanged.
- A stored value is re-validated with its own schema on read; a malformed row throws naming the
  setting (never the value), matching today's `AUTHENTIK_OUTPOST_PORT` behaviour.
- The #158 migration runs *inside* `openInventoryDb`, so it reads the ladder from the database
  handle it already has (`meta` row `authentikGroupLadder`) through the same pure precedence
  function (`effectiveValue(def, stored, env)`) the accessor uses.

## R5 -- No-restart clients

- **Decision**: `buildAuthentikClient()`/`buildCloudflareClient()` keep their signatures but
  return a *live* client: a `Proxy` that resolves the real or unconfigured client from current
  config on every method call (`liveClient(build)` in `src/lib/live-client.ts`). The web service
  and MCP server construct it once; each call sees the current URL/token. `isConfigured()` is just
  another method, so `requireUserDirectory` follows a token being set or cleared too.
  `RealAuthentikClient` still receives `authentikConfig()` at construction, now per call.
  `buildNpmClient` was already built per `plan()`/`apply()`; it switches to the accessor.
- **Alternatives**: rebuild `AppDeps` per request (rejected: threads through every route module).

## R6 -- GitHub token

- **Verified live**: `GET https://api.github.com/repos/community-scripts/ProxmoxVE` with
  `Authorization: Bearer <invalid token>` returns **401**. No response body is parsed, so no
  fixture is needed -- only the status code.
- **Decision**: `githubApiHeaders(extra?)` in `src/lib/github.ts` returns
  `{ 'User-Agent': 'bellhop', ...extra, Authorization: 'Bearer <token>' }` (the last only when
  `githubApiToken` is set) and `githubUnauthorizedError(context)` builds the 401 message:
  "`<context>`: GitHub rejected the configured GitHub API token (401) -- replace or clear
  githubApiToken: `settingFix(...)`". Every `api.github.com` request in `app-source.ts`
  (`resolveHeadSha`, `compareBranch`), `app-update-check.ts` (`githubGet`), and `script-catalog.ts`
  (`fetchRepoSlugs`) uses it. `raw.githubusercontent.com` requests are unchanged (not API, not
  rate-limited the same way).

## R7 -- Import from data/*.env

- **Decision**: `importEnvFiles(inventoryPath, dataDir)` in `src/lib/config-import.ts`. For each
  file (`authentik.env`, `cloudflare-api.env`, `nginx-proxy-manager.env`) it uses
  `dotenv.parse(readFileSync(...))` -- never `process.env`, so a real environment variable is an
  override, not an import source -- and for each moved key whose env var appears with a
  non-empty value and that has **no stored value**, validates it with the key's schema and
  stores it. An invalid value is skipped with a warning naming the key (storing it would make
  `loadInventory` fail). Logs `Imported <ENV_VAR> from data/<file> as setting <key>` per key.
  Skips entirely when the inventory database does not exist yet (no side-effect file creation).
  `WEB_UI_AUTH_MODE` maps to `webUiAuthMode` and is imported from `authentik.env`, where
  production keeps it today.
- **Ordering**: each entry point still dotenv-loads the files (so they keep overriding), then
  runs the import, then `useConfigStore(path)`, then `loadInventory`.

## R8 -- Auth mode as a guarded setting

- **Decision**: `webUiAuthMode` (`auto|authentik|none`, unset = `auto`), env override
  `WEB_UI_AUTH_MODE`. `authMode(env)` reads it through the accessor. `AuthUser` gains
  `viaForwardAuth?: true`, set by `resolveAuthUser` only on the `x-authentik-username` branch
  (never for the dev user or the local operator). PATCH refuses `webUiAuthMode: 'authentik'`
  unless `(req.realUser ?? req.user).viaForwardAuth`. Leaving `authentik` is confirmed client-side.
- **Admin-group guard**: PATCH computes the effective admin/builtin-admin group names after the
  update and refuses when the real user (`req.realUser ?? req.user`) is not `localOperator` and
  would no longer pass `isAdminUser`. Both guards run after schema validation, before any write.

## R9 -- Environment-pinned fields on write

- **Decision**: web PATCH refuses a key whose `configValue(...).source === 'environment'` (400,
  naming the variable). The CLI stores it and logs a warning: its environment is not
  necessarily the service's. The MCP `set_config` tool inherits the CLI's `runSetConfig`, so it
  also warns.

## R10 -- Secret writes and never-echo

- **Decision**: `runSetConfig` handles both kinds: for a secret key, a positional value is refused
  ("pass the value on standard input with --stdin"), the CLI layer reads stdin (`--stdin`) or a
  no-echo prompt on a TTY, the dry-run line is `Would set <key> (value hidden)`, and the
  applied log line is `Set <key> in <path>`. The MCP `set_config` Operation's `key` enum lists only
  `SETTINGS_KEYS`, so a secret key never reaches a job's persisted `argsJson`.
- Secret schema: tokens (`authentikApiToken`, `cloudflareDnsApiToken`, `githubApiToken`) are
  non-empty with no whitespace; `npmApiPassword` is non-empty with no control characters. zod's
  messages do not include the input value.
