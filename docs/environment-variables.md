# Environment variables

Almost everything Bellhop is configured with is a setting stored in the
inventory database and edited on the web UI's Settings page or with
`set-config` (see [Integration settings and
secrets](configuration.md#integration-settings-and-secrets)). This page
covers the two kinds of environment variable that remain: overrides, which
pin a setting from outside the database, and variables that only exist in
the environment.

## Overrides

Every integration setting keeps an environment variable that overrides it.
For any of them, the value in use is:

1. the environment variable, when it is set and not empty;
2. otherwise the stored setting;
3. otherwise the built-in default, or "not set".

The value is read each time it is used, so a change saved on the Settings
page or with `set-config` takes effect on the next request (web UI) or the
next run (CLI, MCP server) without a restart — unless an environment
variable pins it. A pinned field is shown read-only on the Settings page,
labelled "set by environment", and the web UI refuses to change it, naming
the variable. `set-config` stores the value anyway and warns that the
variable overrides it, because the shell you run the CLI from does not
necessarily share the web service's environment.

| Environment variable | Setting | Secret |
|---|---|---|
| `WEB_UI_AUTH_MODE` | `webUiAuthMode` | |
| `AUTHENTIK_API_URL` | `authentikApiUrl` | |
| `AUTHENTIK_API_TOKEN` | `authentikApiToken` | yes |
| `AUTHENTIK_ADMIN_GROUP` | `authentikAdminGroup` | |
| `AUTHENTIK_BUILTIN_ADMIN_GROUP` | `authentikBuiltinAdminGroup` | |
| `AUTHENTIK_GROUP_LADDER` | `authentikGroupLadder` | |
| `AUTHENTIK_OUTPOST_NAME` | `authentikOutpostName` | |
| `AUTHENTIK_OUTPOST_PORT` | `authentikOutpostPort` | |
| `AUTHENTIK_AUTHORIZATION_FLOW_SLUG` | `authentikAuthorizationFlowSlug` | |
| `AUTHENTIK_INVALIDATION_FLOW_SLUG` | `authentikInvalidationFlowSlug` | |
| `AUTHENTIK_OIDC_SIGNING_KEY_NAME` | `authentikOidcSigningKeyName` | |
| `CLOUDFLARE_DNS_API_TOKEN` | `cloudflareDnsApiToken` | yes |
| `NPM_API_URL` | `npmApiUrl` | |
| `NPM_API_EMAIL` | `npmApiEmail` | |
| `NPM_API_PASSWORD` | `npmApiPassword` | yes |
| `GITHUB_API_TOKEN` | `githubApiToken` | yes |

What each setting does, and its default, is in [Integration settings and
secrets](configuration.md#integration-settings-and-secrets).

The settings that existed before these (`nfsServer`, `proxyDriver`,
`customScriptsRepo`, ...) have no environment variable, with one per-run
exception: `NFS_SERVER` (see [Not settings](#not-settings) below).

### The data/*.env files

Before the settings store existed, these values lived in three hand-written
files in the data directory: `data/authentik.env`,
`data/cloudflare-api.env` and `data/nginx-proxy-manager.env`. On startup,
the web service, the CLI, the MCP server and the Windows service installer
each copy every value from those files that has no stored setting yet into
the settings store, logging the variable and setting names (never the
values). A setting that already has a stored value is never overwritten,
and the files themselves are never changed.

While a file is still present, its values are also loaded into the
environment, so they keep overriding the stored settings, and the Settings
page shows those fields as "set by environment". Once the Settings page
shows the values you expect, delete the files: from then on the stored
settings are what's in use, and the fields become editable. Copy the
inventory database somewhere safe first if you want a backup — it now
holds the secrets too (see
[Secrets](configuration.md#secrets)).

### Sign-in mode

`webUiAuthMode` (`WEB_UI_AUTH_MODE`) decides how the web UI establishes
who is making a request:

- `auto` (the default when unset) — trusted `X-authentik-*` headers are
  used when present; a request without them is served as a synthetic
  always-admin local operator. This is what lets the toolkit run with no
  identity provider at all.
- `authentik` — strict: trusted headers are required, and a request
  without them gets a 401. **Store this on any deployment where
  authentication is load-bearing.** `auto` cannot distinguish a
  deployment that never had forward-auth from one whose `forward_auth`
  directive just broke; this mode is the guarantee that the second case
  fails closed.
- `none` — always the local operator; trusted headers are ignored.

The Settings page refuses to switch it to `authentik` from a session that
did not itself come through Authentik's forward-auth, and asks for
confirmation before switching away from `authentik` — see [Locked
out](authentik.md#locked-out) for recovering from a wrong value anyway.

### Group ladder upgrades

`authentikGroupLadder` is an ordered, comma-separated Authentik group
ladder, low (broadest audience) to high (narrowest) — it replaced the old
single `AUTHENTIK_APP_USERS_GROUP` variable, which no longer exists. An
inventory entry's `authGroup` names one rung; `sync-authentik` binds its
Application to that rung and every rung above it, so the top rung is
effectively "admin only" with no separate admin OR-check needed. It
defaults to `bellhop-app-users-open,bellhop-app-users,bellhop-users,authentik
Admins`.

**Upgrading from a deployment that relied on the previous default**
(`homelab-app-users-open,homelab-app-users,homelab-users,authentik
Admins`, before the project's rename to Bellhop): stored `authGroup`
values are never rewritten by an upgrade, so set `authentikGroupLadder`
explicitly to the old value **before** upgrading — `AUTHENTIK_GROUP_LADDER`
in `data/authentik.env` works too, and is imported on the first start —
keeping every gated app on its current groups unchanged. If you upgrade
first without doing this, every entry still gated at an old-default rung
is left untouched, not reconciled, until you either set the ladder to the
old value as above, or rename those groups in Authentik to the new default
names and re-tier each affected entry (clear and re-set its access tier)
so its stored `authGroup` matches a rung on the new default ladder.

Until one of these is done, `sync-authentik` reports every affected
entry under "Entries with an unknown authGroup" and leaves its existing
Authentik Application and bindings alone — it is never deleted or
silently rebound.

## Environment-only variables

These are not settings and can only be set in the environment.

- `INVENTORY_FILE` — path to the SQLite inventory database to use. Defaults
  to `inventory/bellhop.db`. Override to point at a temp `.db` fixture (e.g.
  one seeded via `import-yaml-inventory --yaml-path
  inventory/hosts.yaml.example --db-path <temp-path> --apply`), for
  testing without touching real infrastructure. The settings store lives
  in this same database, so the override also selects which settings are
  read.
- `PORT` — port the web UI's Express server listens on (see [Web UI](web-ui.md)).
  Defaults to 3000 if unset, but both `web:dev` and `web:start` set it to
  3001 themselves.
- `WEB_DATA_DIR` — directory the web UI stores its job history SQLite DB
  and job logs in, and where the `data/*.env` files above are looked for.
  Defaults to `data/` in the repo root.
- `WEB_UI_LOCAL_USER` — the username of the synthetic local operator
  described under [Sign-in mode](#sign-in-mode). Defaults to `local`.
  Shown in the UI's "Signed in as" line and recorded as a job's
  `triggered_by_username`.
- `WEB_UI_DEV_USER` / `WEB_UI_DEV_GROUPS` — local-development/test-only
  bypass for the web UI's auth check: when `WEB_UI_DEV_USER` is set, a
  request carrying no `X-authentik-*` headers is treated as signed in as
  this username, in whatever groups `WEB_UI_DEV_GROUPS` names
  (administrator groups included). Real `X-authentik-*` headers still take
  precedence when present, and the bypass applies in `authentik` mode as
  well as `auto` (only `none` ignores it). `web:dev` sets this automatically (to `local-dev`); `npm test` sets
  it too (to `test-user`) so the existing test suite doesn't need to fake
  Authentik headers on every request. **Never set this in the production
  Windows service's environment** — doing so would disable auth entirely
  for the real deployment (see [Web UI](web-ui.md)).
- `SSH_AUTH_SOCK` — the SSH agent socket, used only when none of the
  default identity files (`~/.ssh/id_ed25519`, `id_ecdsa`, `id_rsa`) exists
  and a host has no `ssh_identity_file` of its own. On Windows, Pageant is
  used instead.

## Not settings

These stay exactly as they were and are not part of the settings store:

- `deploy-vpn-gateway` credentials (`NORDVPN_ACCESS_TOKEN`,
  `PIA_USERNAME`/`PIA_PASSWORD`) — the web form (Provisioning page's Deploy
  VPN Gateway) collects them in its own required, per-provider credential
  fields, so there is nothing to create on disk for the web path; the
  CLI's own `deploy-vpn-gateway` keeps reading them from the environment
  (an operator's own interactive shell has them exported).
- `NFS_SERVER` — a per-run override for the inventory-wide `nfsServer`
  setting (see [Inventory-wide settings](configuration.md#inventory-wide-settings)): the NAS IP
  `migrate-nfs-mount` matches fstab entries against, and that
  `sync-inventory`'s own fstab scan looks for. With neither this nor
  `nfsServer` set, `migrate-nfs-mount` fails and `sync-inventory` skips its
  NFS scan.
- `FSTAB_PATH` — path to the guest fstab file `migrate-nfs-mount` reads and
  edits (it's the only command left that touches guest fstab — see
  `audit-nfs-mounts` in [Commands](commands.md), which reads parent-host `pct config` instead).
  Defaults to `/etc/fstab`. Override to point at a temp file for testing.
- `CLOUDFLARE_API_TOKEN` — Caddy's own token for Cloudflare DNS-01
  issuance, set in Caddy's environment on the proxy host (see the [Caddy
  driver](reverse-proxy/caddy.md)). Bellhop never reads it; its own
  Cloudflare token is the separate `cloudflareDnsApiToken` setting, so
  each can be revoked without breaking the other.
