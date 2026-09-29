# Environment variables

Environment variables and local files that override Bellhop's defaults.

- `INVENTORY_FILE` — path to the SQLite inventory database to use. Defaults
  to `inventory/bellhop.db`. Override to point at a temp `.db` fixture (e.g.
  one seeded via `import-yaml-inventory --yaml-path
  inventory/hosts.yaml.example --db-path <temp-path> --apply`), for
  testing without touching real infrastructure.
- `FSTAB_PATH` — path to the guest fstab file `migrate-nfs-mount` reads and
  edits (it's the only command left that touches guest fstab — see
  `audit-nfs-mounts` in [Commands](commands.md), which reads parent-host `pct config` instead).
  Defaults to `/etc/fstab`. Override to point at a temp file for testing.
- `NFS_SERVER` — a per-run override for the inventory-wide `nfsServer`
  setting (see [Inventory-wide settings](configuration.md#inventory-wide-settings)): the NAS IP
  `migrate-nfs-mount` matches fstab entries against, and that
  `sync-inventory`'s own fstab scan looks for. No longer has a hardcoded
  default (issue #124) — with neither this nor `nfsServer` set,
  `migrate-nfs-mount` fails and `sync-inventory` skips its NFS scan.
- `PORT` — port the web UI's Express server listens on (see [Web UI](web-ui.md)).
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
  forward-auth setup (see [Web UI](web-ui.md)).
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
  new OpenID client (native OIDC gating, see [OIDC mode](authentik.md#oidc-mode)) signs its
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
  set `WEB_UI_AUTH_MODE=authentik`** — see [Running without
  Authentik](authentik.md#running-without-authentik) for why.
- `data/nginx-proxy-manager.env` (required only when `proxyDriver` is
  `nginx-proxy-manager` — see [Nginx Proxy Manager
  driver](reverse-proxy/nginx-proxy-manager.md)) — a gitignored file
  holding `NPM_API_EMAIL`/`NPM_API_PASSWORD`, the admin credentials
  `sync-proxy` logs into Nginx Proxy Manager's REST API with, and the
  optional `NPM_API_URL` override. Loaded by the CLI, the web UI, and the
  MCP server, same as the other files in this section. Unset
  `NPM_API_URL` derives `http://<the proxy: true entry's ip>:81` from
  inventory instead — NPM's own admin UI/API port.
- `data/cloudflare-api.env` (optional) — a gitignored file holding
  `CLOUDFLARE_DNS_API_TOKEN`, a Cloudflare API token scoped to Zone:Read +
  DNS:Edit on the inventory `domain`'s zone. Loaded by both the CLI and the
  web UI. With it set, `prune-acme-challenges [--apply]` and the web UI's
  push-live step delete `_acme-challenge` TXT records untouched for over
  24h. Without it, the CLI command reports that it is not configured and
  the web UI skips the step with one log line; nothing else changes. Mint a
  dedicated token rather than reusing Caddy's own, so revoking one never
  breaks certificate issuance.
