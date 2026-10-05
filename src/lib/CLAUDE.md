# src/lib

Shared library code: the inventory schema and SQLite store, target resolution and SSH, MID, package-manager detection, TLS probing, Proxmox ACLs, and the settings store.

Cross-cutting rules live in the root `CLAUDE.md`: `runRemote` is the only remote path, guest commands are POSIX sh (with exceptions), the dry-run convention, `saveInventory` is a full replace, secrets never leave the store, web UI authz rigor, single-operator assumptions are recorded, example data only.

Pointers:

- `npm-client.ts` (Nginx Proxy Manager REST client): see `src/lib/proxy/drivers/CLAUDE.md` (Nginx Proxy Manager driver).
- `script-catalog.ts` (install-app catalog): see `src/commands/provisioning/CLAUDE.md` (script catalog).
- `app-source.ts` (custom script repository resolution): see `src/commands/provisioning/CLAUDE.md` (custom script source); the pin-once rule is in `src/operations/CLAUDE.md`.
- `authentik-client.ts` (`AuthentikClient`, `listOAuth2Providers` filtering): see `src/web/CLAUDE.md` (user/group management).
- `permissions.ts` (`isAllowed`, `isGuestCreator`): see `src/web/CLAUDE.md` (per-resource permissions, creator access).
- Proxy drivers: see `src/lib/proxy/CLAUDE.md`.

## Inventory schema (`inventory.ts`)

