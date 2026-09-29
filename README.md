# Bellhop

A self-hosted app store for your Proxmox VE homelab. Bellhop installs
appliances from [community-scripts](https://github.com/community-scripts/ProxmoxVE)
into new LXC containers, then handles what comes after: inventory,
reverse-proxy routes (Caddy or nginx, through a pluggable driver — see
"Reverse proxy drivers" below), Authentik login gating, updates, and
migrations between hosts. It ships as a web UI, a CLI, and an MCP server,
and reaches your Proxmox hosts over SSH from your local machine.

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
`subdomains`/`ip`/`port`/`proxy`/`insecureBackendTls` fields —
`subdomains` is a list, so one host/guest can front more than one;
`insecureBackendTls` is for a backend that serves HTTPS with a
self-signed cert. A top-level `externalSites[]` covers reverse-proxy
targets that aren't a Proxmox host or guest at all, e.g. a NAS — see the
example file). `inventory/hosts.yaml` itself is never read by any command
other than `import-yaml-inventory` — everything else reads
`inventory/bellhop.db`, so re-run the import command above any time you
change the hand-edited `hosts.yaml` copy.

### Inventory-wide settings (before your first sync)

A few operator-specific values — your NAS's `nfsServer` IP chief among
them — live in the inventory database rather than in code, and are unset
by default. Set them before your first `sync-inventory`, so it can do
things like discover NFS mounts right away instead of skipping that scan
and printing a reminder:

```bash
npm run bellhop -- set-config nfsServer <ip> --apply
```

The web UI's Settings page sets the same values, for anyone who'd rather
not use the CLI. See "Inventory-wide settings" below for the full list and
what happens when a value stays unset. If you're hand-editing
`inventory/hosts.yaml` for `import-yaml-inventory` instead, these keys can
go there too — see the commented `nfsServer`/`backupStorage`/`dnsServer`/
`statusPagePath` keys in `inventory/hosts.yaml.example`.

## Usage

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
bellhop guest-power --guest plex --state start --apply
bellhop guest-power --guest plex --state shutdown --apply
bellhop audit-nfs-mounts        # report NFS mounts across all lxc guests
bellhop audit-nfs-mounts --host plex-lxc  # just one guest
```

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
separate update command). If you've configured `customScriptsRepo`/
`customScriptsBranch` (see "Inventory-wide settings" below), both commands
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
in the web UI (see below) additionally re-syncs the reverse proxy and
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
bellhop render-status-page          # dry run: prints the generated status page HTML
bellhop render-status-page --apply  # writes it to the proxy host
bellhop sync-authentik          # dry run: prints Applications/OpenID clients to create/update/remove
bellhop sync-authentik --apply  # reconciles Authentik Proxy Providers, OpenID clients, and policy bindings
bellhop oidc-credentials media           # print an OIDC-gated entry's issuer, client ID, and client secret
bellhop adopt-oidc-client media          # dry run: preview adopting a hand-made OpenID client
bellhop adopt-oidc-client media --apply  # adopt it as Bellhop-managed, without rotating its credentials
```

`render-status-page` regenerates a static, LAN-only status page (raw
`inventory/hosts.yaml` plus the actual deployed proxy configuration, both
fetched fresh) on whichever host is flagged `proxy: true`. It's a manual,
on-demand command on the CLI side — the web UI calls it automatically
after any change that touches the reverse proxy (see below).

`sync-authentik` reconciles Authentik Proxy Providers, OpenID (OAuth2)
clients, Applications, policy bindings, and embedded-outpost membership
against every inventory entry that has an `authGroup` set — the same
gated entries `sync-proxy` addresses `forward_auth` at. `oidc-credentials`
and `adopt-oidc-client` are its companions for native OIDC gating; see
"OIDC mode" below.

## Reverse proxy drivers

`sync-proxy` doesn't talk to Caddy (or any other proxy) directly — it goes
through a driver, chosen by the `proxyDriver` setting (see "Inventory-wide
settings" below; unset means `caddy`, the default; `nginx` and `none`
are the other drivers that ship). Exactly one driver is active per
deployment: it's a per-deployment choice, not a per-entry one, so every
gated/reverse-proxied inventory entry is served by the same proxy. The web
UI's Settings page presents this choice as a dropdown of every driver
Bellhop supports, rather than a free-text field — see "Inventory-wide
settings" below.

