# Provisioning commands

Commands that create, move, mount storage into, or install apps onto Proxmox guests: `attach-nfs-mount`, `migrate-nfs-mount`, `migrate-guest`, `install-app` (plus `update-app`, which lives in `src/commands/maintenance/` but shares this machinery), and `deploy-vpn-gateway`.

Related elsewhere:

- See `src/lib/CLAUDE.md` (Machine ID / `resolveMid`, package-manager detection for `configure-guest --packages`, `pve-acl.ts` creator grant and `copyGuestAcls`, `script-catalog.ts`, `app-source.ts`).
- See `src/web/jobs/CLAUDE.md` (web prompt relay and detection tiers).
- See `src/operations/CLAUDE.md` (pin-once app-source resolution via `previewAndEnqueue`/`resolvesApp`).
- See `src/web/CLAUDE.md` (`/api/provisioning` route inventory upsert and `syncProxyLive`).

## NFS: host-relay bind-mounts

Host-relay bind-mounts are the only supported NAS pattern: the guest never runs `mount -t nfs`. The parent host mounts a Proxmox `nfs:` storage and the guest gets it via `pct set <vmid> -mpN ...` on the *parent host*. Shared resolution/script-building logic lives in `src/lib/nfs.ts`.

### `attach-nfs-mount`

`attach-nfs-mount.ts` is the only way to give an *existing* lxc guest a mount. `create-lxc`/`install-app` offer the same bind-mount at creation time via `--nfs-storage`/`--nfs-mount-point`, sharing this logic.

- `--mount-point` is required (no existing fstab mount to discover it from, unlike `migrate-nfs-mount`).
- Refuses if the guest already has an `mpN` at that exact path. `existingMountPoints()` scans `pct config <vmid>` for `,mp=<path>`, stopping at the next comma. Do not "simplify" this to the old bash `awk -F',mp=' '{print $2}'`: that captured trailing options too (e.g. `,backup=0`) and silently missed duplicates.

### `migrate-nfs-mount`

`migrate-nfs-mount.ts` converts one guest at a time from a direct guest-side NFS mount to a host-relay bind-mount backed by an already-existing `nfs:` storage. It never creates or modifies storage config.

- Discovers the guest's current export/mount point with `parseNfsLines` (`src/lib/nfs.ts`, the one remaining fstab-line parser; it must read the *pre-migration* guest's fstab).
- Cross-validates the `--storage`'s configured `export` (`pvesh get /storage/<id>`) against what the guest actually mounts and refuses on any mismatch.
- Targets two `runRemote` names in one run: the guest (unmount, edit fstab) and its parent host (`pct set` a new `mpN` at the next free index found by scanning `pct config <vmid>`, so an existing bind-mount is never clobbered; then `pct reboot`, a real brief outage).

### `--storage` note (both NFS commands)

Both commands resolve the target path via `pvesh get /storage/<id>`, so `--storage` must name a real Proxmox `nfs:` storage entry. As of 2026-07-28 that is only `nas-proxmox`. `nas-media`/`nas-immich` were deliberately moved *off* Proxmox-managed storage onto plain `/etc/fstab` host mounts, because Proxmox's `nfs:` type forces a `content` type (e.g. `images`) and kept auto-recreating a same-named junk directory at the share root. So neither command works with `--storage nas-media`/`nas-immich`; onboarding a guest onto those shares needs a manual `pct set <vmid> -mpN /mnt/pve/nas-media,mp=<path>` + `pct reboot`.

## `migrate-guest` (#96)

`migrate-guest.ts` moves an `lxc`/`vm` guest between Proxmox hosts (`pve-node-a` <-> `pve-node-b`), renumbering VMID/IP per the target host's `resolveMid`. It uses backup + restore under a new explicit VMID, not `pct migrate`/`qm migrate`: VMIDs are unique cluster-wide, and Proxmox's migrate commands can't change a VMID within a cluster.

Pipeline:

