# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run typecheck   # tsc --noEmit — run after editing any TypeScript file
npm test            # node's built-in test runner, all *.test.ts under test/
```

Run any command from the repo root as `npm run bellhop -- <command> [flags]`
(or `bellhop <command> [flags]` once `npm link` has been run once to expose
the `bellhop` bin globally). Provisioning and networking commands default
to a dry run that only prints what they would do; pass `--apply` to actually
execute.

To verify a command's behavior without touching real infrastructure, override
`INVENTORY_FILE` to point at a temp SQLite fixture rather than the real
`inventory/bellhop.db` — build one with `saveInventory(tempPath, inv)` (see any
file under `test/commands/`/`test/web/routes/` for the pattern: a
`mkdtempSync`'d directory plus a `bellhop.db` filename), or with
`import-yaml-inventory --yaml-path inventory/hosts.yaml.example --db-path
<tempPath> --apply` for a fixture seeded from the example file's shape.
There's no comment concept to worry about losing on a write the way the old
`hosts.yaml` text file had — a `better-sqlite3` connection just has rows.
`inventoryPath()` in `src/cli.ts` honors `INVENTORY_FILE` the same way the
bash version's `INVENTORY_FILE` env var did (now defaulting to
`inventory/bellhop.db` rather than `inventory/hosts.yaml`). For unit-testing
command *logic*
(as opposed to exercising the real CLI), inject a `FakeSSHClient` (from
`test/support/fake-ssh-client.ts`) as the command's `ssh` dependency instead
of mocking `ssh`/`pct`/`qm` binaries on `PATH` — there is no `PATH`-binary
layer to mock anymore, since remote execution goes through the `ssh2` npm
library rather than shelling out to a system `ssh` client. See any file
under `test/commands/` for the pattern: build a `FakeSSHClient` with a
`(sshTarget, sshUser, command) => ExecResult` responder, pass it as `ssh` in
the command function's `deps` argument, and assert on `ssh.history` and the
function's return value. The one exception is a file-configured proxy
driver's generated shell script (`src/lib/proxy/file-driver.ts`): it may be
executed locally under `sh` with that proxy's own binaries (e.g. `caddy`,
`systemctl`) stubbed on `PATH`, to prove its backup/restore control flow
actually restores — see `test/lib/proxy/file-driver.test.ts` — distinct
from the SSH/exec layer above, which stays `FakeSSHClient`-only.

`src/lib/ssh-client.ts`'s `Ssh2SSHClient` is the only file that actually
opens an SSH connection; it has no automated test (verify it manually
against real infrastructure) — every other file is covered by `npm test`.

## Architecture

Every command imports from `src/lib/`, which is the single place that knows
how to reach a target and is the only code that talks to `ssh2` directly:

- **Inventory** (`inventory/bellhop.db`, a SQLite database, contains real
  hostnames/IPs and is a binary file — `git diff` on it shows "binary file changed" rather
  than a meaningful per-field diff, an accepted tradeoff of moving off a
  hand-edited YAML file — infra-change history stops being human-readable
  in git going forward. As of 2026-08-13 it is gitignored, not committed
  to this repo at all — issue #116: this repo is public, so no future
  commit can ever pick up real operational data again.
  Each checkout/worktree keeps its own real `.db` file on disk (see "New
  branches are git worktrees" below for how a fresh worktree gets one);
  git itself never tracks it, so there's no per-checkout index flag to
  maintain the way the file's older skip-worktree setup needed.
  `inventory/hosts.yaml.example`
  remains as
  documentation of the schema shape only; nothing in this codebase parses
  it anymore. The one-time `import-yaml-inventory` CLI command
  (`src/cli.ts`) reads a `hosts.yaml`-shaped file and calls `saveInventory`
  against a fresh `.db` path to populate it — the way to go from a
  hand-edited copy of the example to a real `bellhop.db`) lists Proxmox hosts
  (`hosts[]`) and their LXC/VM guests
  (`guests[]`), typed and validated by the `zod` schema in
  `src/lib/inventory.ts` (`HostEntrySchema`/`GuestEntrySchema`/
  `InventorySchema`). Every host carries `ssh_user` (enforced non-empty by
  the schema itself, `z.string().min(1)`) — the SSH login user
  `Ssh2SSHClient`/`runRemote` use, since a guest has no SSH login of its own
  and always resolves its `ssh_user`/`ssh_target` from its *parent host*.
  Two optional per-host connection fields sit alongside it: `ssh_port`
  (omitted means ssh2's own default of 22) and `ssh_identity_file` (omitted
  means the global `~/.ssh/id_ed25519` -> `id_ecdsa` -> `id_rsa` lookup, with
  an agent fallback). `ssh_identity_file` resolves a bare filename against
  `~/.ssh/`, expands a leading `~`, and treats anything else as an ordinary
  path; when set it must be readable — `resolvePrivateKey`
  (`src/lib/ssh-client.ts`) throws naming the host and resolved path rather
  than silently falling back, since a per-host override is a deliberate
  operator statement and a quiet fallback would surface much later as an
  opaque sshd auth failure. Passphrase-protected keys are not supported
  (issue #122 scoped them out) — use an agent for one. `ProxyJump`/bastion
  tunneling is likewise out of scope.
  Guests reference their parent host by name and carry a `vmid`. Optional
  `subdomains`/`ip`/`port`/`insecureBackendTls` fields drive reverse-proxy
  generation through whichever driver is active (issue #10 — see the
  "Reverse-proxy driver interface" bullet below; Caddy and nginx, issue
  #30, are the two drivers that ship today) — `subdomains` is a list (a host or guest can
  front more than one subdomain; `sync-proxy` emits one route per entry in
  the list, all pointing at the same `ip`/`port`);
  `insecureBackendTls` — see the driver-interface bullet below;
  `proxyManual` (optional, hosts and guests only, renamed from `caddyManual`
  in issue #10) marks an entry whose real proxy config is
  hand-authored elsewhere (outside `sync-proxy`'s managed markers) —
  `buildRoutes` skips deriving a route for it entirely, even
  though its `subdomains[]` still drives the Dashboard's service link; set
  by hand for a host (there's no web UI for host editing) or via the
  Dashboard's "read-only proxy" column checkbox for a guest;
  `authGroup` (optional, hosts/guests/external_sites -- issue #158
  replaced the earlier `requiresAuth` boolean with this field) names one
  rung of an ordered Authentik group ladder (`AUTHENTIK_GROUP_LADDER`, see
  the `sync-authentik` bullet below) and gates that entry's subdomain(s)
  behind Authentik forward-auth at that tier; absent means ungated, the
  same semantics `requiresAuth: false` used to have.
  `authMode` (optional, hosts/guests/external_sites, issue #1) names *how*
  a gated entry's tier is enforced: `forward` (absent means this, the
  original behavior) puts the active proxy driver's forward-auth in front
  of it (Caddy's `forward_auth` or nginx's `auth_request`), addressed
  at whichever entry has `authentik: true`; `oidc` instead gives the entry
  its own Authentik OpenID Connect client, so the app itself checks the
  login rather than the proxy. Every consumer (`buildRoutes`,
  `sync-authentik`, the Dashboard's edit-confirmation rule) reads
  `effectiveAuth(entry)` (returns `'ungated' | 'forward' | 'oidc'`) rather
  than `authMode` directly, since `authMode` is meaningless without
  `authGroup` -- an unset `authGroup` is always `'ungated'` regardless of
  what `authMode` holds, and `effectiveAuth()` is the one place that
  fold-in happens, so no two consumers can disagree about which mode an
  entry is actually in. `oidcRedirectUris` (optional,
  same three entry types) is the list of absolute `http://`/`https://`
  callback addresses Authentik's OpenID client is allowed to send a
  signed-in user back to; required once `effectiveAuth()` is `'oidc'` and
  the entry has `subdomains` (`oidcConfigErrors`, enforced only from
  `commitGuestEdit` -- `src/operations/edit-guest.ts`, shared by the
  Dashboard's guest-PATCH route and the MCP server's `edit_guest` tool --
  rather than from `validateInventory()` itself, so an unrelated load of an
  already-saved inventory, or a host/external-site row hand-edited straight
  into `bellhop.db`, never fails over it). `oidcMobileRedirectUris`
  (optional, same three entry types, issue #22) sits alongside it: a
  separate ordered list of the same shape, but for a native mobile app's
  own sign-in callback rather than a browser's -- a custom-scheme URI
  (`app.example:///oauth-callback`) or an `https://` hand-off page, validated
  by `isValidMobileRedirectUri` (broader than `oidcRedirectUris`'s
  http(s)-only rule: any scheme with no whitespace/control characters,
  except `javascript:`/`data:`/`file:`/`vbscript:` in any letter case,
  rejected by name). Always optional, in every mode -- unlike
  `oidcRedirectUris`, an OIDC entry with subdomains but no mobile list is
  still complete. A URI must not appear in both lists of the same entry;
  `oidcConfigErrors` enforces this the same write-time-only way it enforces
  the required-callback rule above (and, via its
  `checkCrossListDuplicates` option, only for an edit that changed either
  list, so a duplicate already saved never blocks an unrelated edit) -- on `commitGuestEdit` alone, never on
  `validateInventory()`, so a saved inventory always loads regardless of
  what an `AUTHENTIK_AUTHORIZATION_FLOW_SLUG` change or a hand-edited row
  does to it. `sync-authentik`'s exported `clientRedirectUris(entry)`
  is what actually decides an OpenID client's allowed callbacks: the web
  list plus the mobile list, deduplicated, web first -- so a mobile-only
  edit shows as ordinary `redirect_uris` drift on the client, never a
  separate code path. Neither field is synced away
  when the other changes: switching `authMode` back to `forward` leaves
  `oidcRedirectUris`/`oidcMobileRedirectUris` in place, inert, in case the
  entry switches back.
  `sync-authentik`
  creates/deletes the matching Authentik Proxy Provider and Application,
  and binds it to the named rung **and every rung above it** (Authentik's
  Applications default to `policy_engine_mode: any`, so the bindings OR
  together) -- the ladder's top rung is therefore effectively "admin only",
  and an admin gets in because their group sits at the top of the ladder,
  not via a separate check. The old auto-created `homelaboratory-app-users`
  group and the separate builtin-admin OR-check (which had mirrored this
  app's own admin-gating OR-check from issue #86) are both gone, replaced
  by the top rung. This description covers `authMode: 'forward'` (or
  unset) -- see the `sync-authentik` bullet below for what an entry in
  `authMode: 'oidc'` gets instead of a Proxy Provider. For a forward-mode
  entry, the active driver addresses its rendered forward-auth directive at
  whichever entry has `authentik: true` (mirrors `proxy: true`'s
  single-entry role, marking which host/guest actually runs the Authentik
  instance); a no-op on an entry with no `subdomains` (no candidate to
  gate) in both `sync-proxy` and `sync-authentik`, but `proxyManual` only
  silences `sync-proxy`
  (`buildRoutes` skips deriving a route, `forward_auth` included,
  for a `proxyManual` entry) — it is *not* a no-op for `sync-authentik`,
  which still creates/maintains that entry's Authentik Provider/
  Application/bindings regardless of `proxyManual`, since the
  operator's hand-authored proxy block may still want to route through
  Authentik forward-auth on its own;
  `unauthenticatedPaths` (optional, hosts/guests/external_sites, same
  placement as `authGroup`) is a list of proxy path-matcher globs (e.g.
  `/api/*`) that `sync-proxy` exempts from the `forward_auth` check on a
  gated entry -- added for issue #113, where an *arr-style
  app's server-to-server API calls (Prowlarr -> Whisparr) were getting
  redirected to an Authentik login the same as a browser request. A no-op
  when `authGroup` is unset or the entry is `proxyManual`, same as
  `insecureBackendTls`'s existing "inert when not applicable" precedent.
  Restricted (issue #10, US4) to an exact path or a path ending in `/*`
  (parsed by `parsePathPattern`/`isValidUnauthenticatedPath` -- see the
  driver-interface bullet below) since that is the common subset every
  analysed proxy can express; not an Authentik Proxy Provider setting --
  Authentik's own native equivalent (`skip_path_regex` / "Unauthenticated
  Paths") has a confirmed, closed-as-wontfix bug
  (goauthentik/authentik#6563) where it leaks across providers sharing one
  embedded outpost, which is this toolkit's exact topology; editable via
  the guest Advanced modal's Unauthenticated Paths field (mirroring
  `authGroup`'s own dropdown there) — hosts/external sites remain
  DB/CLI-only, same as `authGroup` itself (there's no web UI for host
  editing);
  `unprivileged` (optional, `lxc` guests only) records the guest's actual
  `pct config <vmid>` privilege status as of the last manual check —
  informational only, not enforced or auto-synced by any command (though
  `sync-inventory` does preserve it on existing entries via its `{
  ...existing }` spread, same as `subdomains`/`port`/`proxy`); `app`
  (optional, set once by `install-app`'s apply step, never hand-edited)
  records the community-scripts slug the guest was installed from — drives
  the Dashboard's community-scripts quick-open link, preserved across
  `sync-inventory` runs and repeat `upsertGuestEntry` merges the same way
  `port` is; `appSource: 'custom'` (optional, `lxc`/`vm` guests only,
  issue #11 -- a `guests.app_source` column added by `ensureColumn`) sits
  alongside `app` and records that this particular slug was actually
  installed from the operator's configured `customScriptsRepo`/
  `customScriptsBranch` rather than from upstream ProxmoxVE/ProxmoxVED --
  set only by the web/MCP `install-app` apply path (never the CLI, which
  doesn't touch inventory at all) when `resolveAppSource`
  (`src/lib/app-source.ts`) returned `kind: 'custom'`, and preserved across
  `sync-inventory`/repeat `upsertGuestEntry` merges the exact same way
  `app` is. Drives the Dashboard/Update page's link to the app's script on
  GitHub in the configured custom repository/branch instead of the plain
  community-scripts.org one (research R8 in
  `specs/003-custom-script-repo/research.md`); falls back to no link at
  all if the custom settings are later unset, since there's no repository
  left to point at. `proxy: true` (renamed from `caddy: true` in issue #10)
  on exactly one entry marks where the reverse proxy runs — this
  cross-field rule (along with "every guest's `host` resolves to a real
  entry", "non-empty `subdomains` requires `ip` unless `proxyManual` is
  set", and "no two entries claim the same subdomain") lives in
  `validateInventory()`
  alongside the schema, since it spans multiple entries rather than
  validating one field in isolation. Each host also carries an optional
  `bridges[]` (`BridgeEntrySchema`: `name`/`alias`/`active`) — fully
  refreshed by `sync-inventory` on every run from Proxmox's own
  `/nodes/<node>/network` data, never hand-edited. `alias` mirrors whatever
  free-text "Comment" is set on that bridge interface in Proxmox itself
  (Datacenter -> node -> System -> Network), defaulting to `'LAN'` when a
  bridge has no comment yet — the toolkit never writes that comment back to
  Proxmox, it only mirrors it, so there is nothing to "preserve" the way
  guest `subdomains`/`port`/`proxy` are preserved. Each host also carries an
  optional `storages[]` (`StorageEntrySchema`: `name`/`type`/`content[]`/
  `active`), refreshed the same way from `/nodes/<node>/storage` -- `active`
  combines Proxmox's own `active` (currently reachable) and `enabled`
  (admin hasn't disabled it) into one flag, and only storages supporting at
  least one of `vztmpl`/`rootdir`/`images` are kept at all (a pure
  backup-only or iso-only pool is never a candidate for anything this
  toolkit picks a storage for, so it's dropped rather than cluttering
  `bellhop.db`). `install-app`'s `pickStorage` reads this to fill
  `var_template_storage` (first active storage with `vztmpl`) and
  `var_container_storage` (first active storage with `rootdir` or
  `images`) -- see `install-app`/`update-app` below for why these matter
  and why there's no single hardcoded default across hosts. `pve-node-a`
  and `pve-node-b` are members of the same Proxmox cluster, so
  `/etc/pve` (including `storage.cfg`) is synced between them — a `pvesm add`
  run on one host is visible on the other immediately, and repeating it
  there fails with "already defined" rather than actually creating a second,
  independent entry. This matters for `migrate-nfs-mount`'s `--storage`
  flag: an `nfs:` storage only needs to be created once cluster-wide, not
  once per host.
- **Reading/writing the inventory database** (`loadInventory`/
  `saveInventory` in `src/lib/inventory.ts`) open a `better-sqlite3`
  connection to `inventory/bellhop.db` (WAL journal mode, foreign keys on)
  and read/write six tables: `hosts`, `guests`, `external_sites`,
  `subdomains` (one row per subdomain, `owner_type`/`owner_name` pointing
  back at the host/guest/external_site that claims it — the normalized form
  of what used to be an inline `subdomains[]` array field on each entry),
  `proxy_owner` (renamed from `caddy_owner` in issue #10; a single-row,
  `CHECK (id = 1)`-enforced table recording
  which one entry has `proxy: true`; written by `saveInventory` but not
  currently read back by `loadInventory`, which instead reads the `proxy`
  boolean column already present directly on the owning `hosts`/`guests`
  row), and `meta` (`domain` plus ten optional operator-specific scalars,
  issue #124: `nfsServer`, `backupStorage`, `dnsServer`, `statusPagePath`,
  plus the issue #11 pair `customScriptsRepo`/`customScriptsBranch`, the
  issue #10 pair `proxyDriver`/`proxyConfigPath` (which reverse-proxy
  driver `src/lib/proxy/index.ts`'s `getDriver()` hands back, and its
  configuration-file location — see the "Reverse-proxy driver interface"
  bullet below), and the issue #30 pair `proxyTlsCertificate`/
  `proxyTlsKey` (the shared TLS certificate/key path pair the nginx
  driver's every server block references — see the "nginx driver" bullet
  below; inert for Caddy, which issues its own per-site certificate)
  — see `SettingsSchema`/`SETTINGS_KEYS` in
  `src/lib/inventory.ts`, spread into `InventorySchema` rather than nested
  under their own key, same flat placement as `domain`). Each used to be a
  hardcoded literal specific to this operator's own network (or, for the
  #11 pair, simply didn't exist before); each is now optional, and the one
  or two commands that read the first four fail with a named error
  pointing at `set-config` rather than silently falling back to this repo
  author's values, since a wrong IP is worse than a missing one for any
  other operator. That error also names the web UI's Settings page,
  via the shared `settingFix(key, valueHint)` helper
  (`src/lib/settings-hint.ts`, issue #20) every such message ends with, so
  a CLI reader and a web-UI-only operator get the same two remedies no
  matter which front end raised it. `customScriptsRepo`/`customScriptsBranch` are validated
  individually by `SettingsSchema` (owner/repo shape; git branch-name
  shape) but their both-or-neither cross-field rule is deliberately *not*
  in the schema — `set-config` writes one key at a time, so a schema-level
  check would make it impossible to ever set the first of the pair — and
  is instead enforced where the pair is actually read, by
  `customScriptSource()` in `src/lib/app-source.ts` (see the `install-app`/
  `update-app` bullet below). A fifth setting, `vpnCredentialsFile`,
  existed briefly on this same branch (issue #124) but was dropped before
  merge once the file mechanism it named was removed as redundant — see
  "VPN gateway deploy credentials" below. The only writers are `set-config <key> [value] [--unset]
  [--apply]` (`src/commands/maintenance/set-config.ts`, dry-run by
  default like every other mutating command) and the web UI's admin-only
  Settings page (see below) — both validate against the same
  `SettingsSchema`, so a value rejected by one is rejected identically by
  the other. Two related former literals are *derived* rather than
  configured, so they never appear here: the LAN gateway `set-guest-vpn
  --vpn none` restores comes from the guest's parent host's own
  `midScheme.gateway`, and the Windows service's firewall `remoteip=`
  scope (`scripts/windows-service.ts`'s `resolveProxyIp`, renamed from
  `resolveCaddyIp` in issue #10) comes from
  whichever entry has `proxy: true`. `saveInventory`
  runs as a single `db.transaction`: it deletes every row from five
  tables (in FK-safe order: `subdomains`/`proxy_owner`/`guests`/
  `external_sites`/`hosts`) and re-inserts everything fresh, and separately
  upserts the `meta` table key-by-key (`domain` plus each defined
  `SETTINGS_KEYS` value) via INSERT ... ON CONFLICT DO UPDATE, and
  `DELETE FROM meta WHERE key = ?`s any settings key left `undefined` on
  the passed-in `Inventory` — the delete is what makes clearing a setting
  (`set-config <key> --unset`, or the web Settings page's PATCH) round-trip
  correctly, rather than leaving a stale value in the DB for the next load
  to pick back up. So it's still a full, wholesale replace on every write, same
  as the old YAML implementation's array replacement — there's just no
  comment concept left to lose in the process, since a SQLite row has
  nowhere to carry one; the old "hand-authored comments on an individual
  host/guest entry don't survive a write" caveat no longer applies because
  there's nothing informal for a write to discard. `sortInventoryForFile` (still the name)
  remains the deterministic-ordering pass — hosts alphabetically by `name`;
  guests by `host`, then `type`, then `ip` (numeric per-octet, ip-less
  last), then `name` — mirroring the Dashboard's own
  `sortGuestsForDisplay`/`compareIp` in `web-client/src/lib/guest-display.ts`
  (duplicated rather than shared, since `web-client` is a fully separate
  build with no imports from `src/`); each host's `bridges[]`/`storages[]`/
  `nfsMounts[]`, and each storage's own `content[]`, are sorted
  alphabetically by name too. It's now called on both ends — `loadInventory`
  runs it on the assembled result right before validation (SQL's own
  `ORDER BY name`/`ORDER BY host, name` gets hosts/guests most of the way
  there, but `sortInventoryForFile` is still what guarantees the nested
  arrays and the exact tie-breaking rules match), and `saveInventory` runs
  it on its way in — so it now guarantees `loadInventory`'s returned array
  order on every read, not just file-write order the way it used to. This
  is still what makes `sync-inventory --apply` idempotent when nothing on
  the real infrastructure changed, for the same reason as before: Zod
  normalizes per-entry *field* order on every load regardless of source
  order, so array element order — driven by whatever order Proxmox's own
  API happens to return guests/interfaces/storage pools in — remains the
  only thing that could otherwise drift between two identical runs. The
  `subdomains` table is the one place row order is operator-meaningful
  rather than purely cosmetic (`sync-proxy` treats an entry's first
  subdomain as its canonical hostname), so it's read back `ORDER BY rowid`
  rather than alphabetically — `saveInventory` always fully clears that
  table and re-inserts each owner's subdomains in their original array
  order within the same transaction, so insertion order (rowid order)
  faithfully preserves authored order; any future direct writer of that
  table needs to preserve plain array-order insertion too, or this
  ordering guarantee silently breaks. The `yaml` npm package itself hasn't
  left the codebase — `import-yaml-inventory` (below) still uses it to
  parse a `hosts.yaml`-shaped source file, and `render-status-page`
  (below) still uses its `stringify` to produce a human-readable snapshot
  of the live inventory for display — it's just no longer what
  `loadInventory`/`saveInventory` themselves read or write. A one-time,
  self-idempotent schema migration (issue #158) runs the first time
  `hosts`/`guests`/`external_sites` are opened while they still carry a
  `requires_auth` column: every row with `requires_auth = 1` gets
  `auth_group` set to the configured `AUTHENTIK_GROUP_LADDER`'s *top*
  rung -- `authentik Admins` in the default ladder -- a deliberate
  fail-closed choice (the narrowest audience), not one tuned to match any
  particular operator's prior Authentik state -- and then the
  `requires_auth` column itself is dropped. Once
  it's gone, the `PRAGMA table_info` guard that triggers the migration is
  false forever after, so it never re-runs, and a database created fresh
  by current code never has the column to migrate at all. This is
  **forward-only**: once a database is migrated, code from before this
  branch can no longer open it, since its own `INSERT`s still name the
  now-dropped `requires_auth` column. Because the migration reads
  `AUTHENTIK_GROUP_LADDER` at DB-open time, any entry point that opens the
  inventory database must `dotenv`-load `data/authentik.env` first -- the
  three that do today are `src/cli.ts`, `src/web/server.ts`, and
  `scripts/windows-service.ts` -- or a custom ladder never takes effect for
  the migration and the fail-closed top-rung default is used instead.
  A second one-time, self-idempotent migration sits right next to it
  (`migrateCaddyToProxy`, issue #10's full Caddy-to-proxy rename): the
  first time `hosts`/`guests` are opened while they still carry a `caddy`
  or `caddy_manual` column, each is renamed in place (`ALTER TABLE …
  RENAME COLUMN`, SQLite 3.25+, available in the bundled `better-sqlite3`)
  to `proxy`/`proxy_manual`, and any existing `caddy_owner` table is
  dropped outright rather than renamed onto `proxy_owner` — `caddy_owner`
  is written by `saveInventory` on every save but never read back by
  `loadInventory`, so nothing is lost by dropping it, and the very next
  save fills `proxy_owner` fresh. It runs before the schema's own
  `ensureColumn(..., 'proxy_manual', ...)` calls, since by the time those
  run `CREATE TABLE IF NOT EXISTS proxy_owner` has already created an
  empty table this migration would otherwise collide with, and because
  `ensureColumn` adding `proxy_manual` first would make the rename fail
  with a duplicate-column error. Same guarded (`PRAGMA table_info`),
  self-idempotent, log-only-when-something-changed, **forward-only**
  pattern as #158's migration above — each column is checked
  independently, so a database that predates `caddy_manual` entirely just
  skips that rename and gets `proxy_manual` from `ensureColumn` instead,
  and a database created fresh by current code has none of
  `caddy`/`caddy_manual`/`caddy_owner` to migrate at all, so the guards
  are false from the start and nothing is ever logged for it.
- **Target resolution** (`resolveTarget`/`runRemote` in `src/lib/targets.ts`):
  a `pve` entry is reached by a direct SSH exec; an `lxc`/`vm` guest is
  reached by SSHing to its *parent host* and running `pct exec <vmid> --`/
  `qm guest exec <vmid> --`. Every command sent to a guest is wrapped as
  `sh -c ${shellQuote(cmd)}` (`shellQuote` in `src/lib/ssh-client.ts`,
  POSIX single-quote escaping) because `pct exec`/`qm guest exec` don't
  invoke a shell themselves — without this wrapping, compound commands
  (`cmd1 && cmd2`) would reach the guest split apart rather than as one
  compound command. It's `sh`, not `bash`, as of issue #120: a default
  Alpine container has only busybox ash at `/bin/sh`, so a bash wrapper
  failed with `bash: not found` before the command ever ran (verified
  against the stock `alpine-3.24-default` template, which ships
  `/bin/ash`, `/bin/busybox`, and `/bin/sh` and no `/bin/bash`).
  **Every command routed through `runRemote` *to a guest* must therefore
  be POSIX sh** — no `[[ ]]`, `<<<`, arrays, or `pipefail`. This applies
  to the `lxc`/`vm` branches only: the `pve` branch hands the command
  straight to `ssh.exec`, which runs it in the host's own login shell
  (bash on Proxmox), so a host-targeted command is not bound by this.
  One command keeps a hand-rolled `bash -c` wrapper deliberately:
  `deploy-vpn-gateway` builds its own `pct exec <vmid> -- bash -c '...'`
  calls rather than going through `runRemote`, and stays on bash because
  it creates its own Debian container and `apt-get install`s into it.
  Distinct from that, `update-app` sends `bash -c "$(curl ...)"` *as* its
  command through `runRemote` to a guest — the outer wrapper is `sh -c`
  like everything else; the inner `bash` is deliberate because
  community-scripts require it. `install-app` runs the same
  `bash -c "$(curl ...)"` against a `pve` host, so it takes the direct-SSH
  branch and was never wrapped either way. `qm guest exec`'s always-exits-0-on-successful-agent-call
  quirk (the real exit code and output are a JSON envelope on stdout,
  `{"exitcode":N,"out-data":"...","err-data":"..."}`) is parsed and
  translated into the real `ExecResult` by `runRemote`'s `vm` branch, with a
  timeout named as a constant (`VM_EXEC_TIMEOUT_SECONDS`, 60, used to build
  both the `--timeout` flag and the failure message below) rather than a
  bare literal repeated in two places — fixed at 60s for every command
  routed to a VM, with no per-call override (issue #2 operator PR review:
  package commands are never sent to a VM at all as of that decision, so
  the per-call `vmTimeoutSeconds` override this constant briefly grew, and
  the longer wait it existed for, were both removed rather than kept around
  unused — see the `update-all`/`configure-guest` bullets below). Three
  envelope shapes besides the normal `{"exitcode":...}`
  one are reported as failures (`code: 1`), never silently coerced to
  success the way an old `parsed.exitcode ?? 0` used to: a command that
  outlives the wait gets a pid-only envelope with no `exitcode` at all
  (`{"pid":N}`) — the command is still running in the guest when `qm guest
  exec` gives up waiting on it; a command killed by a signal gets an
  `exited: 1` envelope carrying a `signal` number instead of a `pid` (also
  no `exitcode`) — reported with whatever `out-data`/`err-data` it produced
  plus `killed by signal <N>` appended to stderr, rather than being
  misreported as the pid-only timeout case above and having its output
  dropped (this check runs first, since both shapes share the "no
  `exitcode`" test); and one that fails to
  parse as JSON at all (a plain `JSON.parse`, no pre-processing needed —
  verified live 2026-09-26 that real `qm guest exec` output is strict JSON,
  including a completed command's own embedded newlines, which come through
  as a properly-escaped `\n` inside `"out-data"`/`"err-data"` rather than a
  raw control character).
  `Ssh2SSHClient.exec()` (`src/lib/ssh-client.ts`) authenticates the same way
  a plain `ssh`/git-bash client does when no agent is running: it reads a
  default identity file directly (`~/.ssh/id_ed25519`, `id_ecdsa`, or
  `id_rsa`, first match wins) and passes it as `privateKey`. It only falls
  back to an agent (`SSH_AUTH_SOCK` on Unix, `'pageant'` on Windows) if none
  of those files exist — matching the passwordless key-auth setup this
  toolkit has always assumed, see Prerequisites — with a 5s connect timeout
  so a broken/missing key fails
  fast with a clear error instead of hanging. All three `SSHClient` methods
  take a single `SshTarget`
  (`{ host, user, port?, identityFile? }`) rather than two positional
  strings, and `Ssh2SSHClient.connectConfig()` is the one place it becomes
  ssh2 connection options. `hostSshTarget(host)` (`src/lib/targets.ts`) is
  the sole mapping point from an inventory entry onto that type, so a future
  per-host connection setting only has to be threaded through there.
  Its exec channel's `'close'`
  handler treats a `null` exit code (ssh2's signal for "the remote process
  was terminated by a signal, not a normal exit" — the second callback arg
  is the signal name) as a failure (`code: 1`, with the signal name in
  `stderr` if nothing else was captured there) rather than coercing it to
  `0`/success — discovered live: killing a hung remote `whiptail` process
  (see `install-app` below) made the exec's `'close'` fire with `code: null`,
  and the old `code ?? 0` silently reported that as a *successful* install,
  which went on to write a phantom guest into inventory and push a broken
  Caddy route for a container that was never actually created. The exec
  channel's stdin is closed (`stream.end()`) immediately after the channel
  opens, so a remote command that tries to read from stdin with nothing
  feeding it now fails fast (EOF) instead of hanging forever — discovered
  live via `install-app` hangs on `paperless-gpt`/`paperless-ngx`, both of
  which have their own `read -p`-style prompts baked into the app script
  itself, outside the `mode`/`PHS_SILENT`/`var_*` unattended-mode machinery
  described later in this file's `install-app` paragraph. `runRemote`
  is the only function that actually executes something remote; every
  command goes through it.
- **Machine ID (MID)** (`resolveMid` in `src/lib/targets.ts`, used by
  `create-lxc`/`create-vm`/`install-app`): a single operator-chosen integer
  (1-254) passed via `--mid` derives both the VMID and the guest's
  IP/gateway from the target host's `midScheme` in inventory (a structured
  `{ vmidBase, ipPrefix, cidrSuffix?, gateway }` field, `cidrSuffix`
  defaulting to 16) — e.g. `vmidBase: 4000, ipPrefix: "192.168.1."` + MID 4
  -> VMID `4004`, IP `192.168.1.4/16`. `resolveMid` itself does no collision
  checking -- `create-lxc`/`create-vm` don't need any, since they call `pct
  create`/`qm create` directly and get Proxmox's own native rejection on a
  reused VMID; `install-app` is the one exception (see its own entry below)
  and pre-checks the VMID itself before ever handing it to community-scripts'
  installer. One collision nothing catches at all: a host normally sits on
  its own `midScheme.ipPrefix`, so a `--mid` equal to that host's own last
  octet derives a guest IP identical to the host's own `ssh_target`/`ip`.
  Proxmox rejects a duplicate VMID, but nothing rejects a duplicate
  address — check the host's last octet and avoid picking it as a MID.
  `midScheme` is only validated when a command actually calls
  `resolveMid`, not globally, so hosts that never get MID treatment don't
  need one. `validateInventory` separately rejects two hosts sharing the
  same `midScheme.vmidBase` or `midScheme.ipPrefix`, since either would let
  `resolveMid` hand out colliding VMIDs/IPs across two different hosts.
- **Targeting flags**: `update-all` uses `--host <name>` / `--all` /
  `--group pve|lxc`, implemented once by `selectTargets` in
  `src/lib/targets.ts`. As of issue #2 (operator PR review) `update-all`
  never acts on a VM at all: `selectUpdateTargets`
  (`src/commands/maintenance/update-all.ts`) is the one place its targets
  are decided, and both `runUpdateAll` and the `update-all` operation's
  `preview` (`src/operations/maintenance.ts`) call it rather than
  `selectTargets` directly, so preview and apply can never disagree.
  `{ all: true }` silently drops every `vm` guest from the result (hosts
  and lxc guests only — an operator running `--all` wants everything this
  toolkit can safely update, not a failure over a VM that happens to be in
  inventory); `{ group: 'vm' }` and `{ host: <vm-name> }` are explicit
  requests to target a VM, so both reject outright (`update-all does not
  update VMs...`) instead of silently resolving to nothing — naming a VM
  explicitly is treated as an operator mistake worth surfacing. Every other
  selector shape delegates to the unchanged `selectTargets`, including its
  unknown-host error. `TargetSelector`'s own `group` field
  (`src/lib/targets.ts`) still accepts `'vm'` (other callers, like
  `selectTargets` itself, use the full type), and the CLI's `--group`
  flag still accepts any string at the commander layer — it's
  `selectUpdateTargets`'s runtime check that actually rejects `vm`, not a
  narrower CLI-level type. The web/MCP `update-all` operation's own `group`
  field (`src/operations/maintenance.ts`) *is* narrowed to
  `z.enum(['pve', 'lxc'])`, so a `vm` value is rejected at input-parsing
  time there, before `selectUpdateTargets` ever runs.

  As of issue #120, `update-all` no longer runs one hardcoded apt command
  against every target: it probes each one first
  (`PROBE_COMMAND` in `src/lib/package-manager.ts`, a `command -v` chain)
  and dispatches to `UPDATE_COMMANDS`, a five-entry table covering
  `apt`/`dnf`/`apk`/`pacman`/`zypper`. A target whose OS isn't recognized
  lands in its own `failUnknownPm` result bucket rather than the generic
  `failCommand`, and — like every other failure bucket — fails the web job
  and sets the CLI's exit code to 1. Detection is deliberately runtime
  rather than an inventory field: Proxmox's own `ostype` is a
  creation-time label (and a useless generic `l26` for every VM), while
  `command -v` is ground truth and self-corrects if a guest's OS changes.
  As of issue #2 the probe-then-classify step itself is shared:
  `detectPackageManager` (`src/lib/package-manager.ts`) runs
  `PROBE_COMMAND` and classifies the result, and both `update-all` and
  `configure-guest --packages` call it — only the *reaction* to an
  unrecognized OS differs, left to the caller: `update-all` still buckets
  it into `failUnknownPm` and keeps going across its many targets, while
  `configure-guest` (a single-target command) throws
  `UnknownPackageManagerError` instead. `configure-guest --packages`
  installs the requested packages with the detected manager via
  `INSTALL_COMMANDS`, an `UPDATE_COMMANDS`-shaped table of install (rather
  than upgrade) commands living alongside it in the same file.
  `configure-guest --packages` also refuses a guest of type `vm` outright
  (issue #2 operator PR review, the same VM exclusion `update-all` applies
  above) — checked before any remote call, in both dry run and apply, so
  neither the probe nor the install ever reaches a VM; `--ssh-key` given in
  the same invocation is not run either, since the whole command fails
  before reaching that step. `--ssh-key` given alone (no `--packages`) is
  unaffected and still works against a VM.
- **Dry-run convention**: anything that mutates infrastructure or the
  inventory file (`create-lxc`, `create-vm`, `configure-guest`,
  `sync-proxy`, `migrate-nfs-mount`, `attach-nfs-mount`, `sync-inventory`)
  defaults to printing what it would do and only executes with `--apply`.
  `create-lxc`/`create-vm`/`configure-guest` use the shared
  `confirmOrDryRun` function (`src/lib/dry-run.ts`); `sync-proxy`/
  `migrate-nfs-mount`/`attach-nfs-mount` hand-roll the check instead since
  they need to return a multi-line block/script for the CLI layer to print
  rather than a single command line; `sync-inventory` always computes and
  prints its new/updated/removed summary and only gates the actual file
  write behind `--apply`. `create-lxc`'s and `install-app`'s dry-run/preview
  is no longer fully local: both now make one live SSH call to the target
  host to resolve its `authorized_keys` (`readHostAuthorizedKeys`,
  `src/lib/authorized-keys.ts`) so the previewed command/script is provably
  identical to what apply actually sends — the same rationale NFS storage
  resolution already established (`resolveNfsMountPath` makes a live
  `pvesh get /storage/<id>` call during preview when NFS options are
  given), except this one happens unconditionally on every dry run, not
  just when an optional flag is set. `configure-guest --packages`'s dry
  run (issue #2) joins this same group: it now also makes one live probe
  call (`detectPackageManager`, above) against the target guest before
  printing its preview line, so a dry run names the exact detected
  package manager and install command apply would send rather than
  guessing `apt-get` — a `--ssh-key`-only dry run still makes no remote
  calls at all, since only `--packages` has anything to detect.
- **Reverse-proxy driver interface** (`src/lib/proxy/`, issue #10) is a
  driver seam between the inventory and whichever reverse proxy is actually
  running, put in place so a second proxy can be added by writing one
  driver rather than untangling Caddy-specific code throughout the toolkit.
  Caddy and nginx (issue #30) are the two drivers that ship and actually
  manage a proxy -- an admin-API Caddy driver, and drivers for Nginx Proxy
  Manager/HAProxy, are follow-up issues (its shape was checked against all
  four on paper first; see `specs/006-reverse-proxy-driver/research.md`).
  A third registered driver, `none`, ships alongside them as of issue #33
  -- see "A driver that manages no reverse proxy at all" below.
  Single-operator-assumption
  update: this toolkit is no longer hard-wired to Caddy -- exactly one
  driver is active per deployment (`proxyDriver`, a per-deployment choice,
  not a per-entry one), and a future driver only has to declare what it
  supports rather than fit into Caddy-shaped code. The one single-operator
  assumption this round deliberately keeps is `TLS_BLOCK`'s hardcoded
  Cloudflare DNS-01 with fixed resolvers (one domain, one DNS provider,
  one operator) -- unchanged in effect, just now confined entirely inside
  the Caddy driver instead of spread through a Caddy-specific generator.
  The nginx driver (issue #30) adds two more of its own, both narrower:
  its shared-certificate default is derived from the inventory `domain`,
  not hardcoded, but its CA-bundle verification path and its `conf.d`
  default config path both assume a Debian/Ubuntu nginx layout -- see the
  "nginx driver" bullet below.
  Four files split the
  responsibility: `routes.ts`'s `buildRoutes(inventory)` derives a
  proxy-neutral `ProxyRoute[]` from `hosts[]`/`guests[]`/`externalSites[]`
  -- the exact derivation rules the old Caddy-specific generator applied
  directly (skip `proxyManual`/no-`subdomains` entries; default `port` to
  `80`; throw the same missing-authentik error when a forward-gated route
  exists but no entry has `authentik: true` with an `ip`) -- and
  `buildProxyContext(inventory)` derives the shared `ProxyContext` (the
  Authentik outpost's `ip`/`port`; the fixed `externalPort` `443`; and,
  issue #30, `tls: { certificatePath, keyPath }` -- the shared
  certificate/key path pair a driver that cannot obtain its own per-site
  certificate serves on every route, from `proxyTlsCertificate`/
  `proxyTlsKey` when set, else certbot's own default path for the
  inventory `domain`; always present, since `domain` is mandatory, so a
  driver never has to handle "no certificate"; the Caddy driver ignores
  it entirely, since it obtains its own per-site certificate via DNS-01);
  a route never carries its auth *tier*, only its `mode`
  (`'ungated' | 'forward' | 'oidc'`, plus a forward route's parsed
  (`PathPattern[]`) and raw (`string[]`, stored order) `unauthenticatedPaths`)
  -- tier enforcement stays entirely Authentik's job, in `sync-authentik`
  below. `driver.ts` defines the `ReverseProxyDriver` interface itself
  (`id`, `label` -- the Settings page dropdown's option text --,
  `capabilities`, `defaultConfigPath: string | null` (`null` means the
  driver uses no configuration file), `statusPage: { suggestedPath:
  string } | null` (`null` means it serves no status page), two optional
  Settings-page hints -- `usesSharedCertificate` (`true` means the driver
  serves `ctx.tls`'s shared certificate, so the page shows the
  `proxyTlsCertificate`/`proxyTlsKey` fields; nginx only) and
  `configPathNote` (a sentence appended to the Proxy config path help) --,
  `plan()`/`apply()`/`snapshot()`) and `checkCapabilities(routes, driver)`;
  `file-driver.ts`'s
  `fileDriver(...)` is a shared builder for any driver configured by files
  (Caddy and nginx, issue #30, both are; HAProxy is a candidate -- three of
  the five analysed mechanisms have no file at all, e.g. Caddy's own admin
  API, so the top-level contract is "reconcile these routes" rather than
  "render this file", with `fileDriver` supplying everything a
  file-configured driver needs on top of that); `index.ts`'s
  `getDriver(inventory)` resolves the `proxyDriver` setting (unset means
  `DEFAULT_PROXY_DRIVER_ID` (`'caddy'`); `'nginx'`, issue #30, and
  `'none'`, issue #33, are the other registered ids;
  an id no registered driver has -- only reachable by hand-editing
  `bellhop.db`, since the schema's own zod enum already rejects any other
  value at load time -- throws `"Unknown proxyDriver '<id>' -- run: bellhop
  set-config proxyDriver caddy --apply"`) to a driver instance, and
  `driverDeps(inventory, ssh, driver)` resolves the rest of what
  `plan()`/`apply()`/`snapshot()` need (`proxyHost` from the entry flagged
  `proxy: true`, throwing `"No inventory entry has 'proxy: true'"` if none
  is; `configPath` from the `proxyConfigPath` setting, else the driver's
  own `defaultConfigPath`, throwing if that resolves to `null` -- only
  reachable for a driver that manages no proxy, which every real caller
  short-circuits around before `driverDeps` ever runs). `index.ts` also
  exports `listDrivers()` (every registered driver, Caddy, nginx, then None, in
  registration order -- the Settings page's dropdown source), and
  `driver.ts` exports `managesProxy(driver)` (`driver.id !==
  NO_PROXY_DRIVER_ID`, the constant in `ids.ts` -- `false` only for the
  `none` driver below). It is the one signal for "Bellhop manages no
  proxy", so a caller never compares `driver.id === 'none'` directly and
  never reads `statusPage === null` to mean it (a `null` `statusPage`
  only means a *managed* driver serves no status page). `getDriver`'s
  unknown-id error names `DEFAULT_PROXY_DRIVER_ID` as the fix.

  **A driver that manages no reverse proxy at all** (`src/lib/proxy/
  drivers/none.ts`'s `noneDriver`, issue #33 -- single-operator-assumption
  update: not every deployment has a Bellhop-managed reverse proxy in
  front of it, whether that's a hand-configured proxy or none at all) is
  the third registered driver, selected the same way as Caddy/nginx via
  `proxyDriver: 'none'`. Its `label` is `'No proxy'`, its
  `defaultConfigPath` and `statusPage` are both `null`, and its
  `capabilities` accept both `forward` and `oidc` auth modes (so
  `checkCapabilities` never rejects a gated entry under it -- the
  assumption is that whatever proxy the operator does run enforces
  `forward_auth` itself) with `acmeDns01ViaCloudflare: false`. Its `plan()`
  returns `{ preview: NO_PROXY_SYNC_MESSAGE, payload: null }` with no
  routes/context ever consulted, `apply()` is a no-op, and `snapshot()`
  throws `NO_PROXY_STATUS_PAGE_ERROR` -- both constants defined in
  `driver.ts` alongside `managesProxy` so every caller shares the exact
  text. `runSyncProxy` (`src/commands/networking/sync-proxy.ts`) checks
  `managesProxy(driver)` immediately after `getDriver` and, when false,
  returns `{ proxyHost: null, driver: driver.id, preview:
  NO_PROXY_SYNC_MESSAGE, applied: false }` (always `false`, even with
  `--apply`, since nothing is ever written) before
  `driverDeps`/`buildRoutes`/`checkCapabilities` ever run -- those would
  otherwise throw over a missing `proxy: true` entry or a missing
  `authentik` ip that "no proxy" makes irrelevant. `SyncProxyResult.
  proxyHost` is therefore `string | null`, and every caller keys on that
  rather than on `applied`: the CLI and the `sync-proxy` operation
  (`src/operations/maintenance.ts`) print/log `result.preview` instead of
  their usual "Generated/Wrote ... for <host>" lines whenever it's `null`
  (dry run and `--apply` alike), and `syncProxyLive`/`migrate-guest`'s
  post-move push log it via `logInfo` rather than dropping it --
  `migrate-guest` also skips its "Pushing the new IP ... live via the
  proxy" line when `managesProxy(getDriver(inventory))` is false.

  **Capability enforcement** (FR-011/FR-012): `checkCapabilities` returns
  one `CapabilityError` per route whose `auth.mode` isn't in the active
  driver's `capabilities.authModes` (an `'ungated'` route is never a
  candidate). The message suggests switching to the other auth mode only
  when the driver can enforce that one; otherwise it suggests clearing
  `authGroup` or choosing a `proxyDriver` that supports the mode.
  `runSyncProxy` (`src/commands/networking/sync-proxy.ts`)
  joins every message into one thrown `Error` and refuses to preview or
  write anything -- for both a dry run and `--apply`; `commitGuestEdit`
  (`src/operations/edit-guest.ts`) runs the same check against the
  *edited* guest's own route only, derived alone by `buildRouteForEntry`
  (`routes.ts`), so nothing about another entry -- its own capability
  mismatch, a missing authentik ip, a bad exempt path -- can block a
  different guest's edit; it still surfaces the next time that entry is
  itself synced or edited, or by the push-live step's own `sync-proxy`
  call, reported as `proxySynced: false`. This check runs only where a route is
  about to become live configuration or a specific entry is being saved --
  never from `validateInventory()` itself (FR-013), so changing
  `proxyDriver` can never make an already-saved inventory fail to load;
  Caddy and nginx both support both modes, so this never actually triggers
  today, but it
  is the guarantee every future driver inherits.

  **`fileDriver(def)`** owns the full render -> back up -> write ->
  validate -> restore-or-reload cycle for a proxy configured by files, so
  a new file-configured driver only supplies `render()`, its validate
  command, and its reload command, plus a required `label` and
  `statusPage` (no defaults, so a new driver can't silently show its bare
  id in the Settings dropdown or opt out of a status page by omission;
  `usesSharedCertificate`/`configPathNote` are optional and passed
  through unchanged;
  `configFiles()` optionally overrides which paths `snapshot()` reads;
  defaults to `[configPath]`). `apply()`
  builds one POSIX `sh` script (`buildFileDriverScript`, run via
  `runRemote` on the proxy host) that: first refuses, touching nothing, to
  replace an existing `'owned'` file whose first line isn't that
  `FileSpec`'s `ownedHeader` (when set -- see the nginx driver bullet);
  backs up every target file
  (or records that it didn't exist); installs one `trap ... EXIT` once
  every backup exists, so *any* non-zero exit from that point on -- a
  write-phase command failing under `set -e`, or the validate command
  itself failing -- restores every backup (removing files that didn't
  exist before) through that one trap handler, not a restore block
  duplicated at each failure site -- and, since an EXIT trap does not run
  when the shell is killed by a signal, a second trap on HUP/INT/TERM that
  clears every trap, runs the same restore, and exits 1; writes each file (`'owned'` replaces it
  whole, `'managed-section'` removes any existing
  `# BEGIN bellhop-managed`…`# END bellhop-managed` block and appends the
  new one, creating the file if absent); runs the validate command,
  printing a named failure message and exiting non-zero if it fails (the
  trap performs the actual restore); disarms every trap together
  (`trap - EXIT HUP INT TERM`), removes the backups, and reloads. The
  `bellhop-managed` markers are defined once, in `file-driver.ts`: a
  driver's `render()` returns only a `'managed-section'` file's body, and
  `plan()` wraps it with `wrapManagedSection` before previewing it or
  putting it in the payload, so the preview is still exactly what
  `apply()` writes. `apply()` itself throws on a non-zero exit, with
  stderr in the message -- this is a behavior fix, not just a rename
  (issue #10): the former `sync-caddy` validated a *temporary copy* before
  ever overwriting the real Caddyfile and reported a failed validate as a
  successful apply regardless; now a failed remote validate or write
  throws all the way up, so `syncProxyLive` (the Dashboard guest edit,
  provisioning jobs) surfaces the failure to its caller. `migrate-guest`'s
  post-move push is the exception: by then the source guest is destroyed
  and inventory saved, so it catches the failure and logs a `logWarn`
  saying the migration succeeded, the proxy sync failed (with the error),
  and to retry with `bellhop sync-proxy --apply`, rather than failing a
  migration that already happened. For a Dashboard guest edit specifically, this
  means the inventory write has already happened (`commitGuestEdit` saves
  before calling `syncProxyLive`) by the time a proxy failure is caught,
  so the response reports it separately as `proxySynced: false, proxyError:
  <message>` rather than rejecting the whole request. `snapshot()` never
  calls `buildRoutes`/`buildProxyContext`/`render` -- it only `cat`s the
  resolved `configFiles()` paths -- so a read-only status-page request
  still succeeds when the current inventory is itself invalid (a bad
  `unauthenticatedPaths` entry, a missing `authentik` ip) the same a real
  `sync-proxy` run would fail on.
- **Caddy driver** (`src/lib/proxy/drivers/caddy.ts`) is the first driver
  that shipped (and the default), built with `fileDriver`: `capabilities: {
  authModes: ['forward', 'oidc'], acmeDns01ViaCloudflare: true }`,
  `defaultConfigPath: '/etc/caddy/Caddyfile'`, `validateCommand: caddy
  validate --adapter caddyfile --config <path>`, `reloadCommand:
  systemctl reload caddy`. Its `render()` is the old `buildCaddyBlock`
  ported over verbatim minus the markers (`fileDriver` adds those), now reading the proxy-neutral `ProxyRoute[]`/
  `ProxyContext` `buildRoutes`/`buildProxyContext` already derived rather
  than walking raw inventory entries itself, and emitting
  `unauthenticatedPaths` from a route's raw stored strings (in stored
  order) rather than reconstructing them from the parsed `PathPattern[]`
  -- byte-identical output was the whole point of this refactor (FR-010,
  SC-001), and reusing the raw strings verbatim is what keeps a
  forward-gated route's `not path ...` line identical to what it always
  rendered. Everything the old generator did to the Caddyfile block itself
  is unchanged and now lives entirely inside this one driver file: one
  site block per entry (hostnames joined into a comma-separated address
  list, canonical first, matching the hand-authored style rather than
  repeating directives per alias) across hosts, guests, and external
  sites (`ExternalSiteSchema` in `src/lib/inventory.ts` — a reverse-proxy
  target that isn't a Proxmox host or guest at all, e.g. a NAS; never an
  SSH/exec target, only ever the source of a `ProxyRoute`); the same
  hardcoded Cloudflare DNS-01 `tls {}` clause on every block (`TLS_BLOCK`,
  not inventory-configurable -- one domain, one DNS provider, one
  operator -- the single-operator assumption this refactor deliberately
  keeps, now contained inside this one driver instead of spread across a
  Caddy-specific generator); every `reverse_proxy` always in block form
  with an unconditional `header_up X-Forwarded-Port 443` (`EXTERNAL_PORT`,
  from `ProxyContext`, so backends building absolute external URLs --
  e.g. Dispatcharr's VOD cover art, issue #91 -- get the real external
  port); `insecureTls: true` adding a `transport http {
  tls_insecure_skip_verify }` line in the same block; content outside the
  managed markers never touched, never generated, and appended rather than
  replacing anything on a Caddyfile with no marker yet; a forward-gated
  route with exempt paths wrapping `forward_auth` in a named
  `@auth_required { not path <patterns...> }` matcher, omitted when the
  list is empty; and no `forward_auth`/`@auth_required`/outpost-passthrough
  at all for an `'oidc'`-mode route -- `render()`'s outpost-address access
  is only reached for a `'forward'` route, since `buildRoutes` already
  throws the missing-authentik error before producing one with no outpost
  to address.
- **nginx driver** (`src/lib/proxy/drivers/nginx.ts`, issue #30) is the
  second driver that ships, also built with `fileDriver`: `capabilities: {
  authModes: ['forward', 'oidc'], acmeDns01ViaCloudflare: false }` --
  nginx cannot obtain its own certificate the way Caddy's DNS-01 does, so
  it never leaves a stale `_acme-challenge` record behind for
  `prune-acme-challenges` to find (see that bullet below).
  `label: 'nginx'`, `defaultConfigPath: '/etc/nginx/conf.d/bellhop.conf'`,
  `statusPage: { suggestedPath: '/var/www/html/index.html' }` (the
  Debian/Ubuntu nginx package's default document root -- serving it is the
  operator's own hand-authored `server` block's job, as with Caddy's),
  `usesSharedCertificate: true`, a `configPathNote` warning that the whole
  file is replaced and a file it didn't generate is refused,
  `validateCommand: nginx -t`, `reloadCommand: systemctl reload nginx`. Unlike the Caddy
  driver's managed-section file, this one file is entirely Bellhop's own:
  `render()` returns it in `'owned'` mode, replaced whole on every apply,
  since nginx has no admin API and no other content this toolkit's
  operator hand-authors alongside a managed section that would need
  preserving. The file always opens with a "generated by Bellhop, do not
  edit" header comment -- also its ownership mark: the `FileSpec` carries
  it as `ownedHeader`, and `buildFileDriverScript` refuses (before any
  backup or write, exiting non-zero with a message naming the path and the
  `set-config proxyConfigPath` fix) to replace an existing file whose first
  line isn't exactly that header, since `proxyConfigPath` is shared across
  drivers and a Caddyfile path left over from the Caddy driver would
  otherwise be replaced whole while `nginx -t` still passed -- then two `map` blocks emitted unconditionally, even
  with zero routes, so the file's shape never depends on the inventory
  (research R8): `$bellhop_connection_upgrade` (turns a WebSocket
  `Upgrade` request's `Connection` header into `upgrade` and every other
  request's into `''`, mirroring Caddy's own automatic WebSocket
  passthrough) and `$bellhop_http_host` (Authentik's own nginx recipe's
  `$ak_http_host` map under a different name: `$http_host`, falling back
  to `$host`, so an explicit port in the original `Host` survives). Both
  are Bellhop-prefixed rather than the recipe's own names because
  `map`/variable names are global across the whole nginx configuration and
  an operator's other files may already define the recipe's own names --
  defining a `map` twice fails `nginx -t` (research R3). One `server`
  block per route: `listen 443 ssl;` and `listen [::]:443 ssl;` (no
  `http2` parameter -- its directive differs between supported nginx
  releases, and no port-80 server -- both left to the operator's own
  configuration, research R6), `server_name` listing `route.hostnames`
  canonical-first, `ssl_certificate`/`ssl_certificate_key` from `ctx.tls`
  (double-quoted), `client_max_body_size 0;`, `proxy_buffering off;`,
  `proxy_request_buffering off;`, and `proxy_read_timeout 1d;`/
  `proxy_send_timeout 1d;` (Caddy streams request bodies and has no
  upstream read timeout; nginx's 60s default would cut off a quiet
  WebSocket or server-sent-events stream).
  Every proxied location repeats the same proxy-line block rather than
  hoisting it to the `server` level (nginx only inherits
  `proxy_set_header` onto a location that defines none of its own, and
  every location here defines some, research R4) -- parity with Caddy's
  `reverse_proxy` defaults: `proxy_http_version 1.1;`, `Host
  $bellhop_http_host`, the `X-Forwarded-For`/`-Proto`/`-Host` triple
  (`X-Forwarded-For` *set* to `$remote_addr`, never appended to, matching
  Caddy 2.5+ without `trusted_proxies`, so a client can't pose as a LAN
  address),
  `X-Forwarded-Port` always `ctx.externalPort` (matching the Caddy
  driver's own unconditional `header_up X-Forwarded-Port 443`, issue #91),
  and the `Upgrade`/`Connection $bellhop_connection_upgrade` WebSocket
  pair -- since nginx's own defaults are the opposite of Caddy's on every
  one of these points, a backend that works behind the Caddy driver today
  would otherwise break on switching drivers. The backend connection is
  `https://` (plus `proxy_ssl_verify off;`) when the route's
  `insecureTls` is set, or `https://` with `proxy_ssl_verify on;` and
  `proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;`
  (the Debian/Ubuntu CA bundle path -- a single-operator assumption, same
  as this driver's `conf.d` default config path) when the backend port is
  443 without `insecureTls`, else plain `http://` (research R5) -- this is
  Caddy's own rule, and without the explicit `on` nginx would otherwise
  silently skip the upstream-certificate verification Caddy performs
  automatically for a port-443 backend. A forward-gated route additionally
  gets `proxy_buffers 8 16k;`/`proxy_buffer_size 32k;` at the server level
  (Authentik's recipe, sized for its large response headers) and, on
  `location /` (omitted entirely when an exempt `/*` pattern already
  exempts everything, since a second `location /` fails `nginx -t` with a
  duplicate-location error), Authentik's standalone-nginx recipe verbatim
  under bellhop-prefixed variable names: `auth_request
  /outpost.goauthentik.io/auth/nginx;`, `error_page 401 =
  @goauthentik_proxy_signin;`, the `Set-Cookie` pass-back, and the same
  five identity headers the Caddy driver forwards -- username, groups,
  email, name, uid, no `entitlements`, so both drivers hand a backend the
  same identity (research R3). Each unique parsed `unauthenticatedPaths`
  pattern (deduped on kind+path, outpost-namespace patterns dropped -- see
  below) becomes its own location with the same proxy lines and no
  `auth_request`: an exact path as `location = "<path>"`, a `/api/*`-style
  prefix as `location ^~ "/api/"` (wins over any regex location an
  operator include might add, matching Caddy's own `path /api/*`
  semantics) -- except the bare `/*` pattern, which produces no location
  of its own and instead removes the forward-auth lines from `location /`
  itself (research R7); every path is double-quoted with `\`/`"`
  backslash-escaped so it's matched literally. A pattern inside the
  outpost's own `/outpost.goauthentik.io` namespace (that exact path, or
  anything under it) is silently skipped rather than rendered or thrown
  on: an exact or `^~` location there would outrank the
  outpost-passthrough location below it under nginx's own location-match
  precedence and misroute the `auth_request` subrequest to the site's own
  backend instead of the outpost -- reproducing, not failing on, the same
  case Caddy's own `handle /outpost.goauthentik.io/*` (issue #10) already
  handles regardless of any `not path` exemption. A guest edit
  (`parseUnauthenticatedPaths`, via `commitGuestEdit`) rejects such a path
  outright, so this skip only ever applies to an entry saved before that
  rule or written straight into `bellhop.db` -- the schema itself
  (`UnauthenticatedPathSchema`) still accepts it, so a saved inventory
  never becomes unloadable. The
  `location /outpost.goauthentik.io`/`location @goauthentik_proxy_signin`
  pair is always present on a forward-gated route, verbatim from
  Authentik's recipe under the same bellhop-prefixed names. An OIDC-mode
  or ungated route gets none of the forward-auth lines or locations at
  all. The certificate/key pair every server block references is
  `ctx.tls` (see the driver-interface bullet above) -- because nginx
  cannot obtain a certificate itself the way Caddy's per-site Cloudflare
  DNS-01 does, one operator-managed certificate (in practice a wildcard
  for the domain, issued and renewed by something like `certbot`) covers
  every site this driver generates instead.
- **`sync-authentik`**
  (`src/commands/networking/sync-authentik.ts`) is `sync-proxy`'s
  counterpart for the Authentik side of issue #80's per-app forward-auth:
  REST-only (no SSH), it reconciles Authentik Proxy Providers/
  Applications/policy bindings/embedded-outpost membership against every
  gated inventory entry (one whose `authGroup` names a rung), using the
  entry's canonical subdomain (`subdomains[0]`) as a deterministic Application slug rather
  than persisting any Authentik object IDs back into
  `inventory/bellhop.db`. That same slug is also the Application's
  and Proxy Provider's *display name*, verbatim (issue #156) -- the
  Provider's `externalHost` (`https://<slug>.<domain>`) is the only place
  the domain is still appended, since it is the URL Authentik matches an
  incoming forward-auth request against. `toCreate`/`toRemove`/`conflicts`
  on the result therefore all hold bare slugs, and
  `src/web/routes/dashboard.ts`'s guest-PATCH handler compares
  `subdomains[0]` against that list directly to scope the conflict banner
  to the edited guest -- the two must stay in lockstep, since a mismatch
  fails silently by rendering no banner at all. Same dry-run/`--apply` convention as
  every other sync command. Binding membership is now fully reconciled on
  *every* `--apply` (issue #158), not written once at Application creation
  the way it used to be: for each gated entry's Application, `--apply`
  binds it to the entry's named rung and every rung above it
  (`AUTHENTIK_GROUP_LADDER`, comma-separated ordered low-to-high, defaulting
  to `bellhop-app-users-open,bellhop-app-users,bellhop-users,authentik
  Admins` -- `src/lib/authentik-config.ts`'s `rungsAtOrAbove`), creating
  whichever of those bindings are missing and deleting any existing binding
  whose group is on the ladder but no longer wanted. A binding to a group
  that isn't on the ladder at all (a hand-added one), or a policy-/
  user-backed binding, is left untouched either way -- only a
  ladder-member *group* binding is this command's to remove. A ladder rung
  some gated entry needs that doesn't actually exist as an Authentik group
  is reported in the result's `missingRungs` list and never auto-created --
  unlike the old behavior of auto-creating a shared
  `homelaboratory-app-users` group, manufacturing an empty group from a
  typo in `AUTHENTIK_GROUP_LADDER` would hide the mistake rather than
  surface it. An entry whose `authGroup` names a group absent from the
  ladder is skipped entirely -- no Application created, no bindings touched
  -- and reported in the result's `offLadder` list instead of failing
  `loadInventory` outright: `validateInventory` runs on every load, so a
  hard error there would let an `AUTHENTIK_GROUP_LADDER` edit make an
  already-saved inventory refuse to load. Changing an entry's tier through
  the Dashboard is asymmetric: anyone with resource access to the guest may
  *raise* it (a narrower rung, or gating a previously-ungated entry); only
  an admin may *lower* it (a broader rung, or clearing the gate entirely)
  -- enforced server-side in the guest-PATCH handler
  (`src/web/routes/dashboard.ts`), via the same `isAdminUser` check (and
  therefore the same impersonation behavior) used everywhere else. The same
  handler applies a parallel rule to `unauthenticatedPaths` (issue #158):
  adding a path exemption is the privileged operation there, because only
  adding can make something reachable without permission -- removing one
  only narrows. Anyone with resource access may narrow (remove paths, clear
  the list, or merely reorder -- reordering is compared as a set, so it is
  never treated as an addition); adding a path to an entry whose *resulting*
  `authGroup` (this same request's own authGroup edit, if any, already
  applied) is set requires the caller to actually be able to reach that
  app -- admin, or membership in that rung or any rung above it
  (`rungsAtOrAbove`), otherwise 403. It is a no-op, and therefore
  unchecked, on an entry with no `authGroup` at all: the Caddy driver's
  `render()` only emits the `@auth_required` matcher inside its
  `if (entry.authGroup)` branch (mirroring `buildRoutes`'s own
  `route.auth.mode === 'forward'` gate), so an exemption on an ungated
  entry never reaches the deployed proxy configuration -- there is nothing
  to widen. A non-admin may add path exemptions to an
  ungated entry (permitted, since the field is inert) and subsequently gate
  that entry (permitted as a "raise" of an ungated entry), producing a gated
  entry whose paths are all exempt -- not an escalation because the entry was
  already fully public before the raise, so the caller never widens an
  audience, only fails to narrow one -- but a "raise" is therefore not by
  itself a guarantee that an app is actually protected. Full reconciliation of
  Application existence too: an entry whose gate is cleared (`authGroup`
  removed) has its Provider/Application deleted and removed from the
  outpost's provider list on the next `--apply` run. Ownership is
  deliberately narrow (issue #154): an Application is this command's to
  delete only if its slug matches an inventory subdomain **and** it is
  backed by a proxy provider, the only kind this command creates. An
  Application with a non-proxy provider (an OAuth2/OIDC one) or no provider
  at all is never touched whatever its slug, and neither is one whose slug
  is absent from inventory (e.g. the `homelab.example.com` dashboard's own
  Provider/Application from #10, or `qbittorrent`, which fronts an external
  seedbox provider through a hand-authored Caddy block). The corollary: if
  a gated entry's slug is already held by an
  Application this command does not own, creating one would fail Authentik's
  unique-slug constraint -- that entry is skipped and reported in the
  result's `conflicts` list
  (printed by the CLI; returned by `syncProxyLive` as
  `authentikConflicts` and echoed in the Dashboard guest-PATCH response
  (filtered there to the edited guest's own subdomain -- the list itself is
  inventory-wide),
  where `EditableAuthGroup`/`EditableSubdomains` render it as a warning
  banner -- that route calls `syncProxyLive` straight from its Express
  handler, outside any job, so a `logWarn` alone would only reach the
  service's stderr; the `logWarn` is still emitted for the
  provisioning-job callers, which do run inside `withCapturedConsole`)
  rather than aborting the run, since a Dashboard edit
  elsewhere in the inventory must not fail over it. Does **not** detect a
  subdomain rename on an already-gated entry: the old slug is no longer an
  inventory subdomain, so its Application falls outside this command's
  ownership rule and is left behind while a new one is created under the
  new slug -- delete the old Provider/Application in Authentik by hand.
  See `candidateEntries`'s comment in `sync-authentik.ts`.

  **Native OIDC gating** (issue #1) extends this same command to the other
  `authMode`: for an entry where `effectiveAuth()` is `'oidc'`,
  `sync-authentik` creates/maintains an Authentik OAuth2/OpenID Provider
  and Application in place of the Proxy Provider/Application a forward-mode
  entry gets, bound to the same rung-and-above rule via the same
  `planBindingChanges` (exported, and shared with `adopt-oidc-client.ts` --
  see below) -- but never added to the forward-auth outpost, since an OIDC
  entry's app is reached directly, not through the proxy's `forward_auth`.
  Ownership of an OAuth2-backed Application needs more than the #154
  slug-match rule a Proxy-backed one needs: `ownedProviderKind` (exported)
  only recognizes it as Bellhop's when its provider also carries
  `meta_publisher: 'bellhop'` (`BELLHOP_META_PUBLISHER`) -- a hand-made
  OpenID client sharing an entry's slug is therefore never a false match,
  unlike a Proxy Provider, which stays owned by slug alone regardless of
  marker (the unchanged #154 rule, kept so an Application created before
  the marker existed is still recognized). `ownedProviderKind`'s
  `proxyProviderIds`/`oauth2ProviderIds` sets are safe to build straight from
  `listProxyProviders()`/`listOAuth2Providers()` and check independently
  (proxy first) despite a live quirk verified against Authentik 2026.8: a
  Proxy Provider is a subclass of OAuth2Provider in Authentik's own model, so
  `GET /api/v3/providers/oauth2/` itself returns every proxy provider too --
  `RealAuthentikClient.listOAuth2Providers` (`src/lib/authentik-client.ts`)
  is what filters those back out before this command ever sees them, by
  cross-referencing the proxy list, so `oauth2ProviderIds` here is always
  genuinely OAuth2-only and this file's own provider-kind logic never has to
  account for the overlap itself. It lists OAuth2 Providers on
  every run (to compute ownership even for a run with no OIDC entries), so
  once any entry is in OIDC mode the Authentik API token in
  `data/authentik.env` needs a few scopes forward-auth-only gating never
  required: read/write on OAuth2/OpenID Providers, read on
  certificate-keypairs and scope/property mappings, and update on
  Applications -- see README's "OIDC mode" section. With *no* candidate in
  `authMode: 'oidc'` (gated or not), a failed OAuth2 listing is treated as
  an empty one (`listOAuth2ProvidersForRun`), so a forward-only deployment
  whose token predates this feature keeps working exactly as before; with
  any, it propagates, since an OpenID client's ownership can't be decided
  without it.
  The OpenID client itself is confidential, explicitly permits the
  authorization-code + refresh-token grant types (`OIDC_GRANT_TYPES` --
  Authentik silently stores `[]` and rejects every authorize request if
  this isn't sent explicitly on create, research.md R2), signs tokens with
  the certificate-keypair named `AUTHENTIK_OIDC_SIGNING_KEY_NAME`
  (`authentik-config.ts`, default `'authentik Self-signed Certificate'` --
  a stock Authentik install always has this self-signed cert, so it's a
  safe single-operator default an operator overrides only after
  deliberately setting up their own signing key), and releases the fixed
  `openid`/`profile`/`email` scope mappings (`OIDC_SCOPE_MAPPINGS`, looked
  up by Authentik's stable `managed` identifier rather than display name,
  since names are editable). Both the signing key and the scope mappings
  are resolved once per run, only when some entry actually has redirect
  URIs to act on, and either failing skips every such entry
  (`missing-signing-key`/`missing-scope-mapping`, in `oidcSkipped`) with a
  named, actionable reason while forward-mode entries in the same run carry
  on (FR-015) -- an entry with no `oidcRedirectUris` at all is skipped the
  same way (`missing-redirect-uris`), and is never PATCHed down to an empty
  callback list even if it once had one, since that would lock a working
  login out rather than merely leave it incomplete. `diffOAuth2Settings`
  compares an existing Provider's redirect URIs (as a set of
  `(matchingMode, url)` pairs), grant types, scope-mapping ids, signing
  key, and client type against the desired shape (research.md R4) and
  returns only the drifted Authentik field names plus a patch carrying just
  those fields -- credentials are structurally absent from
  `DesiredOAuth2Settings`, so neither a routine drift fix nor
  `adopt-oidc-client` (below) can ever rotate `client_id`/`client_secret`
  (FR-009/FR-011), whatever else changed. `oidcUpdates` in the result
  reports drift fixed in place this run (e.g. `~ slug: redirect_uris,
  signing_key`).

  **Mode switches** (`ModeSwitch`, Story 3/research R5) keep the
  Application itself -- its pk, slug, and every existing binding -- and
  only swap which provider it points at, so a tier change survives a mode
  switch untouched. Authentik's provider names are unique **across every
  provider kind** (confirmed live against Authentik 2026.8), and both
  providers in a switch are named after the slug (issue #156), so the
  outgoing provider can't simply be deleted and a same-named one created in
  its place without a moment where neither holds that name; instead
  `planProviderName` renames the outgoing provider to `'<slug> (replaced)'`
  (`REPLACED_PROVIDER_SUFFIX`) first -- a proxy-provider rename re-sends the
  provider's own `mode` (and `internal_host` in `proxy` mode), since
  Authentik 2026.8 rejects a name-only PATCH with a 400 and a fixed mode
  would convert a hand-made provider (`renameProxyProvider` takes the whole
  `AuthentikProxyProvider` for this) -- creates the new provider under the
  bare slug name, repoints the Application at it (clearing `meta_publisher`
  on an oidc -> forward switch, since a Proxy-backed Application is owned
  without it; setting it on a forward -> oidc switch), and only then
  deletes the renamed-away outgoing provider -- so the Application is never
  left pointing at nothing. If a mode switch fails partway *after* the
  outgoing provider has been renamed but *before* the Application is
  repointed, the renamed `'<slug> (replaced)'` provider is left behind
  holding that name; a later attempt to switch the entry back to the same
  mode is then skipped as `provider-name-taken` (naming the stranded
  provider, in `forwardSkipped`/`oidcSkipped`) until the operator deletes
  it by hand in Authentik. An unused, correctly-*named* provider left
  behind by any other partial failure self-heals instead: the next run's
  `planProviderName` reuses it (`reuseId`/`orphan`) rather than colliding
  with it on Authentik's duplicate-name rejection -- it's specifically the
  renamed-away, differently-named provider from a switch that has no
  self-heal path today.

  **Outpost membership is now fully reconciled on every `--apply`**, not
  just written at Application creation: every owned, desired,
  Proxy-backed Application's provider belongs on the embedded outpost, and
  a retired one (removed, or switched to OIDC) does not -- so an
  Application left off the outpost by an earlier partial failure self-heals
  on the next run, and the dry run previews that repair too
  (`outpostChanges`, FR-014). Only providers this command owns are ever
  added or removed from it; a hand-added one is untouched.

  `forwardSkipped` mirrors `oidcSkipped` for the other direction: a new
  forward-auth Application, or an oidc -> forward switch, that can't get
  its Proxy Provider because the name it needs is already taken by an
  unrelated provider (`provider-name-taken`) is left alone and reported,
  rather than failing the whole apply on Authentik's duplicate-name
  rejection.

  **`adoptableConflicts`** narrows `conflicts` to the ones with a path
  forward: a conflicting entry whose existing, unowned Application is
  backed by *any* OAuth2 provider (marked or not -- a marked one is never
  actually a conflict, since it would already be owned) can be adopted; one
  backed by a Proxy Provider or by nothing is not, and stays a plain,
  unresolvable conflict (`resolve-by-hand`). `conflictExplanation(slug,
  result)` is the one place the wording is chosen, used by
  `formatSyncAuthentik`, `syncProxyLive`'s job-log warnings, and
  delete-guest's pre-removal sync; `syncProxyLive` also returns
  `authentikAdoptableConflicts`, which `commitGuestEdit` narrows to the
  edited guest as `authentikConflictAdoptable: true`, so the Dashboard's
  shared `AuthentikConflictBanner` (`AuthentikSyncBanners.tsx`) offers
  adoption instead of "resolve by hand" -- the Adopt button for an admin on
  an OIDC-effective guest, a "switch to OIDC mode, then adopt" note for a
  forward-mode one.

  **Post-apply discovery check** (FR-013, research.md R6): after every real
  `--apply`, each OIDC entry that still has a Bellhop-owned client gets its
  `<issuer>/.well-known/openid-configuration` fetched (10s timeout,
  `DISCOVERY_TIMEOUT_MS`) and checked for a 200 JSON response
  (`checkOidcDiscovery`) -- never rolled back on failure, since the client
  itself is correct in Authentik and the usual cause is network-shaped
  (Authentik unreachable from here, a proxy in front of it). `syncAuthentikFailed`
  is what turns a failed discovery check (or an instance-wide
  `missing-signing-key`/`missing-scope-mapping` skip) into the CLI's
  non-zero exit code -- only on `--apply`, never on a dry run, and never
  over a merely incomplete entry (`missing-redirect-uris`,
  `provider-name-taken`), since those are one entry's own unfinished
  configuration rather than something the sync itself got wrong.
  `syncProxyLive` surfaces the same failures as a Dashboard warning
  (`oidcDiscoveryFailures`, see `edit-guest.ts` below) instead of failing
  the save (FR-013).

  **Mobile consent step** (issue #22): whenever at least one
  `oidcMobileRedirectUris` entry is in effect anywhere in the inventory,
  `sync-authentik` also reconciles a one-click consent step on the shared
  authorization flow (`AUTHENTIK_AUTHORIZATION_FLOW_SLUG`) -- four objects:
  a consent stage `MOBILE_CONSENT_STAGE_NAME`
  (`'bellhop-mobile-app-consent'`, `mode: 'always_require'`), a binding of
  it to the flow (`evaluate_on_plan: false`, `re_evaluate_policies: true`,
  order `10`, matching the stock explicit-consent flow's own consent
  binding), an expression policy `MOBILE_CONSENT_POLICY_NAME`
  (`'bellhop-consent-on-mobile-redirect'`), and a binding of that policy to
  the stage binding (`failure_result: false`). `mobileUriSet(desired)`
  (research R6) is the sole input: the sorted, deduplicated union of
  `oidcMobileRedirectUris` over every *desired* OIDC-mode candidate --
  gated, has subdomains, `effectiveAuth() === 'oidc'` -- regardless of
  ladder/conflict/skip state for that entry, since a URI with no live
  client behind it can never be a real login's `redirect_uri` and this
  keeps the policy stable while an operator fixes an unrelated problem on
  that entry. `renderMobileConsentExpression(uris)` renders a Python
  expression policy body: a sorted `MOBILE_REDIRECT_URIS` set literal (each
  URI a `pythonStringLiteral`, escaping outside printable ASCII by code
  point, not UTF-16 unit, so a surrogate pair renders as the one character
  Python decodes rather than two lone surrogates that would silently never
  match) followed by a check of
  `request.context.get("goauthentik.io/providers/oauth2/params").redirect_uri`
  against that set; its first line is `MOBILE_CONSENT_MARKER`, and a policy
  is Bellhop's only when its expression starts with that exact marker
  (ownership, alongside "is a consent stage" for the stage -- a same-named
  object failing either check is reported as a conflict and left
  completely untouched, the whole consent reconcile skipped for that run).
  Fails closed on both sides: a missing `params` object evaluates to
  `None`, which is never in the set, so the stage is skipped (no consent
  page) the same as a thrown exception under `failure_result: false` --
  neither ever blocks a login.

  **Live-verified Authentik 2026.8 API quirks** (research R4) this
  reconcile works around: `GET /api/v3/policies/all/` ignores its own
  `name` query filter (returns every policy regardless), so
  `findPolicyByName` matches client-side; `GET /api/v3/flows/bindings/`
  ignores `target__slug` the same way (`target=<pk>` works), so bindings
  are listed by the already-resolved flow pk and filtered to the owned
  stage's `stageId` in code; and a policy binding created on a flow-stage
  binding is filtered by `GET /api/v3/policies/bindings/?target=<pk>`
  using the binding's own `policybindingmodel_ptr_id` (filtering by the
  binding's plain `pk` fails outright, `"Select a valid choice"`), while
  that same listing's own `target` field on the result reports the
  binding's ordinary `pk` instead -- so a listed policy binding is matched
  against *either* id (`AuthentikFlowStageBinding.id` or
  `.policyBindingModelId`), and a new one is always created with
  `target: policyBindingModelId` (what Authentik's own admin UI sends).

  **Ownership and reconcile order** (research R7/R8): a conflicting stage
  or policy stops the whole consent reconcile for that run -- nothing
  created, updated, or deleted, reported in `mobileConsent.conflicts`,
  never failing it (FR-017). Wanting the step, creation order is stage ->
  policy -> binding -> policy-binding; not wanting it (the set went empty,
  or was always empty), deletion order is the reverse
  (policy-binding -> binding -> policy -> stage) -- only objects this
  command owns are ever touched, so a hand-added binding/policy on the
  same stage binding survives. `applyMobileConsent` rolls a just-created
  stage binding back out if creating its policy binding then fails *in the
  same run* (a stage binding with no policy on it would otherwise gate
  every login on the flow, not just mobile ones, until the next successful
  sync) -- a stage binding that already existed before this run (a repair
  case) is left in place on the same failure instead, since it was already
  live either way. The cache is cleared (`POST
  /api/v3/flows/instances/cache_clear/`, FR-015) after any run that changed
  the binding or the policy, including the rollback case above (a plan may
  have been cached in between) and even when a later step in the same run
  failed -- a stage-only repair (just the consent `mode`) needs no clear,
  since the stage reads its own mode when it executes rather than from a
  cached plan.

  **Failure isolation and the no-mobile-URI read-failure swallow**
  (research R9): the whole consent reconcile runs inside its own
  `try/catch` after every other `sync-authentik` step (group bindings,
  before discovery) -- a thrown error becomes `mobileConsent.error` (the
  message plus a hint naming `AUTHENTIK_AUTHORIZATION_FLOW_SLUG` and the
  token's stage/policy/flow permissions) and the rest of the run completes
  regardless. `syncAuthentikFailed` (the CLI's non-zero-exit signal) is
  `true` when `applied && mobileConsent?.error` -- a conflict alone never
  makes it true. When the mobile URI set is *empty*, a failure while merely
  *reading* the four objects (listing stages/policies/bindings, resolving
  the flow) is swallowed and planned as "nothing to do" rather than thrown
  -- mirroring `listOAuth2ProvidersForRun`'s own precedent -- so a
  deployment whose Authentik token predates this feature, and which sets no
  mobile URLs, never sees a new error or a new non-zero exit; the
  trade-off is that owned leftovers from an earlier under-permissioned run
  wouldn't be cleaned up, accepted because that combination can't have
  created them in the first place. `syncProxyLive` (the Dashboard push-live
  step) logs `mobileConsent.conflicts`/`mobileConsent.error` via `logWarn`
  the same as `missingRungs`, and also returns them (conflicts, then the
  error) as `SyncProxyLiveResult.authentikMobileConsentProblems`, since the
  guest PATCH runs outside any job and the admin who saved a mobile URI
  would otherwise never see them. They're instance-wide, so
  `commitGuestEdit` echoes them as `mobileConsentProblems` only when the
  edit changed that guest's `oidcMobileRedirectUris` (order-sensitive
  compare, so resending the same list isn't a change); the Dashboard shows
  them as a warning banner under the mobile redirect URL field, and MCP
  `edit_guest` returns the same result.

  Two limits of the consent step's scope: it is bound only to the
  `AUTHENTIK_AUTHORIZATION_FLOW_SLUG` flow, so an OpenID client using a
  different authorization flow (e.g. one adopted with `adopt-oidc-client`
  that was set up with its own) gets the mobile URIs in its
  `redirect_uris` but no consent step; and `adopt-oidc-client` writes the
  client's `redirect_uris` (web + mobile) but does not reconcile the
  consent step itself -- the next `sync-authentik` run (or any Dashboard
  guest edit, via `syncProxyLive`) creates it.

  The web UI's Dashboard auth-group dropdown
  (`EditableAuthGroup.tsx`, replacing the old "requires auth" checkbox,
  backed by `GET /api/auth-groups` -- authenticated but deliberately not
  admin-gated, since a non-admin needs the rung options to raise a tier)
  reaches this the same way subdomain edits
  reach `sync-proxy`: via `syncProxyLive`, which now runs `sync-proxy`,
  `render-status-page`, and `sync-authentik` back to back, then
  `prune-acme-challenges` (below), as one combined push-live step.

  Changing `authMode`/`oidcRedirectUris`/`oidcMobileRedirectUris` through
  the Dashboard's guest PATCH
  (`EditableAuthMode.tsx`/`EditableOidcRedirectUris.tsx`/
  `EditableOidcMobileRedirectUris.tsx` -- issue #22 split the Advanced
  modal into General and Access tabs, General holding the type/ip/host/
  vmid/subdomains/port/proxy/VPN/app fields and Access holding auth
  group/mode plus whichever of unauthenticated paths (forward mode) or
  callback URLs/mobile redirect URLs/OIDC client info (OIDC mode) apply to
  the entry's current mode -- `accessFieldsFor(guest)`
  (`web-client/src/lib/oidc.ts`) decides which, reading the entry's saved
  mode rather than any in-progress dropdown edit, so a field hidden by a
  mode switch keeps its saved value rather than losing it; one exception,
  `needsCallbackUrlsBeforeOidc`: a gated forward-mode guest with no web
  callback URL also gets the callback URLs field, since `oidcConfigErrors`
  refuses its switch to OIDC until one exists. Which rows are rendered for
  the current tab, and so which field-help state is still live, comes from
  `renderedAdvancedFields`/`liveHelp` in `web-client/src/lib/
  advanced-modal.ts`) is
  admin-only in
  both directions with no raise/lower exception (FR-018, unlike
  `authGroup`'s own asymmetry) -- switching *to* OIDC removes the
  forward-auth gate the active proxy driver would otherwise enforce, and
  the callback URL (web or mobile)
  decides where a completed login is sent, so getting any of them wrong is never
  a purely narrowing edit. `oidcEditChangeError` (`src/web/routes/
  dashboard.ts`) is what enforces this -- triggered whenever the request
  body touches `authMode`, `oidcRedirectUris`, or `oidcMobileRedirectUris`,
  and comparing all three against the *parsed* current/updated entries
  (order-sensitive, like `oidcRedirectUris` itself) rather than the raw
  body, so resending an unchanged value is never treated as a change.
  `editDeletesOidcClient`/
  `OIDC_CLIENT_DELETION_CONFIRMATION_ERROR` (`src/operations/edit-guest.ts`)
  is the FR-022a confirmation rule: an edit that takes an entry from
  `effectiveAuth() === 'oidc'` to anything else (switching to forward-auth,
  or clearing `authGroup` while still in OIDC mode) is rejected (400)
  unless the request carries `confirmOidcClientDeletion: true`, decided
  from inventory state alone rather than whether the sync ever actually
  created a client for it. `commitGuestEdit` (extracted from the
  Dashboard's guest-PATCH handler so it's shared, unchanged, by the MCP
  server's `edit_guest` tool via `runEditGuest`) checks this before
  anything is validated or written, so an unconfirmed edit leaves the entry
  and its client exactly as they were. The Dashboard's `EditableAuthMode`
  shows a `ConfirmDeleteModal` naming the app before resending with that
  flag set; if the server still rejects a confirmed save (a concurrent edit
  changed something first), it reopens the same modal rather than
  surfacing a raw error. A successful guest-PATCH save runs the same
  combined `syncProxyLive` push-live step every subdomain/`authGroup` edit
  already triggers, so an OIDC entry's client is created/updated/deleted
  live in the same request; any post-apply discovery-check failures for the
  caller's own guest are echoed back as `oidcDiscoveryFailures` and
  rendered as a warning banner, the OIDC counterpart to the existing
  `authentikConflicts` banner. The same goes for why the sync left the
  guest alone: `syncProxyLive` returns both `authentikOidcSkipped` and
  `authentikForwardSkipped`, and `commitGuestEdit` echoes the edited
  guest's own entries from both as one `oidcSkipped` list (rendered by
  `AuthentikSkipBanner`). That matters because the push-live step writes
  the proxy configuration *before* it syncs Authentik: switching to OIDC drops the
  `forward_auth` gate first, so a skipped or failed sync leaves the app
  ungated at the edge until the next successful one.
- **OIDC credentials and adoption**
  (`src/commands/networking/oidc-credentials.ts`, `adopt-oidc-client.ts`,
  `src/web/routes/oidc.ts`, issue #1) are `sync-authentik`'s companion
  read/adopt commands, both admin-gated everywhere they're exposed.
  `oidc-credentials <entry>` (CLI, read-only, no `--apply`) and
  `GET /api/oidc/:entry/credentials` (web, behind the whole router's
  `requireAdminGroup`, `Cache-Control: no-store` since the response carries
  a secret) look up an OIDC-effective entry's Bellhop-owned OpenID client
  the same way `sync-authentik` computes ownership (`ownedProviderKind`)
  and return its issuer, client ID, and client secret read live from
  Authentik (`getOAuth2Credentials`) -- never from `inventory/bellhop.db`,
  which never holds a secret at all (FR-004/FR-021: not in the inventory,
  not in job history/logs/the jobs database, and not in any MCP tool
  response). `runOidcClientInfo` is the MCP-safe wrapper (FR-019b): it
  calls the same lookup and drops the secret from its own return value
  before anything in the MCP layer ever holds it, rather than trusting
  every call site to remember to omit it -- the `get_oidc_client` tool
  (`src/mcp/build-server.ts`) calls only this, never the secret-carrying
  function directly, and its response's `secretAvailableFrom` field points
  at the Dashboard or the `oidc-credentials` CLI command instead. The
  Dashboard's `OidcCredentials.tsx` (the guest Advanced modal's reveal
  button) calls the web route directly; a non-admin sees a plain "OIDC
  (credentials visible to admins)" note instead of a disabled control,
  since there's nothing for them to reveal at all (FR-020, including under
  impersonation -- `isAdminUser` reads the same overlaid `req.user.groups`
  every other admin check does).
  `adopt-oidc-client <entry> [--apply]` (CLI), `POST
  /api/oidc/:entry/adopt/preview`/`/apply` (web, same router, surfaced by
  `AdoptOidcClientButton` next to the conflict banner on
  `EditableAuthMode`/`EditableOidcRedirectUris`), and the MCP tool
  `adopt_oidc_client` (registered like every other `MCP_OPERATIONS` entry,
  `fleetWide: true` rather than `targetType: 'guest'` since `entry` can
  also name a host or external site) all go through the one
  `runAdoptOidcClient` function, so the three front ends can never disagree
  about what adoption does or refuses: it sets `meta_publisher: 'bellhop'`,
  PATCHes any settings drift via the same `diffOAuth2Settings`
  `sync-authentik` uses (so it can never touch `client_id`/`client_secret`
  either), and reconciles the entry's ladder bindings via the same exported
  `planBindingChanges` -- the same three steps a routine sync performs for
  an owned OIDC entry, just against one entry instead of every candidate.
  Same dry-run/`--apply` convention as every other command
  (`formatAdoptOidcClient` mirrors `formatSyncAuthentik`'s own
  OpenID-settings/binding-change layout). Refuses an entry that isn't
  OIDC-effective, an Application that's already owned (either kind), or one
  that isn't OAuth2-backed at all.
- **`prune-acme-challenges`**
  (`src/commands/networking/prune-acme-challenges.ts`, issue #162) deletes
  `_acme-challenge` TXT records left behind in the inventory `domain`'s
  Cloudflare zone by the Caddy driver's DNS-01 `TLS_BLOCK` (an aborted
  issuance, a restart mid-challenge, a removed or renamed subdomain).
  The command's own name and behavior are unchanged by issue #10 -- only
  *when it runs inside `syncProxyLive`* is now gated on a driver
  capability (see below), since a driver without
  `capabilities.acmeDns01ViaCloudflare` (the nginx driver, issue #30,
  declares this `false` since it never touches DNS at all; HAProxy, not
  yet shipped, would too) never leaves one of these records behind in the
  first place.
  REST-only via
  `CloudflareClient` (`src/lib/cloudflare-client.ts`, the same
  real/unconfigured null-object pattern as `AuthentikClient`). Ownership is
  deliberately **age-based and zone-wide, not inventory-scoped** -- unlike
  `sync-authentik`'s #154 rule: a record is this command's to delete when
  its name is `_acme-challenge.<domain>` or `_acme-challenge.<labels>.<domain>`
  (case-insensitive), its type is `TXT`, and its `modifiedOn` is more than
  24h old (`STALE_AFTER_MS`, not configurable). An inventory-scoped rule
  would never catch a removed/renamed subdomain's record, the main case it
  exists for; age is what keeps it safe, since a challenge record matters
  only for the minutes a challenge is validated, so a day-old one is in use
  by no ACME client on the zone (Caddy's, a hand-authored block's, or a
  NAS's). A `CNAME` at `_acme-challenge` (DNS-01 delegation), a record with
  no parseable `modifiedOn`, and a record Cloudflare itself created/owns
  (`meta.read_only`/`meta.auto_added` -- e.g. its own Universal/Advanced
  cert validation TXT records, mapped onto `CloudflareDnsRecord.managedByCloudflare`)
  are never deleted, however old they get. The client lists every
  TXT record with no server-side name filter -- a read-only capture of the
  live zone on 2026-09-12 found zero `_acme-challenge` records (8 records
  total), so no filter could be verified, and the command does all name
  matching. Credential: `CLOUDFLARE_DNS_API_TOKEN` from gitignored
  `data/cloudflare-api.env` (Zone:Read + DNS:Edit, minted for this alone),
  dotenv-loaded by `src/cli.ts`, `src/web/server.ts`, and
  `src/mcp/server.ts`. It is **not**
  `data/cloudflare.env`, which is the `cloudflare-ddns-lxc` answer file
  and still read by nothing in `src/`, and the variable name differs from
  the `CLOUDFLARE_API_TOKEN` Caddy and DDNS use, so each token stays
  independently revocable. Every `RealCloudflareClient` request carries an
  `AbortSignal.timeout(CLOUDFLARE_REQUEST_TIMEOUT_MS)` (10s) so a Cloudflare
  endpoint that accepts the connection and then stalls can't hang the caller
  indefinitely -- a timeout surfaces as a thrown `Error` like any other
  request failure. Dry run by default, `--apply` deletes, a failed
  delete is reported and the rest proceed (CLI exit 1). In `syncProxyLive`
  (`src/web/proxy-sync.ts`) it is the last step and **never fails the
  caller** (the 10s timeout on every request bounds how long that can
  take): a driver without `acmeDns01ViaCloudflare` (checked via
  `getDriver(inventory)`) logs one skip line and returns before ever
  touching Cloudflare (`pruneAcmeDriverSkipMessage`); an unconfigured
  client logs its own skip line; and any thrown error (bad token, outage,
  zone not found, timeout) becomes a `logWarn`; `SyncProxyLiveResult`
  carries nothing for either case, since there is no Dashboard action to
  ask for. `syncProxyLive` is
  reached through the shared operations layer (`src/operations/edit-guest.ts`
  and `src/operations/provisioning.ts`), so the web UI and the MCP server
  both run it. `cloudflare` is **required** on `OperationDeps`
  (`src/operations/types.ts`): `syncProxyLive` treats a missing client as
  unconfigured and skips the prune silently, so a required field is what
  turns a forgotten deps literal into a compile error instead of a
  cleanup that quietly never runs. It stays optional on `AppDeps` and
  `syncProxyLive`'s own deps (defaulting to `UnconfiguredCloudflareClient`,
  like `impersonationStore`) only so tests that don't care need no change;
  `src/web/server.ts` and `src/mcp/server.ts` always pass
  `buildCloudflareClient()`. Only the guest-edit and create/install/
  delete-guest paths prune: `sync-proxy`, `render-status-page`, and
  `migrate-guest` -- CLI, web, and MCP alike -- call `runSyncProxy`/
  `runRenderStatusPage` directly rather than `syncProxyLive`, so a guest
  migration or a manual proxy push never cleans up stale TXT records.
- **`render-status-page`** (`src/commands/networking/render-status-page.ts`)
  regenerates a static HTML page and writes it to the operator-configured
  `statusPagePath` (issue #124) on whichever entry is `proxy: true` — the
  document root Caddy's hand-authored `caddy.example.com` block already
  serves via `file_server` (that block itself is hand-authored outside any
  driver's managed section, so it stays named after Caddy regardless of
  which driver is active). Opt-in entirely: an operator who hasn't set
  `statusPagePath` never gets a page rendered anywhere. The standalone CLI
  command itself throws, naming the `set-config statusPagePath
  </absolute/path> --apply` fix; the two automated callers below treat an
  unset `statusPagePath` as a no-op, logging one line and continuing rather
  than failing the rest of their run. As of issue #33, the active driver
  is checked first, before `statusPagePath`: a driver that manages no
  proxy (`proxyDriver: 'none'`, `!managesProxy(driver)`) throws
  `NO_PROXY_STATUS_PAGE_ERROR` from the standalone command regardless of
  whether `statusPagePath` happens to be set, since there is neither a
  managed proxy nor a document root to write to; a *managed* driver whose
  `statusPage` is `null` (none ships today) throws
  `statusPageUnsupportedError(id)` instead, whose remedy is to clear
  `statusPagePath` or choose a driver that serves one. The exported
  `statusPageSkipReason(inventory)` is the one place that decides, for the
  two automated callers, whether their render should even run: it returns
  `{ message, level }` in the same order -- the `none` skip line
  (`info`), the managed-but-no-status-page line (`warn` when
  `statusPagePath` is set, since the operator's setting is being ignored,
  else `info`), the existing `statusPagePathSkipMessage()` when
  `statusPagePath` is unset (`info`) -- or `null` when the render should
  actually happen. `syncProxyLive` and `migrate-guest`'s post-move push
  both call it and pass any non-null result to `logStatusPageSkip`
  instead of duplicating either check inline.
  The page shows two fetched-fresh
  `<pre>` blocks (HTML-escaped): a
  human-readable YAML snapshot of the current inventory (`src/cli.ts` calls
  `loadInventory` then the `yaml` package's `stringify` on the result and
  passes that string in as plain text — `inventory/bellhop.db` itself has no
  text form to `cat`, so this is a live re-render rather than a raw file
  read the way the old `inventory/hosts.yaml` version worked) and the
  "Deployed proxy configuration" section, read via the active driver's own
  `snapshot()` (issue #10, T014) rather than a hardcoded `cat` of a
  driver-specific config path — `CADDYFILE_PATH` is gone; the driver's
  `configFiles()` (defaulting to `[configPath]`, where `configPath` comes
  from the `proxyConfigPath` setting, else the driver's own
  `defaultConfigPath`) is what resolves the path(s) now, so this page shows
  whatever the active driver actually manages and its own failure message
  comes from that one shared implementation (`src/lib/proxy/file-driver.ts`)
  instead of being duplicated here. As a standalone CLI
  command it's still manual, on-demand — the CLI's own `sync-proxy` never
  calls it. The web UI is the exception: `src/web/proxy-sync.ts`'s
  `syncProxyLive` (used by both `create-lxc`/`create-vm`/`install-app`
  apply when the Subdomains field was used, and the Dashboard's
  guest-subdomains PATCH endpoint — see below and "Reading/writing the
  inventory database") calls `sync-proxy` then `render-status-page`
  back to back on every web-UI-driven subdomains change, so the two never
  drift the way a CLI-only workflow could, unless `statusPagePath` is unset,
  in which case only `sync-proxy` runs. `migrate-guest` (below) skips it the
  same opt-in way on its own post-move proxy push. That `caddy.example.com`
  block is hand-restricted to LAN/internal ranges only (a Caddy `@internal
  remote_ip` matcher + `handle`/`handle` pair, 403 otherwise) since the page
  shows real internal hostnames/IPs — neither `render-status-page` nor
  `syncProxyLive` has any opinion on that restriction, they only ever touch
  `index.html`/the managed proxy-configuration section, never the site
  block itself.
- **`attach-nfs-mount`** (`src/commands/provisioning/attach-nfs-mount.ts`)
  is the way to give an *existing* guest access to a NAS share — there is
  no direct-mount path anymore (see below). `create-lxc`/`install-app` also
  offer the same host-relay bind-mount as an optional step at creation time
  via `--nfs-storage`/`--nfs-mount-point`, sharing this command's
  resolution/script-building logic via `src/lib/nfs.ts` — but
  `attach-nfs-mount` remains the only way to add a mount to a guest that
  already exists. It attaches an lxc guest to an
  already-existing Proxmox `nfs:` storage entry via a host-relay bind-mount
  (`pct set ... mpN`) on the guest's *parent host*, the same mechanism
  `migrate-nfs-mount` converts existing guests onto — the guest itself
  never runs `mount -t nfs`. Unlike `migrate-nfs-mount`, it has no existing
  fstab mount to discover the target path from, so `--mount-point` is a
  required flag. Refuses to proceed if the guest already has an `mpN`
  bind-mount configured at that exact path (`existingMountPoints()` scans
  `pct config <vmid>` for `,mp=<path>`, stopping at the next comma) — this
  intentionally does **not** replicate the original bash version's
  `awk -F',mp=' '{print $2}'`, which actually captured the mount path plus
  any trailing comma-separated `pct` options after it (e.g. `,backup=0`)
  and so would have silently failed to detect a duplicate whenever one was
  present; the TypeScript port fixes that bug rather than reproducing it.
  Both `attach-nfs-mount` and `migrate-nfs-mount` resolve their target path
  via `pvesh get /storage/<id>`, so `--storage` must name a real Proxmox
  `nfs:` storage entry — as of 2026-07-28 that's only `nas-proxmox`.
  `nas-media`/`nas-immich` were deliberately moved *off* Proxmox-managed
  storage onto plain `/etc/fstab` host mounts (Proxmox's `nfs:` storage type
  forces a `content` type, e.g. `images`, which made Proxmox auto-create and
  endlessly recreate a same-named junk directory at the share root), so
  neither command currently works with `--storage nas-media`/`nas-immich`;
  onboarding a new guest onto either share needs a manual `pct set <vmid>
  -mpN /mnt/pve/nas-media,mp=<path>` + `pct reboot` instead.
- **`sync-inventory`** (`src/commands/maintenance/sync-inventory.ts`)
  queries every `pve`-type host directly (never a guest — so it's the one
  command that never exercises `runRemote`'s `pct`/`qm` wrapping path) via
  `pvesh get /nodes/$(hostname)/{lxc,qemu}` and reconciles `guests[]` with
  live state, keyed by `(host, vmid)`: existing entries keep
  `name`/`subdomains`/`port`/`proxy` but get `type`/`ip` refreshed (IP parsed
  from the guest's `net0`/`ipconfig0` config, mask stripped); new guests are
  added with no `subdomains`/`port`/`proxy` (unless the web UI's create-lxc/
  create-vm/install-app apply already added the entry itself — see below —
  in which case sync-inventory's `{ ...existing }` merge preserves whatever
  `subdomains` that apply already set); guests no longer present are
  dropped. It also queries every host's `/nodes/$(hostname)/network`,
  filters for `type: 'bridge'`, and fully replaces that host's `bridges[]`
  (`alias` from the interface's Proxmox `comments` field, defaulting to
  `'LAN'`) — a host whose network query fails keeps its previous `bridges[]`
  entirely unchanged rather than being blanked out, reported via
  `bridgeFailures` and `formatSyncInventory`. It does the same for
  `/nodes/$(hostname)/storage` -> `.hosts[].storages` (see the schema
  paragraph above for what's kept vs. dropped and why), independently of
  the bridges query (one failing doesn't affect the other) and reported via
  its own `storageFailures`. `--apply` calls `saveInventory`, which
  replaces `.hosts` and `.guests` wholesale, sorted — see "Reading/writing
  the inventory database" above for the SQLite implementation and the sort
  order/idempotency rationale.
- **`audit-nfs-mounts`** (`src/commands/maintenance/audit-nfs-mounts.ts`)
  is read-only and, unlike its original fstab-scanning design, has no NFS-
  server parameter at all: now that host-relay bind-mounts (see
  `attach-nfs-mount`/`migrate-nfs-mount` below) are this toolkit's only
  supported pattern, it iterates every `lxc`-type guest in inventory (or
  one via `--host`, which throws if the named entry isn't type `lxc`), runs
  `pct config <vmid>` on the guest's *parent host* through `runRemote`, and
  parses its `mpN:` lines with `parseMpEntries` (`src/lib/nfs.ts`) into
  `{ hostPath, mountPoint }` pairs. Each guest's `mpN` host paths are then
  matched, per its parent host, against `knownNfsPaths` — a `Map` built
  from that host's own `nfsMounts[]` (sync-inventory's discovered fstab
  mounts) plus a deterministic `/mnt/pve/<name>` entry for every `nfs:`-type
  storage in `storages[]` (Proxmox's own fixed mount convention,
  so no extra `pvesh` call is needed to resolve it) — an `mpN` path that
  matches neither is simply not NFS-backed and is skipped. Matches are
  aggregated by share name into `usages: NfsMountUsage[]`
  (`{ name, export?, hostPath, users: string[] }`, `users` listing each
  `<guest> (<container mount point>)` sharing it) rather than the old
  `Map<string, string[]>` keyed by export path, since a host-relay mount's
  identity is its inventory-known name, not a live export string a guest
  might not even carry post-migration; a guest whose `pct config` can't be
  read is counted separately as `unreachable`, never silently treated as
  "no NFS mounts." Still exists for the same reason it always has:
  inventorying current NFS usage across containers, just against the
  bind-mount topology the toolkit actually uses today rather than the
  direct guest-side fstab mounts it used before `attach-nfs-mount`/
  `migrate-nfs-mount` replaced them.
- **`migrate-nfs-mount`**
  (`src/commands/provisioning/migrate-nfs-mount.ts`) converts one guest at
  a time from a direct guest-side NFS mount (the old pattern, before
  `attach-nfs-mount` replaced it — see above) to a host-relay bind-mount
  backed by an already-existing Proxmox `nfs:` storage entry — it never
  creates or modifies storage config itself. It discovers the guest's
  current export/mount-point via `parseNfsLines` (`src/lib/nfs.ts` — the
  one remaining fstab-line parser now that `audit-nfs-mounts` has moved to
  `parseMpEntries`, since this command still has to read a *pre-migration*
  guest's direct fstab mount before it can convert it), cross-validates the given `--storage`'s
  configured `export` (`pvesh get /storage/<id>`) against what the guest
  actually mounts, and refuses to proceed on any mismatch — the same "catch
  a plausible operator mistake" spirit as inventory validation. It's also
  the one command in this toolkit that targets two different `runRemote`
  names in a single run: the guest itself (unmount, edit fstab) and the
  guest's *parent host* (`pct set` a new `mpN` bind-mount at the next free
  index, found by scanning `pct config <vmid>` so an existing bind-mount is
  never clobbered; `pct reboot`, which is a real, brief outage for whatever
  the guest runs).
- **`migrate-guest`** (`src/commands/provisioning/migrate-guest.ts`, issue
  #96) moves an `lxc`/`vm` guest from one Proxmox host to the other
  (`pve-node-a` <-> `pve-node-b`), renumbering its VMID/IP to
  match the target host's `resolveMid` convention. It does this via backup
  and restore under a new, explicit VMID rather than `pct migrate`/`qm
  migrate`, because Proxmox VMIDs are unique **cluster-wide**, not
  per-node — neither `pct migrate` nor `qm migrate` can change a guest's
  VMID during a same-cluster migration, so a real host move that also needs
  a new VMID has no path through Proxmox's own migrate commands at all.
  Pipeline: `vzdump <old-vmid> --storage <backup-storage> --mode stop
  --compress zstd` on the source host (`--backup-storage` falls back to the
  inventory-wide `backupStorage` setting when omitted, throwing if neither
  is given — see "Reading/writing the inventory database" above; validated
  `active`/backup-capable/`nfs`-type on *both*
  hosts the same way `migrate-nfs-mount`'s `--storage` is, since only a
  cluster-shared storage is guaranteed visible from both sides of the
  backup/restore); `pct restore`/`qm restore` on the target host into the
  `resolveMid`-derived VMID, using `pickStorage` (or an operator-chosen
  `--storage` override, same pattern as `install-app`/`create-lxc`/
  `create-vm`) to resolve the target guest-storage; reconfigure networking
  and start the guest; verify it reaches "running" status on the target
  host (a small retry budget, same convention as the TLS-probe retry in
  issue #100) — **this is the safety gate before anything on the source
  host is touched**, so a verification failure leaves the old guest
  intact and the new (unverified) one in place for the operator to debug,
  with no automatic rollback; only once verified does it destroy the old
  guest and clean up the intermediate backup archive (including its
  `.notes` and `.log` sidecars — vzdump's `.log` sidecar *replaces* the
  archive's `.tar.<ext>`/`.vma.<ext>` extension rather than appending onto
  it the way `.notes` does, so cleanup strips that suffix before appending
  `.log` instead of naively appending `.tar.zst.log`). Because `vzdump
  --mode stop` restarts a guest that was running before the backup
  (documented/observed Proxmox behavior), the source guest is explicitly
  re-checked and stopped again, if needed, right after the backup and
  *before* restore begins on the target — closing the window for the rest
  of the migration, not just narrowing it to right before the final
  destroy step, since restore+start on the target while the source might
  still be running risks both copies running simultaneously (and, for a
  guest with an NFS host-relay bind-mount, both writing to the same NAS
  share at once). Network reconfiguration is a read-then-surgically-rewrite
  step, not a reconstructed `--net0`/`--ipconfig0` string: it reads the
  *restored* guest's own config (`pct config`/`qm config`) and rewrites
  only `ip=` (`setNet0Ip`/`setIpconfig0Ip`, `src/lib/guest-vpn.ts`,
  sibling helpers to `set-guest-vpn`'s own `setNet0Gateway` and built the
  same way — see that command's entry above for why a rebuilt-from-scratch
  net0 string silently drops `hwaddr=`/`tag=`/etc.). Critically, it never
  touches `gw=`: `resolveMid` returns the same gateway regardless of host
  role on this toolkit's single flat LAN, so a migration never legitimately
  needs to change it, and for a guest deliberately routed through a VPN
  gateway guest (`set-guest-vpn`), silently resetting `gw=` back to the LAN
  gateway would un-VPN it with no indication that happened. A guest itself
  flagged `vpnGateway` is refused outright at the pre-flight-validation
  stage (mirroring `set-guest-vpn`'s own refusal to route a gateway through
  a gateway) — migrating a gateway would change the IP every other guest
  routed through it points its `gw=` at, and this command has no
  reconciliation step to fix those dependents back up. On success,
  `inventory/bellhop.db` is updated in place (same `(host, vmid, ip)`
  rewrite, preserving `subdomains`/`port`/`proxy`/`app`/
  `insecureBackendTls`/`authGroup`/etc., that the Dashboard's guest-PATCH
  route already does for in-place edits), and if the guest has
  `subdomains`, `sync-proxy` runs in the same `--apply` so the managed
  proxy configuration points at the new IP immediately (a failure there
  only warns -- see the driver-interface bullet above) — `render-status-page`
  runs
  alongside it too, but only when `statusPagePath` is set (see
  `render-status-page` below for the opt-in behavior it shares with
  `syncProxyLive`) —
  `sync-authentik` reconciliation is deliberately not run here, since it
  keys off `authGroup`/subdomain identity, never guest IP. Web UI: a
  Provisioning-page form (Guest/Target Host/MID/Backup Storage/Storage),
  gated by the same inline `isResourceAllowed` check every other route in
  `provisioning.ts` uses, submitting through the existing job-queue/
  log-streaming infrastructure like every other provisioning action.
- **`install-app`/`update-app`**
  (`src/commands/provisioning/install-app.ts`/
  `src/commands/maintenance/update-app.ts`) wrap
  [community-scripts/ProxmoxVE](https://github.com/community-scripts/ProxmoxVE)'s
  `ct/<app>.sh` one-line installers. Before doing anything else, `install-app`
  pre-checks that its `--mid`-derived VMID isn't already in use on the
  target host (`checkVmidAvailable`: `pct status <vmid> || qm status <vmid>`,
  since a VMID can already be occupied by either guest type), throwing a
  clear error naming the conflicting inventory guest (or a generic message
  if the VMID is live but untracked) rather than letting community-scripts'
  `build.func` silently reassign the VMID to a free one while keeping the
  now-stale IP baked into `var_net` (see issue #53) -- this runs on every
  call, dry-run included. `install-app` targets a `pve` host and
  reuses `resolveMid` (same as `create-lxc`) to derive
  `var_ctid`/`var_net`/`var_gateway`, sets the community-scripts `var_*` env
  vars to force its normally-interactive whiptail installer into unattended
  mode, then runs `bash -c "$(curl -fsSL <app-url>)"`. Getting genuinely
  unattended turned out to need more than the `var_*` overrides alone
  (discovered live, debugging a real stuck job): community-scripts' shared
  `misc/build.func` calls `clear` partway through regardless of `var_*`,
  which fails outright with no `TERM` set over a non-interactive `pct exec`
  session (`export TERM=xterm` fixes it); its `install_script()` shows an
  interactive "Default Install / Advanced Install / ..." whiptail menu
  whenever the `$mode` env var is unset, with *no* tty check first, so it
  hangs forever rather than erroring (`export mode=default` selects the
  same choice the `var_*` overrides already assume); and it separately shows
  a "Which storage pool?" whiptail menu (also no tty check) unless
  `var_template_storage`/`var_container_storage` are set — `pickStorage`
  (below) fills those from the target host's scanned `storages[]`.
  `PHS_SILENT=1` is build.func's own documented headless-mode flag,
  covering its other interactive prompts (OS-mismatch checks, addon-update
  prompts, ...) with their own safe default. Below all of that, the exec
  channel's own closed stdin (see `Ssh2SSHClient.exec()` above) is a second,
  lower-level backstop that catches app-level prompts none of these
  `var_*`/`mode`/`PHS_SILENT` flags reach — the confirmed real cases are
  `paperless-gpt` and `paperless-ngx`, both of which have their own plain
  `read -rp`/`read -r -p` prompts baked into the app script itself, not the
  generic `build.func` whiptail flow those flags suppress. `pickStorage(host, contentTypes)`
  (`src/lib/storage.ts` — shared, not install-app-specific: `create-lxc` and
  `create-vm` use it too, see below) picks the first *active* storage
  supporting one of the given Proxmox content types (`['vztmpl']` for
  `var_template_storage`, `['rootdir', 'images']` for
  `var_container_storage`) — throws a clear error naming the host if none
  qualify (even during a dry-run preview, since a preview showing a script
  with no storage vars set would just be misleading) rather than risking
  the same silent hang; different hosts can have different pools available
  (confirmed live: `pve-node-b` has no storage with
  `local-lvm`'s exact name/content combo `pve-node-a` has), so there's
  no single hardcoded fallback. The web UI exposes this as editable
  dropdowns (`select-storage` `FieldKind`, `storageContentTypes` on the
  field def) rather than leaving it fully automatic: `install-app` gets
  Template Storage/Container Storage fields, `create-lxc` gets a Storage
  field (previously hardcoded to `local-lvm` regardless of what a host
  actually has), and `create-vm`'s existing Disk Storage field changes from
  a static `local-lvm`/`local`/`nas-proxmox` list to the same host-aware
  dropdown — all three populate from the selected host's `storages[]`,
  re-filter and re-select a default when the host changes (same pattern as
  the Bridge field), and fall back to `pickStorage`'s automatic selection
  server-side if left unset (so the CLI, which has no `--storage` flags,
  keeps working unchanged). As of issue #64, `deploy-vpn-gateway` gained
  the same web-UI treatment -- a Provisioning-page form (VPN
  Provider/Host/MID/Name/Storage, plus conditional per-provider credential
  fields -- Access Token for NordVPN, Username/Password for PIA,
  shown/hidden and masked per the selected VPN Provider) reusing this exact
  storage-dropdown-with-automatic-fallback pattern; see the "Web UI
  responsiveness/theming" bullet below for its credentials mechanism. Both
  `create-lxc` and `install-app` also
  automatically provision the target Proxmox host's own
  `~/.ssh/authorized_keys` into every newly created guest
  (`readHostAuthorizedKeys`, `src/lib/authorized-keys.ts` — this toolkit
  already assumes passwordless key auth to every Proxmox host, so that file
  is exactly the set of keys already trusted to reach it today):
  `create-lxc` runs a follow-up `pct exec` call
  (`buildAuthorizedKeysWriteScript`) right after `pct create` succeeds;
  `install-app` instead sets `var_ssh=yes`/`var_ssh_authorized_key=<keys>`,
  which community-scripts' own `build.func`/`install_ssh_keys_into_ct()`
  consumes — the same mechanism its own interactive "add an SSH key?"
  prompt would have used, just pre-answered (`var_ssh=no` with no
  `var_ssh_authorized_key` line when the host has no keys to offer). Both
  commands log a sample `ssh root@<ip>` connect command on a successful
  apply, regardless of whether the key-provisioning step succeeded, was
  skipped, or failed. A missing/failed key-provisioning step *warns and
  does not fail* `create-lxc` — the guest was already created successfully,
  and this is a convenience addition, not a hard requirement, same
  precedent as a failed NFS attach not rolling back the guest either. This
  is **not** symmetric with `install-app`: because `install-app` reuses
  community-scripts' own `install_ssh_keys_into_ct()` rather than
  duplicating its logic, a failed key-push during `install-app --apply` can
  fail the *entire install* — that function returns 252 on a failed `pct
  exec`/`pct push`, at a point in `build.func` where `set -e` may still be
  in effect, aborting the whole script rather than continuing past it the
  way `create-lxc`'s own follow-up call does. This asymmetry is a known,
  intentional tradeoff (explicitly accepted, not a bug to fix) of reusing
  community-scripts' own tested key-install logic instead of duplicating
  it in this toolkit — so a future `install-app` abort over an SSH key push
  isn't a mystery. `install-app`'s CLI action (`src/cli.ts`) also opts into
  an interactive mode — `SSHClient.execInteractive()`
  (`src/lib/ssh-client.ts`) — whenever `--apply` runs attached to a real
  terminal (`process.stdin.isTTY`): the community-scripts installer's own
  stdin/stdout are piped through a real remote pty live instead of being
  buffered, so an app-specific prompt some installer scripts show (e.g.
  `paperless-gpt`'s Paperless URL/API-token prompt, `paperless-ngx`'s
  Adminer prompt — found via issue #52) is visible and answerable rather
  than silently defaulted. No prompt-detection heuristic is involved: a
  real pty makes any prompt, known or not, behave the same way a plain
  interactive `ssh` session would. Ctrl+C during an interactive install is
  intercepted locally (never forwarded to the remote) and cancels the
  connection, warning that the vmid may be left partially created since
  the remote script gets killed mid-run. The web UI never uses this path —
  `runInstallApp`'s `opts.interactive` stays unset for a web-triggered
  apply, and `JobSSHClient` (`src/web/jobs/job-ssh-client.ts`) rejects
  `execInteractive()` outright as a safety boundary, since a background
  job has no terminal to attach to. The web UI instead answers app-script
  prompts by *relaying* them (issue #57):
  `src/web/routes/provisioning.ts` sets `watchForPrompts` for `install-app`
  alone (every other job type leaves it unset, so `JobSSHClient` behaves as
  it always has with no detection overhead) and pre-scans the app script
  via `checkAppUrl(...).prompts`; `JobSSHClient` watches the output stream,
  moves the job to `awaiting_input`, emits the text over the
  `/ws/jobs/:id` WebSocket (replayed to a client connecting mid-prompt),
  and `POST /api/jobs/:id/answer` writes the reply back into the channel
  (`/dismiss-prompt` abandons a false positive). Note that supplying
  `onStdinReady` makes `exec()` request a real pty *and keep stdin open*
  rather than its default immediate `stream.end()` — which is what makes
  answering possible, and also why an undetected prompt **hangs the job**
  here instead of failing fast on EOF the way every non-watching exec does.
  Detection runs on one self-re-arming timer with three cumulative
  silence tiers (`src/web/jobs/job-ssh-client.ts`, issue #160): at 2s it
  tests the trailing line against the app's own pre-scanned prompt
  strings, compiled into regexes by
  `src/web/jobs/prompt-matcher.ts` (shell expansions in the hint become
  wildcards, since the script source carries `${TAB3}Enter the token: `
  while the pty prints `   Enter the token: `); at 30s it adds the two
  original trailing-line heuristics — a *string-final* `?` or a
  `(y/n)`-style hint; at 5 minutes it escalates whatever is in the buffer
  unconditionally as a `stall`, because `watchForPrompts` mode holds stdin
  open and an undetected prompt would otherwise hang the job forever
  (there is no EOF backstop here, and the 15-minute abandon timer only
  starts once a prompt has already been detected). Every pause carries its
  origin (`expected`/`heuristic`/`stall`) through to the job row and the
  WebSocket, so `JobView` can number a known prompt ("question 2 of up to
  4") and flag a stall as a guess rather than a detected question. The
  banner's hint text, dismiss-button label, and which controls get the
  quiet/outline treatment for each origin all come from one
  `Record<PromptOrigin | 'none', …>` table, `promptBannerView()` in
  `web-client/src/lib/prompt-banner.ts` (issue #4), so a new origin can't
  ship without copy for the banner to show.
  The MCP server surfaces the same pauses: its jobs run through the same
  `JobRunner`/`JobSSHClient` detection, and `wait_for_job` relays each one
  through MCP elicitation instead of a WebSocket (see "MCP server" below) --
  one detection path, two front ends.
  The pre-scan reads `install/<slug>-install.sh` — the file `build.func`
  downloads into the container, and where an app's own `read` prompts
  actually live. It is deliberately *not* the `ct/<slug>.sh` script: all 20
  ct scripts that carry a `read` prompt have it inside `update_script()`,
  which `install-app` never reaches. Measured 2026-09-10, 75 of 584 install
  scripts prompt (128 prompts); the two heuristics alone caught 61 and
  missed 67, and 33 scripts missed their *first* prompt, so a
  web-triggered apply stalled immediately. **The web UI is now the
  equal path for a prompting app**, with three residual gaps that fall
  back to the heuristic and stall tiers: the 14 `ct/` scripts with no
  conventionally-named install script, a pasted full script URL (no
  derivable counterpart), and a prompt whose text is built from a variable
  rather than a literal string.
  `update-app` targets
  an existing guest and re-runs the *same* `ct/<app>.sh` command *inside* it
  (via `runRemote`'s normal `pct`/`qm`-wrapping path) — that's the
  documented way these scripts' own `update_script()` path gets triggered,
  rather than a separate update command; it exports the same `TERM`/
  `PHS_SILENT` (but not `mode`, which only matters for `install_script()`,
  never reached when running inside an already-created guest). Neither
  command's CLI path touches
  `inventory/bellhop.db`; `sync-inventory` is what picks up a newly
  `install-app`-created guest there. The web UI's `/api/provisioning`
  routes (`src/web/routes/provisioning.ts`) are the one exception: on a
  successful `create-lxc`/`create-vm`/`install-app` apply, the route layer
  itself (not the command function, which stays inventory-agnostic so the
  CLI's behavior above is unaffected) upserts the new guest into
  `inventory/bellhop.db` right away — name/type/vmid/host/ip derived from
  the resolved MID, plus any `subdomains` entered in that form's Subdomains
  field — rather than waiting on a separate Sync Inventory run. When
  `subdomains` were given, it also awaits `syncProxyLive` (see
  `render-status-page` below) in the same job, so the whole apply only
  succeeds once those subdomains are actually live.
  The web UI's App field is backed by a cached catalog of every
  community-scripts `ct/<slug>.sh` script (`src/lib/script-catalog.ts`,
  issue #131), served by `GET /api/provisioning/install-app/apps` and
  rendered as a type-to-filter suggestion popup by
  `web-client/src/components/AppCheckInput.tsx` -- grouped
  `ProxmoxVE (stable)` above `ProxmoxVED (development)`, community-scripts'
  own vernacular for its two repos. The field itself stays free text, so
  pasting a full script URL still works exactly as `resolveAppUrl`'s
  `includes('://')` branch has always allowed; the catalog is only ever a
  suggestion list, never a constraint, and every failure path (GitHub
  unreachable, nothing cached) degrades to the plain text input the field
  used to be. Slugs are all it can offer -- the community-scripts org
  publishes no machine-readable catalog metadata, so there are no
  descriptions, categories, or icons to show. A slug present in both repos
  is listed under stable only, since `checkAppUrl` and the apply-time curl
  both resolve it to the stable script anyway. The catalog persists to its
  own `script_catalog`/`script_catalog_meta` tables inside
  `inventory/bellhop.db` -- like `permission_groups`/
  `permission_rules`, they sit outside `saveInventory`'s wholesale
  delete-and-reinsert, so `sync-inventory --apply` never disturbs them --
  and refreshes on read whenever the stored copy is older than
  `CATALOG_MAX_AGE_MS` (24h). There is no manual refresh control and no
  background timer, and the CLI's `install-app --app` is unaffected.
  When `customScriptsRepo`/`customScriptsBranch` (issue #11) are configured,
  `getScriptCatalog` (`src/lib/script-catalog.ts`) also adds a third group,
  ordered first, labelled with the source's own `owner/repo@branch`
  string, holding **only the apps the branch changes** (issue #15:
  `resolveHeadSha` + `compareBranch`, the same comparison
  `resolveAppSource` uses -- not the fork's whole `ct/` listing, which
  carries every inherited upstream app), plus `conflicts`, the subset
  `detectConflict` flags; any slug it shares with `stable`/`dev` is
  removed from those and annotated with which upstream repo(s) it
  shadows (`withCustomGroup`). A fork-only app is not listed, but typing
  its slug still resolves it. Unlike the
  persisted upstream catalog, the custom group's cache
  (`customCatalogCache`, keyed by that same `owner/repo@branch` label so a
  settings change never serves a stale listing under the old key) is
  **in-memory only, never written to `script_catalog`**, and its own TTL
  (`CUSTOM_CATALOG_MAX_AGE_MS`, 5 minutes) is far shorter than the upstream
  table's 24h — an operator pushing to their own branch should see the new
  app soon, not up to a day later, and at a 5-minute TTL a persisted copy
  would gain nothing while also needing a `script_catalog.repo`
  `CHECK`-constraint table rebuild to add a third value (research R4). A
  failed custom-repository fetch (network error, private/missing repo,
  half-configured settings) never fails the whole catalog — it just omits
  the custom group for that call, logs a warning, and starts the same
  short failure cooldown `getUpstreamCatalog` already uses, so the
  suggestion list still shows `stable`/`dev` while a fork stays
  unreachable.
  Resolving a bare `--app` slug for either command goes through
  `resolveAppSource(app, inventory, fetchImpl)`
  (`src/lib/app-source.ts`, issue #11): with no custom settings configured
  it's a same-as-always upstream resolution with no extra network call; with
  both set, it first calls `resolveHeadSha` to pin the configured branch to
  its current head commit (a bare-SHA GitHub API request,
  `Accept: application/vnd.github.sha`, chosen over the branches endpoint
  because it needs no JSON parsing and handles a branch name containing
  `/`), then (issue #15) makes one more rate-limited request,
  `compareBranch`: `GET /repos/community-scripts/ProxmoxVED/compare/
  main...<owner>:<repo>:<sha>`. The head is addressed by the *pinned
  commit*, not the branch name, because a branch-name head whose repo
  doesn't exist was observed live being answered from a different fork in
  the same network (`status: identical`, no error); a commit outside
  ProxmoxVED's fork network 404s instead. `changedSlugsFromFiles` turns
  its `files[]` into the changed set -- `ct/<slug>.sh` or
  `install/<slug>-install.sh` with any status but `removed` (a rename
  counts only its new name -- the old one no longer exists in the fork,
  the same reason a deletion never counts). Resolution then follows `specs/004-changed-apps-only/
  research.md` R6: a changed slug -> `kind: 'custom'` at the pinned commit
  (`changed: true`); otherwise the two upstream `ct/` scripts are probed
  (raw, `probeUpstream`'s present/absent/error tri-state) and a hit *or an
  error* -> `kind: 'upstream'`, byte-identical to the feature being off
  ("can't tell" prefers upstream over a possibly stale inherited fork
  copy); otherwise the fork's `ct/<slug>.sh` at the pinned commit -> 200 is
  a fork-only `kind: 'custom'` (`changed: false`), 404 falls through to
  upstream. For a changed slug only, and only when the branch is behind
  (`behindBy > 0`), `detectConflict` reads the app's two scripts from
  upstream ProxmoxVED's raw content at the merge base and at `main`; any
  difference (a 404 on one side counts) sets `conflict: true`. It is
  deliberately *not* a reverse compare: the compare file list stops at 300
  files and upstream routinely moves further than that between rebases,
  while raw reads cost no API quota; a failed read is logged and counts as
  no conflict. A compare file list of 300 or more files is itself a named
  error, since a truncated changed set would silently send changed apps
  upstream. Every failure that
  *does* throw (unknown/private repo, unknown branch, not a ProxmoxVED
  fork, a GitHub error status or rate limit, an unreachable network) names
  the configured `customScriptsRepo`/`customScriptsBranch` and points at
  `set-config` and the Settings page, and — per FR-008 — never silently
  falls back to upstream.
  The upstream base is fixed to `community-scripts/ProxmoxVED@main`, a
  single-deployment-shape assumption #11 already made (a VED-shaped fork). `buildInstallAppScript`/`buildUpdateAppScript`
  branch on `source.kind === 'custom'`: the generated script curls
  `source.ctUrl` directly (no upstream fallback -- resolution already
  confirmed the script exists at that commit) and, critically, exports
  `COMMUNITY_SCRIPTS_URL=<source.scriptsBaseUrl>` (the pinned commit's raw
  root, never the branch name) before that curl runs. This one export is
  the whole mechanism (research R1): both upstream repos' `ct/` scripts
  now run on a shared engine, `community-scripts/core`'s `core/build.func`,
  which resolves every non-engine path (`ct/…`, `install/…`) against
  `COMMUNITY_SCRIPTS_URL` when it's set, and which also exports that same
  variable into the container so its own baked-in `/usr/bin/update`
  helper stays pinned to the commit an app was last installed/updated from
  -- without the export, a fork-installed app's own
  `install/<slug>-install.sh` would still be pulled from upstream
  ProxmoxVED, or 404 if upstream never had that app. `install-app`'s
  in-container `/usr/bin/update` helper also asks community-scripts.org
  whether an app can be updated, which has no knowledge of a fork-only
  app; both limitations are inherent to reusing community-scripts' own
  engine rather than bugs in this toolkit, and are recorded as known
  limitations in README rather than worked around.
  `formatSourceNotice(source)` builds the one notice line both
  `runInstallApp`/`runUpdateApp` emit before doing anything else -- a
  `warn` (`logWarn`) telling the operator to rebase when the source
  conflicts, an `info` (`logInfo`) when a changed app merely replaces an
  upstream copy, nothing for a fork-only app or an upstream resolution --
  (before `resolveMid`/`checkVmidAvailable` for install, before the
  update's own `runRemote` call), so it's the first line of a dry run, a
  captured preview, and the job log alike.
  Because the web/MCP apply path used to resolve up to three times for one
  operation (preview, the prompt pre-scan, and apply itself, which runs
  inside a job that can start much later), `previewAndEnqueue`
  (`src/operations/core.ts`) now resolves a custom source **once per
  operation**, before preview, for any `Operation` flagged
  `resolvesApp: true` (`install-app`, `update-app` -- `src/operations/
  provisioning.ts`/`maintenance.ts`) -- storing the result on the parsed
  input's own internal `appSource` field, which is never part of the
  operation's zod `shape` (so it's never accepted from a request body) and
  never serialized into the job's persisted `argsJson` (`enqueue()`
  stringifies the original `raw` input, not the mutated one). `op.preview`,
  the `watchForPrompts` prompt pre-scan (`promptsForSource` for a `'custom'`
  resolution, `checkAppUrl` otherwise -- unchanged for every non-`resolvesApp`
  operation and for a pasted URL, which has no `scriptsBaseUrl` to scan),
  and the job's own `apply()` (which receives `input.appSource` as
  `InstallAppOptions.source`/`UpdateAppOptions.source`) therefore all read
  the exact same pinned commit (SC-004): one commit is pinned per apply
  operation, at the moment `previewAndEnqueue` runs, and the preview text
  logged at the top of that job's log, the prompt pre-scan, and the apply
  itself all read that one commit -- a branch push after that point can
  never make what actually ran diverge from what the job log's own preview
  shows. This is narrower than "preview and apply always match": the web
  UI's standalone Preview button (`POST /api/provisioning/:id/preview`,
  which calls `op.preview` directly, not through `previewAndEnqueue`) and
  the App check (`GET .../check-app`) each pin their own commit
  independently, at whatever moment they're called -- a branch push between
  a standalone Preview/check and a later Apply click is exactly the case
  this can't cover, and the job log's own preview line is what shows the
  commit that apply actually pinned and used. The CLI has no shared pin at
  all: it runs a dry run and a separate `--apply` invocation, each resolving
  independently, matching how it already treats every other live lookup
  (authorized_keys, NFS storage paths) rather than introducing a CLI-only
  caching layer for this one case.
- **Live TLS-backend probing** (`src/lib/tls-probe.ts`, issue #100) augments
  the previously fully-manual `insecureBackendTls` checkbox with a live
  probe of the guest's actual running app on two web-UI paths -- the
  checkbox stays authoritative for hosts, CLI usage, `proxyManual`
  entries, and any probe attempt that ends inconclusive; only a conclusive
  probe overrides it. `probeInsecureBackendTls`
  runs `curl -s -o /dev/null --max-time 5 https://<ip>:<port>/` via
  `runRemote` against the guest's *parent host* (never the guest itself, so
  it never depends on `curl` being installed inside the container), and
  interprets curl's exit code (`interpretCurlExitCode`) into
  `'insecure' | 'trusted' | 'inconclusive'` -- `60`/`51` (untrusted/
  unverified cert) -> `'insecure'`; `0`/`35` (trusted, or no TLS at all on
  that port) -> `'trusted'`; anything else (connection-refused, timeout,
  DNS failure, or a thrown SSH/exec error) -> `'inconclusive'`, which is
  never itself a final answer -- except a thrown error stops the retry
  loop immediately rather than retrying, since a throw means the SSH
  round-trip itself failed (host unreachable, or the job was cancelled),
  not a curl-level signal that retrying could resolve. It never throws, so
  both call sites below treat its result as purely informational.
  `recordProvisionedGuest` (`src/web/routes/provisioning.ts`, the
  create-lxc/create-vm/install-app web-apply codepath) probes the
  newly-created guest with a ~3-minute retry budget (6 retries, 30s apart,
  logging one line per attempt into the job log) whenever the entry has a
  concrete `ip`+`port`+non-empty `subdomains` combo -- in practice this
  only ever fires for `install-app`, since neither `create-lxc` nor
  `create-vm`'s web form collects a `port` at creation time; a guest
  created via either of those still gets probed the first time its
  `port`+`subdomains` are set together through the Dashboard PATCH path
  below. The Dashboard's guest PATCH handler (`src/web/routes/dashboard.ts`)
  probes the same way but single-shot (no retries -- an existing guest
  being edited is presumed already running), only when the edit actually
  changed `subdomains`/`port` and the resulting entry isn't `proxyManual`
  (whose proxy config, and thus `insecureBackendTls`, is never generated).
  On both paths, a conclusive probe result always overwrites whatever
  `insecureBackendTls` value the same request also submitted. CLI usage
  keeps today's fully-manual behavior unchanged -- neither the CLI's
  create-lxc/create-vm/install-app commands nor any other CLI command has
  a way to set `port`+`subdomains` on a guest at all, so there's no
  per-guest hook point to probe from.
- **Web UI responsiveness/theming** (`web-client/src/`): a single
  `640px` breakpoint (`index.css`) separates desktop layout from mobile
  layout — there is no intermediate tablet breakpoint. Below it, `Sidebar`
  becomes an off-canvas drawer (fixed, translated off-screen, toggled by a
  hamburger button, closes on backdrop tap or nav-link click) instead of
  the static 200px column used above it. Every `.data-table` (Dashboard's
  Hosts/Bridges/Storage/Guests tables, JobHistory's Jobs table) switches to
  a card layout below the breakpoint — `table`/`tbody`/`tr`/`td` become
  `display: block`, and each `<td>` carries a `data-label="…"` attribute
  matching its column header, shown via CSS `::before` since `<thead>` is
  hidden in this layout — rather than horizontal-scrolling the table as-is;
  any new table added to the web UI should follow this same `data-label`
  convention, not a scroll container. A long card value wraps
  (`overflow-wrap: anywhere`, right-aligned) rather than truncating, and a
  flex row holding a user-supplied name needs `min-width: 0` plus
  `overflow-wrap: anywhere` on the item that shrinks (see
  `.job-header-main`, issue #5). Theme is controlled by
  `ThemeContext`/`ThemeToggle` (`web-client/src/lib/theme.tsx`), not the
  raw `prefers-color-scheme` media query directly: the user's choice
  (`'light' | 'dark' | 'system'`, persisted in `localStorage`, defaulting
  to `'system'`) is resolved to an actual light/dark value in JS and
  written to `document.documentElement.dataset.theme`; `index.css` keys its
  dark-mode variable overrides off `:root[data-theme='dark']` rather than
  `@media (prefers-color-scheme: dark)`, so any new themed CSS should target
  that selector too. The guest Advanced modal's field explanations
  (issue #34) live in `web-client/src/lib/advanced-field-help.ts`, keyed by
  label and pinned by a test against the modal source, and are shown via
  `FieldHelp` (`web-client/src/components/FieldHelp.tsx`), a reusable ⓘ
  disclosure used instead of a hover-only `title` since `title` never shows
  on touch.
- **Web UI inventory reload** (`refreshInventory` in `src/lib/inventory.ts`,
  wired into `src/web/app.ts`'s `buildApp`): the web service loads
  `inventory` once at startup (`src/web/server.ts`), but every `/api`
  request now reloads it from disk first via a global middleware —
  `refreshInventory(deps.inventory, deps.inventoryPath)` calls
  `loadInventory` and `Object.assign`s every field onto the *existing*
  object rather than replacing the reference, so every route module's
  closure over that shared object sees fresh data with no per-route
  changes needed. This is what makes a direct DB edit, a CLI command run
  while the service is up, or a hand-edit visible in the web UI
  immediately rather than only after a service restart (issue #98). A
  failed reload (e.g. a transient lock) is logged via `logWarn` and
  swallowed -- the request proceeds with the last known-good in-memory
  copy rather than failing outright. One consequence worth knowing: since
  `inventory` is a shared, mutable object read across `await` points in
  some handlers (e.g. `src/web/proxy-sync.ts`'s `syncProxyLive`, which
  reads `deps.inventory` multiple times across an SSH+Authentik REST
  round trip), a concurrent request's reload can theoretically change it
  mid-handler -- low-probability at this toolkit's single-operator scale,
  but a future contributor relying on `inventory` staying constant across
  an `await` in a request handler should snapshot it locally first.
- **Shared operations layer** (`src/operations/`, issue #16): every
  preview/apply action the web UI or MCP server can run is one `Operation`
  (`src/operations/types.ts`) -- a zod input `shape`, `target`/`targetType`,
  `preview()`, and `apply()` -- registered in `src/operations/index.ts`.
  The web routes (`provisioning.ts`, `maintenance.ts`, and the Dashboard's
  guest PATCH via `src/operations/edit-guest.ts`) are thin adapters that
  keep only HTTP, permission, and attribution concerns. Field builders in
  `src/operations/fields.ts` accept both the web form's string encoding
  (`'4'`, `'true'`, `''`) and typed JSON, so one shape serves both front
  ends. `previewAndEnqueue` (`src/operations/core.ts`) is the single
  implementation of "preview outside the job, then enqueue with the preview
  logged at the top" -- the ordering that avoids the `withCapturedConsole`
  deadlock. A new web form field must also be added to its operation's
  `shape`, or schema parsing strips it (`test/operations/provisioning.test.ts`
  checks this for every `PROVISIONING_COMMANDS` field). An `Operation` may
  also set `resolvesApp: true` (`install-app`/`update-app`, issue #11):
  `previewAndEnqueue` resolves a custom-script-repository source exactly
  once for such an operation, before `preview()` runs, and stashes it on
  the parsed input's internal `appSource` field so `preview()`, the
  prompt pre-scan, and the job's `apply()` all read the one pinned commit
  instead of each independently re-resolving -- see the `install-app`/
  `update-app` bullet above for the full mechanism. The CLI does not use
  this layer.
- **MCP server** (`src/mcp/server.ts`, `src/mcp/build-server.ts`, issue
  #16): a stdio MCP server (`npm run mcp`) exposing one tool per
  `MCP_OPERATIONS` entry (every operation except `migrate-nfs-mount`), each
  a dry-run preview unless called with `apply: true`, which enqueues a job
  and returns its id; plus `edit_guest`, read-only tools (`get_inventory`,
  `get_guest_status`, `audit_nfs_mounts`, `list_install_apps`,
  `check_install_app`), and job tools (`list_jobs`, `get_job` with
  offset-paged logs and any pending prompt, `wait_for_job`,
  `answer_job_prompt`, `dismiss_job_prompt`, `cancel_job`). `wait_for_job`
  (`src/mcp/wait-for-job.ts`, issue #58) is the MCP counterpart to the web
  UI's prompt relay: it blocks on a job this process owns until it finishes,
  pauses, or `maxWaitSeconds` (default 300) passes, and when the job pauses
  at `awaiting_input` it asks the human directly through MCP form
  elicitation (answer / not a real prompt — resume / cancel the job), then
  keeps waiting in the same call. A client that doesn't declare elicitation
  support, a declined form, an elicitation error, or a dialog left unanswered
  for 10 minutes all return
  `prompt_pending` so the model falls back to `answer_job_prompt` and
  friends; a declined prompt stays handed off (no later `wait_for_job` call
  re-asks it) until the job pauses on a new one, and if the human picks
  "cancel the job" in the dialog, the tracker marks that prompt as
  cancelling so no concurrent or repeat `wait_for_job` call re-asks it
  while the cancellation settles (`PromptTracker`,
  `src/mcp/elicitation.ts`, which also keeps concurrent waiters from
  opening duplicate dialogs). `maxWaitSeconds` is not enforced while a
  dialog is open; the elicitation request's own 10-minute timeout bounds it
  instead (issue #174). That is longer than the SDK's 60s default, which
  would drop real dialogs, and well under JobRunner's 15-minute abandon
  timer, so a client that never shows the dialog (a remote Claude Code
  session did exactly that) hands the prompt back to the model with time
  left to ask in chat, instead of silently stalling until the job is
  cancelled. On timeout the SDK withdraws the dialog, and the prompt stays
  handed off the same as a decline. The dialog's message leads with the
  prompt text and the answer field's title repeats it, because Claude
  Code's terminal folds all but the first few message lines.
  `buildMcpServer` sends one throwaway
  `ping()` in `server.server.oninitialized` to work around a bug in the
  *client's* `Protocol#_oncancel` (confirmed against @modelcontextprotocol/sdk
  1.30.0, 2026-09), which silently drops a cancellation whose request id is
  0; this can only be removed once the MCP clients this server is actually
  used with (Claude Code and others, each bundling their own SDK) ship a
  fixed `_oncancel` -- upgrading this repo's own SDK dependency only fixes
  the in-repo test client. Cancelling a
  `wait_for_job` call never cancels the job. It runs as the local operator with
  CLI-level trust -- no authentication, no permission filtering -- and uses
  its own checkout's `inventoryPath()`/`dataDir()`, so whichever checkout
  runs it is the one it manages; nothing in this repo says where it should
  run. It shares `data/jobs.sqlite3` with the web service: `JobRunner` stamps
  an `owner` on every job (`'web'`, or `'mcp:<pid>'`), and orphan cleanup
  (`JobStore.interruptOrphaned`) only touches the caller's own rows plus
  rows of MCP processes whose pid is dead, so neither process's startup
  interrupts the other's in-flight jobs. A job owned by the *other* process
  is nonetheless fully watchable and controllable from here (issue #6):
  `/ws/jobs/:id` (`src/web/routes/jobs.ts`) recognizes a job
  whose row `owner` differs from this process's own `JobRunner.owner` and,
  since that runner's events never fire for it, runs a per-connection
  foreign-job tailer (`src/web/jobs/job-tail.ts`) instead -- a `setInterval`
  that polls the shared job row and log file once a second and emits the
  same `chunk`/`status`/`prompt`/`prompt-cleared` messages a local job
  would, so a client sees no protocol difference. It also stops (and the
  socket closes) once it sees the owning MCP process has died -- checked
  via the row's `mcp:<pid>` owner, same liveness check as orphan cleanup --
  rather than polling a stuck row forever; the job row itself is only ever
  closed out by orphan cleanup at the next web-service start. Control
  (cancel/answer/dismiss) of a foreign job goes through the shared
  `requestJobControl` (`src/web/jobs/job-control.ts`), used by both the
  three web routes and the three matching MCP tools: a local job is still
  applied directly; a foreign job is refused up front the same way a local
  one would be (a terminal job's cancel, a not-`awaiting_input` job's
  answer/dismiss) plus one foreign-only case (an `mcp:<pid>` owner whose
  process has died), and otherwise is recorded as a row in the new
  `job_control_requests` table and returned immediately -- 202 on the web,
  `{ requested: true }` from MCP -- without waiting on the owner. The
  owning `JobRunner` runs its own poll timer (`processControlRequests()`,
  500ms, running only while it has active jobs) that applies each pending
  row through its ordinary `cancel`/`answerPrompt`/`dismissPrompt`, appends
  an attribution line to the job log (`Stop requested from web UI by
  <user>`, `Answer sent from MCP (mcp:<pid>)`, etc. -- never the answer text
  itself) and marks the row handled, or marks it `not-applicable` if the
  job isn't one this runner still has a controller for. Because a request
  can outlive its target (the MCP process that queued it exits, or the job
  finishes before the owner ever polls again), `JobStore
  .closeStaleControlRequests()` -- run at the top of every poll pass and
  from `reconcileOrphanedJobs()` -- closes any pending request whose job is
  terminal or whose `mcp:<pid>` owner is dead, from any process, so a
  request aimed at a since-exited MCP server or a since-restarted web
  service never sits with its answer text lingering. `wait_for_job` is the
  one exception, unchanged and still owner-only (`requireOwned` in
  `src/mcp/job-helpers.ts`, now its only remaining caller) -- it blocks on
  the job's in-memory controller/events, which only the owning process
  ever holds. stdout is the
  protocol channel, so `src/mcp/server.ts` redirects `console.log` to
  stderr at startup. On stdin close it cancels its jobs and exits; a job
  still running when the client session ends is therefore interrupted.
  **Native OIDC gating** (issue #1) adds three surfaces here:
  `adopt-oidc-client` is registered like every other `MCP_OPERATIONS` entry
  (`adopt_oidc_client`, preview/apply, `fleetWide: true`); `edit_guest`'s
  existing input shape (`EDIT_GUEST_SHAPE`) already covered
  `authMode`/`oidcRedirectUris`, so no new tool was needed for those, but it
  now also accepts `confirmOidcClientDeletion: true` -- required for the
  same edit the Dashboard's confirmation dialog gates (FR-022a), and its
  description tells the model to ask the user first, since this server has
  no dialog of its own to show one in; unlike the Dashboard,
  `authMode`/`oidcRedirectUris` changes need no admin check here at all,
  because this server always runs with CLI-level trust (FR-018 is a
  web-UI-only restriction). `EDIT_GUEST_SHAPE` also gained
  `oidcMobileRedirectUris` (issue #22, same shape and admin-free trust
  level as `oidcRedirectUris`) once the mobile-redirect-list field existed
  to edit -- again no new tool, since `edit_guest` already covers every
  writable guest field. A standalone `get_oidc_client` tool
  (`src/mcp/build-server.ts`) wraps `oidc-credentials`'s lookup logic
  (`runOidcClientInfo`, `commands/networking/oidc-credentials.ts`) to
  return an OIDC-gated entry's issuer and client ID -- and only those two,
  never the secret (FR-019b) -- with a `secretAvailableFrom` field pointing
  at the Dashboard or the `oidc-credentials` CLI command instead.
  **VPN gateway runtime tools** (issue #7) add five more:
  `get_vpn_gateway_status`, `list_vpn_gateway_servers`,
  `list_vpn_gateway_cities`, `list_vpn_gateway_groups`, and
  `connect_vpn_gateway`. `src/operations/vpn-gateway.ts` is the one
  implementation behind both these tools and `/api/networking/gateways/*`
  (`src/web/routes/networking.ts`, now a thin adapter that keeps
  `requireResourceAccess` and maps a `GatewayResult`'s `not-found` to 404
  and `upstream` to 502) -- a shared non-`Operation` action, like
  `runEditGuest`, since four of the five are plain reads and
  `connect_vpn_gateway` is deliberately immediate rather than a
  preview/apply pair, matching the Dashboard's own Connect button, which
  has no preview either. Each call returns a `GatewayResult`; a tool
  returns the gateway's own JSON body on success, and on failure throws
  (surfaced by the SDK as an `isError` result) carrying the exact same
  message text the web route's error body shows, so a tool failure and a
  Dashboard failure read identically. Timeouts are unchanged from the web
  route: 5s for `get_vpn_gateway_status`, 15s for the three list tools,
  and none for `connect_vpn_gateway` (a VPN reconnect can legitimately
  take a while, and aborting it partway could tear down a switch that was
  actually succeeding).
- **Web UI authentication** (`src/web/auth.ts`): the entire web UI is
  gated behind a global `requireAuth` Express middleware, mounted in
  `src/web/app.ts` ahead of every route mount, that trusts the
  `X-authentik-*` identity headers the reverse proxy fronting it (the
  `proxy: true` entry's proxy -- Caddy's `forward_auth` or nginx's
  `auth_request`) adds once a request has been checked against a
  self-hosted Authentik instance —
  there is no OIDC client, login page, or session store anywhere in this
  repo; Authentik and the proxy own the actual authentication session, and
  this app only ever reads already-verified headers off the request
  (`resolveAuthUser`, also exported standalone for the WebSocket path
  below) -- the one exception is `req.user.groups` specifically, which an
  active admin-user-impersonation override (see "Web UI admin user
  impersonation" below) can overlay after `requireAuth` runs; `req.user`'s
  other fields and `req.realUser` (when set) always reflect the real,
  header-verified identity untouched.
  Whether authentication is required at all is now controlled by
  `WEB_UI_AUTH_MODE` (issue #123): `auto` (the default) falls back to a
  synthetic always-admin local operator when no trusted headers are
  present, `authentik` requires them and 401s otherwise, and `none`
  ignores headers entirely. **The production Windows service must set
  `WEB_UI_AUTH_MODE=authentik`** in its own `data/authentik.env`
  -- under the default `auto`, a proxy config that lost its forward-auth
  directive would silently serve every request as a full-admin local
  operator rather than failing closed. `WEB_UI_DEV_USER` remains the
  dev/test affordance for simulating a *specific non-admin group
  membership*, which the local operator cannot do -- and, unlike a missing
  `forward_auth` header, it takes effect regardless of `WEB_UI_AUTH_MODE`
  (even `authentik`), so it must stay unset in the production service's
  environment the same as before (`scripts/windows-service.ts`'s
  `buildService()` never sets it). The group names `isAdminUser` checks are
  themselves now `AUTHENTIK_ADMIN_GROUP`/`AUTHENTIK_BUILTIN_ADMIN_GROUP`-
  configurable via `authentikConfig()` (`src/lib/authentik-config.ts`,
  defaulting to today's `bellhop-admins`/`authentik Admins`), with
  `isAdminUser` (`src/web/auth.ts`) as the single admin predicate used
  everywhere a group-membership check happens. The
  `/ws/jobs/:id` WebSocket upgrade handler (`src/web/routes/jobs.ts`)
  needs its own separate `resolveAuthUser` call at the top of its
  `'upgrade'` listener, since it's wired directly onto the raw
  `http.Server` and runs before/independent of Express's middleware chain
  — `requireAuth` never sees these requests, so without this the job-log
  WebSocket would stay fully unauthenticated even after every other route
  was locked down. None of this is meaningfully safe on its own: it all
  depends on the Windows firewall rule `scripts/windows-service.ts`'s
  `addFirewallRule` installs being scoped to `remoteip=<proxy-host's IP>`
  (`resolveProxyIp`, renamed from `resolveCaddyIp` in issue #10 — it
  derives the address from `findProxyEntry`/`proxy: true` rather than a
  hardcoded literal, so the rule follows automatically if the proxy ever
  moves; its errors name `'proxy: true'`) rather than "any" LAN host —
  that scope is what prevents something other
  than the proxy from reaching the app directly and spoofing the
  `X-authentik-*` headers it trusts unconditionally. Forward-auth at the
  proxy was a deliberate choice over an app-embedded OIDC client: Authentik
  and the proxy own the session, and this app holds no session state of
  its own. Which proxy fronts the web UI is whatever runs on the
  `proxy: true` entry -- Caddy or nginx, per `proxyDriver` -- and the
  firewall scope follows that entry, not the driver choice.
- **Web UI user/group management** (`src/web/routes/users.ts`,
  `src/web/routes/groups.ts`): full CRUD on Authentik users/groups from
  inside the web UI, gated by a `requireAdminGroup` middleware
  (`src/web/auth.ts`) that checks `req.user.groups` via `isAdminUser`
  against `AUTHENTIK_ADMIN_GROUP` (default `'bellhop-admins'`) —
  a dedicated group scoped to this app, distinct from Authentik's own
  built-in "authentik Admins" group. `isAdminUser` also treats membership
  in that built-in group itself as sufficient (`AUTHENTIK_BUILTIN_ADMIN_GROUP`,
  default `'authentik Admins'`, OR'd into the same check) so there's always
  at least one path into the Users page without a manual, out-of-band
  Authentik group edit. `AUTHENTIK_APP_USERS_GROUP` no longer exists
  (issue #158) -- `sync-authentik`'s single app-users group became an
  ordered ladder, `AUTHENTIK_GROUP_LADDER` (see that bullet above for its
  default and how it's used), which is unrelated to `AUTHENTIK_ADMIN_GROUP`/
  `AUTHENTIK_BUILTIN_ADMIN_GROUP`: those two gate *this app's own* admin
  pages, while the ladder's top rung is the effective admin-only tier for a
  *gated inventory entry*. As of issue #123 both are `authentikConfig()`
  (`src/lib/authentik-config.ts`) values, not hardcoded constants, and have
  exactly one definition each — `Sidebar.tsx`/`GroupsSection.tsx` no longer
  duplicate them at all (issue #86's original duplication, and a second
  copy `GroupsSection.tsx` had grown since): the web client fetches
  `GET /api/whoami` (`src/web/routes/dashboard.ts`) once per page load
  through the shared `WhoAmIProvider`/`useWhoAmI()` (`web-client/src/lib/
  whoami.tsx`, fetch/staleness/generation logic in `whoami-store.ts` --
  issue #13's polish pass), and `Sidebar`/`UsersPage` read `isAdmin`/
  `adminGroups`/`capabilities` from that hook rather than fetching it
  themselves; `GroupsSection` stays a plain prop consumer, getting
  `adminGroups` passed down from `UsersPage`. Also gated behind the directory-capability check
  (`requireUserDirectory`, `src/web/auth.ts`) on top of `requireAdminGroup` —
  see "Running without Authentik" in `README.md` for what happens when no
  `AUTHENTIK_API_URL`/`AUTHENTIK_API_TOKEN` are configured. `AuthentikClient`
  (`src/lib/authentik-client.ts`) wraps
  Authentik's REST API v3, modeled on the `SSHClient` injection pattern:
  `RealAuthentikClient` is used when `AUTHENTIK_API_URL`/
  `AUTHENTIK_API_TOKEN` are both set; otherwise `UnconfiguredAuthentikClient`
  is injected instead, so every route call fails the same clear
  "not configured" way rather than needing a null check at each call site.
  `RealAuthentikClient` has no live-instance test (same precedent as
  `Ssh2SSHClient`, verify manually against real infrastructure), but since
  the request bodies it builds and the responses it maps are pure functions
  of global `fetch`, `test/lib/authentik-client.test.ts` pins a growing set
  of them with a stubbed `fetch` (`withStubbedFetch`) -- unlike every other
  `AuthentikClient` method, `listOAuth2Providers()` is genuinely stubbed-fetch-
  tested precisely *because* Authentik's raw response needs filtering: a
  proxy provider is a subclass of OAuth2Provider in Authentik's own model, so
  `GET /api/v3/providers/oauth2/` returns every proxy provider too (2026.8,
  verified live), with `meta_model_name`/`component` reporting the OAuth2
  values for all of them -- the response alone can't tell them apart, only
  membership in `GET /api/v3/providers/proxy/` can. `listOAuth2Providers`
  fetches that list too and drops any pk present in it, so every caller that
  trusts "in the OAuth2 list" to mean "really an OAuth2 provider"
  (`ownedProviderKind`, `planProviderName`, `adopt-oidc-client.ts`,
  `oidc-credentials.ts`) never has to re-check.
  Those two vars are read via plain `process.env`, same as everything
  else, but `src/web/server.ts` populates them at startup the same way it
  populates the VPN gateway credentials (see "VPN gateway deploy
  credentials" below): a gitignored `data/authentik.env`, loaded via
  `dotenv` before `buildAuthentikClient()` runs. This exists because
  nothing else sets these two vars for the actual deployment — the
  Windows service (`scripts/windows-service.ts`'s `buildService()`) only
  sets `PORT`/`USERPROFILE` in its env, so without this file there was no
  working way to hand the production service an Authentik token at all.
  Creating a user never collects a password in this UI — `POST /api/users`
  immediately calls Authentik's recovery-link endpoint and returns it for
  the admin to copy and share, so this app never sees or sets a user's
  password directly (the same recovery-link generation is exposed
  standalone for an existing user who's locked out). `DELETE /api/users/:id`
  and `POST /api/users/:id/deactivate` both reject with 400 if the target
  is the requesting admin's own account — a self-lockout guard, since this
  is deliberately the one place authorization state (who can reach this
  page at all) is edited through the page itself. Local dev
  (`npm run web:dev`) sets `WEB_UI_DEV_GROUPS=bellhop-admins`
  alongside `WEB_UI_DEV_USER` (both read by `resolveAuthUser`'s dev
  fallback) so the admin-gated `/users` page is reachable without a real
  Authentik session. `package.json`'s `web:dev` script hardcodes that
  group name to today's *default* `AUTHENTIK_ADMIN_GROUP` value, not to
  whatever your own `data/authentik.env` actually configures -- and since
  issue #123 made that name configurable, the two can diverge: if
  `data/authentik.env` sets `AUTHENTIK_ADMIN_GROUP` to anything else
  (`authentik Admins`, say), `isAdminUser` checks against that, not
  `bellhop-admins`, and a local `web:dev` session is
  therefore **not** admin despite `WEB_UI_DEV_GROUPS` naming an
  "admins"-looking group. This predates issue #158, but that branch gave it
  a visible symptom worth knowing: in local dev, the auth-group dropdown's
  `canLower` (see `sync-authentik` above) comes back `false`, and widening
  an app's tier or clearing its gate is refused the same way it would be
  for a real non-admin. Fixing the script is out of scope for a docs pass --
  if it matters for a given task, either edit `data/authentik.env` locally
  or override `WEB_UI_DEV_GROUPS` to match it. This is deliberately scoped
  to administration only — deciding what a signed-in user/group is
  authorized to see or do elsewhere in this app is a separate, later piece
  of work (issue #13).
- **Web UI per-resource group permissions** (`src/lib/permissions.ts`,
  `src/web/access.ts`, `src/web/routes/permissions.ts` -- issue #13): once a
  second real user exists (the bullet above), an admin can restrict what a
  non-admin Authentik group can see and act on. Two new tables in
  `inventory/bellhop.db` (`permission_groups`/`permission_rules`),
  independent of and never touched by `saveInventory`'s wholesale
  delete-and-reinsert, record each group's mode (`allow-list` or
  `block-list`) and its host/guest resource list. A group with no row in
  `permission_groups` is unrestricted -- today's behavior, unchanged, for
  every group until an admin explicitly configures one via the admin-only
  Permissions page. `src/web/access.ts`'s `isResourceAllowed`/
  `filterInventoryForUser` layer an admin bypass (`isAdminUser` -- the
  same `AUTHENTIK_ADMIN_GROUP`/`AUTHENTIK_BUILTIN_ADMIN_GROUP`-configurable
  check `requireAdminGroup` uses) on top of `src/lib/permissions.ts`'s pure `isAllowed` (multi-group access
  is an intersection -- the most restrictive group a caller belongs to
  always wins, never widened by a more permissive one). Enforcement is
  read-filtering on `GET /api/inventory`/`GET /api/guests/status` plus a
  `requireResourceAccess` middleware/inline check on every route that
  mutates a specific host or guest (Dashboard's guest PATCH,
  `guest-power`/`set-guest-vpn`, `update-app`, the VPN gateway proxy routes,
  and every provisioning command's `preview`/`apply`). `GET /api/jobs(/:id)`
  and its cancel/answer/dismiss-prompt actions filter separately: since a
  job's `target` (`src/web/jobs/job-store.ts`) is just a name with no
  recorded resource type, `jobs.ts`'s own `isJobVisible` matches a caller's
  group rules by name alone rather than reusing `isResourceAllowed` (which
  requires a type) -- an earlier draft tried checking the name as both a
  host and a guest and OR-ing the results, but that let a block-list rule
  tagged with the "wrong" type silently leak the job, since a missing row
  under the untagged type defaults to allowed. Fleet-wide actions with no
  single target (`update-all`, `audit-nfs-mounts`, `sync-ssh-keys`,
  `push-ssh-key`, `sync-inventory`, `sync-proxy`) stay admin-only via the
  existing `requireAdminGroup` rather than being filtered. External sites
  are out of scope -- they aren't exposed via `GET /api/inventory` or shown
  on the Dashboard at all today. Host and guest rules are independent --
  blocking a host hides only that host's own inventory entry, never the
  guests running on it, which are controlled entirely by their own
  separate rules.
- **Web UI admin user impersonation** (`src/web/impersonation.ts`,
  `src/web/routes/impersonation.ts` -- issue #101): once per-resource
  permissions exist (the bullet above), an admin can view/act on the app as
  if they belonged only to one chosen non-admin group, to verify a group's
  allow-list/block-list rule actually behaves as intended without a second
  real Authentik login. State lives entirely in process memory --
  `ImpersonationStore`, a `Map<realUsername, groupName>` keyed by the
  trusted `X-authentik-username` header (no cookie, no signing secret,
  nothing persisted to disk; a server restart clears every active
  impersonation). `applyImpersonation`, mounted in `app.ts` immediately
  after `requireAuth`, overlays `req.user.groups` with just the
  impersonated group and stashes the untouched real identity on
  `req.realUser` -- every existing permission check in this app
  (`isResourceAllowed`, `requireResourceAccess`, `isJobVisible`,
  `requireAdminGroup`) reads only `req.user.groups`, so this one overlay
  point is what makes the rest of the app behave as the impersonated group,
  with no changes needed to `access.ts`/`permissions.ts` themselves.
  `POST`/`DELETE /api/impersonate` (the only two routes that ever
  read/write the store) are gated by a *separate* `requireRealAdminGroup`
  middleware that checks `(req.realUser ?? req.user).groups` rather than
  the overlaid `req.user.groups` `requireAdminGroup` reads everywhere
  else -- this is the one property the whole feature depends on: without
  it, the moment an admin impersonates a non-admin group, `requireAdminGroup`
  would 403 the very endpoint needed to turn impersonation back off,
  locking them into that view until a server restart. The two configured
  admin groups (`AUTHENTIK_ADMIN_GROUP`/`AUTHENTIK_BUILTIN_ADMIN_GROUP`,
  defaulting to `bellhop-admins`/`authentik Admins`) are excluded
  from the picker and rejected server-side, since impersonating an admin
  group is a no-op. The `/ws/jobs/:id` WebSocket upgrade handler
  (`src/web/routes/jobs.ts`) bypasses Express middleware the same way it
  bypasses `requireAuth` (see "Web UI authentication" above), so it
  duplicates `applyImpersonation`'s overlay logic inline rather than
  reusing it -- kept in sync by hand, not shared, since there's no third
  bypass point yet to justify extracting a common helper. Every job
  gained `triggered_by_username`/`triggered_by_impersonating` columns on
  `job-store.ts`'s `jobs` table (nullable, populated on every
  `jobRunner.enqueue()` call site across `provisioning.ts`/
  `maintenance.ts`, not just impersonated ones -- this app had no actor
  tracking at all before this feature), shown as a "Triggered by" column
  in the Job History table, so the real admin identity stays visible and
  auditable even while their *view* of the app is impersonated.
  Starting/stopping impersonation from the Sidebar (issue #13's polish
  pass) `await`s the shared `WhoAmIProvider`'s `refresh()` rather than
  `window.location.reload()`, which bumps the store's `generation` and
  remounts the routed page (see the "Web UI user/group management" bullet
  above) so it refetches under the new identity without a full browser
  reload; a failed lookup surfaces inline in the Sidebar with a Retry
  control that reloads the page instead of calling `refresh()`, since a
  plain re-fetch can never recover an expired Authentik forward-auth
  session (Caddy's login redirect only works on a top-level navigation) and
  the banner only shows once the identity has already failed to load, so
  there's no in-page state a reload would lose.
- **Web UI Settings page** (`/settings`,
  `web-client/src/pages/SettingsPage.tsx` — issue #124, issue #20) is the
  web-UI half of the `meta` scalars
  described in "Reading/writing the inventory database" above: a
  `GET`/`PATCH /api/settings`
  (`src/web/routes/settings.ts`), gated by the same `requireAdminGroup`
  middleware as the Users/Permissions pages. `PATCH` validates against the
  exported `SettingsSchema` — the same schema `set-config` imports — so a
  value rejected by the CLI is rejected identically here, and a `null`/`''`
  submitted value clears the setting the same way `set-config --unset`
  does. As of issue #10, `SettingsSchema`/the page's field list both add
  `proxyDriver` and `proxyConfigPath` alongside the pre-existing six;
  issue #30 adds `proxyTlsCertificate`/`proxyTlsKey` (placeholders
  showing certbot's own default path for the inventory domain) beside
  those, inert unless the nginx driver is active.
  `proxyDriver` renders as a `<select>`, not the plain `<input>` every other
  setting gets: as of issue #33, `settingsResponse()` (`src/web/routes/
  settings.ts`, shared by GET and PATCH so the two can never disagree)
  adds `proxyDrivers` (every registered driver from `listDrivers()`, mapped
  to `{ id, label, defaultConfigPath, suggestedStatusPagePath,
  managesProxy, usesSharedCertificate, configPathNote }`, Caddy, nginx,
  then None) and `defaultProxyDriver` (`DEFAULT_PROXY_DRIVER_ID`) to the
  response, and the page's `proxyDriverOptions(drivers, defaultId)`
  (`web-client/src/lib/settings-display.ts`, framework-free so it's
  tested with plain `node --test`, same convention as `admin-nav.ts`)
  turns that into the dropdown's options, suffixing only the default
  driver's label with `" (default)"`. The displayed value is
  `drafts.proxyDriver || data.defaultProxyDriver`, so an unset setting
  shows as the default driver selected, and Save/Clear round-trip exactly
  like every other field. The same file's `proxyFieldView(selectedId,
  drivers)` decides, for whichever driver is currently selected in that
  *unsaved* dropdown value, whether the Proxy config path, Status page
  path, and Proxy TLS certificate/key fields apply at all: a driver whose
  `managesProxy` is `false` (only `none` today) hides all of them
  entirely rather than showing them disabled or empty; a managed driver
  always shows Proxy config path (placeholder its `defaultConfigPath`, or
  empty with "Required: this driver has no default." help text when that
  is `null`, with the driver's own `configPathNote` appended when it has
  one -- nginx's says it replaces the whole file and refuses one it didn't
  generate, Caddy's that only the managed section is replaced), shows
  Status page path only when its `suggestedStatusPagePath` is non-null,
  and shows the two TLS fields only when `usesSharedCertificate` is true
  (`showTlsFields`; nginx only, issue #30 -- driver metadata, never an id
  comparison in the page); an unrecognized id (never reachable through the
  dropdown itself, but defensive) hides all of them. The TLS fields also
  stay hidden until the driver list has loaded, since unlike the other two
  they mean nothing for the default driver. Until the driver list has
  loaded (or if the load fails) the
  dropdown is a disabled, option-less `<select>` with its Save disabled,
  never a free-text input. `SettingsPage.tsx` uses the shown field's own
  placeholder/help text from `proxyFieldView`'s result in place of the
  static Caddy-specific ones the `FIELDS` table used to hardcode for
  `proxyConfigPath` (`statusPagePath`'s help text stays static; only its
  placeholder is driver-driven). Hiding a field is display-only: its
  draft and stored value are never touched, and no PATCH is ever sent
  because a field stopped being shown -- an operator who switches back to
  a driver that uses it sees the old value still there. The page also
  shows two *derived* values (`derivedValues()`, `src/web/routes/
  settings.ts`) read-only, for
  the same reason the Dashboard shows other server-computed state: nothing
  to edit, just what the toolkit currently resolves them to -- each host's
  `midScheme.gateway`, and (labelled "Proxy IP (firewall scope)", renamed
  from "Caddy host" by issue #10) the `proxy: true` entry's `ip`, from
  `findProxyEntry`, with an explained empty state for each
  (`proxyHostText`/`LAN_GATEWAYS_EMPTY_TEXT`,
  `web-client/src/lib/settings-display.ts`). Unlike Users
  and Permissions, the Settings nav link shows for any admin even without
  Authentik's user directory (issue #20) -- it needs only an identity, not
  Authentik's REST API. `Sidebar.tsx` decides the whole Admin nav group
  through `adminNavLinks(isAdmin, hasDirectory)`
  (`web-client/src/lib/admin-nav.ts`, framework-free so it's tested with
  plain `node --test`): `hasDirectory: false` still returns Settings alone,
  `true` returns Users/Permissions/Settings in that order, and the "Admin"
  `nav-group-label` itself only renders when the returned list is
  non-empty. The impersonation picker's own `isAdmin && hasDirectory` gate
  is untouched by this -- impersonating a group is itself an Authentik
  user/group operation, so it still needs the directory regardless of what
  the nav shows.
- **VPN gateway deploy credentials** (`src/web/server.ts`): unlike an
  operator's interactive shell (which has `NORDVPN_ACCESS_TOKEN`/
  `PIA_USERNAME`/`PIA_PASSWORD` exported for the CLI's own
  `deploy-vpn-gateway`), this web service has none of those by default.
  A web-triggered deploy (Provisioning page's Deploy VPN Gateway form)
  gets them from the form itself: the Access Token (NordVPN) / Username
  and Password (PIA) credential fields -- shown/hidden per provider via
  `FieldDef.showIf`, masked via `kind: 'secret'` -- are marked
  `required: true` in `src/web/commands-meta.ts`. That flag is declarative
  only today: nothing in `ProvisioningForm.tsx`/`FieldInput.tsx` or the
  route layer reads it (true of every field that sets it, not just these
  three), so a blank credential is actually caught one step later, by
  `deploy-vpn-gateway.ts`'s own check -- whose error names both the form
  field and the CLI env var, so either audience gets something actionable.
  There is no credentials file and no dotenv load for these anymore -- an
  earlier version of this branch (issue #124) loaded a gitignored
  `data/vpn-credentials.env` as a fallback for a blank form field, but that
  mechanism was removed as redundant with the form's own fields. `deploy-vpn-gateway.ts` is unchanged by
  this: it still accepts `accessToken`/`piaUsername`/`piaPassword` as
  options that take priority over `process.env`, same override pattern as
  its existing `storage` option, and the CLI still sources them from
  `process.env` only (it has no flags for these). `src/web/routes/provisioning.ts`
  redacts any `kind: 'secret'` field to `'[redacted]'` before a job's
  request body is persisted, so a form-supplied credential is used for
  the real deploy but never stored in plain text in the jobs table / Job
  History page. Multiple gateways of the same
  provider may now coexist in inventory (`vpnGateway`'s old
  one-per-provider `validateInventory` restriction was lifted) --
  `deploy-vpn-gateway --name <guest-name>` (CLI) / the form's Name field
  (web, which takes a short identifier that the form composes into
  `${vpn}-<identifier>-gw-lxc`) is what distinguishes them, and
  `set-guest-vpn --vpn <gateway-name|none>` / the Dashboard's VPN dropdown
  route to one by name, not by provider.

## Project philosophy

This toolkit is for the user's own personal homelab — they are the sole
operator and author of the inventory (`inventory/bellhop.db`); there is no
other user or attacker in this threat model for the CLI or the inventory
file/data model itself. Validation is still worth adding when it also
catches typos/misconfiguration (e.g. rejecting a non-numeric `vmid`), but
don't spend effort or add complexity purely to defend against a
hypothetical malicious operator or attacker-controlled inventory file.
Favor simplicity and functional correctness over
security-hardening-for-its-own-sake. This does not extend to the web UI:
once a second, less-trusted user exists there (issue #11's user/group
management, issue #13's per-resource permissions), correct authorization
enforcement for that real co-user is in scope and worth real effort — not
defended against a malicious external attacker, but a restricted user
genuinely should not be able to see or act on what an admin has blocked
them from, and bugs that leak past that boundary are worth fixing with
the same rigor as any other correctness bug.

## Workflow conventions

- **Infra changes are sequenced real-world-first.** `inventory/bellhop.db`
  is a live pointer this toolkit's commands use to reach hosts
  (`ssh_target`, etc.) — for any change to real infrastructure (a host IP
  change, a storage move, cluster topology), do the real change first and
  only edit the inventory (hand-edit a `hosts.yaml` copy and re-run
  `import-yaml-inventory --apply` against it, or edit `bellhop.db` directly)
  and docs to match afterward, once the user confirms it landed. Editing
  the repo ahead of the real change makes commands try to reach a host
  that isn't there yet, and leaves the repo describing infrastructure that
  doesn't exist.
- **New branches are git worktrees, created at the start of work on an
  issue — before brainstorming, not deferred until implementation.** Use
  `git worktree add` (or the `superpowers:using-git-worktrees` skill)
  instead of `git checkout -b` in the main working directory, even for
  small tasks — switching branches in-place disrupts any other work or
  long-running process (a running `npm run web:dev`, say) pinned to that
  checkout.
  Once a worktree exists, make every change in the worktree itself, never
  in the main checkout with files copied over afterward — but **never move
  the Claude session into it**. Changing the session's working directory
  (`cd`, `Set-Location`) into a worktree is what corrupts Claude sessions:
  the session's primary directory drifts, and later commands (a
  `specify extension add`, say) land in the wrong checkout. Stay in the
  main checkout and reach the worktree by absolute path instead — Read/
  Edit/Write with full worktree paths, `git -C <worktree>`, `npm --prefix
  <worktree>`. A tool that can only resolve the repo from its current
  directory (Spec Kit's PowerShell scripts, for example) runs in a
  subshell scoped to that one command, `(cd <worktree> && <cmd>)`, which
  leaves the session where it was.
  Create the worktree for a new issue immediately, before running
  brainstorming/writing-plans. Any specification, plan or task list written
  for an issue belongs on that issue's own branch, committed like any other
  change, and follows the constitution (`.specify/memory/constitution.md`),
  Principle I: example values only, never real hostnames, domains, IPs, or
  credentials. A design note that genuinely needs real values does not
  belong in this repository at all — keep it in a gitignored location, or
  outside the repository entirely, per that same principle.
  **A fresh worktree starts with neither an inventory database nor a
  `data/` directory**: `data/` is gitignored as a whole directory, and
  `inventory/bellhop.db` is gitignored as a specific file within the
  otherwise-tracked `inventory/` directory (see "Inventory" above). Copy
  `inventory/bellhop.db` (plus its `-wal`/`-shm` sidecar files, for a
  consistent snapshot), `data/authentik.env` and, when present,
  `data/cloudflare-api.env` across from the operator's deployment checkout
  (the one the web service actually runs from), `mkdir -p`-ing the
  worktree's `data/` first. Never seed from the main checkout: main holds
  no real data at all — no `inventory/bellhop.db`, no `data/` — so running
  it shows exactly what a fresh clone would. The deployment checkout is the
  only authoritative copy; any other checkout's database is a snapshot that
  drifts from it. Where the deployment checkout lives is operator-specific
  and deliberately not recorded in this repository — it belongs in the
  operator's own private notes. Without these files the new worktree's CLI
  commands and web UI can't reach real infrastructure or a real Authentik
  instance — commands would operate on stale/wrong hosts, and
  `AuthentikClient` would fall back to `UnconfiguredAuthentikClient`.
- **Anytime superpowers is invoked on an issue, make sure the issue is
  assigned to the person doing the work before proceeding.** Check the
  issue's assignee (`gh issue view <number> --json assignees`) and assign
  it (`gh issue edit <number> --add-assignee <user>`) if it isn't already —
  don't leave a worktree/branch in progress against an unassigned issue.
- **Once a worktree exists for the branch (per the rule above), never pass
  `isolation: "worktree"` on an `Agent` dispatch for that branch's work.**
  That parameter makes the Agent tool silently create and manage a second,
  separate worktree of its own — redundant with the one already set up, and
  a real risk of an implementer's commits landing somewhere other than the
  branch being tracked. Dispatch subagents with a plain `Agent` call (no
  `isolation` field) and point them at the existing worktree path in the
  prompt (e.g. "Work from: `<worktree-path>`") instead.
- **Commit and push freely.** This is a personal, single-operator repo —
  once a change is verified (typecheck/tests/live check as appropriate),
  commit and push without pausing for a separate confirmation round-trip.
  Still surface what was committed/pushed in the summary.
- **Finishing a branch: use the `finishing-a-development-branch` skill's
  standard push-and-PR flow, targeting `main` — don't layer custom process
  on top of it.** Push the branch and open a PR against `main` (check
  `gh pr list --head <branch>` first; only run `gh pr create` if none
  already exists — if one's already open, just push and let it pick up the
  new commits). Never choose the skill's "merge locally" option for this
  repo — `main` only ever advances via the fast-forward pull described
  next, never a local merge, so that option doesn't apply here.

  A local `main` stays in sync with `origin/main` via a
  **fast-forward-only pull** (`git fetch origin main && git merge --ff-only
  origin/main`, or `git pull --ff-only`) — never a local merge into `main`,
  never followed by a push. If `--ff-only` ever fails, local `main` has
  commits `origin/main` doesn't (a policy violation — something landed on
  `main` locally that should have gone through a branch/PR instead) — stop
  and investigate rather than forcing past it.

  Leave the worktree and local branch alone once the PR is open — they
  stay in place until the PR actually closes on GitHub. Cleaning one up is
  always an explicit, separate action taken later (when asked, or once
  you've confirmed via `gh pr view <branch-or-number> --json state,mergedAt`
  that it's actually merged) — never an automatic follow-on to pushing a
  branch or to a PR merging.
- **A branch that changes a single-operator assumption records it.** Where a
  change introduces, fixes, or invalidates something that only holds for one
  deployment's topology — a hardcoded literal, an assumption about how many
  hosts or operators exist — say so in the branch, so the project's record
  of those assumptions stays true rather than drifting.
- **`CONTRIBUTING.md` restates contributor-facing rules — keep it in
  sync.** It is the outside contributor's summary of the constitution and
  README (dry-run convention, `FakeSSHClient` testing, example data only,
  the three CI checks, branch-per-issue-via-PR). A change to any convention
  it restates updates it in the same change, the same way README/CLAUDE.md
  are.
- **GitHub operations go through the `gh` CLI, not the GitHub MCP tools.**
  The GitHub MCP server's token is not reliably scoped to this repository
  (`mcp__github__*` calls come back 404/422 "resource does not exist or
  you do not have permission"); `gh` is authenticated with proper access.
  Use `gh` via Bash for issues, PRs, and any other GitHub action here.
- **Mobile is a first-class target for the web UI, not an afterthought.**
  Any UI/frontend change must be verified in a browser at both a
  desktop-width viewport and a mobile-width viewport (≤640px, the
  existing CSS breakpoint in `web-client/src/index.css`) before it's
  reported as complete — a change that only looks right on desktop is not
  done. This came out of issue #89, where the Users/Groups management
  page shipped with several mobile-specific layout breaks (action buttons
  overflowing a card, an inline-edit checklist fighting the generic
  label/value row layout) that desktop-only verification never caught.

## Development environment notes (Windows)

- **Verifying a process is actually stopped needs PowerShell, not bash.**
  `concurrently`, `npm --prefix`, and Node's per-file test-isolation
  workers get spawned on Windows through `npm.cmd`/`cmd.exe` shim chains
  that produce real Windows process trees git-bash's `ps`/`kill` doesn't
  reliably see or terminate. To actually kill a Windows-spawned node tree,
  use `taskkill /PID <pid> /T /F` (kills the whole tree). Before reporting
  a server/test process as stopped, confirm with `Get-Process -Name node`
  and `Get-NetTCPConnection -State Listen` on the relevant port — don't
  trust bash `ps` alone.
- **Kill background dev servers/shells by PID once done with them** —
  don't leave orphaned processes for the user to notice. Match the
  specific PID (by start time or port ownership) rather than a broad
  `taskkill /IM node.exe`, and verify the process tree is actually gone
  (not just that the stop call returned success).
- **Never kill Chrome by image name** (`taskkill //F //IM chrome.exe`) when
  cleaning up a headless test instance — the user runs their own Chrome
  windows on this machine, and a by-name kill takes those down too.
  Capture the specific PID when launching headless Chrome and kill only
  that PID during cleanup.