`inventory/bellhop.db` is a SQLite database holding real hostnames/IPs. It is gitignored (issue #116: the repo is public); each checkout/worktree keeps its own copy on disk. `git diff` can't show it meaningfully, an accepted tradeoff. `inventory/hosts.yaml.example` documents the schema shape only; nothing parses it except the one-time `import-yaml-inventory` CLI command (`src/cli.ts`), which reads a `hosts.yaml`-shaped file and calls `saveInventory` against a fresh `.db` path.

Schema: `HostEntrySchema`/`GuestEntrySchema`/`InventorySchema` (zod). Proxmox hosts are `hosts[]`, their LXC/VM guests `guests[]`; guests reference their parent host by name and carry a `vmid`.

### Host SSH fields

- `ssh_user` is required on every host (`z.string().min(1)`). A guest has no SSH login of its own; it resolves `ssh_user`/`ssh_target` from its parent host.
- `ssh_port` (optional; omitted means ssh2's default 22).
- `ssh_identity_file` (optional; omitted means the global `~/.ssh/id_ed25519` -> `id_ecdsa` -> `id_rsa` lookup, then agent fallback). A bare filename resolves against `~/.ssh/`, a leading `~` is expanded, anything else is an ordinary path. When set it must be readable: `resolvePrivateKey` (`ssh-client.ts`) throws naming the host and resolved path rather than falling back, because a per-host override is a deliberate operator statement and a quiet fallback would surface later as an opaque sshd auth failure.
- Out of scope: passphrase-protected keys (issue #122; use an agent) and `ProxyJump`/bastion tunneling.

### Proxy-related entry fields

On hosts, guests, and external sites (`ExternalSiteSchema`: a reverse-proxy target that is not a Proxmox host/guest, e.g. a NAS; never an SSH/exec target, only a `ProxyRoute` source):

- `subdomains` (list): one route per entry, all to the same `ip`/`port`. The first is the canonical hostname.
- `ip`, `port`, `insecureBackendTls` (see `src/lib/proxy/CLAUDE.md` for driver rendering).
- `proxyManual` (hosts and guests): the real proxy config is hand-authored outside the managed markers. `buildRoutes` skips the entry entirely (no route, no forward-auth), but its `subdomains[]` still drives the Dashboard's service link. Set by hand for a host (no host-edit UI) or via the Dashboard's "read-only proxy" checkbox for a guest. It does **not** silence `sync-authentik`, which still maintains that entry's Authentik Provider/Application/bindings, since the hand-authored block may still route through forward-auth.
- `proxy: true` on exactly one entry marks where the reverse proxy runs.
- `authentik: true` marks the entry running Authentik; forward-auth directives address it.

### Auth fields

- `authGroup` (issue #158): names one rung of the ordered `AUTHENTIK_GROUP_LADDER`; gates the entry's subdomains at that tier. Absent means ungated. Reconciled by `sync-authentik` (see `src/commands/networking/CLAUDE.md`).
- `authMode` (issue #1): `forward` (default when absent) puts the active proxy driver's forward-auth in front (addressed at the `authentik: true` entry); `oidc` gives the entry its own Authentik OpenID client so the app checks the login.
- `effectiveAuth(entry)` returns `'ungated' | 'forward' | 'oidc'` and is the one place `authMode` is folded together with `authGroup` (unset `authGroup` is always `'ungated'`). Every consumer (`buildRoutes`, `sync-authentik`, the Dashboard edit-confirmation rule) reads it, never `authMode` directly, so no two consumers disagree.
- `oidcRedirectUris`: absolute `http://`/`https://` callbacks. Required once `effectiveAuth()` is `'oidc'` and the entry has `subdomains`.
- `oidcMobileRedirectUris` (issue #22): a separate ordered list for a native app's callback (custom scheme like `app.example:///oauth-callback`, or an `https://` hand-off page). Validated by `isValidMobileRedirectUri`: any scheme, no whitespace/control characters, but `javascript:`/`data:`/`file:`/`vbscript:` (any case) are rejected by name. Always optional, in every mode.
- A URI must not appear in both lists of one entry.
- `oidcConfigErrors` enforces the required-callback rule and (via its `checkCrossListDuplicates` option, only for an edit that changed either list) the cross-list duplicate rule. It runs only from `commitGuestEdit` (`src/operations/edit-guest.ts`, shared by the Dashboard guest PATCH and MCP `edit_guest`), never from `validateInventory()`, so a saved inventory always loads regardless of an `AUTHENTIK_AUTHORIZATION_FLOW_SLUG` change or a hand-edited row, and an already-saved duplicate never blocks an unrelated edit.
- `sync-authentik`'s exported `clientRedirectUris(entry)` decides an OpenID client's allowed callbacks: web list plus mobile list, deduplicated, web first. A mobile-only edit is ordinary `redirect_uris` drift.
- Neither list is cleared when the other changes, and switching `authMode` back to `forward` leaves both in place, inert, in case the entry switches back.
- `unauthenticatedPaths` (issue #113): proxy path-matcher globs (e.g. `/api/*`) exempted from forward-auth on a gated entry, for server-to-server API calls (an *arr app calling another). Inert when `authGroup` is unset or the entry is `proxyManual`. Restricted to an exact path or a path ending in `/*` (`parsePathPattern`/`isValidUnauthenticatedPath`), the subset every proxy can express. It is deliberately not Authentik's own `skip_path_regex`, which has a closed-wontfix bug (goauthentik/authentik#6563) leaking across providers sharing one embedded outpost, which is exactly this toolkit's topology. Editable for guests in the Advanced modal; hosts/external sites are DB/CLI-only, like `authGroup`.

### Other guest fields

- `unprivileged` (`lxc` only): the guest's `pct config` privilege status as of the last manual check. Informational only; not enforced or auto-synced, though `sync-inventory` preserves it.
- `app`: the community-scripts slug, set once by `install-app`'s apply, never hand-edited. Drives the Dashboard's community-scripts link. Preserved across `sync-inventory` and repeat `upsertGuestEntry` merges.
- `appSource: 'custom'` (`lxc`/`vm`, `guests.app_source` via `ensureColumn`, issue #11): the slug came from the configured `customScriptsRepo`/`customScriptsBranch`. Set only by the web/MCP `install-app` apply when `resolveAppSource` returned `kind: 'custom'` (never the CLI, which doesn't touch inventory). Preserved like `app`. Makes the Dashboard/Update page link to the script in the custom repo/branch; if the custom settings are later unset, there is no link at all.
- `creator` (issue #58): `{ uid?, username, since? }` in nullable `created_by_uid`/`created_by_username`/`created_by_since` columns (`ensureColumn`). The real signed-in web-UI user who created the guest, set by the web apply paths of `create-lxc`/`create-vm`/`install-app`/`deploy-vpn-gateway` via `creatorFromActor(deps.actor)` (never CLI or MCP). Preserved across `sync-inventory`, `upsertGuestEntry`, and `migrate-guest`. See `src/web/CLAUDE.md` for what it grants.

### `validateInventory()` cross-field rules

Rules that span entries live here rather than in the schema:

- exactly one entry has `proxy: true`;
- every guest's `host` resolves to a real host;
- non-empty `subdomains` requires `ip` unless `proxyManual` is set;
- no two entries claim the same subdomain;
- no two hosts share `midScheme.vmidBase` or `midScheme.ipPrefix` (either would let `resolveMid` hand out colliding VMIDs/IPs).

Driver capability checks and `oidcConfigErrors` are deliberately never run from here, so a setting change can't make a saved inventory unloadable.

### Bridges and storages

- `bridges[]` (`BridgeEntrySchema`: `name`/`alias`/`active`): fully refreshed by `sync-inventory` from `/nodes/<node>/network`, never hand-edited. `alias` mirrors the bridge's Proxmox "Comment" (Datacenter -> node -> System -> Network), defaulting to `'LAN'`. The toolkit never writes that comment back.
- `storages[]` (`StorageEntrySchema`: `name`/`type`/`content[]`/`active`): refreshed from `/nodes/<node>/storage`. `active` combines Proxmox's `active` (reachable) and `enabled` (not admin-disabled). Only storages supporting at least one of `vztmpl`/`rootdir`/`images` are kept; backup-only or iso-only pools are dropped. `pickStorage` reads these.

### Cluster note

`pve-node-a` and `pve-node-b` are members of one Proxmox cluster, so `/etc/pve` (including `storage.cfg`) is synced between them. A `pvesm add` on one host is visible on the other immediately; repeating it there fails with "already defined". For `migrate-nfs-mount`'s `--storage` flag this means an `nfs:` storage is created once cluster-wide, not once per host.

## Inventory database read/write

`loadInventory`/`saveInventory` open a `better-sqlite3` connection (WAL journal mode, foreign keys on).

### Tables

- `hosts`, `guests`, `external_sites`.
- `subdomains`: one row per subdomain, `owner_type`/`owner_name` pointing at its host/guest/external_site.
- `proxy_owner`: single row (`CHECK (id = 1)`) recording which entry has `proxy: true`. Written by `saveInventory` but never read back; `loadInventory` reads the `proxy` column on the owning row.
- `meta`: `domain` plus the operator settings (below).
- `secret_settings` (`key`/`value`, `SECRET_SETTINGS_TABLE_SQL` in `config.ts`): the four secrets. See "Settings store".
- Outside `saveInventory`'s delete-and-reinsert (never disturbed by it): `secret_settings`, `permission_groups`/`permission_rules`, `script_catalog`/`script_catalog_meta`, `task_schedules`, `app_update_status`.

### `meta` settings

`SettingsSchema`/`SETTINGS_KEYS` in `inventory.ts`, spread flat into `InventorySchema` (same placement as `domain`):

- `nfsServer`, `backupStorage`, `dnsServer`, `statusPagePath` (issue #124). The commands that read them fail with a named error pointing at `set-config` rather than falling back to a hardcoded value, since a wrong IP is worse than a missing one. Every such message ends with `settingFix(key, valueHint)` (`settings-hint.ts`, issue #20), which also names the web Settings page.
- `customScriptsRepo`/`customScriptsBranch` (issue #11): validated individually (owner/repo shape; git branch-name shape). Their both-or-neither rule is deliberately not in the schema, because `set-config` writes one key at a time; it is enforced where read, by `customScriptSource()` in `app-source.ts`.
- `proxyDriver`/`proxyConfigPath`: which driver `getDriver()` returns and its config file location.
- `proxyCaddyTls` (issue #51): `cloudflare` (default), `letsencrypt`, `internal`, or `files`; inert for non-Caddy drivers.
- `proxyTlsCertificate`/`proxyTlsKey` (issue #30): shared cert/key pair for nginx, and for a Caddy driver in `files` mode.
- `proxyCertResolver`/`proxyApiUrl` (issue #35): Traefik only. `proxyCertResolver` also admits the reserved `none`.
- `pveUserRealm`/`pveCreatorRole` (issue #53): see "Proxmox access for VM creators". `pveUserRealm` unset means the feature is off.
- Issue #64's twelve integration settings (`authentikApiUrl` plus eight other `authentik*` keys, `webUiAuthMode`, `npmApiUrl`, `npmApiEmail`), defined in `settings-defs.ts`'s `MovedSettingsSchema` and spread into `SettingsSchema`.

Writers: `set-config <key> [value] [--unset] [--apply]` (`src/commands/maintenance/set-config.ts`) and the admin-only web Settings page. Both validate against `SettingsSchema`, so they accept and reject identically.

Two former literals are derived, not configured: the LAN gateway `set-guest-vpn --vpn none` restores comes from the parent host's `midScheme.gateway`; the Windows service's firewall `remoteip=` (`scripts/windows-service.ts`'s `resolveProxyIp`) comes from the `proxy: true` entry.

### `saveInventory` transaction

One `db.transaction`: delete every row from `subdomains`/`proxy_owner`/`guests`/`external_sites`/`hosts` (FK-safe order) and re-insert everything; upsert `meta` key by key (`domain` plus each defined `SETTINGS_KEYS` value) with `INSERT ... ON CONFLICT DO UPDATE`; and `DELETE FROM meta WHERE key = ?` for any setting left `undefined`. That delete is what makes clearing a setting (`set-config --unset`, a web PATCH) round-trip instead of leaving a stale value for the next load.

### `sortInventoryForFile`

The deterministic-ordering pass (name kept from the YAML era):

- hosts by `name`;
- guests by `host`, then `type`, then `ip` (numeric per octet, ip-less last), then `name`, mirroring the Dashboard's `sortGuestsForDisplay`/`compareIp` in `web-client/src/lib/guest-display.ts` (duplicated, not shared, since `web-client` is a separate build with no imports from `src/`);
- each host's `bridges[]`/`storages[]`/`nfsMounts[]` and each storage's `content[]` by name.

It runs on both ends: `loadInventory` applies it before validation (SQL `ORDER BY` gets most of the way, but this guarantees nested arrays and tie-breaks), and `saveInventory` applies it on the way in. So it guarantees `loadInventory`'s returned order on every read. It is what makes `sync-inventory --apply` idempotent when nothing changed: Zod normalizes field order on load, so array order (driven by whatever order Proxmox's API returns) is the only thing that could otherwise drift.

### Subdomain order

`subdomains` order is operator-meaningful (the first is canonical), so it is read back `ORDER BY rowid`, not alphabetically. `saveInventory` clears the table and re-inserts each owner's subdomains in array order within one transaction, so rowid order preserves authored order. Any future direct writer of this table must also insert in plain array order, or the guarantee silently breaks.

### `yaml` package

Still used by `import-yaml-inventory` (parsing) and `render-status-page` (`stringify` of the live inventory for display), not by `loadInventory`/`saveInventory`.

### Migrations

Both are guarded by `PRAGMA table_info`, self-idempotent, log only when something changed, and **forward-only**: once a database is migrated, code from before the change can't open it.

- **`requires_auth` -> `auth_group` (issue #158)**: runs the first time `hosts`/`guests`/`external_sites` are opened while they still have a `requires_auth` column. Every row with `requires_auth = 1` gets `auth_group` set to the configured ladder's *top* rung (`authentik Admins` in the default ladder), a deliberate fail-closed choice (narrowest audience). Then the column is dropped. Older code can't open the result because its `INSERT`s still name `requires_auth`. The ladder is read at DB-open time from the database being opened: the `authentikGroupLadder` `meta` row on the same handle, through the config accessor's pure `effectiveValue` (so `AUTHENTIK_GROUP_LADDER` still overrides), not through the snapshot. A custom ladder therefore applies whichever entry point opens the database, even before the `data/*.env` import has run (a ladder only in `data/authentik.env` arrives as the env override, since entry points dotenv-load first).
- **`migrateCaddyToProxy` (issue #10)**: the first time `hosts`/`guests` are opened with a `caddy` or `caddy_manual` column, each is renamed in place (`ALTER TABLE … RENAME COLUMN`, SQLite 3.25+) to `proxy`/`proxy_manual`, and any `caddy_owner` table is dropped (it was never read back, and the next save fills `proxy_owner`). It must run before the schema's `ensureColumn(..., 'proxy_manual', ...)`: `CREATE TABLE IF NOT EXISTS proxy_owner` has already run by then, and `ensureColumn` adding `proxy_manual` first would make the rename fail with a duplicate column. Each column is checked independently, so a database predating `caddy_manual` just gets `proxy_manual` from `ensureColumn`.

## Target resolution (`targets.ts`, `ssh-client.ts`)

`resolveTarget`/`runRemote` in `targets.ts`. A `pve` entry is reached by a direct SSH exec. An `lxc`/`vm` guest is reached by SSHing to its parent host and running `pct exec <vmid> --` / `qm guest exec <vmid> --`.

### `sh -c` wrapping

Every guest command is wrapped as `sh -c ${shellQuote(cmd)}` (`shellQuote` in `ssh-client.ts`, POSIX single-quote escaping), because `pct exec`/`qm guest exec` don't invoke a shell; without it, `cmd1 && cmd2` would reach the guest split apart. It is `sh`, not `bash` (issue #120), because a default Alpine container (e.g. `alpine-3.24-default`) has only busybox ash at `/bin/sh` and no `/bin/bash`. The POSIX-sh rule and its exceptions are in the root `CLAUDE.md`.

### `qm guest exec` envelopes

`qm guest exec` exits 0 whenever the agent call succeeds; the real result is a JSON envelope on stdout: `{"exitcode":N,"out-data":"...","err-data":"..."}`. `runRemote`'s `vm` branch parses it with a plain `JSON.parse` (real output is strict JSON; embedded newlines arrive as escaped `\n`) and translates it into the real `ExecResult`.

- Timeout: `VM_EXEC_TIMEOUT_SECONDS` (60) builds both the `--timeout` flag and the failure message. Fixed for every VM command, no per-call override (package commands are never sent to a VM, so no longer wait is needed).
- These shapes are reported as failures (`code: 1`), never coerced to success:
  - **signal-killed**: `exited: 1` with a `signal` number and no `exitcode`. Reported with its `out-data`/`err-data` plus `killed by signal <N>` appended to stderr. Checked first, since it shares "no `exitcode`" with the timeout shape.
  - **timed out**: pid-only `{"pid":N}`, no `exitcode`; the command is still running in the guest when `qm guest exec` stops waiting.
  - **unparseable**: anything that fails `JSON.parse`.

### `Ssh2SSHClient`

`Ssh2SSHClient.exec()` is the only code that opens an SSH connection (no automated test; verify against real infrastructure).

- **Auth order**: read a default identity file directly (`~/.ssh/id_ed25519`, `id_ecdsa`, `id_rsa`, first match) and pass it as `privateKey`, matching a plain `ssh` client with no agent. Only if none exist, fall back to an agent (`SSH_AUTH_SOCK` on Unix, `'pageant'` on Windows). A per-host `ssh_identity_file` overrides this (see above).
- 5s connect timeout, so a broken/missing key fails fast instead of hanging.
- **`SshTarget`**: all three `SSHClient` methods take one `{ host, user, port?, identityFile? }`. `Ssh2SSHClient.connectConfig()` is the one place it becomes ssh2 options, and `hostSshTarget(host)` (`targets.ts`) is the sole mapping from an inventory entry, so a new per-host connection setting is threaded through there only.
- **Null exit code**: the exec channel's `'close'` handler treats a `null` code (ssh2's "terminated by a signal"; the second arg is the signal name) as failure (`code: 1`, signal name in `stderr` if nothing else was captured), never `0`.
- **Stdin closed**: the channel's stdin is closed (`stream.end()`) right after it opens, so a remote command that reads stdin with nothing feeding it fails fast on EOF instead of hanging forever (e.g. app scripts like `paperless-gpt`/`paperless-ngx` with their own `read -p` prompts outside the unattended-mode flags). Exception: supplying `onStdinReady` keeps stdin open with a pty (the web prompt relay; see `src/web/jobs/CLAUDE.md`).
- `execInteractive()` pipes a real remote pty for the CLI's interactive `install-app`; see `src/commands/provisioning/CLAUDE.md`.

### phantom-success: why a null exit code is a failure

A signal-killed remote process once reported `code: null`, the old `code ?? 0` turned it into success, and `install-app` wrote a phantom guest into inventory and pushed a proxy route for a container that never existed.

## Machine ID (MID)

`resolveMid` in `targets.ts`, used by `create-lxc`/`create-vm`/`install-app`. One operator-chosen integer (1-254), `--mid`, derives the VMID and the guest's IP/gateway from the host's `midScheme` (`{ vmidBase, ipPrefix, cidrSuffix?, gateway }`, `cidrSuffix` default 16). Example: `vmidBase: 4000, ipPrefix: "192.168.1."` + MID 4 -> VMID `4004`, IP `192.168.1.4/16`.

- `resolveMid` does no collision checking. `create-lxc`/`create-vm` rely on Proxmox rejecting a reused VMID; `install-app` pre-checks the VMID itself (see `src/commands/provisioning/CLAUDE.md`).
- Uncaught collision: a `--mid` equal to the host's own last octet derives a guest IP identical to the host's own address. Nothing rejects a duplicate address; avoid that MID.
- `midScheme` is validated only when a command calls `resolveMid`, so hosts that never get MID treatment don't need one. Cross-host uniqueness is in `validateInventory` (above).

## Targeting and package managers

### `selectTargets` and `selectUpdateTargets`

`update-all` uses `--host <name>` / `--all` / `--group pve|lxc`, implemented by `selectTargets` (`targets.ts`). `update-all` never acts on a VM: `selectUpdateTargets` (`src/commands/maintenance/update-all.ts`) is the one place its targets are decided, and both `runUpdateAll` and the `update-all` operation's `preview` (`src/operations/maintenance.ts`) call it, so preview and apply can't disagree.

- `{ all: true }` silently drops every `vm` guest (hosts and lxc only).
- `{ group: 'vm' }` and `{ host: <vm-name> }` are explicit VM requests and reject: `update-all does not update VMs...`.
- Every other selector delegates to `selectTargets`, including its unknown-host error.
- `TargetSelector.group` still accepts `'vm'` (other callers use the full type) and the CLI's `--group` accepts any string; the runtime check in `selectUpdateTargets` is what rejects `vm`. The web/MCP operation's `group` is `z.enum(['pve', 'lxc'])`, rejecting `vm` at parse time.

### Package-manager detection (`package-manager.ts`)

`PROBE_COMMAND` (a `command -v` chain) probes a target, and `detectPackageManager` runs it and classifies the result. `UPDATE_COMMANDS` covers `apt`/`dnf`/`apk`/`pacman`/`zypper`; `INSTALL_COMMANDS` is the same shape with install commands. Detection is runtime rather than an inventory field because Proxmox's `ostype` is a creation-time label (a generic `l26` for every VM), while `command -v` is ground truth and self-corrects.

Callers differ only in how they react to an unrecognized OS:

- `update-all` puts it in its own `failUnknownPm` bucket (not `failCommand`) and continues; like every failure bucket it fails the web job and sets CLI exit code 1.
- `configure-guest --packages` (single target) throws `UnknownPackageManagerError`.

`configure-guest --packages` also refuses a `vm` guest outright, before any remote call, in dry run and apply; a `--ssh-key` in the same invocation does not run either. `--ssh-key` alone still works against a VM. Its dry run makes one live probe so the preview names the exact manager and command; a `--ssh-key`-only dry run makes no remote calls. See `src/commands/maintenance/CLAUDE.md` and `src/commands/provisioning/CLAUDE.md`.

## Live TLS-backend probing (`tls-probe.ts`)

Issue #100. Augments the manual `insecureBackendTls` checkbox on two web paths. The checkbox stays authoritative for hosts, CLI usage, `proxyManual` entries, and any inconclusive probe; only a conclusive probe overrides it, and it always overwrites whatever value the same request submitted.

`probeInsecureBackendTls` runs `curl -s -o /dev/null --max-time 5 https://<ip>:<port>/` via `runRemote` on the guest's parent host (never the guest, so it never needs curl in the container). `interpretCurlExitCode`:

- `60`/`51` (untrusted/unverified cert) -> `'insecure'`;
- `0`/`35` (trusted, or no TLS on that port) -> `'trusted'`;
- anything else (refused, timeout, DNS, or a thrown SSH/exec error) -> `'inconclusive'`, never a final answer.

A thrown error stops the retry loop immediately (the SSH round trip itself failed, or the job was cancelled; retrying can't help). The function never throws, so callers treat its result as informational.

Call sites (see `src/web/CLAUDE.md`):

- `recordProvisionedGuest` (`src/web/routes/provisioning.ts`): ~3-minute budget (6 retries, 30s apart, one job-log line per attempt) when the entry has `ip`+`port`+non-empty `subdomains`. In practice only `install-app` (create-lxc/create-vm forms collect no `port`).
- Dashboard guest PATCH (`src/web/routes/dashboard.ts`): single shot, only when the edit changed `subdomains`/`port` and the entry isn't `proxyManual`.

CLI usage is fully manual: no CLI command sets `port`+`subdomains` on a guest, so there's no hook point.

## Proxmox access for VM creators (`pve-acl.ts`)

Issue #53. The only module that maps a Bellhop user to a Proxmox user and reads/writes per-guest Proxmox ACLs; every remote call goes through `runRemote` against a `pve` host. Exports and exact message text: `specs/016-pve-creator-acl/contracts/pve-acl.md`.

### `grantCreatorAccess`

Off entirely unless `pveUserRealm` is set. Called from `create-vm`'s operation `apply()` (`src/operations/provisioning.ts`) in a `finally` around `recordProvisionedGuest`, not sequenced after it: once `runCreateVm` succeeded the VM exists, so the grant is attempted even if recording or pushing subdomains fails. It never throws (every outcome is a logged line and return value), so it can't mask `recordProvisionedGuest`'s error.

The person comes from `OperationDeps.actor` (`Actor | undefined`, `src/operations/types.ts`), set only by the provisioning router's `deps()` via `resolveActor(req)` (`src/web/impersonation.ts`). Same real-user rule as `resolveTriggeredBy` (`req.realUser ?? req.user`, so an impersonating admin's grant goes to their real account), but `undefined` for the synthetic local operator (`localOperator: true`), who has no Proxmox account. CLI and MCP (`create_vm`) never set `actor`; the `no-actor` branch reports "nothing to grant to" in one informational line for all those cases.

### Host-side filtering

`buildRealmReadCommand` (realm config) and `buildGuestAclReadCommand` (guest ACLs) filter output on the Proxmox host itself with an inline `perl -MJSON::PP` program rather than returning raw `pvesh` JSON. A realm's config carries its OIDC client secret (`client-key`) in clear text and the cluster ACL list carries everyone's user IDs, and every `exec` in a web/MCP job streams stdout into the job log (`JobSSHClient.exec`'s `onChunk`), so filtering must happen before capture. Node re-validates with zod and re-filters with `aclsForVmid`, so a misbehaving host-side filter can't widen what a migration copies.

### `copyGuestAcls` and destroy

`migrate-guest` calls `copyGuestAcls` unconditionally (not gated on `pveUserRealm`; it copies whatever permissions exist on the old VMID, creator grant or hand-added) after the new guest is verified running and before the original is destroyed, because destroying removes that VMID's permissions.

Destroy needs no ACL cleanup: Proxmox's `PVE::AccessControl::remove_vm_access`, called by both VM and container destroy regardless of `--purge`, deletes every permission on the VMID (verified in Proxmox VE 9.2.10 source). A reused VMID never inherits old grants. Known limitation: the same destroy drops pool membership and `copyGuestAcls` doesn't recreate it, so a pooled guest must be re-added by hand after migration (`docs/proxmox-access.md`).

No single-operator assumption: `pveUserRealm`/`pveCreatorRole` are optional per-deployment settings, and realm/role names come from Proxmox or the operator.

## Settings store

Issue #64. Files: `settings-defs.ts`, `config.ts`, `config-import.ts`, `live-client.ts`, `github.ts`. One store for every integration value that used to live only in `data/authentik.env`/`data/cloudflare-api.env`/`data/nginx-proxy-manager.env`, so an admin changes any of them without a shell or restart. The secrets-never-leave rule is in the root `CLAUDE.md`; the Settings page and its PATCH guards are in `src/web/CLAUDE.md` and `web-client/CLAUDE.md`.

### Definitions (`settings-defs.ts`)

A leaf module: it imports nothing from `inventory.ts`, which would close an import cycle through `authentik-config.ts`. Holds `MovedSettingsSchema`, `SecretSettingsSchema`, and `SETTING_DEFS` (per key: env var name, Settings-page group, secret flag, source `data/*.env` file). Secrets: `authentikApiToken`, `cloudflareDnsApiToken`, `npmApiPassword`, `githubApiToken`, stored in `secret_settings`, never read by `loadInventory`, so a secret is never on `Inventory` and can't reach anything that serializes it (status page, `/api/inventory`, snapshots). Only `writeSecret`/`clearSecret` and the one-time import write it.

### The accessor (`config.ts`)

Every consumer reads a moved value or secret through it at the point of use, never once at startup.

- `configValue(key, env = process.env)` returns `{ value?, source: 'environment' | 'settings' | 'none' }`: env var (set and non-empty) first, then stored value, then nothing (the consumer applies its own default; `authentikConfig()` and `npm-client.ts` keep theirs).
- `effectiveValue` is that rule as a pure function, shared with the #158 migration.
- `configValueAt(path, ...)` reads an explicit database (`/api/settings` uses it).
- A stored value is re-validated on read; a malformed one throws naming the key and its variable, never the value.
- **Snapshot**: the stored half is cached per process, keyed by database path, with a 2 s TTL (`CONFIG_SNAPSHOT_TTL_MS`). Opening `bellhop.db` read-only costs ~7 ms and `authentikConfig()` runs several times per request; a long-lived connection would hold the file open on Windows. Invalidated at the start of every `/api` request (next to `refreshInventory` in `src/web/app.ts`) and by every in-process write (`saveInventory`, `writeSecret`/`clearSecret`, the import). A web save is visible on the next request; a CLI/MCP write on the web service's next request.
- Each entry point (`src/cli.ts`, `src/web/server.ts`, `src/mcp/server.ts`, `scripts/windows-service.ts`) registers its database once with `useConfigStore(path)` via `importEnvFilesAndUseStore`. With none registered (`useConfigStore(null)`, every test that doesn't opt in) the accessor reads the environment only, the pre-#64 behavior; that is why tests passing their own `env` object needed no change.

### One-time import (`config-import.ts`)

`importEnvFiles` runs after the entry point's dotenv loads. It `dotenv.parse`s each file directly (a real env var is an override, never an import source) and stores every valid value whose key has no stored value yet (`ON CONFLICT DO NOTHING`, so it never overwrites, and a second start imports nothing). Invalid values are skipped with a warning. It logs key names only, never touches the files, and does nothing before the database exists.

A file left in place is still dotenv-loaded, so it keeps overriding, and the Settings page shows its fields as "set by environment" until it's deleted *and the process restarts* (dotenv values stay in the running process's environment). Each pinned field shows its "Stored copy" (`environment[key].stored`, plus `storedValue` for a non-secret), which is how an operator confirms the import before deleting a file. On a production deployment, confirm **Web UI sign-in** shows "Stored copy: authentik" before deleting `data/authentik.env`. Upgrade order: check the stored copies, delete the files, restart the web service and any long-running MCP server.

### `withFreshSettings`

A command that loads the inventory, awaits something slow, then saves (`sync-inventory --apply`, `set-guest-vpn`, the Dashboard guest edit) saves through `withFreshSettings` (`inventory.ts`), which takes every setting from the database as it is now, so a settings save that landed meanwhile isn't reverted by the stale copy.

### Live clients (`live-client.ts`)

`buildAuthentikClient()`/`buildCloudflareClient()` return a `liveClient(build)` Proxy that rebuilds the real-or-unconfigured client from current config on every property access, so a client built once by the web service or MCP server follows a later save (`isConfigured()` included).

### GitHub headers (`github.ts`)

`githubApiHeaders(extra?)` builds headers for every `api.github.com` request (`app-source.ts`'s `resolveHeadSha`/`compareBranch`, `app-update-check.ts`, `script-catalog.ts`), adding `Authorization: Bearer <githubApiToken>` only when that secret (or `GITHUB_API_TOKEN`) is set. `githubUnauthorizedError` turns a 401 into an error naming the setting and the Settings page. `raw.githubusercontent.com` reads stay anonymous.

### Secret input and write rules

- `set-config` takes a secret only from `--stdin` or a no-echo prompt (`secret-input.ts`) and refuses it as an argument. The MCP `set_config` tool's key enum lists non-secret keys only.
- A web write to a key pinned by the environment is refused naming the variable. The CLI stores it and warns, since its environment isn't necessarily the service's.

### Single-operator assumptions

- Removed: the "no GitHub token setting" assumption, and the need to hand-write `data/*.env` files on the deployment host.
- Kept by design: secrets are plain text in `bellhop.db`, as they were in the `.env` files. Write-only means never returned, not encrypted at rest; every copy or backup of the database carries them.
