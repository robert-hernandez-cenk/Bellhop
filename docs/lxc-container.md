# Running Bellhop in an LXC container

The recommended way to run Bellhop's web service is an LXC container on one
of your Proxmox hosts, created by a community-scripts installer: the same
`build.func` engine as the community scripts you already install apps with.
The installer lives in the
[ProxmoxVED fork](https://github.com/robert-hernandez-cenk/ProxmoxVED)
(`ct/bellhop.sh`, `install/bellhop-install.sh`), not in this repository.

Running it as a Windows service (`npm run service:install`) still works but
is deprecated, and will be removed in a future update (#68).

## What the installer does

- Creates an unprivileged Debian 13 container: 2 cores, 2048 MB RAM, an
  8 GB disk. Override any of them with the usual `var_cpu`, `var_ram`,
  `var_disk` and the other `var_*` variables.
- Installs Node 24 and a C/C++ toolchain. `npm ci` runs `node-gyp` on
  `better-sqlite3`, so the toolchain is needed even though the package ships
  prebuilt binaries.
- Deploys the latest [GitHub release](https://github.com/robert-hernandez-cenk/Bellhop/releases)
  to `/opt/bellhop`, installs its dependencies and builds the web client.
  The installer needs a published release; it cannot install from a branch.
- Generates an SSH key for root (`/root/.ssh/id_ed25519`), only if there is
  none yet.
- Registers `bellhop.service`, which starts at boot and restarts on failure,
  serving the web UI on port 3000.
- Adds a `bellhop` command that runs the CLI against the same database and
  data directory as the service.

It asks nothing beyond the standard container prompts, and nothing at all in
an unattended install. It never asks for a secret. Sign-in and integrations
are configured from Bellhop itself, after the install.

When it finishes, it prints the web UI address, the container's SSH public
key, and the `set-config bellhopGuest` line to run later (step 3 below).

## Where things live

| Path | Contents | Replaced on update |
|---|---|---|
| `/opt/bellhop` | the release's code, `node_modules`, the built web client | yes |
| `/var/lib/bellhop/inventory/bellhop.db` | the inventory and every setting and secret | no |
| `/var/lib/bellhop/data` | job history, job logs, sign-in sessions | no |
| `/root/.ssh/id_ed25519` | the key Bellhop reaches your hosts with | no |
| `/etc/default/bellhop` | `PORT`, `INVENTORY_FILE`, `WEB_DATA_DIR` | no |

`INVENTORY_FILE` and `WEB_DATA_DIR` are the same
[environment variables](environment-variables.md#environment-only-variables)
any Bellhop install honors. The container only points them outside the
application directory. Include `/var/lib/bellhop` in your container backups.

## First run

### 1. Trust the container's key on your hosts

Bellhop reaches every Proxmox host over SSH as root. Add the public key the
installer printed to `/root/.ssh/authorized_keys` on a Proxmox node. In a
cluster that file is a link to the cluster-shared
`/etc/pve/priv/authorized_keys`, so adding it on one node covers every node.
To print the key again, run this inside the container:

```bash
cat /root/.ssh/id_ed25519.pub
```

A standalone host (not in a cluster) needs the key added on each host.

### 2. Create the inventory

A fresh container has no inventory. Write a `hosts.yaml` for your hosts:
copy `/opt/bellhop/inventory/hosts.yaml.example` and edit it (see
[Hand-editing the inventory](configuration.md#hand-editing-the-inventory)).
Then import it into the container's database:

```bash
cp /opt/bellhop/inventory/hosts.yaml.example /root/hosts.yaml
nano /root/hosts.yaml
bellhop import-yaml-inventory --yaml-path /root/hosts.yaml --db-path /var/lib/bellhop/inventory/bellhop.db --apply
```

`import-yaml-inventory` replaces the whole inventory, including every
setting, with what the file holds. Run it once to bootstrap; after that,
change settings with `set-config` or on the Settings page.

### 3. Mark the container as Bellhop's own guest

```bash
bellhop set-config bellhopGuest <container-hostname> --apply
```

The installer printed this line with the hostname filled in. You can also
put `bellhopGuest: <container-hostname>` in `hosts.yaml` before importing.
See [Bellhop's own guest](#bellhops-own-guest) below for what it does.

### 4. Pull in your guests

```bash
bellhop sync-inventory
bellhop sync-inventory --apply
```

`sync-inventory` names guests after their Proxmox hostname, so the container
appears under the name `bellhopGuest` already holds.

### 5. Settings and integrations

Set the [inventory-wide settings](configuration.md#inventory-wide-settings)
(`nfsServer`, `dnsServer`, ...) and the [integration settings and
secrets](configuration.md#integration-settings-and-secrets) (Authentik,
Cloudflare, ...) with `bellhop set-config` or on the web UI's Settings page,
at `http://<container-ip>:3000`.

### 6. Turn on sign-in before exposing the UI

The web UI starts with sign-in off (`webUiAuthMode` unset means `none`):
anyone who can reach port 3000 is a full administrator. Before the UI is
reachable from anywhere you don't fully trust, set up sign-in through
Authentik (see [Sign-in mode](environment-variables.md#sign-in-mode)).

Sign-in needs an HTTPS address, so put the web UI behind your reverse proxy
first. The container's own inventory entry is "Bellhop's own entry" in
[Web login: Setting it up](authentik.md#setting-it-up). Give it
`subdomains` (for example `bellhop`, for `https://bellhop.example.com`) and
`port: 3000`, by editing the guest in the web UI, then follow those steps.

The container needs no firewall rule restricting who can reach the port.
Bellhop signs users in through its own OIDC client and never trusts identity
headers, so a request's source address grants nothing.

## Updating

Bellhop updates like any community-script app. Run the script's update from
inside the container:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/robert-hernandez-cenk/ProxmoxVED/local/ct/bellhop.sh)"
```

If a newer release exists, the update stops the service, replaces
`/opt/bellhop` with that release, reinstalls its dependencies, rebuilds the
web client and starts the service again. If not, it changes nothing. It
never touches `/var/lib/bellhop`, `/etc/default/bellhop` or `/root/.ssh`.

Bellhop cannot update its own container (`update-app` refuses it; see
below), so this is the way to update Bellhop.

## Bellhop's own guest

Some actions on the container Bellhop runs in would cut off the service
performing them. With `bellhopGuest` set to the container's inventory name:

- `update-app`, `delete-guest`, `migrate-guest` and guest start/shutdown
  refuse that guest, in a dry run too, from the CLI, the web UI and the MCP
  server alike. There is no override: act on it in Proxmox directly, or
  update it with the script above.
- `update-all` skips it and reports it as skipped. Every other target is
  updated as usual.

With `bellhopGuest` unset, nothing is protected. Change or clear it with
`bellhop set-config bellhopGuest ...` or on the Settings page (General tab).

## Not covered yet

- The MCP server runs over stdio from wherever your MCP client runs; a
  network transport, and with it a second service in this container, is
  #65.
