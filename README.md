# Bellhop

A self-hosted app store for your Proxmox VE homelab. Bellhop installs
appliances from [community-scripts](https://github.com/community-scripts/ProxmoxVE)
into new LXC containers, then handles what comes after: inventory, Caddy
reverse-proxy routes, Authentik login gating, updates, and migrations
between hosts. It ships as a web UI, a CLI, and an MCP server, and
reaches your Proxmox hosts over SSH from your local machine.

Bellhop is an independent project, not affiliated with or endorsed by
Proxmox Server Solutions GmbH. Proxmox is a registered trademark of
Proxmox Server Solutions GmbH.

## Prerequisites

- [Node.js](https://nodejs.org/) >= 24
- Passwordless SSH key access to every Proxmox host in your inventory. By
  default this reads a default identity file directly (`~/.ssh/id_ed25519`,
  `id_ecdsa`, or `id_rsa` — first match wins), the same as a plain `ssh`
  client with no agent running — **no SSH agent is required**. An agent
  (OpenSSH agent on Linux/macOS, Pageant on Windows) is only used as a
  fallback, when none of those identity files exist.
- `npm`

## Setup

```bash
npm install
npm link   # exposes the `bellhop` command globally; optional, you can
           # also always run `npm run bellhop -- <command> ...` instead
```

`npm install` also installs `web-client/`'s dependencies (an npm workspace
of this package) — no separate install step is needed to run `npm run
web:dev`/`web:build`.

First-time inventory setup only (skip this if `inventory/bellhop.db` already
exists):

```bash
npm run bellhop -- import-yaml-inventory --yaml-path inventory/hosts.yaml.example --db-path inventory/bellhop.db --apply
```

(or, once you have a real `hosts.yaml` hand-edited from the example,
`--yaml-path inventory/hosts.yaml` instead — see `import-yaml-inventory
--help`).

To hand-edit real Proxmox hosts and guests before importing them, copy
`inventory/hosts.yaml.example` to `inventory/hosts.yaml` first and edit
that copy. See the comments in the example file for the schema (`domain`,
`hosts[]` — each with an `ssh_user` (the SSH login user for that host —
Proxmox generally only allows `root`) and an optional `midScheme`
(`vmidBase`/`ipPrefix`/`gateway`) used by `--mid` below — `guests[]`, optional
`subdomains`/`ip`/`port`/`caddy`/`insecureBackendTls` fields —
`subdomains` is a list, so one host/guest can front more than one;
`insecureBackendTls` is for a backend that serves HTTPS with a
self-signed cert. A top-level `externalSites[]` covers reverse-proxy
targets that aren't a Proxmox host or guest at all, e.g. a NAS — see the
example file). `inventory/hosts.yaml` itself is never read by any command
other than `import-yaml-inventory` — everything else reads
`inventory/bellhop.db`, so re-run the import command above any time you
change the hand-edited `hosts.yaml` copy.

## Usage

All commands are run as `bellhop <command> [flags]` (after `npm link`)
or `npm run bellhop -- <command> [flags]`.

**Maintenance:**
```bash
bellhop update-all --host pve1
bellhop update-all --group lxc
bellhop update-all --all
bellhop sync-inventory          # dry run: prints new/updated/removed guests
bellhop sync-inventory --apply  # writes inventory/bellhop.db's hosts[] and guests[]
bellhop update-app --guest plex --app plex --apply
bellhop guest-power --guest plex --state start --apply
bellhop guest-power --guest plex --state shutdown --apply
bellhop audit-nfs-mounts        # report NFS mounts across all lxc guests
bellhop audit-nfs-mounts --host plex-lxc  # just one guest
```

`sync-inventory` queries every Proxmox host in inventory for its actual
LXC containers and VMs (via `pvesh`) and reconciles `guests[]` with
reality: existing entries keep their `name`/`subdomains`/`port`/`caddy` but
get `type`/`ip` refreshed; newly discovered guests are added (with no
`subdomains`/`port`/`caddy` — add those by hand); guests no longer present
on their host are removed. `--apply` writes the reconciled `hosts[]`/
`guests[]` back to `inventory/bellhop.db`, a SQLite database (see
`CLAUDE.md`) — `domain` and `externalSites[]` are left untouched.

`audit-nfs-mounts` reads `pct config <vmid>` on each `lxc` guest's *parent
host* (or one guest via `--host`) and cross-references its host-relay
bind-mounts (`mpN` entries) against that host's known NFS-backed paths —
its discovered fstab mounts and any Proxmox-managed `nfs:` storage — to
report which NFS shares are in use where, grouped by export. It never reads
anything from inside the guest itself (there's no guest-side fstab NFS
mount left to read since `attach-nfs-mount`/`migrate-nfs-mount` moved every
guest onto host-relay bind-mounts). Read-only — it never modifies anything.

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
or `sync-caddy` can target it — the create commands only create the guest
on the Proxmox host, they don't touch the inventory database.

`attach-nfs-mount` is the way to give an *existing* guest NAS access —
there's no scripted direct-mount path anymore. `create-lxc`/`install-app`
also accept `--nfs-storage`/`--nfs-mount-point` to attach the same
host-relay bind-mount as an optional step at creation time, but
`attach-nfs-mount` is still how you add one to a guest that already exists.
It attaches an `lxc`
guest to an already-existing Proxmox `nfs:` storage entry (`pvesm add nfs
<id> --server ... --export ...`, created manually once per share, not per
guest — see the cluster note in `CLAUDE.md`) via a host-relay bind-mount
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
separate update command).

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
in the web UI (see below) additionally re-syncs Caddy and reconciles
Authentik automatically in the same action; the CLI path doesn't do
either, so if the deleted guest had `subdomains`/an `authGroup` set, run
`sync-caddy`/`sync-authentik` by hand afterward to drop the now-gone
guest's config there too.

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
and (if the guest has subdomains) the live Caddy config are updated as
part of the same `--apply`, no separate `sync-inventory`/`sync-caddy` run
needed.

