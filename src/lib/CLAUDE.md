# src/lib

Inventory schema and store, targets and SSH, MID, package managers, TLS probing, Proxmox ACLs, settings store. Cross-cutting rules: root `CLAUDE.md`.

Documented elsewhere: proxy drivers and `npm-client.ts` in `src/lib/proxy/CLAUDE.md` and `src/lib/proxy/drivers/CLAUDE.md`; `script-catalog.ts` and `app-source.ts` in `src/commands/provisioning/CLAUDE.md` (pin-once rule: `src/operations/CLAUDE.md`); `authentik-client.ts` (`AuthentikClient`, `listOAuth2Providers` filtering) and `permissions.ts` (`isAllowed`, `isGuestCreator`) in `src/web/CLAUDE.md`.

## Inventory schema (`inventory.ts`)

`inventory/bellhop.db` (SQLite, real hostnames/IPs) is gitignored (#116): the repo is public, so no commit can ever pick up real operational data. One per checkout. `inventory/hosts.yaml.example` documents the shape only; the one-time `import-yaml-inventory` CLI command (`src/cli.ts`) `saveInventory`s a `hosts.yaml`-shaped file to a fresh `.db`.

Zod `HostEntrySchema`/`GuestEntrySchema`/`InventorySchema`: `hosts[]` (Proxmox) and `guests[]` (LXC/VM, naming their `host`, with a `vmid`).

### Host SSH fields

- `ssh_user`: required (`z.string().min(1)`). Guests have no SSH login; they use the parent host's `ssh_user`/`ssh_target`.
- `ssh_port`: optional, default 22.
- `ssh_identity_file`: optional; omitted = default key lookup (below). Bare filename resolves against `~/.ssh/`, leading `~` expands, else a path. If set it must be readable: `resolvePrivateKey` (`ssh-client.ts`) throws naming host and path, never falls back (the override is deliberate; a silent fallback would surface as an opaque sshd auth failure).
- Out of scope: passphrase-protected keys (#122; use an agent), `ProxyJump`/bastions.

### Proxy-related entry fields

On hosts, guests, and external sites (`ExternalSiteSchema`: a proxy target that isn't a Proxmox host/guest, e.g. a NAS; never SSH/exec'd, only a `ProxyRoute` source):

- `subdomains`: one route per entry, all to the same `ip`/`port`; the first is canonical.
- `ip`, `port`, `insecureBackendTls` (rendering: `src/lib/proxy/CLAUDE.md`).
- `proxyManual` (hosts, guests): config hand-authored outside the managed markers; `buildRoutes` skips it (no route, no forward-auth), `subdomains[]` still drives the Dashboard link. Hosts: set by hand; guests: Dashboard "read-only proxy" checkbox. Does **not** silence `sync-authentik`, which still maintains its Provider/Application/bindings (the hand-authored block may use forward-auth).
- `proxy: true` on at most one entry: where the reverse proxy runs.
- `authentik: true`: the entry running Authentik; forward-auth addresses it.

### Auth fields

- `authGroup` (#158): a rung of `AUTHENTIK_GROUP_LADDER`, gating the subdomains at that tier; absent = ungated. A no-op on an entry with no `subdomains` in `sync-authentik` (`candidateEntries` skips it) as well as `sync-proxy`. Reconciled by `sync-authentik` (`src/commands/networking/CLAUDE.md`).
- `authMode` (#1): `forward` (default) = driver forward-auth addressed at the `authentik: true` entry; `oidc` = the entry's own Authentik OpenID client.
- `effectiveAuth(entry)` -> `'ungated' | 'forward' | 'oidc'` is the only place `authMode` and `authGroup` combine (no `authGroup` = `'ungated'`); every consumer (`buildRoutes`, `sync-authentik`, Dashboard edit confirmation) reads it, never `authMode`.
- `oidcRedirectUris`: absolute `http://`/`https://` callbacks; required once `effectiveAuth()` is `'oidc'` and the entry has `subdomains`.
- `oidcMobileRedirectUris` (#22): ordered native-app callbacks (custom scheme like `app.example:///oauth-callback`, or an `https://` hand-off page), always optional. `isValidMobileRedirectUri`: any scheme, no whitespace/control chars; `javascript:`/`data:`/`file:`/`vbscript:` (any case) rejected by name.
- A URI may not be in both lists of one entry. Both rules are `oidcConfigErrors`, edit-time only (`checkCrossListDuplicates`), never in `validateInventory()`; see `src/operations/CLAUDE.md` (guest edit).
- `clientRedirectUris(entry)` (`sync-authentik`) merges both lists, so a mobile-only edit is ordinary `redirect_uris` drift.
- Neither list is cleared when the other changes or `authMode` returns to `forward`; they stay inert in case it switches back.
- `unauthenticatedPaths` (#113): globs (e.g. `/api/*`) exempt from forward-auth on a gated entry, for server-to-server calls (*arr apps). Inert without `authGroup` or with `proxyManual`. Exact path or `/*` suffix only (`parsePathPattern`/`isValidUnauthenticatedPath`), what every proxy can express. Not Authentik's `skip_path_regex`: closed-wontfix goauthentik/authentik#6563 leaks it across providers sharing one embedded outpost (this topology). Hosts/external sites: DB/CLI-only.

### Other guest fields

- `unprivileged` (`lxc`): `pct config` privilege status at the last manual check. Informational, not enforced or synced; `sync-inventory` preserves it.
- `app`: community-scripts slug, set once by `install-app`'s apply, never hand-edited; drives the Dashboard link. Preserved across `sync-inventory` and repeat `upsertGuestEntry`.
- `appSource: 'custom'` (`lxc`/`vm`, `guests.app_source`, #11): slug came from `customScriptsRepo`/`customScriptsBranch`. Set only by web/MCP `install-app` apply when `resolveAppSource` returned `kind: 'custom'`; preserved like `app`. Links to the script in that repo/branch; no link if those settings are later unset.
- `creator` (#58): `{ uid?, username, since? }` in nullable `created_by_uid`/`created_by_username`/`created_by_since` columns (`ensureColumn`): the real web-UI user who created the guest, never CLI/MCP. Writers, preservation, what it grants: `src/web/CLAUDE.md` (creator access).

### `validateInventory()` cross-field rules

- at most one `proxy: true` entry (zero is valid, e.g. the `none` driver);
- at most one `authentik: true` entry;
- if any entry is forward-gated (`effectiveAuth() === 'forward'`, incl. external sites), an `authentik: true` entry exists and has an `ip` (OIDC-gated entries need neither);
- every guest's `host` exists;
- non-empty `subdomains` requires `ip` unless `proxyManual`;
- no subdomain claimed twice;
- no two hosts share `midScheme.vmidBase` or `midScheme.ipPrefix` (`resolveMid` would hand out colliding VMIDs/IPs).

Never here: driver capability checks, `oidcConfigErrors` (a setting change must not make a saved inventory unloadable).

### Bridges and storages

- `bridges[]` (`BridgeEntrySchema`: `name`/`alias`/`active`): fully refreshed by `sync-inventory` from `/nodes/<node>/network`, never hand-edited. `alias` mirrors the bridge's Proxmox "Comment" (Datacenter -> node -> System -> Network), default `'LAN'`; never written back.
- `storages[]` (`StorageEntrySchema`: `name`/`type`/`content[]`/`active`): from `/nodes/<node>/storage`. `active` = Proxmox `active` (reachable) AND `enabled`. Kept only if supporting one of `vztmpl`/`rootdir`/`images` (backup-/iso-only pools dropped). `pickStorage` reads these.

### Cluster note

`pve-node-a` and `pve-node-b` share one cluster, so `/etc/pve` (incl. `storage.cfg`) is synced: a `pvesm add` on one shows on the other at once, and repeating it fails "already defined". `migrate-nfs-mount --storage`'s `nfs:` storage is created once cluster-wide.

## Inventory database read/write

`loadInventory`/`saveInventory` use `better-sqlite3` (WAL, foreign keys on).

### Tables

- `hosts`, `guests`, `external_sites`.
- `subdomains`: one row each, `owner_type`/`owner_name` -> owner.
- `proxy_owner`: single row (`CHECK (id = 1)`) naming the `proxy: true` entry; written by `saveInventory`, never read (`loadInventory` reads the owning row's `proxy` column).
- `meta`: `domain` plus operator settings.
- `secret_settings` (`key`/`value`, `SECRET_SETTINGS_TABLE_SQL` in `config.ts`): the four secrets.
- Never touched by `saveInventory`: `secret_settings`, `permission_groups`/`permission_rules`, `script_catalog`/`script_catalog_meta`, `task_schedules`, `app_update_status`.

### `meta` settings

`SettingsSchema`/`SETTINGS_KEYS` (`inventory.ts`), spread flat into `InventorySchema` like `domain`:

- `nfsServer`, `backupStorage`, `dnsServer`, `statusPagePath` (#124): readers fail with a named error, never a hardcoded fallback (a wrong IP is worse than none), ending with `settingFix(key, valueHint)` (`settings-hint.ts`, #20), which names both `set-config` and the Settings page.
- `customScriptsRepo`/`customScriptsBranch` (#11): each validated (owner/repo; git branch name). Both-or-neither is not in the schema (`set-config` writes one key at a time); `customScriptSource()` (`app-source.ts`) enforces it on read.
- `proxyDriver`/`proxyConfigPath`: `getDriver()`'s driver and its config file.
- `tlsSource` (#72): `acme-dns`, `acme-http`, `internal`, `files`, `external`; unset means the active driver's `defaultTlsSource`. `acmeDnsProvider` (#72): `cloudflare` only (the default). Both are enum-checked only, never against the driver (`checkTlsSource` in `src/lib/proxy/tls.ts` runs where configuration is produced), so switching drivers never makes the inventory unloadable. They replaced `proxyCaddyTls` (#51); a leftover `proxyCaddyTls` meta row is ignored by `loadInventory` (it reads only `SETTINGS_KEYS`) and left in place by `saveInventory`.
- `proxyTlsCertificate`/`proxyTlsKey` (#30): the shared cert/key pair served under `tlsSource: files`.
- `proxyCertResolver`/`proxyApiUrl` (#35): Traefik only; `proxyCertResolver` is read under `acme-dns`/`acme-http`, and no value is reserved (`none` was, until #72's `external` replaced it).
- `pveUserRealm`/`pveCreatorRole` (#53): unset `pveUserRealm` = creator grant off.
- #64's twelve integration settings (`authentikApiUrl` + eight other `authentik*`, `webUiAuthMode`, `npmApiUrl`, `npmApiEmail`): `settings-defs.ts`'s `MovedSettingsSchema`, spread into `SettingsSchema`.

Writers: `set-config <key> [value] [--unset] [--apply]` (`src/commands/maintenance/set-config.ts`) and the admin-only web Settings page, both validating against `SettingsSchema`.

Derived, not configured: `set-guest-vpn --vpn none`'s LAN gateway is the parent host's `midScheme.gateway`; the Windows service firewall `remoteip=` (`scripts/windows-service.ts`'s `resolveProxyIp`) is the `proxy: true` entry.

### `saveInventory` transaction

One `db.transaction`: delete all rows from `subdomains`/`proxy_owner`/`guests`/`external_sites`/`hosts` (FK-safe order) and re-insert; upsert `meta` per key (`domain` + `SETTINGS_KEYS`) via `INSERT ... ON CONFLICT DO UPDATE`; `DELETE FROM meta WHERE key = ?` per `undefined` setting, so clearing (`set-config --unset`, web PATCH) doesn't leave a stale value.

### `sortInventoryForFile`

Deterministic ordering (YAML-era name):

- hosts by `name`;
- guests by `host`, `type`, `ip` (numeric per octet, ip-less last), `name`, mirroring `sortGuestsForDisplay`/`compareIp` in `web-client/src/lib/guest-display.ts` (duplicated: `web-client` imports nothing from `src/`);
- each host's `bridges[]`/`storages[]`/`nfsMounts[]` and each storage's `content[]` by name.

Runs in `loadInventory` before validation (SQL `ORDER BY` misses nested arrays/tie-breaks) and in `saveInventory`, fixing every read's order. That makes `sync-inventory --apply` idempotent: Zod normalizes field order, leaving Proxmox's array order as the only possible drift.

### Subdomain order

The first subdomain is canonical, so `subdomains` is read `ORDER BY rowid`; `saveInventory` re-inserts each owner's list in array order. Any direct writer must too, or the order silently breaks.

The `yaml` package is used by `import-yaml-inventory` (parse) and `render-status-page` (`stringify` of live inventory), not by `loadInventory`/`saveInventory`.

### Migrations

Both `PRAGMA table_info`-guarded, self-idempotent, log only on change, **forward-only** (older code can't open a migrated DB).

- **`requires_auth` -> `auth_group` (#158)**: on a `requires_auth` column in `hosts`/`guests`/`external_sites`, sets `auth_group` on every `requires_auth = 1` row to the ladder's *top* rung (`authentik Admins` by default; fail-closed), then drops the column. The ladder is the opened DB's own `authentikGroupLadder` `meta` row (same handle, pure `effectiveValue`, so `AUTHENTIK_GROUP_LADDER` overrides), not the snapshot, so a custom ladder applies from any entry point even before the `data/*.env` import (a ladder only in `data/authentik.env` arrives as the env override via dotenv).
- **`migrateCaddyToProxy` (#10)**: renames `hosts`/`guests` columns `caddy`/`caddy_manual` (`ALTER TABLE … RENAME COLUMN`, SQLite 3.25+) to `proxy`/`proxy_manual` and drops any `caddy_owner` table (never read; next save fills `proxy_owner`). Must run before `ensureColumn(..., 'proxy_manual', ...)`, else the rename hits a duplicate column. Columns are checked independently (a DB without `caddy_manual` gets `proxy_manual` from `ensureColumn`).

## Target resolution (`targets.ts`, `ssh-client.ts`)

`resolveTarget`/`runRemote`: a `pve` entry gets a direct SSH exec; an `lxc`/`vm` guest is reached via its parent host with `pct exec <vmid> --` / `qm guest exec <vmid> --`.

### `sh -c` wrapping

Guest commands are wrapped `sh -c ${shellQuote(cmd)}` (POSIX single-quote escaping) because `pct exec`/`qm guest exec` invoke no shell, so `cmd1 && cmd2` would arrive split. `sh`, not `bash` (#120): stock Alpine (`alpine-3.24-default`) has only busybox ash at `/bin/sh`. POSIX-sh exceptions: root `CLAUDE.md`.

### `qm guest exec` envelopes

`qm guest exec` exits 0 whenever the agent call succeeds; the `vm` branch `JSON.parse`s the stdout envelope `{"exitcode":N,"out-data":"...","err-data":"..."}` (strict JSON, newlines escaped) into the real `ExecResult`.

- `VM_EXEC_TIMEOUT_SECONDS` (60) builds both `--timeout` and the failure message; fixed, no per-call override (package commands never go to VMs).
- Failures (`code: 1`), never coerced to success:
  - **signal-killed**: `exited: 1` + `signal`, no `exitcode`; keeps `out-data`/`err-data`, appends `killed by signal <N>` to stderr. Checked before the timeout shape.
  - **timed out**: pid-only `{"pid":N}`; still running in the guest.
  - **unparseable**: fails `JSON.parse`.

### `Ssh2SSHClient`

`Ssh2SSHClient.exec()` is the only code that opens SSH (no automated test; verify on real infrastructure).

- **Auth order**: first of `~/.ssh/id_ed25519`/`id_ecdsa`/`id_rsa` as `privateKey` (like plain `ssh` without an agent); only if none exist, an agent (`SSH_AUTH_SOCK`, `'pageant'` on Windows). `ssh_identity_file` overrides.
- 5s connect timeout: a bad key fails fast.
- **`SshTarget`** `{ host, user, port?, identityFile? }` is the one argument of all three `SSHClient` methods. Only `Ssh2SSHClient.connectConfig()` maps it to ssh2 options and only `hostSshTarget(host)` (`targets.ts`) builds it from an entry, so a new per-host setting is threaded only there.
- **Null exit code**: `'close'` with `code === null` (signal-terminated; 2nd arg is the signal name) is a failure (`code: 1`, signal name in `stderr` if nothing else captured), never `0`.
- **Stdin closed**: `stream.end()` right after open, so a command reading stdin fails on EOF, not hangs (e.g. `paperless-gpt`/`paperless-ngx` `read -p` prompts). `onStdinReady` instead keeps stdin open with a pty (web prompt relay; `src/web/jobs/CLAUDE.md`).
- `execInteractive()`: real remote pty for the CLI's interactive `install-app` (`src/commands/provisioning/CLAUDE.md`).

### phantom-success: why a null exit code is a failure

A signal-killed remote process reported `code: null`, the old `code ?? 0` called it success, and `install-app` wrote a phantom guest into inventory and pushed a proxy route for a container that never existed.

## Machine ID (MID)

`resolveMid` (`targets.ts`; `create-lxc`/`create-vm`/`install-app`): `--mid` (1-254) derives VMID and IP/gateway from the host's `midScheme` (`{ vmidBase, ipPrefix, cidrSuffix?, gateway }`, `cidrSuffix` default 16). E.g. `vmidBase: 4000, ipPrefix: "192.168.1."` + MID 4 -> VMID `4004`, IP `192.168.1.4/16`.

- No collision check: `create-lxc`/`create-vm` rely on Proxmox's reused-VMID rejection; `install-app` pre-checks (`src/commands/provisioning/CLAUDE.md`).
- Uncaught: a MID equal to the host's last octet yields the host's own IP (no duplicate-address check); avoid it.
- `midScheme` is validated only when `resolveMid` runs, so hosts without MID use need none. Cross-host uniqueness: `validateInventory`.

## Targeting and package managers

### `selectTargets` and `selectUpdateTargets`

`update-all` (`--host <name>` / `--all` / `--group pve|lxc`, via `selectTargets`) never acts on a VM. Only `selectUpdateTargets` (`src/commands/maintenance/update-all.ts`) decides its targets, called by both `runUpdateAll` and the operation's `preview` (`src/operations/maintenance.ts`), so they agree.

- `{ all: true }` silently drops VMs.
- `{ group: 'vm' }` / `{ host: <vm-name> }` reject: `update-all does not update VMs...`.
- Everything else delegates to `selectTargets` (incl. its unknown-host error).
- `TargetSelector.group` allows `'vm'` (other callers) and CLI `--group` takes any string; `selectUpdateTargets` rejects it at runtime. Web/MCP `group` is `z.enum(['pve', 'lxc'])`.

### Package-manager detection (`package-manager.ts`)

`detectPackageManager` runs `PROBE_COMMAND` (a `command -v` chain) and classifies. `UPDATE_COMMANDS` covers `apt`/`dnf`/`apk`/`pacman`/`zypper`; `INSTALL_COMMANDS` has the same shape. Runtime, not an inventory field: Proxmox's `ostype` is a creation-time label (`l26` for every VM); `command -v` is ground truth.

Unrecognized OS: `update-all` buckets it in `failUnknownPm` (not `failCommand`) and continues (still fails the web job / CLI exit 1); `configure-guest --packages` throws `UnknownPackageManagerError`. It also refuses a `vm` guest before any remote call (dry run and apply), so a `--ssh-key` in the same call doesn't run; `--ssh-key` alone works on VMs.

## Live TLS-backend probing (`tls-probe.ts`)

#100. The manual `insecureBackendTls` checkbox stays authoritative for hosts, CLI, `proxyManual`, and inconclusive probes; a conclusive probe overwrites what the same request submitted. `probeInsecureBackendTls` runs `curl -s -o /dev/null --max-time 5 https://<ip>:<port>/` on the parent host (not the guest, which may lack curl). `interpretCurlExitCode`: `60`/`51` -> `'insecure'`; `0`/`35` (trusted, or no TLS) -> `'trusted'`; anything else, including a thrown SSH/exec error -> `'inconclusive'`. A throw stops retries at once (SSH failed or the job was cancelled). Never throws.

Call sites (`recordProvisionedGuest` with retries, Dashboard PATCH single-shot): `src/web/CLAUDE.md`. No CLI hook (no CLI command sets `port`+`subdomains`).

## Proxmox access for VM creators (`pve-acl.ts`)

#53. The only module mapping Bellhop users to Proxmox users and reading/writing per-guest ACLs (via `runRemote` on a `pve` host). Exports and messages: `specs/016-pve-creator-acl/contracts/pve-acl.md`.

### `grantCreatorAccess`

Off unless `pveUserRealm` is set; call site and behavior: `src/operations/CLAUDE.md`. Grantee: `OperationDeps.actor`, set only by the provisioning router via `resolveActor(req)` (`src/web/impersonation.ts`) = `req.realUser ?? req.user` (an impersonating admin's own account); `undefined` for the local operator (`localOperator: true`), CLI, and MCP `create_vm`.

### Host-side filtering

`buildRealmReadCommand`/`buildGuestAclReadCommand` filter on the Proxmox host with inline `perl -MJSON::PP`, never returning raw `pvesh` JSON: realm config holds the OIDC `client-key` in clear text, the ACL list holds everyone's user IDs, and web/MCP job stdout streams into the job log (`JobSSHClient.exec`'s `onChunk`), so filtering must precede capture. Node re-validates (zod) and re-filters (`aclsForVmid`), so a bad host filter can't widen a migration's copy.

### `copyGuestAcls` and destroy

`migrate-guest` calls `copyGuestAcls` unconditionally (not gated on `pveUserRealm`; copies whatever is on the old VMID, creator grant or hand-added) after the new guest is verified running, before destroying the original, since destroy removes the VMID's permissions.

Destroy (`delete-guest`'s, like `migrate-guest`'s) needs no ACL cleanup: VM and container destroy call `PVE::AccessControl::remove_vm_access` regardless of `--purge` (Proxmox VE 9.2.10 source), so a reused VMID inherits nothing. Known limitation: destroy also drops pool membership, which `copyGuestAcls` doesn't restore; re-add a pooled guest by hand (`docs/proxmox-access.md`).

No single-operator assumption: `pveUserRealm`/`pveCreatorRole` are optional; realm/role names come from Proxmox or the operator.

## Settings store

#64. `settings-defs.ts`, `config.ts`, `config-import.ts`, `live-client.ts`, `github.ts`: one store for the integration values formerly in `data/authentik.env`/`data/cloudflare-api.env`/`data/nginx-proxy-manager.env`, editable without a shell or restart. Settings page and PATCH guards: `src/web/CLAUDE.md`, `web-client/CLAUDE.md`.

### Definitions (`settings-defs.ts`)

Leaf module (importing `inventory.ts` would cycle through `authentik-config.ts`): `MovedSettingsSchema`, `SecretSettingsSchema`, `SETTING_DEFS` (per key: env var, Settings-page group, secret flag, source `data/*.env`). Secrets `authentikApiToken`, `cloudflareDnsApiToken`, `npmApiPassword`, `githubApiToken` live in `secret_settings`, never read by `loadInventory`, so none reaches `Inventory` or its serializations (status page, `/api/inventory`, snapshots). Written only by `writeSecret`/`clearSecret` and the import.

### The accessor (`config.ts`)

Consumers read moved values/secrets through it at point of use, never at startup.

- `configValue(key, env = process.env)` -> `{ value?, source: 'environment' | 'settings' | 'none' }`: non-empty env var, then stored value, then nothing (consumer applies its default, e.g. `authentikConfig()`, `npm-client.ts`). `effectiveValue` is this rule, pure (also used by #158's migration). `configValueAt(path, ...)` reads an explicit DB (`/api/settings`).
- Stored values are re-validated on read; a malformed one throws naming key and variable, never the value.
- **Snapshot**: stored half cached per process per DB path, 2 s TTL (`CONFIG_SNAPSHOT_TTL_MS`; an open costs ~7 ms, `authentikConfig()` runs often, and a long-lived connection would hold the file open on Windows). Invalidated per `/api` request (beside `refreshInventory`, `src/web/app.ts`) and by every in-process write (`saveInventory`, `writeSecret`/`clearSecret`, the import), so CLI/MCP writes show on the web service's next request.
- Entry points (`src/cli.ts`, `src/web/server.ts`, `src/mcp/server.ts`, `scripts/windows-service.ts`) register their DB via `importEnvFilesAndUseStore` -> `useConfigStore(path)`. Unregistered (`useConfigStore(null)`, tests by default) reads the environment only, so tests passing their own `env` work unchanged.

### One-time import (`config-import.ts`)

`importEnvFiles` runs after dotenv loads and `dotenv.parse`s each file (a real env var is an override, never imported). It stores each valid value whose key has none yet (`ON CONFLICT DO NOTHING`, so a second start imports nothing), warns on invalid ones, logs key names only, never touches the files, and is a no-op before the DB exists.

A file left in place is still dotenv-loaded, so it keeps overriding ("set by environment") until deleted *and the process restarts*. Retiring: check each field's "Stored copy" (in production, **Web UI sign-in** must show "Stored copy: authentik" before deleting `data/authentik.env`), delete the files, restart the web service and any long-running MCP server.

### `withFreshSettings`

Load-await-save commands (`sync-inventory --apply`, `set-guest-vpn`, Dashboard guest edit) save through `withFreshSettings` (`inventory.ts`), which re-reads every setting from the DB, so a concurrent settings save isn't reverted.

### Live clients and GitHub headers

- `live-client.ts`: `buildAuthentikClient()`/`buildCloudflareClient()` return a `liveClient(build)` Proxy that rebuilds the real-or-unconfigured client from current config on every property access, so a client built once follows later saves (`isConfigured()` included).
- `github.ts`: `githubApiHeaders(extra?)` serves every `api.github.com` request (`app-source.ts`, `app-update-check.ts`, `script-catalog.ts`), adding `Authorization: Bearer <githubApiToken>` only when that secret (or `GITHUB_API_TOKEN`) is set. `githubUnauthorizedError` names the setting and Settings page on a 401. `raw.githubusercontent.com` stays anonymous.

### Write rules and assumptions

- `set-config`'s no-echo prompt is `secret-input.ts`; MCP `set_config`'s key enum lists non-secret keys only.
- A web write to an env-pinned key is refused naming the variable; the CLI stores it and warns (its environment may not be the service's).
- Single-operator assumptions removed: "no GitHub token setting", hand-writing `data/*.env` on the host. Kept by design: secrets are plain text in `bellhop.db`; every DB copy carries them.
