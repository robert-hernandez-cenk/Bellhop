# Commands

Every Bellhop command, grouped by what it does, with the details of how each one behaves.

All commands are run as `bellhop <command> [flags]` (after `npm link`)
or `npm run bellhop -- <command> [flags]`.

**Maintenance:**
```bash
bellhop update-all --host pve1
bellhop update-all --group lxc
bellhop update-all --all        # every host and every lxc guest; VMs are never updated
bellhop sync-inventory          # dry run: prints new/updated/removed guests
bellhop sync-inventory --apply  # writes inventory/bellhop.db's hosts[] and guests[]
bellhop update-app --guest plex --app plex --apply
bellhop check-app-updates          # dry run: prints each lxc app guest's installed vs. latest version
bellhop check-app-updates --apply  # saves the results so the Update page shows them
bellhop check-app-updates --guest plex --apply  # just one guest
bellhop guest-power --guest plex --state start --apply
bellhop guest-power --guest plex --state shutdown --apply
bellhop audit-nfs-mounts        # report NFS mounts across all lxc guests
bellhop audit-nfs-mounts --host plex-lxc  # just one guest
bellhop backfill-guest-creators          # dry run: prints guests it would attribute, and jobs it skips
bellhop backfill-guest-creators --apply  # records them
bellhop backfill-guest-creators --map old-login=test-user --apply  # attribute jobs recorded under a renamed login
bellhop set-config dnsServer 198.51.100.53 --apply  # set an inventory-wide or integration setting
bellhop set-config nfsServer --unset --apply         # clear one
printf '%s' "$TOKEN" | bellhop set-config githubApiToken --stdin --apply  # a secret, on standard input
```

