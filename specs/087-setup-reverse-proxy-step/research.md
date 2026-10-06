# Research: First-run setup, reverse-proxy step

## R1. How to validate a proxy without writing to it

**Decision**: add an optional `check(deps: DriverDeps): Promise<string>` to `ReverseProxyDriver`. It resolves with a one-line summary on success and throws an actionable `Error` on failure. A driver without it (`none`) has nothing to check.

**Rationale**: the existing validation (`validateCommand`) only runs inside `apply()`, after the new file is written, and restores on failure, so using it would write to the proxy. `snapshot()` is read-only but only proves the file can be `cat`ed. A separate method keeps the "nothing is written" guarantee in one place per driver and testable (`ssh.history` has no write, backup, restore or reload).

**Alternatives**: render a trial file to a temp path and validate it (writes to the proxy host, and Traefik/NPM can't do it); reuse `plan()` as the check (it proves Bellhop can render, not that the proxy is healthy).

## R2. What each driver's check does

**Decision** (every command read-only):

| Driver | Check |
|---|---|
| Caddy (`managed-section` file) | The Caddyfile at the config path must exist, then `caddy validate --adapter caddyfile --config <path>` (validate loads and provisions but never runs or reloads). |
| nginx (`owned` file) | The config directory (`dirname`) must exist, then `nginx -t`. Bellhop's own file does not exist before the first sync, so file existence is not required. |
| HAProxy (`owned` files) | The config directory must exist, then `haproxy -c -f /etc/haproxy/haproxy.cfg`, adding `-f <path>` only when Bellhop's file is already there. |
| Traefik (`owned` file) | The config directory must exist. With `proxyApiUrl` set, `curl` the API's `/api/overview` and require HTTP 200; without it, the directory check alone. `curl` missing is a named error. |
| Caddy admin API | `readCaddyConfig(deps, { checkService: true })` (already read-only): refuses Caddyfile mode, a missing `curl`, an unreachable admin endpoint. |
| Nginx Proxy Manager | `buildNpmClient(inventory)` then `listProxyHosts()`: the login happens on first call and the list is read-only. |
| none | no check |

**Rationale**: reuses each driver's own validate command and its own read paths, so "valid" means what `sync-proxy` will later mean. A new `FileDriver` definition field carries the per-driver part (`check: { target: 'file' | 'directory'; command(configPath, { inventory }): string | null }`); the shared builder adds the existence test, the error text naming `proxyConfigPath`, and `runRemote`.

**Alternatives**: `test -f` only (proves nothing about validity); starting the proxy's own validator for owned files with a synthetic include (writes).

## R3. Where the step's logic and state live

**Decision**: `src/web/setup/proxy.ts` (no express), shaped like `proxmox.ts`; completion goes through `SetupService.completeStep('proxy')`; a save that changes anything calls a new `uncompleteSetupStep` in `src/lib/setup-state.ts` (a transaction that removes the id from `completed_steps_json`); `none` calls `completeStep` right after saving.

**Rationale**: #86 already stores progress as completed step ids; un-completing is the one missing primitive. Doing it inside the save keeps FR-013 (any change reopens the step) in one place. A repeated save with identical values does not need to un-complete (FR-014): the save compares the new values to the stored ones and only un-completes on a difference.

## R4. Saving settings and secrets

**Decision**: non-secret proxy settings (`proxyDriver`, `proxyConfigPath`, `tlsSource`, `acmeDnsProvider`, `proxyTlsCertificate`, `proxyTlsKey`, `proxyCertResolver`, `proxyApiUrl`, `npmApiUrl`, `npmApiEmail`) validate with `SettingsSchema.pick(...)` + `MovedSettingsSchema` for the moved keys, are applied with `assignSetting` and persisted with `saveInventory`, exactly as step 2 does. Secrets (`cloudflareDnsApiToken`, `npmApiPassword`) are validated with `SecretSettingsSchema` and stored with `writeSecret`. A blank secret keeps the stored one. A key pinned by an environment variable (`configValueAt(...).source === 'environment'`) is refused naming the variable, like the Settings page.

**Rationale**: no parallel validation path (#70 requirement); the same messages as the Settings page. The whole save validates every value before any write, so a refused request changes nothing, and the inventory part is one `saveInventory` call.

**Settings shown per driver** come from the driver metadata the Settings page already gets (`proxyDriversInfo()`: `usesApiUrl`, `usesCertResolver`, `usesNpmApi`, `defaultConfigPath`, `tlsSources`, `defaultTlsSource`). `proxyDriversInfo` is exported from `routes/settings.ts` and reused as-is, so a new driver needs no change here.

## R5. Moving the proxy flag

**Decision**: load the inventory, set `proxy: true` on the chosen host or guest and remove `proxy` from every other entry (hosts and guests), then `saveInventory`. Candidates are hosts and guests only (an external site cannot be the proxy; `ExternalSite` has no `proxy` field). Under `none` no entry is required, and an existing flag is left as it is.

**Rationale**: matches `validateInventory`'s "at most one" rule; saving through `saveInventory` keeps the sort/validation path single.

## R6. Certificate source rules on save

**Decision**: after applying the new values to a copy of the inventory, call `checkTlsSource(updated, driver)` and refuse with its message. Require the Cloudflare token only when the effective source is `acme-dns` with provider `cloudflare` and neither a stored nor an environment value exists; require `proxyTlsCertificate` and `proxyTlsKey` only for `files` (the schema already defaults them from `domain`, so a blank pair is accepted and the default is shown). `none` skips all of it.

**Rationale**: `usesCloudflareDns01` and `checkTlsSource` already encode these rules for `sync-proxy`; the step must not invent different ones.

## R7. The dry-run preview

**Decision**: after the driver check passes, call `runSyncProxy({ apply: false }, { ssh, inventory })` and return `preview`. Any error it throws (capability, TLS, missing outpost) is returned as the preview error, and the step is not completed on a driver pass alone.

**Rationale**: FR-011 says the step shows what the first sync would write. `runSyncProxy` is the single source and never writes without `apply`. The Caddy admin API and NPM `plan()` read the live proxy, which is read-only. On a fresh install there are no gated routes, so no outpost is needed.

## R8. Client

**Decision**: a `ProxyStep` in `SetupPage.tsx` using `proxyDriverOptions`/`tlsSourceOptions` from `web-client/src/lib/settings-display.ts`, the `settings-help` and `setup-*` classes the Basics step uses, and the same busy/error/notice pattern as `ProxmoxStep`. Secret inputs are `type="password"`, never prefilled, and show "set" or "not set" beside the label.

**Rationale**: consistent with the existing step; mobile layout comes from the shared classes, verified at both viewports.

## R9. Seeding for local verification

**Decision**: the walkthrough only appears on an install with no hosts, so the live deployment database cannot be used to run it. Manual verification uses a throwaway database and data directory (an empty `INVENTORY_FILE`) with `FakeSSHClient`-style simulated hosts through the demo seed, not the live checkout.

**Rationale**: the worktree-seeding rule in CLAUDE.md is for CLI/UI work against real hosts; seeding the live DB here would skip the walkthrough entirely.