**Networking:**
```bash
bellhop sync-caddy          # dry run: prints the generated Caddyfile block
bellhop sync-caddy --apply  # writes it and reloads Caddy
bellhop render-status-page          # dry run: prints the generated status page HTML
bellhop render-status-page --apply  # writes it to the Caddy host
```

`render-status-page` regenerates a static, LAN-only status page (raw
`inventory/hosts.yaml` plus the actual deployed Caddyfile, both fetched
fresh) on whichever host is flagged `caddy: true`. It's a manual,
on-demand command on the CLI side — the web UI calls it automatically
after any change that touches Caddy (see below).

## Web UI

A browser dashboard for everything above, instead of the CLI:

```bash
npm run web:dev                   # dev server: API on :3001, Vite dev server with hot-reload
npm run web:build                 # production build of web-client/dist
npm run web:start                 # production: one Express server serving both the API and the built UI, on :3001
```

`src/web/server.ts` is a single Express process that's both the backend
*and* the frontend in production (`web:start`) — it mounts every
`/api/*` route (dashboard, jobs, provisioning, maintenance) and serves
`web-client/dist`'s built static files with a catch-all fallback to
`index.html`. Only `web:dev` runs a separate frontend process (Vite's dev
server, for hot-reload), proxying API calls to the same backend.

The Dashboard shows inventory (hosts, guests, bridges, storages), lets you
run provisioning actions (create-lxc/create-vm/install-app/
deploy-vpn-gateway/delete-guest/migrate-guest/attach-nfs-mount/
migrate-nfs-mount) and maintenance actions (sync-inventory) from forms
instead of flags, and streams every action's live log via WebSocket on a Job
page — every job also lands in Job History afterward. Each guest row also
has its own Start/Shutdown icon buttons (`guest-power` under the hood) for
one-off actions without opening a form.
Updating apt packages and community-script apps has its own dedicated
`/update` page instead, showing a card per host/guest with an apt-update
icon and, for guests with an app installed, a second community-script-update
icon. Changes that touch
subdomains (a new guest's Subdomains field, editing an existing guest's
subdomains, deleting a guest that had any) automatically re-run
`sync-caddy` and `render-status-page` in the same job, so the live
Caddyfile and status page never drift from what the Dashboard shows. Set
`PORT` to run it on a port other than 3001.

