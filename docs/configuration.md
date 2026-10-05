# Configuration

How the inventory is set up, the inventory-wide settings Bellhop reads from it, and the integration settings and secrets stored alongside them.

## Creating the inventory

A fresh install creates its inventory through the web UI's first-run setup
walkthrough (see [First-run setup](setup.md)): it adds your Proxmox hosts,
discovers their bridges, storage and guests with `sync-inventory`, and
sets the domain and the other values below. After setup, `sync-inventory`
keeps hosts and guests in step with Proxmox, the Dashboard edits each
guest, and `set-config` or the Settings page changes the inventory-wide
values. Set `nfsServer` before a `sync-inventory` that should discover NFS
mounts, or it skips that scan and prints a reminder.

For a sample inventory to explore the CLI against, write the demo inventory
to a throwaway database with `npm run demo:seed -- <path>` and point
`INVENTORY_FILE` at it (see [Environment variables](environment-variables.md)).

## Inventory-wide settings

Sixteen values live in the inventory database rather than in code, because
they are specific to your network (the integration settings are covered
separately, under [Integration settings and
secrets](#integration-settings-and-secrets)). Set them with `set-config`:

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
currently selected in that dropdown (unsaved changes included); the
TLS source dropdown (`tlsSource`) appears for every driver that manages a
proxy, listing only the sources that driver supports, with the ACME DNS
provider shown only while the shown source is `acme-dns` and the Proxy TLS
certificate/key fields only while it is `files` (the shown source being the
unsaved choice, else the stored one, else the driver's default); the
Proxy cert resolver field appears only while Traefik is selected with an
`acme-dns`/`acme-http` source, the Proxy API URL field only while Traefik is selected,
and Proxy config path is hidden for a driver with no config file (Caddy
(admin API), Nginx Proxy Manager). Hiding a field never clears its stored
value — see
[Reverse proxy drivers](reverse-proxy/README.md).

| Setting | Used by | When unset |
|---|---|---|
| `domain` | `sync-proxy`, `sync-authentik`, `prune-acme-challenges`, `set-guest-vpn` | No entry can have subdomains (the inventory refuses them), so there is nothing to route; commands that need it fail naming `set-config domain` |
| `nfsServer` | `sync-inventory`, `migrate-nfs-mount` | `sync-inventory` skips its NFS scan; `migrate-nfs-mount` fails |
| `backupStorage` | `migrate-guest` | `--backup-storage` becomes required |
| `dnsServer` | `set-guest-vpn` | `set-guest-vpn` fails |
| `statusPagePath` | `render-status-page` | the status page is never rendered |
| `proxyDriver` | `sync-proxy`, `render-status-page`, every OIDC/forward-auth capability check | `caddy`, the default — allowed values are `caddy`/`caddy-api`/`nginx`/`nginx-proxy-manager`/`haproxy`/`traefik`/`none` |
| `proxyConfigPath` | same as `proxyDriver` | the active driver's own default config path (`/etc/caddy/Caddyfile` for Caddy, `/etc/nginx/conf.d/bellhop.conf` for nginx, `/etc/haproxy/bellhop.cfg` for HAProxy, which also writes `bellhop.map` in the same directory, `/etc/traefik/dynamic/bellhop.yml` for Traefik; `caddy-api`, `nginx-proxy-manager`, and `none` have no config file at all, and hide this field on the Settings page) |
| `tlsSource` | `sync-proxy` and `convert-caddyfile` (every driver that renders certificate configuration), and the push-live step's `prune-acme-challenges` | the active driver's own default (`acme-dns` for Caddy, Caddy (admin API) and Traefik; `files` for nginx; `acme-http` for Nginx Proxy Manager; `external` for HAProxy and `none`) — allowed values are `acme-dns`/`acme-http`/`internal`/`files`/`external`; which ones each driver supports is in [TLS sources](reverse-proxy/README.md#tls-sources). Checked only against that list when written, never against the active driver |
| `acmeDnsProvider` | `tlsSource: acme-dns` | `cloudflare`, the default and only allowed value |
| `proxyTlsCertificate` | `tlsSource: files` (nginx's only source; an option for both Caddy drivers and Traefik) | certbot's own default certificate path for the inventory domain; ignored under every other source, and shown on the Settings page only while the shown TLS source is `files` |
| `proxyTlsKey` | `tlsSource: files` (same as `proxyTlsCertificate`) | certbot's own default key path for the inventory domain; ignored under every other source, and shown on the Settings page only while the shown TLS source is `files` |
| `proxyCertResolver` | the Traefik driver, under `tlsSource` `acme-dns`/`acme-http` | `cloudflare`, the default ACME certificate resolver name every rendered router's `tls.certResolver` is set to — any resolver name is allowed (`none` is no longer reserved: `tlsSource: external` replaced it); ignored by every other driver and under `files`/`external`, and shown on the Settings page only while Traefik is selected with one of those two sources |
| `proxyApiUrl` | the Traefik driver | no post-apply check at all — the file is written and trusted to load; set to Traefik's API address as reachable from the proxy host to have every apply confirm it loaded before succeeding; ignored by every other driver, and shown on the Settings page only while Traefik is selected |
| `customScriptsRepo` | `install-app`, `update-app`, the app catalog | apps resolve from ProxmoxVE/ProxmoxVED only, same as today |
| `customScriptsBranch` | same as `customScriptsRepo` | same as `customScriptsRepo` |
| `pveUserRealm` | `create-vm`'s web-UI creator grant | the creator grant is off entirely |
| `pveCreatorRole` | same as `pveUserRealm` | `PVEVMAdmin` |

See [Reverse proxy drivers](reverse-proxy/README.md) for what `proxyDriver`, `proxyConfigPath`,
`tlsSource`/`acmeDnsProvider` ([TLS sources](reverse-proxy/README.md#tls-sources)),
`proxyTlsCertificate`/`proxyTlsKey`, and the [Traefik
driver](reverse-proxy/traefik.md)'s `proxyCertResolver`/`proxyApiUrl`
actually do. See [Proxmox access for VM creators](proxmox-access.md) for
what `pveUserRealm`/`pveCreatorRole` actually do.

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
head-commit pin, so each resolution uses two of GitHub's 60 anonymous
requests per hour (or of a token's much larger allowance — see [GitHub
token](#github-token)). The web UI resolves separately for the App check, a
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

Without a `githubApiToken`, those `api.github.com` requests are anonymous,
and GitHub's anonymous rate limit is 60 requests per hour per source IP,
shared with anything else on your network making anonymous GitHub API
calls. Hitting that limit fails the operation with a named error (GitHub's
non-200 status is reported verbatim) rather than silently falling back to
upstream. Setting a [GitHub token](#github-token) lifts the limit for
every Bellhop request to GitHub's API.

Two related values are *derived*, not configured: `set-guest-vpn --vpn
none` restores the guest's parent host's `midScheme.gateway`, and the
Windows service's firewall rule scopes to the `proxy: true` entry's `ip`.
This is a real behavior narrowing, not just a literal removed: previously
`--vpn none` always restored the same hardcoded LAN gateway regardless of
the guest's host; now it requires that host to have a `midScheme`
configured, and fails with a named error (`'<host>' has no midScheme, so
there is no LAN gateway to restore '<guest>' to`) if it doesn't.

## Integration settings and secrets

How Bellhop reaches Authentik, Cloudflare, Nginx Proxy Manager and GitHub,
and how the web UI signs people in, are settings too, stored in the same
inventory database and set the same two ways: on the web UI's Settings
page or with `set-config`. Each one can also be pinned by an environment
variable — see [Environment variables](environment-variables.md) for the
variable names and the precedence rule. A saved value is used from the
next request (web UI) or the next run (CLI, MCP server), with no restart.

The Settings page groups everything by integration, one tab each:
General, Proxy, Authentik, Cloudflare and GitHub — the Nginx Proxy
Manager fields below live on the Proxy tab, shown only while Nginx Proxy
Manager is the selected driver.

| Setting | Tab | When unset |
|---|---|---|
| `webUiAuthMode` | General | `none` — see [Sign-in mode](environment-variables.md#sign-in-mode) |
| `webUiOidcIssuer` | General | web login is not configured — see [Web login](authentik.md#web-login) |
| `webUiOidcClientId` | General | web login is not configured |
| `webUiOidcRedirectUri` | General | web login is not configured |
| `webUiOidcClientSecret` (secret) | General | web login is not configured |
| `authentikApiUrl` | Authentik | the Authentik integration is off (no Users/Permissions pages, no `sync-authentik`) |
| `authentikApiToken` (secret) | Authentik | the Authentik integration is off |
| `authentikAdminGroup` | Authentik | `bellhop-admins` |
| `authentikBuiltinAdminGroup` | Authentik | `authentik Admins` |
| `authentikGroupLadder` | Authentik | `bellhop-app-users-open,bellhop-app-users,bellhop-users,authentik Admins` |
| `authentikOutpostName` | Authentik | `authentik Embedded Outpost` |
| `authentikOutpostPort` | Authentik | `9000` |
| `authentikAuthorizationFlowSlug` | Authentik | `default-provider-authorization-implicit-consent` |
| `authentikInvalidationFlowSlug` | Authentik | `default-invalidation-flow` |
| `authentikOidcSigningKeyName` | Authentik | `authentik Self-signed Certificate` |
| `cloudflareDnsApiToken` (secret) | Cloudflare | `prune-acme-challenges` reports it is not configured; the web UI's push-live step skips it |
| `npmApiUrl` | Proxy (Nginx Proxy Manager driver) | `http://<the proxy: true entry's ip>:81` |
| `npmApiEmail` | Proxy (Nginx Proxy Manager driver) | the Nginx Proxy Manager driver cannot sync |
| `npmApiPassword` (secret) | Proxy (Nginx Proxy Manager driver) | the Nginx Proxy Manager driver cannot sync |
| `githubApiToken` (secret) | GitHub | GitHub API requests are anonymous |

Both the API URL and the token must be set for the Authentik integration
to be on. `cloudflareDnsApiToken` is a Cloudflare token scoped to Zone:Read
and DNS:Edit on the inventory `domain`'s zone; mint a dedicated one rather
than reusing Caddy's own `CLOUDFLARE_API_TOKEN`, so revoking one never
breaks certificate issuance. The Nginx Proxy Manager settings are needed
only with `proxyDriver` set to `nginx-proxy-manager` (see [Nginx Proxy
Manager driver](reverse-proxy/nginx-proxy-manager.md)).

Saving either admin group asks for confirmation first, and is refused if
you would no longer be an administrator under the new names. See [Web
UI](web-ui.md#settings-page) for those and the sign-in mode's guards.

### Secrets

The five secrets — `authentikApiToken`, `cloudflareDnsApiToken`,
`npmApiPassword`, `githubApiToken` and `webUiOidcClientSecret` — are write-only. Bellhop uses them,
but never shows them again: the Settings page and its API report only
whether each is set and where the value comes from, and no log line, job
record, error message, status page or inventory snapshot ever carries one.
On the Settings page each is a masked input with Replace and Clear, empty
again after every save.

On the CLI a secret is never an argument, so it can't end up in your shell
history. Pipe it in with `--stdin`, or leave the value off at a terminal to
be prompted without echo:

```bash
printf '%s' "$TOKEN" | bellhop set-config githubApiToken --stdin --apply
bellhop set-config githubApiToken --apply            # prompts for the value
bellhop set-config githubApiToken --unset --apply    # clears it
```

`set-config <secret> <value>` is refused, and the dry run prints `Would set
<key> (value hidden)`. The MCP server can neither read nor write a secret.

Write-only is not encryption: secrets are stored in plain text in the
inventory database (`inventory/bellhop.db`), in a table of their own, just
as they were in plain text in the old `data/*.env` files. Anyone who can
read that file can read them, and every backup or copy of the database
carries them — protect it accordingly.

### Moving off the data/*.env files

An existing deployment configured through `data/authentik.env`,
`data/cloudflare-api.env` and `data/nginx-proxy-manager.env` needs no
manual migration. On the first start of the new version, each entry point
(web service, CLI, MCP server, Windows service installer) copies every
value from those files that has no stored setting into the settings store
and logs which ones it imported — by name, never by value. It never
overwrites a stored setting and never changes the files, so later starts
import nothing.

A file that is still present keeps overriding the stored settings, and the
Settings page shows those fields as "set by environment" and read-only.
Under each such field the page also shows the store's own copy — "Stored
copy: <value>" for a setting, "Stored copy: set" for a secret, or "Stored
copy: not set" if nothing was imported. To finish the move:

1. On the Settings page, check every field marked "set by environment"
   shows a stored copy. On a production deployment, make sure **Web UI
   sign-in** (`webUiAuthMode`) shows "Stored copy: oidc" before
   deleting `data/authentik.env` (the import copies it from there if the
   file sets `WEB_UI_AUTH_MODE`, which must be `oidc` or `none`), or the
   web UI falls back to `none`.
2. Delete the files.
3. Restart the web service, and any long-running MCP server. A running
   process keeps the variables it loaded from the files at startup, so the
   fields stay "set by environment" until it restarts; after that the
   stored settings take over and the fields become editable.

### GitHub token

The daily app update check, the custom script repository's pin and
compare, and the Install App catalog all call GitHub's API. Without a
token they share GitHub's anonymous limit of 60 requests an hour per
source address. Set `githubApiToken` and every one of those requests is
authenticated instead, under GitHub's much higher per-token limit.

Bellhop only reads public repositories, so a [fine-grained personal access
token](https://github.com/settings/personal-access-tokens) with **no
repository permissions** is enough — choose "Public repositories" as its
repository access and grant nothing else. If GitHub rejects the token, the
request fails with an error naming `githubApiToken` and the Settings page,
never the token itself; replace it or clear it to go back to anonymous
requests.