A driver declares what it can enforce (`authModes`, e.g. Caddy supports
both `forward` and `oidc`) and whether it issues TLS certificates itself
through Cloudflare DNS-01 (`acmeDns01ViaCloudflare`, which gates whether
`prune-acme-challenges` runs as part of the web UI's push-live step). It
implements three operations: `plan()` turns the routes derived from
inventory into a preview and an opaque payload (the dry-run preview is
always exactly what `--apply` sends); `apply()` sends that payload live and
reloads the proxy, throwing on failure — a failed validate or write
restores the proxy's previous configuration rather than leaving it
half-written or silently reporting success; `snapshot()` reads back
whatever the proxy currently has deployed, for the status page. Any route
whose auth mode the active driver can't enforce (e.g. a driver with no
`oidc` support and an OIDC-gated entry) is refused at both `sync-proxy` and
guest-edit time, naming the entry, the driver, and the fix — never
silently dropped, which would leave that entry reachable with no gate in
front of it.

**"No proxy" (`proxyDriver: none`) is for an operator whose reverse proxy
is managed by hand, or who has none at all.** It's a real, selectable
driver, not an error state: `sync-proxy` (CLI, web, and MCP alike)
succeeds without making any remote call and reports that Bellhop manages
no reverse proxy, so there is nothing to write — no inventory entry needs
to be flagged `proxy: true` for this to work. It accepts both forward-auth
and OIDC gated entries (capability enforcement never rejects it), on the
assumption that whatever proxy you do run enforces `forward_auth` itself;
`sync-authentik` reconciles Authentik exactly as it does under any other
driver. The standalone `render-status-page` command fails outright under
"No proxy" — there's neither a managed proxy nor a document root to serve
a page from — naming `proxyDriver` as the setting to change; the web UI's
combined push-live step and `migrate-guest`'s post-move push log the same
"nothing to write" line in place of the proxy push, then skip the status
page render with one log line and continue, the same opt-in
skip they already give an unset `statusPagePath`. The stale ACME-challenge
cleanup is skipped too, through the same driver-capability check that
skips it for any driver that doesn't issue certificates via Cloudflare
DNS-01 (nginx included).

A driver that's configured through a file (Caddy and nginx both are; a
future Caddy-admin-API/Nginx-Proxy-Manager/HAProxy-Data-Plane-API driver
might not be) is built with a shared `fileDriver` helper: it backs up the
target file(s), writes the new content in place (either replacing a
managed section while leaving everything else on the file untouched, or
replacing a file Bellhop owns outright), runs the proxy's own validation
command against the real path, restores every backup and fails if
validation fails, and reloads the proxy otherwise. Each such driver must
state its Settings-dropdown label and whether it serves a status page;
neither has a default. A driver that manages a proxy but serves no status
page makes `render-status-page` fail with a message saying to clear
`statusPagePath` or pick another driver, and the push-live step logs a
warning, not an info line, when `statusPagePath` is set but ignored.

On both file-configured drivers (Caddy and nginx), a request to a forward-gated entry's exempt
(`unauthenticatedPaths`) location skips the Authentik check entirely — any
`X-authentik-*` identity headers on that request are whatever the client
itself sent, unverified, so a backend must not trust them on an exempt
path the way it can trust them everywhere else on a gated site.

**Certificates are the operator's job for a driver that doesn't issue them
itself.** Caddy issues its own via Cloudflare DNS-01 with no extra setup;
nginx cannot obtain its own certificate, so every site the nginx driver
generates shares one certificate/key pair instead — see "nginx driver"
below. A future HAProxy driver would need the same kind of
operator-managed certificate tool (`certbot`, `acme.sh`) running alongside
it — Bellhop itself never issues or renews a certificate.

### nginx driver

Select it with `bellhop set-config proxyDriver nginx --apply` (or the
Settings page). It owns one whole file on the proxy host, defaulting to
`/etc/nginx/conf.d/bellhop.conf` (override with `proxyConfigPath`) —
everything else already on the box is left alone. `sync-proxy` renders one
HTTPS `server` block per subdomain-bearing entry, forwarding to its
backend the same way the Caddy driver does (the original `Host`, the
client's address — `X-Forwarded-For` is set to the connecting address, not
appended to, so a client can't pose as a LAN address — and scheme,
external port 443, WebSocket upgrades, unbuffered streaming of responses
and request bodies, a one-day idle timeout so quiet WebSocket and
server-sent-events connections stay open, no request-body size limit) and,
for a
forward-gated entry, checks every request against the embedded Authentik
outpost the same way Caddy's `forward_auth` does, including
`unauthenticatedPaths` exemptions; an `oidc`-mode or ungated entry gets no
forward-auth at all.

Its status page follows the same opt-in `statusPagePath` setting as
Caddy's; the Settings page suggests `/var/www/html/index.html`, the
Debian/Ubuntu nginx package's default document root. Serving that page
(and restricting it to your LAN) is your own hand-authored `server`
block's job, exactly as the status page's site block is for Caddy.