The deployed web UI can be gated behind Caddy's `forward_auth`, checking
every request against a self-hosted Authentik instance and forwarding
trusted `X-authentik-*` identity headers on success — there is no login
page or session store in this app itself, only a global Express middleware
(`src/web/auth.ts`) that trusts those headers when present. Whether a
request arriving with no such headers is rejected or served as a synthetic
always-admin local operator is controlled by `WEB_UI_AUTH_MODE` (see
"Environment variable overrides" and "Running without Authentik" below).
The default `auto` mode falls back to the local operator, so running
`web:start`/`web:dev` directly (not routed through Caddy) works out of the
box instead of 401ing the whole dashboard; set `WEB_UI_AUTH_MODE=authentik`
on any deployment where authentication is load-bearing to get the old,
fail-closed behavior back. `WEB_UI_DEV_USER` remains useful in dev/test for
simulating a *specific non-admin group membership*, which the synthetic
local operator can't do — `web:dev` sets it automatically (to `local-dev`)
and `npm test` sets it too (to `test-user`).

## MCP server

`npm run mcp` starts a stdio [MCP](https://modelcontextprotocol.io) server
that exposes the toolkit's operations as tools for a local AI assistant.
Every operation tool previews by default and only executes with
`apply: true`; applied work runs as a job you can follow with `wait_for_job`
(or `get_job`). If an installer stops to ask a question, `wait_for_job`
shows it to you as a form when your MCP client supports elicitation. If
your client can't show the form, or you leave it unanswered for 10 minutes,
the assistant sees the question and can answer it with
`answer_job_prompt`.
It manages the inventory and `data/` directory of the checkout it runs from.

Register it with Claude Code from the checkout you want it to manage:

```bash
claude mcp add bellhop -- npm run --silent mcp
```

On Windows, wrap it in `cmd /c`:

```bash
claude mcp add bellhop -- cmd /c npm run --silent mcp
```

Run that from PowerShell or cmd. From Git Bash, MSYS path conversion
rewrites `/c` into `C:/` before `claude` sees it, and the saved server fails
to start. Disable the conversion for that one command:

```bash
MSYS_NO_PATHCONV=1 claude mcp add bellhop -- cmd /c npm run --silent mcp
```

`--silent` matters: without it npm prints a banner to stdout, which corrupts
the MCP protocol stream.

Run the registration from inside the checkout. These commands use Claude
Code's default local scope, which only applies in the directory you ran
them from, and `npm run` finds the checkout from the working directory. For
a user or project scope, where Claude Code may start the server from
somewhere else, point npm at the checkout explicitly:

```bash
claude mcp add --scope user bellhop -- npm --prefix /path/to/bellhop run --silent mcp
```

## Inventory-wide settings

Four values live in the inventory database rather than in code, because
they are specific to your network. Set them with `set-config`:

```bash
bellhop set-config dnsServer 10.0.0.53 --apply
bellhop set-config statusPagePath /usr/share/caddy/index.html --apply
bellhop set-config nfsServer --unset --apply
```

Without `--apply` the command prints what it would change and writes
nothing. Admins can set the same values from the web UI's Settings page.

| Setting | Used by | When unset |
|---|---|---|
| `nfsServer` | `sync-inventory`, `migrate-nfs-mount` | `sync-inventory` skips its NFS scan; `migrate-nfs-mount` fails |
| `backupStorage` | `migrate-guest` | `--backup-storage` becomes required |
| `dnsServer` | `set-guest-vpn` | `set-guest-vpn` fails |
| `statusPagePath` | `render-status-page` | the status page is never rendered |

`statusPagePath` unset is a hard failure only for the standalone
`render-status-page` command; the web UI's combined push-live step and
`migrate-guest` both treat it as opt-in and silently skip regenerating the
status page instead of failing the rest of the job.

Two related values are *derived*, not configured: `set-guest-vpn --vpn
none` restores the guest's parent host's `midScheme.gateway`, and the
Windows service's firewall rule scopes to the `caddy: true` entry's `ip`.
This is a real behavior narrowing, not just a literal removed: previously
`--vpn none` always restored the same hardcoded LAN gateway regardless of
the guest's host; now it requires that host to have a `midScheme`
configured, and fails with a named error (`'<host>' has no midScheme, so
there is no LAN gateway to restore '<guest>' to`) if it doesn't.

## Environment variable overrides

- `INVENTORY_FILE` — path to the SQLite inventory database to use. Defaults
  to `inventory/bellhop.db`. Override to point at a temp `.db` fixture (e.g.
  one seeded via `import-yaml-inventory --yaml-path
  inventory/hosts.yaml.example --db-path <temp-path> --apply`), for
  testing without touching real infrastructure.
- `CADDYFILE_PATH` — path to the Caddyfile that `sync-caddy` reads from
  and writes to, and that `render-status-page` reads from when snapshotting
  the "Active Caddyfile" it displays. Defaults to `/etc/caddy/Caddyfile`.
  Override when Caddy's config lives somewhere nonstandard, or to point at
  a temp file for testing.
- `FSTAB_PATH` — path to the guest fstab file `migrate-nfs-mount` reads and
  edits (it's the only command left that touches guest fstab — see
  `audit-nfs-mounts` above, which reads parent-host `pct config` instead).
  Defaults to `/etc/fstab`. Override to point at a temp file for testing.
- `NFS_SERVER` — a per-run override for the inventory-wide `nfsServer`
  setting (see "Inventory-wide settings" above): the NAS IP
  `migrate-nfs-mount` matches fstab entries against, and that
  `sync-inventory`'s own fstab scan looks for. No longer has a hardcoded
  default (issue #124) — with neither this nor `nfsServer` set,
  `migrate-nfs-mount` fails and `sync-inventory` skips its NFS scan.
- `PORT` — port the web UI's Express server listens on (see Web UI above).
  Defaults to 3000 if unset, but both `web:dev` and `web:start` set it to
  3001 themselves.
- `WEB_DATA_DIR` — directory the web UI stores its job history SQLite DB,
  job logs, and (see below) `authentik.env` in. Defaults to
  `data/` in the repo root.
- `WEB_UI_DEV_USER` — local-development/test-only bypass for the web UI's
  auth check: when set, a request carrying no `X-authentik-*` headers is
  treated as signed in as this username, in whatever groups
  `WEB_UI_DEV_GROUPS` names (administrator groups included). Real
  `X-authentik-*` headers still take precedence when present. `web:dev`
  sets this automatically (to `local-dev`); `npm test` sets it too (to
  `test-user`) so the existing test suite doesn't need to fake Authentik
  headers on every request. **Never set this in the production Windows service's
  environment** — doing so would disable auth entirely for the real
  deployment, defeating the whole point of this repo's Caddy+Authentik
  forward-auth setup (see "Web UI" below).
- `WEB_UI_AUTH_MODE` — how the web UI establishes who is making a request.
  - `auto` (the default when unset) — trusted `X-authentik-*` headers are
    used when present; a request without them is served as a synthetic
    always-admin local operator. This is what lets the toolkit run with no
    identity provider at all.
  - `authentik` — strict: trusted headers are required, and a request
    without them gets a 401. **Set this on any deployment where
    authentication is load-bearing.** `auto` cannot distinguish a
    deployment that never had forward-auth from one whose `forward_auth`
    directive just broke; this mode is the guarantee that the second case
    fails closed.
  - `none` — always the local operator; trusted headers are ignored.
- `WEB_UI_LOCAL_USER` — the username of the synthetic local operator
  described above. Defaults to `local`. Shown in the UI's "Signed in as"
  line and recorded as a job's `triggered_by_username`.
- `AUTHENTIK_ADMIN_GROUP` — the Authentik group granting admin rights in
  this app (Users, Permissions, fleet-wide maintenance). Defaults to
  `bellhop-admins`.
- `AUTHENTIK_BUILTIN_ADMIN_GROUP` — Authentik's own built-in superuser
  group, membership in which is also accepted as admin here. Defaults to
  `authentik Admins`.
- `AUTHENTIK_GROUP_LADDER` — an ordered, comma-separated Authentik group
  ladder, low (broadest audience) to high (narrowest) — replaces the old
  single `AUTHENTIK_APP_USERS_GROUP` variable, which no longer exists. An
  inventory entry's `authGroup` names one rung; `sync-authentik` binds its
  Application to that rung and every rung above it, so the top rung is
  effectively "admin only" with no separate admin OR-check needed. Defaults
  to `homelab-app-users-open,homelab-app-users,homelab-users,authentik
  Admins`.
- `AUTHENTIK_OUTPOST_NAME` — the exact name of the Authentik outpost whose
  provider list `sync-authentik` maintains. Defaults to
  `authentik Embedded Outpost`. A mismatch fails `sync-authentik --apply`
  with an error naming this variable.
- `AUTHENTIK_OUTPOST_PORT` — the outpost's forward-auth port, used in the
  `forward_auth` directive `sync-caddy` generates. Defaults to `9000`. Must
  be a positive integer.
- `AUTHENTIK_AUTHORIZATION_FLOW_SLUG` / `AUTHENTIK_INVALIDATION_FLOW_SLUG` —
  the Authentik flow slugs new Proxy Providers are created against.
  Default to `default-provider-authorization-implicit-consent` and
  `default-invalidation-flow`. A missing slug fails Provider creation with
  an error naming the variable.
- `deploy-vpn-gateway` credentials — the web-triggered form (Provisioning
  page's Deploy VPN Gateway) collects `NORDVPN_ACCESS_TOKEN`/
  `PIA_USERNAME`/`PIA_PASSWORD` directly via its own conditional,
  per-provider credential fields (Access Token for NordVPN, Username/
  Password for PIA), which are required. There is no credentials file and
  nothing to create on disk for the web path; the CLI's own
  `deploy-vpn-gateway` keeps reading these from `process.env`, same as
  always (an operator's own interactive shell has them exported).
- `data/authentik.env` (not an env var override itself, but read via it) —
  a gitignored file the web UI loads via `dotenv` at server startup to
  provide `AUTHENTIK_API_URL`/`AUTHENTIK_API_TOKEN` for the web UI's
  user/group management pages (see `CLAUDE.md`'s "Web UI user/group
  management" section). There's no in-app form fallback for these — create
  it by hand (`AUTHENTIK_API_URL=...` / `AUTHENTIK_API_TOKEN=...`, one per
  line). Any of the `AUTHENTIK_*` and `WEB_UI_AUTH_MODE` overrides above
  can live in this file too. **The CLI loads it as well** (as of issue
  #123), so a shell `sync-authentik` run and a web-triggered one always
  agree on group names, the outpost, and the flow slugs. Missing the file
  (or either of `AUTHENTIK_API_URL`/`AUTHENTIK_API_TOKEN`) is a silent
  no-op for the user/group-management REST calls: the app falls back to a
  client that cleanly 503s any Authentik-backed request rather than
  crashing at startup. **Must be created in the checkout the web service
  actually runs from** — per this repo's worktree conventions (see
  `CLAUDE.md`), that's the separate, permanent `../Bellhop-live/`
  worktree the Windows service is installed against, not a feature worktree
  or this main checkout, unless that's the one you're running the service
  from. **On that checkout, this file must also
  set `WEB_UI_AUTH_MODE=authentik`** — see "Running without Authentik"
  below for why.
- `data/cloudflare-api.env` (optional) — a gitignored file holding
  `CLOUDFLARE_DNS_API_TOKEN`, a Cloudflare API token scoped to Zone:Read +
  DNS:Edit on the inventory `domain`'s zone. Loaded by both the CLI and the
  web UI. With it set, `prune-acme-challenges [--apply]` and the web UI's
  push-live step delete `_acme-challenge` TXT records untouched for over
  24h. Without it, the CLI command reports that it is not configured and
  the web UI skips the step with one log line; nothing else changes. Mint a
  dedicated token rather than reusing Caddy's own, so revoking one never
  breaks certificate issuance.

## Running without Authentik

Authentik is optional. With no `data/authentik.env` and no
`WEB_UI_AUTH_MODE` set, the web UI runs in `auto` mode: every request is
served as a single always-admin local operator, and the features that need
Authentik's REST API disable themselves — the Users and Permissions pages
disappear from the nav, `POST /api/impersonate` returns 503, and
`sync-authentik` is skipped by the Dashboard's push-live step instead of
failing it. Everything else — the Dashboard, provisioning, maintenance,
jobs, `sync-caddy`, and every CLI command — works unchanged.

A persistent banner in the UI and a warning line in the server's startup
log both say so, because in this mode **network reach is the only access
control**: anyone who can connect to the port gets full provisioning
rights. The Windows firewall rule this repo installs (scoped to the Caddy
LXC's IP) is what keeps that boundary meaningful.

To add authentication later, set up Authentik forward-auth in Caddy (see
"Web UI" below), create `data/authentik.env`, and set
`WEB_UI_AUTH_MODE=authentik` so a broken `forward_auth` directive fails
closed rather than silently reverting to the local operator.

## Validation

```bash
npm run typecheck   # tsc --noEmit — run after editing any TypeScript file
npm test            # unit tests, against a FakeSSHClient — no real network
```

`src/lib/ssh-client.ts`'s `Ssh2SSHClient` (the only file that opens a real
SSH connection) has no automated test; dry-run mode against real
infrastructure is the safety net for that piece specifically.

## Known hardware issues

One host's onboard NIC (Intel I219-LM, `e1000e` driver,
`nic0`) chronically threw `Detected Hardware Unit Hang` errors — hundreds
per boot, in bursts, throughout normal uptime rather than as a one-off. Each
burst stalls the NIC's TX queue, which breaks corosync cluster heartbeats
(`Token has not been received`) and drops any live connection over that
NIC, including SSH sessions — this is what "the host keeps dying" turned
out to be. On 2026-07-27 one burst was severe enough to hang the
filesystem sync during shutdown and force a reboot.

Root cause: Energy Efficient Ethernet (EEE) was enabled on the NIC, a
known trigger for this exact failure signature on Intel I219 controllers.
Fixed by disabling EEE (`ethtool --set-eee nic0 eee off`) and persisting it
across reboots via `/etc/systemd/system/disable-eee-nic0.service` (enabled,
`WantedBy=multi-user.target`) directly on that host — this is a host-level
OS fix, not something `inventory/bellhop.db` or any command in this repo
manages.

## Further reading

- `CLAUDE.md` — architecture reference (inventory schema, `resolveTarget`/
  `runRemote`, the Machine ID scheme, dry-run conventions, per-command
  design notes).

## Contributing

Contributions are welcome. [`CONTRIBUTING.md`](./CONTRIBUTING.md) covers
setting up a working copy without any real Proxmox infrastructure, how
changes are tested, and the example-data-only rule every change must
follow. Participation is governed by the
[code of conduct](./CODE_OF_CONDUCT.md).

## Security

To report a vulnerability, see [`SECURITY.md`](./SECURITY.md).

## License

MIT — see [`LICENSE`](./LICENSE).
