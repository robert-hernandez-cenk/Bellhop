# Configuration

How the inventory is set up, and the inventory-wide settings Bellhop reads from it.

## Hand-editing the inventory

To hand-edit real Proxmox hosts and guests before importing them, copy
`inventory/hosts.yaml.example` to `inventory/hosts.yaml` first and edit
that copy. See the comments in the example file for the schema (`domain`,
`hosts[]` — each with an `ssh_user` (the SSH login user for that host —
Proxmox generally only allows `root`) and an optional `midScheme`
(`vmidBase`/`ipPrefix`/`gateway`) used by `--mid` (see [Commands](commands.md)) — `guests[]`, optional
`subdomains`/`ip`/`port`/`proxy`/`insecureBackendTls` fields —
`subdomains` is a list, so one host/guest can front more than one;
`insecureBackendTls` is for a backend that serves HTTPS with a
self-signed cert. A top-level `externalSites[]` covers reverse-proxy
targets that aren't a Proxmox host or guest at all, e.g. a NAS — see the
example file). `inventory/hosts.yaml` itself is never read by any command
other than `import-yaml-inventory` — everything else reads
`inventory/bellhop.db`, so re-run the import command in [Setup](../README.md#setup) any time you
change the hand-edited `hosts.yaml` copy.

## Inventory-wide settings (before your first sync)

A few operator-specific values — your NAS's `nfsServer` IP chief among
them — live in the inventory database rather than in code, and are unset
by default. Set them before your first `sync-inventory`, so it can do
things like discover NFS mounts right away instead of skipping that scan
and printing a reminder:

```bash
npm run bellhop -- set-config nfsServer <ip> --apply
```

The web UI's Settings page sets the same values, for anyone who'd rather
not use the CLI. See [Inventory-wide settings](#inventory-wide-settings) below for the full list and
what happens when a value stays unset. If you're hand-editing
`inventory/hosts.yaml` for `import-yaml-inventory` instead, these keys can
go there too — see the commented `nfsServer`/`backupStorage`/`dnsServer`/
`statusPagePath` keys in `inventory/hosts.yaml.example`.

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
field never clears its stored value — see
[Reverse proxy drivers](reverse-proxy/README.md).

| Setting | Used by | When unset |
|---|---|---|
| `nfsServer` | `sync-inventory`, `migrate-nfs-mount` | `sync-inventory` skips its NFS scan; `migrate-nfs-mount` fails |
| `backupStorage` | `migrate-guest` | `--backup-storage` becomes required |
| `dnsServer` | `set-guest-vpn` | `set-guest-vpn` fails |
| `statusPagePath` | `render-status-page` | the status page is never rendered |
| `proxyDriver` | `sync-proxy`, `render-status-page`, every OIDC/forward-auth capability check | `caddy`, the default — allowed values are `caddy`/`nginx`/`nginx-proxy-manager`/`haproxy`/`none` |
| `proxyConfigPath` | same as `proxyDriver` | the active driver's own default config path (`/etc/caddy/Caddyfile` for Caddy, `/etc/nginx/conf.d/bellhop.conf` for nginx, `/etc/haproxy/bellhop.cfg` for HAProxy, which also writes `bellhop.map` in the same directory; `nginx-proxy-manager` and `none` have no config file at all, and hide this field on the Settings page) |
| `proxyTlsCertificate` | the nginx driver | certbot's own default certificate path for the inventory domain; ignored by Caddy, `nginx-proxy-manager`, `haproxy`, and `none`, and shown on the Settings page only while nginx is selected |
| `proxyTlsKey` | the nginx driver | certbot's own default key path for the inventory domain; ignored by Caddy, `nginx-proxy-manager`, `haproxy`, and `none`, and shown on the Settings page only while nginx is selected |
| `customScriptsRepo` | `install-app`, `update-app`, the app catalog | apps resolve from ProxmoxVE/ProxmoxVED only, same as today |
| `customScriptsBranch` | same as `customScriptsRepo` | same as `customScriptsRepo` |

See [Reverse proxy drivers](reverse-proxy/README.md) for what `proxyDriver`, `proxyConfigPath`,
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