Because nginx cannot obtain a certificate the way Caddy does through
Cloudflare DNS-01, every site this driver generates shares one
certificate/key pair — normally a wildcard for your domain, so that adding
a subdomain never needs a certificate step of its own. Point Bellhop at it
with the `proxyTlsCertificate`/`proxyTlsKey` settings (see "Inventory-wide
settings" below); left unset, it looks for certbot's own default path for
a certificate named after the inventory `domain`
(`/etc/letsencrypt/live/<domain>/fullchain.pem`/`.../privkey.pem`). certbot
names a certificate lineage after its first `-d`, so this issues it at
exactly that path:

```bash
certbot certonly --dns-cloudflare -d example.com -d '*.example.com'
```

A wildcard covers one label only: `*.example.com` matches
`grafana.example.com` but not `grafana.lab.example.com`. A multi-label
subdomain such as `grafana.lab` needs its own coverage on the same
certificate (for example an extra `-d '*.lab.example.com'`) — nginx serves
the certificate regardless and does not warn, so browsers see a name
mismatch instead.

Add a certbot deploy hook that reloads nginx after every renewal (for
example a script under `/etc/letsencrypt/renewal-hooks/deploy/` running
`systemctl reload nginx`) — issuing and renewing the certificate, and
making nginx pick up a renewal, are the operator's job; Bellhop only ever
points nginx at the configured paths.

Out of scope: redirecting port 80 to HTTPS (left to your own
configuration, so it never clashes with your certificate tool's own
webroot or default server) and HTTP/2 (its directive differs between
supported nginx releases). Assumes a distribution-packaged nginx managed
by systemd whose main configuration includes `/etc/nginx/conf.d/*.conf`
inside its `http` block (the Debian/Ubuntu and upstream-package default —
use `proxyConfigPath` for a different layout) and that it was built with
the `auth_request` module (standard in the Debian/Ubuntu and nginx.org
packages).

No generated block is a `default_server`, so a request on port 443 for a
hostname (or TLS SNI name) no block claims falls through to nginx's default
server — the first generated block, unless your own configuration declares
a `default_server` — and gets that site's certificate and backend. Bellhop
doesn't emit one itself, since it would collide with a `default_server` of
your own and fail `nginx -t`. To reject unknown names instead, add a
catch-all to your own configuration (nginx 1.19.4 or later):

```nginx
server {
    listen 443 ssl default_server;
    listen [::]:443 ssl default_server;
    ssl_reject_handshake on;
}
```

Switching `proxyDriver` from `caddy` to `nginx` (or back) leaves the other
driver's own files in place: an old Caddyfile's `bellhop-managed` section
stays, still valid, for you to retire by hand once nginx is serving the
same sites. `proxyConfigPath` is shared by both drivers, though, so clear
it (`bellhop set-config proxyConfigPath --unset --apply`) or repoint it
when switching. The nginx driver replaces its file whole, so it refuses to
overwrite an existing file whose first line isn't its own generated header
— an apply with `proxyConfigPath` still pointing at a Caddyfile fails with
that error and leaves the Caddyfile untouched.

**Upgrading an existing installation needs no manual steps in most
cases.** An inventory created by an older version upgrades itself
automatically the first time it's opened by the new code — pull the new
code and restart the service, and the upgrade never repeats. Caddy is
chosen as the driver by default, so the reverse-proxy configuration a
`sync-proxy --apply` produces afterward is unchanged from before the
upgrade. The renamed command was `sync-caddy` and the renamed inventory
flags were `caddy`/`caddyManual`; none of the old names still work, and
`import-yaml-inventory` refuses a `hosts.yaml` that still uses the old
flags until they are renamed to `proxy`/`proxyManual`. Two cases do need
a step by hand:

- **You set `CADDYFILE_PATH`.** That environment variable is gone and is
  no longer read. If you pointed it anywhere other than
  `/etc/caddy/Caddyfile`, run
  `bellhop set-config proxyConfigPath <path> --apply` with the same path.
- **An `unauthenticatedPaths` value is not an exact path or a `/*`
  prefix.** Each value must now be an exact path (`/health`) or a path
  ending in `/*` (`/api/*`); anything else (`/api*`, `/a*b`) makes the
  inventory refuse to load until that value is edited to one of those
  two forms. Since nothing can load the inventory meanwhile, edit it in
  `inventory/bellhop.db` directly: the `unauthenticated_paths_json`
  column of whichever `hosts`, `guests`, or `external_sites` row holds
  it.

### OIDC mode

A gated entry (one with `authGroup` set) is enforced one of two ways,
chosen per entry with `authMode`: `forward` (the default, and the only
option before this feature existed) puts the active proxy driver's
forward-auth in front of it (Caddy's `forward_auth`, or the equivalent
`auth_request` block on the nginx driver), checking every request against
Authentik and forwarding a shared,
already-authenticated identity in `X-authentik-*` headers; `oidc` instead
gives the entry its own Authentik OpenID Connect client and lets the app
run its own login. A driver that can't enforce a mode an entry needs is
refused at sync and edit time rather than silently leaving that entry
ungated — see "Reverse proxy drivers" above.

Choose `oidc` for an app that already has its own user accounts, roles, or
permissions and can tell users apart on its own — forward-auth otherwise
hides every visitor behind the same trusted headers, so the app sees one
shared identity rather than each person's own account. Keep `forward` (the
default) for an app with no login of its own, which is most gated apps in
a typical inventory.