1. Pre-flight: a guest flagged `vpnGateway` is refused outright. Migrating it would change the IP every guest routed through it uses as `gw=`, and nothing here reconciles those dependents.
2. `vzdump <old-vmid> --storage <backup-storage> --mode stop --compress zstd` on the source. `--backup-storage` falls back to the `backupStorage` setting and throws if neither is set. It is validated `active`/backup-capable/`nfs`-type on *both* hosts (same as `migrate-nfs-mount`'s `--storage`), since only cluster-shared storage is visible from both sides.
3. `vzdump --mode stop` restarts a guest that was running before the backup, so the source is re-checked and stopped again right after the backup, *before* restore. Otherwise both copies could run at once (and both write the same NAS share via a bind-mount).
4. `pct restore`/`qm restore` on the target into the `resolveMid`-derived VMID, storage from `pickStorage` or a `--storage` override.
5. Network reconfig is read-then-surgically-rewrite: read the restored guest's `pct config`/`qm config` and rewrite only `ip=` via `setNet0Ip`/`setIpconfig0Ip` (`src/lib/guest-vpn.ts`, siblings of `setNet0Gateway`). A rebuilt net0 string would drop `hwaddr=`/`tag=`/etc. It never touches `gw=`: `resolveMid` returns the same gateway on the single flat LAN, and resetting `gw=` would silently un-VPN a guest routed via `set-guest-vpn`.
6. Start and verify "running" on the target (small retry budget, same convention as the TLS-probe retry). **This is the safety gate**: on failure the old guest stays intact and the new unverified one stays for debugging; no automatic rollback.
7. Copy Proxmox ACLs to the new VMID (`copyGuestAcls`, unconditional, before destroy, since destroy removes the old VMID's permissions; pool membership is not re-created). See `src/lib/CLAUDE.md` (pve-acl).
8. Destroy the old guest; delete the backup archive and its `.notes` and `.log` sidecars. vzdump's `.log` *replaces* the `.tar.<ext>`/`.vma.<ext>` extension (whereas `.notes` appends), so cleanup strips that suffix before appending `.log`.

On success, `inventory/bellhop.db` is updated in place (`(host, vmid, ip)` rewrite preserving `subdomains`/`port`/`proxy`/`app`/`insecureBackendTls`/`authGroup`/`creator`/etc.). If the guest has `subdomains`, `sync-proxy` runs in the same `--apply`; a failure there only warns (the migration already happened) and says to retry `bellhop sync-proxy --apply`. `render-status-page` runs too, only when `statusPagePath` is set. `sync-authentik` is deliberately not run (it keys off `authGroup`/subdomain, never IP). Stale ACME TXT records are not pruned on this path.

Web UI: a Provisioning-page form (Guest/Target Host/MID/Backup Storage/Storage), gated by the same inline `isResourceAllowed` check as every route in `provisioning.ts`, run as a normal job.

## `install-app` / `update-app`

`install-app.ts` and `src/commands/maintenance/update-app.ts` wrap community-scripts/ProxmoxVE `ct/<app>.sh` one-line installers.

### VMID pre-check

Before anything else (dry run included), `install-app` runs `checkVmidAvailable` (`pct status <vmid> || qm status <vmid>`, since either guest type may hold it). It throws naming the conflicting inventory guest, or a generic message if the VMID is live but untracked or (on the web) held by a guest the caller can't see (#54; `canSeeGuest` drops the name). Without it, community-scripts' `build.func` silently reassigns a free VMID while keeping the stale IP in `var_net` (#53).

### Unattended mode

`install-app` targets a `pve` host, derives `var_ctid`/`var_net`/`var_gateway` from `resolveMid`, sets community-scripts `var_*` env vars, and runs `bash -c "$(curl -fsSL <app-url>)"`. The `var_*` overrides alone are not enough:

- `export TERM=xterm`: `misc/build.func` calls `clear`, which fails with no `TERM` over non-interactive `pct exec`.
- `export mode=default`: `install_script()` shows a whiptail "Default Install / Advanced Install" menu when `$mode` is unset, with no tty check, so it hangs forever.
- `var_template_storage`/`var_container_storage`: otherwise a "Which storage pool?" whiptail menu hangs the same way. Filled by `pickStorage`.
- `PHS_SILENT=1`: build.func's documented headless flag for its other prompts (OS mismatch, addon updates).
- Backstop: the exec channel's stdin is closed immediately (`Ssh2SSHClient.exec()`), so an app-level `read -rp` prompt none of these flags reach (confirmed: `paperless-gpt`, `paperless-ngx`) fails on EOF instead of hanging.

### `pickStorage`

`pickStorage(host, contentTypes)` (`src/lib/storage.ts`, also used by `create-lxc`/`create-vm`/`migrate-guest`) picks the first *active* storage supporting one of the content types: `['vztmpl']` for `var_template_storage`, `['rootdir', 'images']` for `var_container_storage`. It throws naming the host if none qualify, even in a dry-run preview (a preview without storage vars would be misleading). There's no hardcoded fallback because hosts differ (`pve-node-b` lacks `pve-node-a`'s `local-lvm` name/content combo).

Web UI exposes these as host-aware `select-storage` dropdowns (`storageContentTypes` on the field def; see `web-client/CLAUDE.md`): `install-app` Template/Container Storage, `create-lxc` Storage, `create-vm` Disk Storage, and `deploy-vpn-gateway` Storage. They populate from the selected host's `storages[]`, re-filter and re-select a default on host change (like Bridge), and fall back to `pickStorage` server-side when unset, so the CLI (no `--storage` flags on these) is unchanged.

### Authorized keys

`create-lxc` and `install-app` push the target host's own `~/.ssh/authorized_keys` into every new guest (`readHostAuthorizedKeys`, `src/lib/authorized-keys.ts`; those keys are already trusted to reach the host). This makes one live SSH read during dry run too, so the preview matches apply.

- `create-lxc`: follow-up `pct exec` (`buildAuthorizedKeysWriteScript`) after `pct create`. A missing/failed push *warns and does not fail* the command (the guest exists; same precedent as a failed NFS attach).
- `install-app`: sets `var_ssh=yes`/`var_ssh_authorized_key=<keys>`, consumed by community-scripts' `install_ssh_keys_into_ct()` (`var_ssh=no` and no key line when the host has none). Known, accepted asymmetry: that function returns 252 on a failed `pct exec`/`pct push` where `set -e` may be active, so a failed key push **can abort the whole install**. Not a bug to fix; it's the cost of reusing community-scripts' tested logic.
- Both log a sample `ssh root@<ip>` on a successful apply regardless of the key step's outcome.

### Interactive CLI install

`install-app`'s CLI action (`src/cli.ts`) uses `SSHClient.execInteractive()` (`src/lib/ssh-client.ts`) whenever `--apply` runs on a TTY (`process.stdin.isTTY`): a real remote pty carries the installer's stdin/stdout live, so app-specific prompts (e.g. `paperless-gpt`'s URL/API-token, `paperless-ngx`'s Adminer prompt, #52) are answerable. No prompt detection is involved. Ctrl+C is intercepted locally (never forwarded), cancels the connection, and warns that the vmid may be partially created.

The web UI never uses this: `runInstallApp`'s `opts.interactive` stays unset, and `JobSSHClient` rejects `execInteractive()` outright. Instead the web UI relays app prompts to the operator (`watchForPrompts`, set for `install-app` only), and pre-scans the app's `install/<slug>-install.sh` (not `ct/<slug>.sh`, whose `read` prompts sit in `update_script()`) for expected prompt text. See `src/web/jobs/CLAUDE.md` for detection tiers, `OutputActivity`, and the pre-scan's gaps.

### `update-app`

`update-app` targets an existing guest and re-runs the *same* `ct/<app>.sh` command *inside* it through `runRemote`'s `pct`/`qm` path; that is how these scripts' `update_script()` is triggered. It exports `TERM`/`PHS_SILENT` but not `mode` (only `install_script()` reads it). The outer wrapper is `sh -c` like every guest command; the inner `bash` is deliberate because community-scripts require it.

Neither command's CLI path touches `inventory/bellhop.db`; `sync-inventory` picks up a new guest. The web route's immediate upsert is the exception: see `src/web/CLAUDE.md`.

## Script catalog (#131)

The web UI's App field suggests slugs from a cached catalog of every community-scripts `ct/<slug>.sh` (`src/lib/script-catalog.ts`), served by `GET /api/provisioning/install-app/apps` and rendered by `web-client/src/components/AppCheckInput.tsx`, grouped `ProxmoxVE (stable)` above `ProxmoxVED (development)`.

- The field stays free text: a pasted full script URL still works (`resolveAppUrl`'s `includes('://')` branch). The catalog is a suggestion only; every failure (GitHub unreachable, nothing cached) degrades to a plain text input.
- Slugs only: community-scripts publishes no machine-readable metadata (no descriptions/categories/icons).
- A slug in both repos is listed under stable only, since `checkAppUrl` and the apply-time curl both resolve it to stable.
- Persisted in `script_catalog`/`script_catalog_meta` in `bellhop.db`, outside `saveInventory`'s delete-and-reinsert (so `sync-inventory --apply` never disturbs it). Refreshed on read when older than `CATALOG_MAX_AGE_MS` (24h). No manual refresh, no background timer. The CLI's `install-app --app` doesn't use it.

### Custom group

With `customScriptsRepo`/`customScriptsBranch` set, `getScriptCatalog` adds a first group labelled `owner/repo@branch` holding **only apps the branch changes** (`resolveHeadSha` + `compareBranch`, the same comparison as `resolveAppSource`, not the fork's whole `ct/` listing), plus `conflicts` (the subset `detectConflict` flags). Slugs it shares with `stable`/`dev` are removed from those and annotated with which upstream repo(s) they shadow (`withCustomGroup`). A fork-only app isn't listed, but typing its slug still resolves it.

- Its cache (`customCatalogCache`, keyed by the `owner/repo@branch` label so a settings change never serves a stale listing) is **in-memory only**, never in `script_catalog`, with `CUSTOM_CATALOG_MAX_AGE_MS` = 5 minutes so a push shows up soon. Persisting it would gain nothing and need a `script_catalog.repo` `CHECK`-constraint table rebuild.
- A failed custom fetch (network, private/missing repo, half-configured settings) omits the custom group for that call, logs a warning, and starts the same short failure cooldown `getUpstreamCatalog` uses; `stable`/`dev` still show.

## Custom script source resolution (#11, #15)

A bare `--app` slug for either command resolves through `resolveAppSource(app, inventory, fetchImpl)` (`src/lib/app-source.ts`). With no custom settings: plain upstream resolution, no extra network call. The both-or-neither rule for the two settings is enforced here (`customScriptSource()`), not in the schema.

With both set:

1. `resolveHeadSha` pins the branch to its head commit (bare-SHA request, `Accept: application/vnd.github.sha`: no JSON parsing, handles `/` in branch names).
2. `compareBranch`: `GET /repos/community-scripts/ProxmoxVED/compare/main...<owner>:<repo>:<sha>`. The head is the *pinned commit*, not the branch name, because a branch-name head whose repo doesn't exist was answered live from a different fork in the same network (`status: identical`, no error); a commit outside the fork network 404s instead.
3. `changedSlugsFromFiles`: `ct/<slug>.sh` or `install/<slug>-install.sh` with any status but `removed`; a rename counts only its new name.
4. Resolution order:
   - changed slug -> `kind: 'custom'` at the pinned commit (`changed: true`);
   - else probe both upstream `ct/` scripts (`probeUpstream`: present/absent/error). A hit *or an error* -> `kind: 'upstream'`, identical to the feature being off ("can't tell" prefers upstream over a possibly stale inherited fork copy);
   - else the fork's `ct/<slug>.sh` at the pinned commit: 200 -> fork-only `kind: 'custom'` (`changed: false`); 404 -> upstream.
5. Conflicts: only for a changed slug and only when `behindBy > 0`, `detectConflict` reads the app's two scripts from upstream ProxmoxVED raw content at the merge base and at `main`; any difference (a 404 on one side counts) sets `conflict: true`. Not a reverse compare, because compare lists stop at 300 files and upstream routinely moves further; raw reads cost no API quota. A failed read is logged and counts as no conflict.
6. A compare file list of 300+ files is a named error (a truncated changed set would silently send changed apps upstream).

Every thrown failure (unknown/private repo, unknown branch, not a ProxmoxVED fork, GitHub error status or rate limit, unreachable network) names `customScriptsRepo`/`customScriptsBranch`, points at `set-config` and the Settings page, and **never silently falls back to upstream**.

Single-operator assumption: the upstream base is fixed to `community-scripts/ProxmoxVED@main` (a VED-shaped fork).

### Generated script for a custom source

`buildInstallAppScript`/`buildUpdateAppScript` branch on `source.kind === 'custom'`: curl `source.ctUrl` directly (no upstream fallback; resolution confirmed it exists) and export `COMMUNITY_SCRIPTS_URL=<source.scriptsBaseUrl>` (the pinned commit's raw root, never the branch name) before the curl. This export is the whole mechanism: both upstream repos' `ct/` scripts run on `community-scripts/core`'s `core/build.func`, which resolves every non-engine path (`ct/…`, `install/…`) against `COMMUNITY_SCRIPTS_URL` and exports it into the container so `/usr/bin/update` stays pinned to the install/update commit. Without it, a fork app's `install/<slug>-install.sh` would come from upstream or 404.

Known limitations (inherent to reusing community-scripts' engine, documented in `docs/configuration.md`): the in-container `/usr/bin/update` helper asks community-scripts.org whether an app can be updated, which knows nothing of a fork-only app.

### Source notice

`formatSourceNotice(source)` builds the one notice line `runInstallApp`/`runUpdateApp` emit first (before `resolveMid`/`checkVmidAvailable` for install, before the update's `runRemote`), so it leads a dry run, a captured preview, and the job log: `logWarn` telling the operator to rebase when the source conflicts; `logInfo` when a changed app replaces an upstream copy; nothing for fork-only or upstream.

Pinning one commit across preview, prompt pre-scan and apply for web/MCP: see `src/operations/CLAUDE.md`. The CLI has no shared pin: its dry run and `--apply` each resolve independently, like its other live lookups.

## `deploy-vpn-gateway`

### bash exception

`deploy-vpn-gateway` builds its own `pct exec <vmid> -- bash -c '...'` calls rather than going through `runRemote`, and stays on bash (not the POSIX `sh` every other guest command must use; see root CLAUDE.md) because it creates its own Debian container and `apt-get install`s into it.

### Credentials

The CLI reads `NORDVPN_ACCESS_TOKEN` / `PIA_USERNAME`/`PIA_PASSWORD` from `process.env` only (no flags). `deploy-vpn-gateway.ts` accepts `accessToken`/`piaUsername`/`piaPassword` options that take priority over `process.env` (same override pattern as its `storage` option).

The web service has none of those env vars. A web deploy (Provisioning page's Deploy VPN Gateway form: VPN Provider/Host/MID/Name/Storage) takes them from the form: Access Token (NordVPN) or Username/Password (PIA), shown/hidden via `FieldDef.showIf` and masked via `kind: 'secret'`, marked `required: true` in `src/web/commands-meta.ts`.

- `required` is declarative only: nothing in `ProvisioningForm.tsx`/`FieldInput.tsx` or the route reads it (for any field). A blank credential is caught by `deploy-vpn-gateway.ts`'s own check, whose error names both the form field and the CLI env var.
- There is no credentials file and no dotenv load for these.
- `src/web/routes/provisioning.ts` redacts every `kind: 'secret'` field to `'[redacted]'` before the job's request body is persisted, so credentials never land in the jobs table or Job History.

### Multiple gateways

Several gateways of the same provider may coexist (no one-per-provider `validateInventory` rule). They are distinguished by name: `deploy-vpn-gateway --name <guest-name>` (CLI), or the form's Name field (a short identifier composed into `${vpn}-<identifier>-gw-lxc`). `set-guest-vpn --vpn <gateway-name|none>` and the Dashboard's VPN dropdown route by name, not provider.
