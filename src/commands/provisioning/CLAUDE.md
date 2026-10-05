# Provisioning commands

Commands that create, move, mount storage into, or install apps onto guests: `attach-nfs-mount`, `migrate-nfs-mount`, `migrate-guest`, `install-app` (and `update-app`, in `src/commands/maintenance/`), `deploy-vpn-gateway`.

See also: `src/lib/CLAUDE.md` (`resolveMid`, package-manager detection, `pve-acl.ts`); `src/web/jobs/CLAUDE.md` (prompt relay/detection); `src/operations/CLAUDE.md` (pin-once source via `previewAndEnqueue`/`resolvesApp`); `src/web/CLAUDE.md` (`/api/provisioning` inventory upsert, `syncProxyLive`).

## NFS: host-relay bind-mounts

The only NAS pattern: the guest never runs `mount -t nfs`; the parent host mounts a Proxmox `nfs:` storage and binds it in with `pct set <vmid> -mpN ...`. Shared logic: `src/lib/nfs.ts`.

### `attach-nfs-mount`

The only way to give an *existing* lxc guest a mount (`create-lxc`/`install-app` offer the same at creation via `--nfs-storage`/`--nfs-mount-point`).

- `--mount-point` is required (no fstab mount to discover).
- Refuses if the guest already has an `mpN` at that exact path. `existingMountPoints()` scans `pct config <vmid>` for `,mp=<path>`, stopping at the next comma. Don't revert to the old bash `awk -F',mp=' '{print $2}'`: it captured trailing options (e.g. `,backup=0`) and silently missed duplicates.

### `migrate-nfs-mount`

Converts one guest from a direct guest-side NFS mount to a host-relay bind-mount on an existing `nfs:` storage; never touches storage config.

- Reads the *pre-migration* guest's fstab with `parseNfsLines` (`src/lib/nfs.ts`, the one remaining fstab-line parser).
- Refuses unless the `--storage`'s configured `export` (`pvesh get /storage/<id>`) matches what the guest mounts.
- The only command that targets two different `runRemote` names in one run: the guest (unmount, edit fstab) and its parent host (`pct set` a new `mpN` at the next free index from `pct config <vmid>`, never clobbering one; then `pct reboot`, a real brief outage).

### `--storage` note (both NFS commands)