To switch an entry to OIDC mode: set `authGroup` (its access tier, same as
today), `authMode: oidc`, and `oidcRedirectUris` (the app's own callback
URL — an absolute `http://`/`https://` address, e.g.
`https://media.example.com/auth/callback`, whatever the app's own OIDC/
OpenID settings call for; more than one is allowed). For a guest, use the
Dashboard's Advanced modal (admin only) — its General/Access tabs, see
"Access tab" below; the callback/mobile-redirect fields live on Access.
Its fields each save on their own,
and a save that would leave an entry in OIDC mode with an access tier but
no callback URL is rejected, so go in this order: set the access tier, save
the Callback URLs, and only then switch Auth mode to OIDC. A host or
external site is DB/CLI-only, the same as `authGroup` itself. Then run
`bellhop sync-authentik --apply` (or save the Dashboard edit, which runs
the same sync as part of its push-live step) to create the OpenID client
in Authentik.

**Mobile app redirect URLs.** An OIDC-mode entry also accepts an optional
`oidcMobileRedirectUris` list, alongside `oidcRedirectUris`, for a native
mobile app's own sign-in callback — either a custom-scheme URI (e.g.
`app.example:///oauth-callback`) or an `https://` hand-off page the app
opens from (e.g. `https://books.example.com/auth/openid/mobile-redirect`).
Use it when the app has an Android/iOS client that signs in through the
phone's browser and gets handed back to the app; a plain browser-only login
never needs it. Any scheme is accepted except `javascript:`, `data:`,
`file:` and `vbscript:` (any letter case), which are rejected with a
message naming the rejected value. A URI must not appear in both the
callback list and the mobile list of the same entry — the edit is rejected,
naming the duplicate, though this is only checked when the entry is edited,
never when a saved inventory is loaded. `sync-authentik` sets the OpenID
client's allowed callbacks to the callback list plus the mobile list
together (deduplicated); a change to only the mobile list is reported the
same as a callback-list change and never rotates the client's credentials.
Set it through the Dashboard's Advanced modal (Access tab, admin only,
same rule as the callback URLs), the MCP server's `edit_guest` tool, or
YAML import — there is no CLI edit command for it.