`set-config <key> [value] [--stdin] [--unset] [--apply]` writes one
setting — any of the [inventory-wide
settings](configuration.md#inventory-wide-settings) or [integration
settings and secrets](configuration.md#integration-settings-and-secrets) —
validated by the same rules the web UI's Settings page uses. `--stdin`
reads the value from standard input instead of an argument, with one
trailing newline stripped. A secret (`authentikApiToken`,
`cloudflareDnsApiToken`, `npmApiPassword`, `githubApiToken`) is refused as
an argument: pipe it with `--stdin`, or leave the value off at a terminal
to be prompted without echo. The dry run never prints a secret's value.
When the key's environment variable is set in your own shell,
`set-config` still stores the value but warns that the variable overrides
it.

`update-all --group` only accepts `pve` or `lxc` (not `vm`), and `--host`
naming a VM guest fails with an error rather than doing nothing — this
toolkit's package update/install mechanism never acts on a VM at all;
update a VM's own packages from inside the VM itself.

`sync-inventory` queries every Proxmox host in inventory for its actual
LXC containers and VMs (via `pvesh`) and reconciles `guests[]` with
reality: existing entries keep their `name`/`subdomains`/`port`/`proxy` but
get `type`/`ip` refreshed; newly discovered guests are added (with no
`subdomains`/`port`/`proxy` — add those by hand); guests no longer present
on their host are removed. `--apply` writes the reconciled `hosts[]`/
`guests[]` back to `inventory/bellhop.db`, a SQLite database (see
`src/lib/CLAUDE.md`) — `domain` and `externalSites[]` are left untouched.

`check-app-updates` compares each `lxc` guest's installed community-scripts
app version against its latest stable GitHub release, the same way the
app's own install script would decide it — a stopped guest is reported
`not checked` without being contacted, an app whose script has no
recognizable release check is `unsupported`, and a release-service error
(including a rate limit) is reported for that guest alone without stopping
the rest of the run. `--guest <name>` checks just one guest and skips the
guest-status query; without it, every eligible guest is checked. Without
`--apply`, nothing is saved; with it, a full run replaces every saved
result and a `--guest` run replaces just that one, which is what the web
UI's Update page reads. The web service also runs this once a day on its
own — see [Web UI](web-ui.md) for the Tasks page that schedules it.

`audit-nfs-mounts` reads `pct config <vmid>` on each `lxc` guest's *parent
host* (or one guest via `--host`) and cross-references its host-relay
bind-mounts (`mpN` entries) against that host's known NFS-backed paths —
its discovered fstab mounts and any Proxmox-managed `nfs:` storage — to
report which NFS shares are in use where, grouped by export. It never reads
anything from inside the guest itself (there's no guest-side fstab NFS
mount left to read since `attach-nfs-mount`/`migrate-nfs-mount` moved every
guest onto host-relay bind-mounts). Read-only — it never modifies anything.

`backfill-guest-creators` is a one-time, CLI-only migration for the web
UI's [per-resource permissions](permissions.md): it records a creator on
every existing guest it can attribute from a successful web-UI
`create-lxc`/`create-vm`/`install-app`/`deploy-vpn-gateway` job in job
history, so a restricted user who already created a guest before creator
recording existed regains access without an admin editing an allow-list by
hand. Dry run by default, printing the plan and changing nothing;
`--apply` writes it. It matches a job to a guest by host, the VMID derived
from the job's recorded machine ID, and guest name all agreeing with a
guest currently in inventory — if several jobs match the same guest, the
most recent successful one wins, and a guest that already has a recorded
creator is never touched. The creator is recorded as of that job's start
time, so it covers that job and later ones on the guest. A job's recorded
login name is resolved against the identity provider's current user list
to attach its stable identifier alongside the name; pass
`--map <old>=<new>` (repeatable) when a job was recorded under a login name
since renamed — without a mapping, that job is
skipped and reported as `unknown-user`. Every skip is reported with a
reason (`unknown-user`, `no-matching-guest`, `already-has-creator`,
`unparseable-args`, or `superseded` by a newer matching job) so nothing is
silently dropped; with `--apply`, a guest that gained a creator or left the
inventory while the command ran is not written and is reported under the
skips instead. A job triggered by the MCP server, by the CLI, by the local
operator (the identity named by `WEB_UI_LOCAL_USER`, `local` by default), by
no recorded user, or that didn't succeed is never used. Requires Authentik
configured (its API URL and token settings) — without it, it fails with the same
"not configured" error the Users page gives, since a username-only record
would reintroduce the rename problem the stable identifier exists to
solve. See [Permissions](permissions.md) for what the recorded creator
actually grants.

**Provisioning** (all default to a dry run that prints the command without
running it — pass `--apply` to actually execute):
```bash
bellhop create-lxc --host pve1 --mid 4 --hostname new-ct --template local:vztmpl/debian-12-standard_12.2-1_amd64.tar.zst --apply
bellhop create-lxc --host pve1 --mid 4 --hostname new-ct --template local:vztmpl/debian-12-standard_12.2-1_amd64.tar.zst --nfs-storage nas-media --nfs-mount-point /mnt/media --apply
bellhop create-vm --host pve2 --mid 4 --name new-vm --cloud-init --apply
bellhop configure-guest --guest media --packages "curl vim" --apply
bellhop attach-nfs-mount --guest media --storage nas-media --mount-point /mnt/media --apply
bellhop install-app --host pve1 --mid 5 --app plex --hostname plex --apply
bellhop migrate-nfs-mount --guest plex-lxc --storage nas-media --apply
bellhop delete-guest --guest old-lxc --apply
bellhop delete-guest --guest old-lxc --backup --backup-storage nas-proxmox --apply
bellhop migrate-guest --guest media --to-host pve2 --apply
bellhop migrate-guest --guest media --to-host pve2 --mid 15 --backup-storage nas-proxmox --storage local-lvm --apply
```

`configure-guest --packages` detects the guest's own package manager
(apt/dnf/apk/pacman/zypper) and installs with it, rather than assuming
`apt-get` — even the dry run makes one live SSH call to the guest to show
the exact install command it would run (e.g. `[DRY RUN] Would install on
media (apk): apk update && apk add 'curl' 'vim'`). An unrecognized OS, a
failed probe, or a failed install all exit 1 rather than reporting success.
On Arch, the install runs `pacman -Syu`, so it also upgrades the whole
system alongside the requested packages — Arch supports no partial
upgrade. `--packages` is never sent to a VM guest — it fails immediately,
before any remote call, naming the guest; install packages inside the VM
itself instead. `--ssh-key` is unaffected by this and still works against
a VM.

`--mid <N>` (1-254) is required by `create-lxc`, `create-vm`, and
`install-app`. It derives both the VMID and the guest's IP/gateway from the
target host's `midScheme` in inventory: `vmid = midScheme.vmidBase + N`, `ip
= midScheme.ipPrefix + N` (masked `/midScheme.cidrSuffix`, defaulting to
`/16`), `gateway = midScheme.gateway`. `create-lxc`/`create-vm`
have no collision checking of their own — they rely on Proxmox's own
`pct create`/`qm create` rejecting an already-used VMID. `install-app` is
the exception: it hands the VMID to a third-party installer that doesn't
fail the same way, so it pre-checks the VMID itself before running that
installer and fails loudly on a collision. On `create-vm`, the derived IP
is applied via `--ipconfig0`, which only takes effect if the VM also has a
cloud-init drive — pass `--cloud-init` too if you need the IP to actually
apply. `create-lxc` always assigns this static IP; there is no DHCP option.

`create-lxc` and `install-app` both automatically add the target Proxmox
host's own SSH keys (`~/.ssh/authorized_keys`) to the new guest, so you can
reach it the same way you already reach the host — no separate `ssh-copy-id`
step needed. On a successful `--apply`, both print a sample `ssh root@<ip>`
command you can use to connect once the guest is up. If the host has no
keys to offer, guest creation still succeeds; you'll just need to add
access some other way.

`--cloud-init` only attaches an empty cloud-init drive (`--ide2
STORAGE:cloudinit`) to the new VM. It does not import or attach an actual OS
disk image — actually booting the VM requires separately importing a real
disk (e.g. via `qm importdisk`) and attaching it, which is out of scope for
this scaffold command.

After `create-lxc`/`create-vm` provisions a new guest, it must be added to
`inventory/bellhop.db` **manually** before `configure-guest`, `update-all`,
or `sync-proxy` can target it — the create commands only create the guest
on the Proxmox host, they don't touch the inventory database.

`attach-nfs-mount` is the way to give an *existing* guest NAS access —
there's no scripted direct-mount path anymore. `create-lxc`/`install-app`
also accept `--nfs-storage`/`--nfs-mount-point` to attach the same
host-relay bind-mount as an optional step at creation time, but
`attach-nfs-mount` is still how you add one to a guest that already exists.
It attaches an `lxc`
guest to an already-existing Proxmox `nfs:` storage entry (`pvesm add nfs
<id> --server ... --export ...`, created manually once per share, not per
guest — see the cluster note in `src/lib/CLAUDE.md`) via a host-relay bind-mount
(`pct set ... mpN`) on the guest's *parent host*; the guest itself never
mounts NFS directly. `--storage <id>` names that already-existing storage;
`--mount-point` is the absolute path inside the guest to bind-mount it at
(e.g. `/mnt/media`). Refuses to proceed if the guest already has a
bind-mount configured at that path. Restarts the guest to apply the new
mountpoint.

Because the mount happens on the Proxmox host rather than inside the
guest, **no NAS-side permission change is needed per guest** — the
NAS's per-host NFS rule only needs to allow the two Proxmox host IPs
(already true for any storage `migrate-nfs-mount` set up), not each
guest's IP individually. That per-guest-rule requirement only applied to
the old, now-removed direct-mount script.

`migrate-nfs-mount` converts a guest still using the old direct-mount
pattern onto the same host-relay bind-mount `attach-nfs-mount` uses for
new guests, once you've manually created the equivalent Proxmox `nfs:`
storage entry and updated the NAS's NFS rule to allow the two Proxmox
host IPs instead of the guest's — the same pattern already used for
`/volume1/Proxmox`.
`--storage <id>` names that already-existing storage; the guest's current
mount point is discovered from its own fstab and kept exactly as-is, only
the mechanism changes. Reboots the guest to apply the new mountpoint.

`install-app` creates a new LXC by running an unattended
[community-scripts](https://github.com/community-scripts/ProxmoxVE)
install script (`ct/<app>.sh`) — `--app plex` installs Plex, etc. It reuses
`--mid` the same way `create-lxc` does for the CTID/IP/gateway. After a
successful install, run `sync-inventory --apply` to add the new guest to
`inventory/bellhop.db`. To update an already-installed app later, use
`bellhop update-app --guest <name> --app <script-name> --apply`, which
re-runs the same community-script from inside the guest — that's how these
scripts' own update path is triggered (re-running the installer, not a
separate update command). If you've configured `customScriptsRepo`/
`customScriptsBranch` (see [Inventory-wide settings](configuration.md#inventory-wide-settings)), both commands
install the apps your fork branch actually changes from that branch, and
every other app from ProxmoxVE/ProxmoxVED exactly as before.

> **Caveat:** the unattended `install-app` mechanism (the `var_*` env
> vars) is verified against community-scripts' actual `misc/build.func`
> source. The `update-app` mechanism — re-running the installer *inside*
> the container to trigger its `update_script()` path — is confirmed
> **broken** for at least one real guest: `update-app --guest jellyfin-lxc
> --app jellyfin --apply` (2026-07-28) reported success but the guest's own
> logs showed the script exited instantly, because the container's OS
> (Ubuntu 22.04, built Dec 2024) doesn't match what the *current*
> `ct/jellyfin.sh` requires (24.04), and separately because `update-app`'s
> generated script never sets a `CTID` env var the script's update path
> expects. `update-app` itself used to silently report success regardless
> of the remote script's exit code — that part is now fixed (it prints
> stdout/stderr and sets a non-zero exit code on failure), so a repeat of
> this won't go unnoticed, but the underlying jellyfin-lxc failure is still
> unresolved.

`delete-guest` stops (if running), optionally backs up (`vzdump`, via
`--backup --backup-storage <id>` — the backup must succeed before
destroying), then destroys an `lxc`/`vm` guest on its parent host.
`--apply` now removes the destroyed guest from `inventory/bellhop.db`
itself, on both the CLI and web UI paths — no separate `sync-inventory`
run needed just to drop it from `guests[]`. The Dashboard's Delete button
in the web UI (see [Web UI](web-ui.md)) additionally re-syncs the reverse proxy and
reconciles Authentik automatically in the same action; the CLI path
doesn't do either, so if the deleted guest had `subdomains`/an `authGroup`
set, run `sync-proxy`/`sync-authentik` by hand afterward to drop the
now-gone guest's config there too.

`migrate-guest` moves an existing `lxc`/`vm` guest to the other Proxmox
host, renumbering its VMID/IP to match the target host's convention. It
works via backup (`vzdump`) and restore under the new VMID rather than
`pct migrate`/`qm migrate`, since VMIDs are unique cluster-wide and neither
migrate command can renumber a guest. The source guest is explicitly
re-checked and stopped again after the backup if `vzdump --mode stop`
restarted it, before restore begins on the target — closing the window
where both copies could otherwise run simultaneously. Only `ip=` is ever
rewritten on the restored guest's network config (`gw=`/`hwaddr=`/`tag=`/
etc. all survive untouched, and a guest routed through a VPN gateway keeps
its VPN routing); a guest itself flagged as a VPN gateway is refused
outright, since migrating it would silently orphan every guest routed
through it. Verification (the restored guest reporting "running" on the
target host) is the safety gate before the original guest is destroyed —
a verification failure leaves both the original guest and the unverified
new one in place for the operator to debug, with no automatic rollback.
`--storage` overrides the automatically-picked target guest storage; `--mid`
defaults to the current VMID's numeric suffix. `inventory/bellhop.db`
and (if the guest has subdomains) the live reverse-proxy config are
updated as part of the same `--apply`, no separate
`sync-inventory`/`sync-proxy` run needed. If that proxy update fails, the
migration still completes (the original guest is already gone by then) and
prints a warning with the error; fix the cause and run
`bellhop sync-proxy --apply`.

**Networking:**
```bash
bellhop sync-proxy          # dry run: prints the generated reverse-proxy configuration
bellhop sync-proxy --apply  # writes it and reloads the proxy
bellhop convert-caddyfile          # dry run: convert the proxy host's Caddyfile for the caddy-api driver
bellhop convert-caddyfile --apply  # load the converted configuration into Caddy (once, when switching)
bellhop render-status-page          # dry run: prints the generated status page HTML
bellhop render-status-page --apply  # writes it to the proxy host
bellhop sync-authentik          # dry run: prints Applications/OpenID clients to create/update/remove
bellhop sync-authentik --apply  # reconciles Authentik Proxy Providers, OpenID clients, and policy bindings
bellhop oidc-credentials media           # print an OIDC-gated entry's issuer, client ID, and client secret
bellhop adopt-oidc-client media          # dry run: preview adopting a hand-made OpenID client
bellhop adopt-oidc-client media --apply  # adopt it as Bellhop-managed, without rotating its credentials
```

`convert-caddyfile` is the one-time step for switching from the Caddy
driver to the [Caddy admin-API driver](reverse-proxy/caddy-api.md#switching-from-the-caddy-driver):
it converts the Caddyfile (minus Bellhop's managed section) with `caddy
adapt`, adds the inventory's routes as Bellhop-tagged ones, and loads the
result into the running Caddy. It refuses to run once Caddy already holds
Bellhop objects.

`render-status-page` regenerates a static, LAN-only status page (a YAML
snapshot of the inventory plus the actual deployed proxy configuration, both
fetched fresh) on whichever host is flagged `proxy: true`. It's a manual,
on-demand command on the CLI side — the web UI calls it automatically
after any change that touches the reverse proxy (see [Web UI](web-ui.md)).
The inventory snapshot it shows includes the non-secret integration
settings (the Authentik URL and group names, the Nginx Proxy Manager
email, the sign-in mode and the rest), but never a secret.

`sync-authentik` reconciles Authentik Proxy Providers, OpenID (OAuth2)
clients, Applications, policy bindings, and embedded-outpost membership
against every inventory entry that has an `authGroup` set — the same
gated entries `sync-proxy` addresses `forward_auth` at. `oidc-credentials`
and `adopt-oidc-client` are its companions for native OIDC gating; see
[OIDC mode](authentik.md#oidc-mode).