Both resolve the target path via `pvesh get /storage/<id>`, so `--storage` must name a real Proxmox `nfs:` storage; as of 2026-07-28 only `nas-proxmox`. `nas-media`/`nas-immich` were moved *off* Proxmox-managed storage onto plain `/etc/fstab` host mounts (Proxmox's `nfs:` type forces a `content` type, e.g. `images`, and kept recreating a same-named junk directory at the share root), so neither command works with them; onboard a guest manually with `pct set <vmid> -mpN /mnt/pve/nas-media,mp=<path>` + `pct reboot`.

## `migrate-guest` (#96)

Moves an `lxc`/`vm` guest between hosts (`pve-node-a` <-> `pve-node-b`), renumbering VMID/IP per the target's `resolveMid`. Uses backup + restore under a new VMID, not `pct migrate`/`qm migrate`: VMIDs are cluster-wide unique and migrate can't change one within a cluster.

1. Pre-flight: a `vpnGateway` guest is refused (its IP is every dependent's `gw=`, and nothing reconciles them).
2. `vzdump <old-vmid> --storage <backup-storage> --mode stop --compress zstd` on the source. `--backup-storage` falls back to the `backupStorage` setting, throwing if neither is set; validated `active`/backup-capable/`nfs`-type on *both* hosts, since only cluster-shared storage is visible from both.
3. `--mode stop` restarts a previously running guest, so the source is re-checked and stopped again *before* restore, else both copies could run (and write the same NAS share).
4. `pct restore`/`qm restore` on the target into the `resolveMid` VMID; storage from `pickStorage` or `--storage`.
5. Network: rewrite only `ip=` in the restored `pct config`/`qm config` (`setNet0Ip`/`setIpconfig0Ip`, `src/lib/guest-vpn.ts`); a rebuilt net0 would drop `hwaddr=`/`tag=`. Never touch `gw=` (same on the flat LAN; resetting it would un-VPN a `set-guest-vpn` guest).
6. Start and verify "running" (small retry budget). **The safety gate**: on failure both guests stay, no rollback.
7. `copyGuestAcls` to the new VMID (unconditional, before destroy, which removes the old VMID's permissions; pool membership is not re-created). See `src/lib/CLAUDE.md` (pve-acl).
8. Destroy the old guest; delete the archive plus `.notes` and `.log` sidecars. `.log` *replaces* the `.tar.<ext>`/`.vma.<ext>` extension (`.notes` appends), so cleanup strips it before appending `.log`.

On success the inventory gets a `(host, vmid, ip)` rewrite keeping every other field (`subdomains`/`port`/`proxy`/`app`/`insecureBackendTls`/`authGroup`/`creator`/...). With `subdomains`, `sync-proxy` runs in the same `--apply`; failure only warns to retry `bellhop sync-proxy --apply`. `render-status-page` runs only when `statusPagePath` is set. `sync-authentik` is not run (keys off `authGroup`/subdomain, not IP); stale ACME TXT records are not pruned here.

Web UI: Provisioning-page form (Guest/Target Host/MID/Backup Storage/Storage), gated by the inline `isResourceAllowed` check like every `provisioning.ts` route, run as a normal job.

## `install-app` / `update-app`

`install-app.ts` and `src/commands/maintenance/update-app.ts` wrap community-scripts/ProxmoxVE `ct/<app>.sh` installers.

### VMID pre-check

First, dry run included: `checkVmidAvailable` (`pct status <vmid> || qm status <vmid>`) throws naming the conflicting guest, or generically if untracked or (web) not visible to the caller (#54, `canSeeGuest`). Else `build.func` silently picks a free VMID but keeps the stale IP in `var_net` (#53).

### Unattended mode

Targets a `pve` host, derives `var_ctid`/`var_net`/`var_gateway` from `resolveMid`, sets `var_*` env vars, and runs `bash -c "$(curl -fsSL <app-url>)"`. Also needed:

- `export TERM=xterm`: `misc/build.func` calls `clear`, which fails without `TERM` over `pct exec`.
- `export mode=default`: `install_script()` otherwise shows a "Default Install / Advanced Install" whiptail menu with no tty check and hangs.
- `var_template_storage`/`var_container_storage` (from `pickStorage`): otherwise a "Which storage pool?" menu hangs the same way.
- `PHS_SILENT=1`: build.func's headless flag for its other prompts (OS mismatch, addon updates).
- Backstop: `Ssh2SSHClient.exec()` closes stdin at once, so an app-level `read -rp` (confirmed: `paperless-gpt`, `paperless-ngx`) fails on EOF instead of hanging.

### `pickStorage`

`pickStorage(host, contentTypes)` (`src/lib/storage.ts`; also `create-lxc`/`create-vm`/`migrate-guest`) returns the first *active* storage with one of the types: `['vztmpl']` for `var_template_storage`, `['rootdir', 'images']` for `var_container_storage`. Throws naming the host if none qualify, even in dry run (a preview with no storage vars set would mislead). No hardcoded fallback: hosts differ (`pve-node-b` lacks `pve-node-a`'s `local-lvm` name/content combo).

Web UI: host-aware `select-storage` dropdowns (`storageContentTypes`; see `web-client/CLAUDE.md`) for `install-app` Template/Container Storage, `create-lxc` Storage, `create-vm` Disk Storage, `deploy-vpn-gateway` Storage, filled from the host's `storages[]` and re-filtered on host change; unset falls back to `pickStorage` server-side, as the CLI (no `--storage` flags) does.

### Authorized keys

`create-lxc`/`install-app` push the host's own `~/.ssh/authorized_keys` (the toolkit already assumes passwordless key auth to every Proxmox host, so it is exactly the keys already trusted) into each new guest (`readHostAuthorizedKeys`, `src/lib/authorized-keys.ts`), read live even in dry run so preview matches apply.

- `create-lxc`: follow-up `pct exec` (`buildAuthorizedKeysWriteScript`) after `pct create`; failure *warns, doesn't fail* (like a failed NFS attach).
- `install-app`: `var_ssh=yes`/`var_ssh_authorized_key=<keys>` for community-scripts' `install_ssh_keys_into_ct()` (`var_ssh=no`, no key line, if the host has none). Accepted asymmetry, not a bug: that function returns 252 on a failed `pct exec`/`pct push` where `set -e` may be active, so a failed push **can abort the install** — the cost of reusing its tested logic.
- Both log a sample `ssh root@<ip>` on successful apply regardless.

### Interactive CLI install

With `--apply` on a TTY (`process.stdin.isTTY`), the CLI action (`src/cli.ts`) uses `SSHClient.execInteractive()`: a real remote pty, so app prompts (e.g. `paperless-gpt` URL/API token, `paperless-ngx` Adminer, #52) are answerable with no detection heuristic. Ctrl+C is intercepted locally (not forwarded), cancels the connection, and warns the vmid may be partially created.

Never on the web (`opts.interactive` unset; `JobSSHClient` rejects `execInteractive()`), which relays prompts (`watchForPrompts`, `install-app` only), pre-scanning `install/<slug>-install.sh` (`ct/<slug>.sh`'s `read` prompts are in `update_script()`).

### `update-app`

Re-runs the *same* `ct/<app>.sh` *inside* an existing guest via `runRemote`'s `pct`/`qm` path, which triggers `update_script()`. Exports `TERM`/`PHS_SILENT`, not `mode` (only `install_script()` reads it). Outer wrapper `sh -c` like every guest command; inner `bash` is required by community-scripts.

Neither CLI path touches `inventory/bellhop.db` (`sync-inventory` picks up new guests); the web route's immediate upsert is the exception (see `src/web/CLAUDE.md`).

## Script catalog (#131)

The web App field suggests slugs from a cached catalog of every `ct/<slug>.sh` (`src/lib/script-catalog.ts`, `GET /api/provisioning/install-app/apps`, `web-client/src/components/AppCheckInput.tsx`), grouped `ProxmoxVE (stable)` above `ProxmoxVED (development)`.

- Free text stays valid (pasted URL: `resolveAppUrl`'s `includes('://')`); any failure degrades to a plain input.
- Slugs only (no upstream metadata exists).
- A slug in both repos lists under stable only (`checkAppUrl` and the apply curl resolve it there).
- Stored in `script_catalog`/`script_catalog_meta`, outside `saveInventory`'s replace; refreshed on read past `CATALOG_MAX_AGE_MS` (24h), no manual refresh or timer. CLI `install-app --app` doesn't use it.

### Custom group

With `customScriptsRepo`/`customScriptsBranch` set, `getScriptCatalog` adds a first group labelled `owner/repo@branch` with **only apps the branch changes** (`resolveHeadSha` + `compareBranch`, as in `resolveAppSource`, not the fork's whole `ct/`), plus `conflicts` (flagged by `detectConflict`). Shared slugs are removed from `stable`/`dev` and annotated with the upstream repo(s) they shadow (`withCustomGroup`). Fork-only apps aren't listed but still resolve when typed.

- `customCatalogCache`, keyed by that label (so a settings change never serves a stale listing), is **in-memory only** (`CUSTOM_CATALOG_MAX_AGE_MS` = 5 min, short so a push to the branch shows up soon); persisting would need a `script_catalog.repo` `CHECK` table rebuild for no gain.
- A failed custom fetch (network, private/missing repo, half-set settings) omits the group, warns, and starts `getUpstreamCatalog`'s failure cooldown.

## Custom script source resolution (#11, #15)

A bare `--app` slug resolves via `resolveAppSource(app, inventory, fetchImpl)` (`src/lib/app-source.ts`). Without custom settings: plain upstream, no extra call. The settings' both-or-neither rule is enforced here (`customScriptSource()`), not in the schema. With both:

1. `resolveHeadSha` pins the branch head (`Accept: application/vnd.github.sha`: no JSON, handles `/` in branch names).
2. `compareBranch`: `GET /repos/community-scripts/ProxmoxVED/compare/main...<owner>:<repo>:<sha>`, head = *pinned commit*, since a branch-name head for a nonexistent repo is answered from another fork (`status: identical`); a commit outside the network 404s.
3. `changedSlugsFromFiles`: `ct/<slug>.sh` or `install/<slug>-install.sh`, any status but `removed`; a rename counts its new name only.
4. Order: changed slug -> `kind: 'custom'` at the pinned commit (`changed: true`); else probe both upstream `ct/` scripts (`probeUpstream`: present/absent/error) — hit *or error* -> `kind: 'upstream'` ("can't tell" prefers upstream over a stale inherited fork copy); else fork `ct/<slug>.sh` at the commit: 200 -> `kind: 'custom'` (`changed: false`), 404 -> upstream.
5. Conflicts, only for a changed slug with `behindBy > 0`: `detectConflict` reads the app's two scripts from upstream raw content at the merge base and `main`; any difference (a 404 on one side counts) sets `conflict: true`. Not a reverse compare (lists stop at 300 files; raw reads cost no quota). A failed read is logged as no conflict.
6. A compare list of 300+ files is a named error (a truncated set would send changed apps upstream).

Every thrown failure (unknown/private repo or branch, not a ProxmoxVED fork, GitHub error/rate limit, network) names both settings, points at `set-config` and the Settings page, and **never falls back to upstream**.

Single-operator assumption: upstream base fixed to `community-scripts/ProxmoxVED@main` (a VED-shaped fork).

### Generated script for a custom source

`buildInstallAppScript`/`buildUpdateAppScript`, when `source.kind === 'custom'`, curl `source.ctUrl` directly (no fallback) after exporting `COMMUNITY_SCRIPTS_URL=<source.scriptsBaseUrl>` (pinned commit's raw root, never the branch). That export is the whole mechanism: `community-scripts/core`'s `core/build.func` resolves `ct/…`/`install/…` against it and exports it into the container (pinning `/usr/bin/update`); without it a fork's `install/<slug>-install.sh` comes from upstream or 404s.

Known limitation (`docs/configuration.md`): the in-container `/usr/bin/update` asks community-scripts.org whether an update exists, which knows nothing of fork-only apps.

### Source notice

`formatSourceNotice(source)` is the first line `runInstallApp`/`runUpdateApp` emit (before `resolveMid`/`checkVmidAvailable` or `runRemote`): `logWarn` to rebase on conflict, `logInfo` when a changed app replaces an upstream copy, else nothing. The CLI's dry run and `--apply` resolve independently (web/MCP pin once).

## `deploy-vpn-gateway`

### bash exception

Uses its own `pct exec <vmid> -- bash -c '...'` (Debian container, `apt-get`); see root CLAUDE.md (POSIX sh rule).

### Credentials

CLI: `NORDVPN_ACCESS_TOKEN` / `PIA_USERNAME`/`PIA_PASSWORD` from `process.env` only (no flags). `deploy-vpn-gateway.ts`'s `accessToken`/`piaUsername`/`piaPassword` options override `process.env` (like its `storage` option).

The web service (`src/web/server.ts`) has no such env; its form (VPN Provider/Host/MID/Name/Storage) has Access Token (NordVPN) or Username/Password (PIA), toggled by `FieldDef.showIf`, masked by `kind: 'secret'`, `required: true` in `src/web/commands-meta.ts`.

- `required` is declarative only, for every field that sets it, not just these three (nothing in `ProvisioningForm.tsx`/`FieldInput.tsx` or the route reads it); `deploy-vpn-gateway.ts`'s own check catches a blank credential, naming the form field and CLI env var.
- No credentials file/dotenv load.
- `src/web/routes/provisioning.ts` redacts `kind: 'secret'` fields to `'[redacted]'` before persisting the job body (never in jobs table/Job History).

### Multiple gateways

Same-provider gateways may coexist (no one-per-provider `validateInventory` rule), told apart by name: `deploy-vpn-gateway --name <guest-name>` or the form's Name (composed into `${vpn}-<identifier>-gw-lxc`). `set-guest-vpn --vpn <gateway-name|none>` and the Dashboard dropdown route by name.