**The mobile consent step.** Once any entry anywhere in the inventory has
a mobile redirect URL in effect, `sync-authentik` also adds a one-click
consent step to the shared authorization flow, scoped to exactly those
URLs: a consent stage named `bellhop-mobile-app-consent`, a binding of it
to the flow, an expression policy named
`bellhop-consent-on-mobile-redirect`, and a binding of that policy to the
stage binding. The policy passes — showing the consent page — only when
the login's own redirect URI exactly matches one of the mobile URLs
currently in effect across the whole inventory; every other login
(browser, or a mobile URL that isn't configured) skips it automatically,
with zero clicks. This fixes a real Android quirk: with an existing
Authentik session, the default authorization flow is nothing but automatic
redirects, and the in-app browser tab can refuse to hand off to the app
when there was no user gesture in the chain — one "Continue" click before
the hand-off is enough to satisfy it. Any error while the policy is
evaluated (an Authentik quirk, an unreachable dependency) means "no
consent page," the same as it not matching — a browser login is never
blocked by it. The four objects are created only while at least one
mobile URL is in effect anywhere; removing the last one is what removes
all four again on the next sync, leaving nothing behind. Bellhop only ever
touches objects it recognizes as its own (a consent stage/expression
policy under those exact names, the policy also carrying a comment marker
identifying it as Bellhop-managed) — a same-named object it didn't create
is reported as a conflict and left untouched, and the rest of the sync
still completes. After creating or changing the stage binding or the
policy, `sync-authentik` clears Authentik's cached flow plans, so a login
already in progress under the old configuration isn't served a stale plan.
**If you already have a hand-made consent stage and policy on this same
flow (under different names) from working around this yourself, delete
them once Bellhop's copy is in place** — otherwise a mobile sign-in shows
two consent pages back to back.

The consent step is bound only to the flow `AUTHENTIK_AUTHORIZATION_FLOW_SLUG`
names. An OpenID client that uses a different authorization flow (one
adopted with `adopt-oidc-client` that was set up with its own flow, say)
still gets its mobile URLs in its allowed callbacks, but no consent step.
`adopt-oidc-client` itself writes the client's callbacks (web and mobile)
but does not reconcile the consent step; the next `sync-authentik` run, or
any Dashboard guest edit, creates it. When a Dashboard save changes an
entry's mobile redirect URLs and the consent step then reports a conflict
or an error, the save still succeeds and the problem is shown as a warning
under that field (and returned by the MCP `edit_guest` tool).

A Dashboard save pushes the proxy configuration change *before* the Authentik sync runs,
so switching an entry to OIDC removes its `forward_auth` gate first. If the
sync then skips the entry (a missing signing key, say) or fails, the app is
reachable with no gate in front of it until the next successful sync — read
the warnings on the save result, and fix whatever they name before relying
on the app's own login. Reveal the entry's credentials from its Advanced modal
(admin only), or run `bellhop oidc-credentials <name>`, to get the issuer
address, client ID, and client secret — paste all three into the app's own
OIDC settings. The secret is never stored anywhere in this toolkit; both
surfaces read it fresh from Authentik every time. The MCP server's
`get_oidc_client` tool returns the issuer and client ID only, never the
secret — its response points at the Dashboard or `oidc-credentials`
instead.

**Account linking is the operator's job, not this toolkit's.** The first
sign-in through a new OIDC client creates a brand-new account in the app
(most OIDC-capable apps do this automatically), with no link to any
account that already existed there under a different login method. To
keep a user on their existing app account, let their first OIDC login
create the new one, then use the app's own account-linking/merge feature
(or delete the duplicate and reassign its data) to move them onto the
account you want them using — Bellhop has no part in that step.

Switching an entry from OIDC back to forward-auth, or clearing its access
tier while in OIDC mode, deletes its OpenID client on the next sync — the
app's existing login stops working until new credentials are entered in it.
The Dashboard asks for confirmation, naming the app, before saving that
kind of edit; the MCP server's `edit_guest` tool rejects the same edit
unless the call passes `confirmOidcClientDeletion: true`. Switching the
other way, from forward-auth to OIDC, deletes only the entry's forward-auth
Proxy Provider (there is no OpenID client yet to lose), so it needs no
confirmation. Either way the Application itself, and so its access-tier
bindings, is kept. Changing
`authMode` or `oidcRedirectUris` is admin-only in both directions on every
front end (unlike an access tier, which a non-admin may raise but not
lower), since switching to OIDC removes the forward-auth gate and the
callback URL decides where Authentik sends a signed-in user's tokens.

If an entry's address already has a hand-made OpenID client in Authentik
(one set up by hand before pointing this toolkit at it), the sync reports
a conflict rather than touching it. Run `bellhop adopt-oidc-client <name>
--apply` (dry run without `--apply`) to bring it under Bellhop's
management — its client ID and secret never change, so the app's existing
login configuration keeps working.

**Custom scope mappings.** A new OpenID client gets Authentik's three
built-in scope mappings, for `openid`, `profile` and `email`. On an existing
client (a routine sync, or adoption), Bellhop checks those scopes by *scope
name*: each one needs some attached mapping with that scope name, built-in
or your own. A custom mapping is therefore kept. The typical case is a
custom `email` mapping that sets `email_verified`, since Authentik's
built-in one always reports it as false and some apps refuse unverified
sign-ins. Mappings for other scopes are left alone too. Only a required
scope with no mapping at all counts as drift, and the fix adds the built-in
mapping for it while keeping everything already attached. The flip side:
if someone swaps a built-in mapping for another mapping with the same scope
name, Bellhop no longer puts the built-in one back.

**Authentik API token permissions.** OIDC mode needs a few more scopes on
the token in `data/authentik.env` than forward-auth-only gating did: read
and write on OAuth2/OpenID Providers (not just Proxy Providers), read on
certificate-keypairs (to resolve the signing key), read on property/scope
mappings, and update on Applications. `sync-authentik` lists OAuth2
Providers on every run. When no entry is in OIDC mode, a token that cannot
read them is tolerated — the sync carries on as forward-auth-only gating
always did — but once any entry is in OIDC mode, a token missing these
scopes fails the whole sync, not just the OIDC part of it. Once any *mobile*
redirect URL is set anywhere in the inventory, the token additionally needs
read/write on consent stages, flow-stage bindings, expression policies and
policy bindings, plus permission to clear the flow cache — the mobile
consent step above. As with the OIDC scopes, this is only ever checked
against a token that actually has a mobile URL to reconcile: a deployment
with no mobile URLs set never needs these and a token missing them causes
no failure, since there is nothing to read or write yet.

**Access tab.** The guest Advanced modal splits its fields across two tabs:
General (type, IP, host, VMID, subdomains, port, read-only proxy, insecure
backend TLS, VPN, app) and Access (auth group, auth mode, and whichever
fields apply to the selected auth mode — unauthenticated paths in forward
mode; callback URLs, mobile app redirect URLs, and OIDC client
issuer/client ID/secret in OIDC mode). A gated forward-mode guest with no
callback URL yet also shows the callback URLs field, noted "Needed before
switching auth mode to OIDC.", since that switch is refused until one is
set. Switching Auth mode back and forth
never loses a hidden field's saved value — it's simply not shown while the
other mode is selected.

**Signing key.** A new OpenID client signs its identity tokens with the
Authentik certificate-keypair named `AUTHENTIK_OIDC_SIGNING_KEY_NAME`
(default: `authentik Self-signed Certificate`, the self-signed cert every
stock Authentik install already has — see "Environment variable
overrides" below). This default is a single-operator convenience, not a
security recommendation for every deployment; override it if you've set
up your own signing key, or renamed/removed the default certificate. A
missing key fails every OIDC entry's sync with a named error; forward-auth
entries in the same run are unaffected.

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
one-off actions without opening a form. A guest row's Advanced link opens a
modal with its less-common fields (auth group, unauthenticated paths, vpn,
and the rest); each one has an ⓘ next to its label with a one-to-two-sentence
explanation, reachable by hover, tap or keyboard.
Updating apt packages and community-script apps has its own dedicated
`/update` page instead, showing a card per host/guest with an apt-update
icon and, for guests with an app installed, a second community-script-update
icon. Changes that touch
subdomains (a new guest's Subdomains field, editing an existing guest's
subdomains, deleting a guest that had any) automatically re-run
`sync-proxy` and `render-status-page` in the same job, so the live
proxy configuration and status page never drift from what the Dashboard
shows. Set `PORT` to run it on a port other than 3001.

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

A job the MCP server starts isn't siloed to it: it shows up live in the web
UI's Job History with the same streaming output, and Stop/answer controls
work from there just as they would for a job started in the web UI. The
same goes in reverse — the MCP control tools can stop or answer a job that
was started from the web UI.

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

Ten values live in the inventory database rather than in code, because
they are specific to your network. Set them with `set-config`:

```bash
bellhop set-config dnsServer 10.0.0.53 --apply
bellhop set-config statusPagePath /usr/share/caddy/index.html --apply
bellhop set-config nfsServer --unset --apply
```

Without `--apply` the command prints what it would change and writes
nothing. Admins can set the same values from the web UI's Settings page,
where `proxyDriver` is a dropdown of the supported ids rather than a
free-text field, and Proxy config path/Status page path are shown or
hidden and given a matching placeholder based on whichever driver is
currently selected in that dropdown (unsaved changes included); the Proxy
TLS certificate/key fields appear only while nginx is selected. Hiding a
field never clears its stored value — see "Reverse proxy drivers" above.

| Setting | Used by | When unset |
|---|---|---|
| `nfsServer` | `sync-inventory`, `migrate-nfs-mount` | `sync-inventory` skips its NFS scan; `migrate-nfs-mount` fails |
| `backupStorage` | `migrate-guest` | `--backup-storage` becomes required |
| `dnsServer` | `set-guest-vpn` | `set-guest-vpn` fails |
| `statusPagePath` | `render-status-page` | the status page is never rendered |
| `proxyDriver` | `sync-proxy`, `render-status-page`, every OIDC/forward-auth capability check | `caddy`, the default — allowed values are `caddy`/`nginx`/`none` |
| `proxyConfigPath` | same as `proxyDriver` | the active driver's own default config path (`/etc/caddy/Caddyfile` for Caddy, `/etc/nginx/conf.d/bellhop.conf` for nginx; `none` has no config file at all) |
| `proxyTlsCertificate` | the nginx driver | certbot's own default certificate path for the inventory domain; ignored by Caddy and `none`, and shown on the Settings page only while nginx is selected |
| `proxyTlsKey` | the nginx driver | certbot's own default key path for the inventory domain; ignored by Caddy and `none`, and shown on the Settings page only while nginx is selected |
| `customScriptsRepo` | `install-app`, `update-app`, the app catalog | apps resolve from ProxmoxVE/ProxmoxVED only, same as today |
| `customScriptsBranch` | same as `customScriptsRepo` | same as `customScriptsRepo` |

See "Reverse proxy drivers" above for what `proxyDriver`, `proxyConfigPath`,
and the nginx driver's `proxyTlsCertificate`/`proxyTlsKey` actually do.

`statusPagePath` unset is a hard failure only for the standalone
`render-status-page` command; the web UI's combined push-live step and
`migrate-guest` both treat it as opt-in and silently skip regenerating the
status page instead of failing the rest of the job.

### Custom script repository

`customScriptsRepo` (`owner/repo`) and `customScriptsBranch` name a
**public** GitHub repository laid out exactly like
[ProxmoxVED](https://github.com/community-scripts/ProxmoxVED) — `ct/<slug>.sh`
and `install/<slug>-install.sh` at its root — plus the branch on it to
install from. The repository must be a fork of
`community-scripts/ProxmoxVED`: Bellhop compares your branch against
upstream ProxmoxVED's `main` to learn which apps the branch actually
changes, and only those apps come from your branch. A personal fork branch
where you develop a few apps before upstreaming them is the intended use
case — the hundreds of upstream scripts the branch merely carries along
keep installing from upstream.

```bash
bellhop set-config customScriptsRepo example-user/ProxmoxVED --apply
bellhop set-config customScriptsBranch my-apps --apply
bellhop set-config customScriptsRepo --unset --apply   # (and the branch) turns it back off
```

The two settings must be set together — setting only one fails any
command that resolves an `--app` slug with a named error pointing back at
`set-config`. With both set, `install-app --app <slug>` and `update-app
--app <slug>` resolve `<slug>` like this:

- **The branch changes the app** (its `ct/<slug>.sh` or
  `install/<slug>-install.sh` was added, modified or renamed since the
  branch left upstream `main`): installs from your branch. If upstream also
  has the app, one informational line says your copy replaces it.
- **The branch doesn't change the app** and ProxmoxVE or ProxmoxVED has it:
  installs from upstream exactly as if the feature were off, with no
  notice.
- **Only your fork has the app** (e.g. inherited from an older upstream
  state and since removed there): installs from your branch, since there
  is nowhere else to get it.

When your branch is behind upstream and upstream *also* changed one of the
apps your branch changes since the branch point, every front end (CLI
output, the web App check/install/update previews, job logs, and the MCP
check result) prints a warning telling you to rebase the branch. The
install still uses your copy — the warning never blocks it. A pasted full
script URL is unaffected — it's used exactly as given, never resolved
against the custom repository.

Working out which apps changed takes one GitHub API request on top of the
head-commit pin, so each resolution uses two of GitHub's 60 unauthenticated
requests per hour. The web UI resolves separately for the App check, a
Preview and an Apply, and each refresh of the custom catalog group (at most
every 5 minutes) spends the same two, so one web install uses roughly 6 to 8. If the comparison can't be made — the repository isn't a
ProxmoxVED fork, GitHub rate-limits or is unreachable, or the branch
changes 300 or more files (GitHub stops listing files there) — the command
fails with an error naming the settings, rather than guessing.

Resolving a slug against the custom repository pins the configured
branch to its current head commit. One commit is pinned per apply
operation, at the moment the web UI or MCP server enqueues it: the preview
written at the top of that job's own log, the expected-prompt pre-scan,
and the apply itself all read that one commit, so a push to the branch
after that point can never make what actually ran differ from what the
job log's own preview shows. A standalone Preview click or App check pins
its own commit independently, at whatever moment it runs — if the branch
moves between a standalone Preview/check and a later Apply, Apply pins a
fresh commit of its own, and the job log for that apply is what shows
exactly which one. The app catalog (the web UI's Install App
suggestion list, and the MCP `list_install_apps` tool) gets a third group
for the custom repository, listed first and refreshed roughly every 5
minutes rather than upstream's 24 hours, so an app you just pushed shows
up within minutes. It lists only the apps your branch changes, and tags
any that upstream also changed (`conflicts upstream`). A fork-only app
isn't listed there, but typing its name still installs it.

Two limitations are inherited from how community-scripts' own installer
engine resolves script locations, and can't be fixed from Bellhop's side:
a custom-installed container's own built-in `/usr/bin/update` helper is
baked with the commit it was installed from, so it stays pinned there
until the guest is updated again through Bellhop's `update-app` (which
re-resolves and re-exports the current head commit on every run, moving
the helper forward); and that same in-container helper separately asks
community-scripts.org whether an update is available, and that site has
no knowledge of a fork-only app — it may report one as already current,
or not found, regardless of what your branch actually has. Update a
custom-sourced app through Bellhop's `update-app`, not the container's
own `update` command, for a result that reflects your branch.

A guest's recorded app source (the Dashboard/Update page's link to the
custom repository's copy of its script) is set once, by the web/MCP
`install-app` apply that created it — `update-app` never changes it,
whichever repository the update itself actually ran from. So the Dashboard
link always reflects where a guest was *installed* from, not where its
most recent update came from; a guest installed from upstream and later
updated through a configured custom repository (because its slug now also
exists there) still links to the plain community-scripts site.

Each app check, preview, and apply that resolves a slug against the custom
repository makes exactly one unauthenticated `api.github.com` request (to
pin the branch's head commit) — GitHub's unauthenticated rate limit is 60
requests per hour per source IP, shared with anything else on your network
making unauthenticated GitHub API calls. Hitting that limit fails the
operation with a named error (GitHub's non-200 status is reported
verbatim) rather than silently falling back to upstream, per FR-008 above.

Two related values are *derived*, not configured: `set-guest-vpn --vpn
none` restores the guest's parent host's `midScheme.gateway`, and the
Windows service's firewall rule scopes to the `proxy: true` entry's `ip`.
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
  to `bellhop-app-users-open,bellhop-app-users,bellhop-users,authentik
  Admins`.

  **Upgrading from a deployment that relied on the previous default**
  (`homelab-app-users-open,homelab-app-users,homelab-users,authentik
  Admins`, before the project's rename to Bellhop): stored `authGroup`
  values are never rewritten by an upgrade, so set
  `AUTHENTIK_GROUP_LADDER` explicitly to the old value above in
  `data/authentik.env` **before** upgrading, keeping every gated app on
  its current groups unchanged. If you upgrade first without doing this,
  every entry still gated at an old-default rung is left untouched, not
  reconciled, until you either set `AUTHENTIK_GROUP_LADDER` to the old
  value as above, or rename those groups in Authentik to the new default
  names and re-tier each affected entry (clear and re-set its access
  tier) so its stored `authGroup` matches a rung on the new default
  ladder.

  Until one of these is done, `sync-authentik` reports every affected
  entry under "Entries with an unknown authGroup" and leaves its existing
  Authentik Application and bindings alone — it is never deleted or
  silently rebound.
- `AUTHENTIK_OUTPOST_NAME` — the exact name of the Authentik outpost whose
  provider list `sync-authentik` maintains. Defaults to
  `authentik Embedded Outpost`. A mismatch fails `sync-authentik --apply`
  with an error naming this variable.
- `AUTHENTIK_OUTPOST_PORT` — the outpost's forward-auth port, used in the
  `forward_auth` directive the active proxy driver's `sync-proxy` output
  generates (Caddy today). Defaults to `9000`. Must be a positive integer.
- `AUTHENTIK_AUTHORIZATION_FLOW_SLUG` / `AUTHENTIK_INVALIDATION_FLOW_SLUG` —
  the Authentik flow slugs new Proxy Providers are created against.
  Default to `default-provider-authorization-implicit-consent` and
  `default-invalidation-flow`. A missing slug fails Provider creation with
  an error naming the variable.
- `AUTHENTIK_OIDC_SIGNING_KEY_NAME` — the Authentik certificate-keypair a
  new OpenID client (native OIDC gating, see "OIDC mode" above) signs its
  identity tokens with. Defaults to `authentik Self-signed Certificate`,
  the self-signed cert a stock Authentik install already has — override it
  only if you've deliberately set up your own signing key, or
  renamed/removed the default certificate. A missing key fails every OIDC
  entry's sync with an error naming this variable.
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
  actually runs from** — the checkout the Windows service is installed
  against, which is not necessarily the one you develop in. **On that
  checkout, this file must also
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
failing it. The Settings page stays in the nav and reachable, since it
needs no Authentik. Everything else — the Dashboard, provisioning,
maintenance, jobs, `sync-proxy`, and every CLI command — works unchanged.

A persistent banner in the UI and a warning line in the server's startup
log both say so, because in this mode **network reach is the only access
control**: anyone who can connect to the port gets full provisioning
rights. The Windows firewall rule this repo installs (scoped to the
`proxy: true` entry's IP) is what keeps that boundary meaningful.

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
