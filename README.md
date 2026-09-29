# Bellhop

A self-hosted app store for your Proxmox VE homelab. Bellhop installs
appliances from [community-scripts](https://github.com/community-scripts/ProxmoxVE)
into new LXC containers, then handles what comes after: inventory,
reverse-proxy routes (Caddy or nginx, through a pluggable driver — see
[Reverse proxy drivers](docs/reverse-proxy/README.md)), Authentik login
gating, updates, and migrations between hosts. It ships as a web UI, a
CLI, and an MCP server, and reaches your Proxmox hosts over SSH from your
local machine.

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

The example file's hosts are placeholders, so importing it only lets you
look around. To manage your own Proxmox hosts, copy it to
`inventory/hosts.yaml`, replace its hosts with yours, and import that
copy before continuing — the file's schema is in
[Hand-editing the inventory](docs/configuration.md#hand-editing-the-inventory).

A few operator-specific values — your NAS's `nfsServer` IP chief among
them — live in the inventory database rather than in code, and are unset
by default. Set them before your first `sync-inventory`, so it can do
things like discover NFS mounts right away instead of skipping that scan
and printing a reminder:

```bash
npm run bellhop -- set-config nfsServer <ip> --apply
```

The web UI's Settings page sets the same values. See
[Configuration](docs/configuration.md) for the full list and what happens
when a value stays unset.

With your own hosts imported, pull their real guests into the inventory —
a dry run first, then `--apply` to write them:

```bash
npm run bellhop -- sync-inventory
npm run bellhop -- sync-inventory --apply
```

Finally, start the web UI on port 3001:

```bash
npm run web:build
npm run web:start
```

See [Web UI](docs/web-ui.md) for the development server, authentication,
and what each page does.

## Commands

All commands are run as `bellhop <command> [flags]` (after `npm link`)
or `npm run bellhop -- <command> [flags]`. Anything that changes
infrastructure or the inventory prints a dry run by default and only acts
with `--apply`. The main ones:

| Command | What it does |
|---|---|
| `sync-inventory` | Reconcile the inventory's guests with what each Proxmox host actually runs |
| `install-app` | Create a new LXC from a community-scripts app installer |
| `update-app` | Re-run an app's installer inside its guest to update it |
| `update-all` | Update OS packages on hosts and LXC guests |
| `create-lxc` / `create-vm` | Create a bare container or VM from a Machine ID |
| `configure-guest` | Install packages or an SSH key on a guest |
| `guest-power` | Start or shut down a guest |
| `migrate-guest` | Move a guest to another Proxmox host |
| `delete-guest` | Stop, optionally back up, and destroy a guest |
| `attach-nfs-mount` | Give an existing guest a NAS share through its host |
| `sync-proxy` | Write the reverse-proxy configuration and reload the proxy |
| `sync-authentik` | Reconcile Authentik applications, OpenID clients, and access tiers |
| `set-config` | Set an inventory-wide setting |

[Commands](docs/commands.md) has every command, its flags, and how each one
behaves.

## Documentation

- [Commands](docs/commands.md) — every command, with examples.
- [Configuration](docs/configuration.md) — the inventory file, inventory-wide
  settings, and installing apps from your own script repository.
- [Environment variables](docs/environment-variables.md) — overrides and
  the local `data/*.env` files.
- [Web UI](docs/web-ui.md) — running the dashboard and how it authenticates.
- [MCP server](docs/mcp-server.md) — Bellhop's operations as tools for an AI
  assistant.
- [Authentik](docs/authentik.md) — running without it, and gating apps
  through OpenID Connect (OIDC mode).
- [Reverse proxy drivers](docs/reverse-proxy/README.md) — how `sync-proxy`
  manages a proxy, with a page per driver: [Caddy](docs/reverse-proxy/caddy.md)
  and [nginx](docs/reverse-proxy/nginx.md).
- [Troubleshooting](docs/troubleshooting.md) — running the checks, and known
  hardware issues.
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
