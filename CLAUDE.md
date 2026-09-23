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
function's return value.

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
  `subdomains`/`ip`/`port`/`insecureBackendTls` fields drive Caddy
  reverse-proxy generation — `subdomains` is a list (a host or guest can
  front more than one subdomain; `sync-caddy` emits one `reverse_proxy`
  block per entry in the list, all pointing at the same `ip`/`port`);
  `insecureBackendTls` — see `sync-caddy` below; `caddyManual` (optional,
  hosts and guests only) marks an entry whose real Caddy config is
  hand-authored elsewhere (outside `sync-caddy`'s managed markers) —
  `buildCaddyBlock` skips generating a site block for it entirely, even
  though its `subdomains[]` still drives the Dashboard's service link; set
  by hand for a host (there's no web UI for host editing) or via the
  Dashboard's "read-only caddy" column checkbox for a guest;
  `authGroup` (optional, hosts/guests/external_sites -- issue #158
  replaced the earlier `requiresAuth` boolean with this field) names one
  rung of an ordered Authentik group ladder (`AUTHENTIK_GROUP_LADDER`, see
  the `sync-authentik` bullet below) and gates that entry's subdomain(s)
  behind Authentik forward-auth at that tier; absent means ungated, the
  same semantics `requiresAuth: false` used to have. `sync-authentik`
  creates/deletes the matching Authentik Proxy Provider and Application,
  and binds it to the named rung **and every rung above it** (Authentik's
  Applications default to `policy_engine_mode: any`, so the bindings OR
  together) -- the ladder's top rung is therefore effectively "admin only",
  and an admin gets in because their group sits at the top of the ladder,
  not via a separate check. The old auto-created `homelaboratory-app-users`
  group and the separate builtin-admin OR-check (which had mirrored this
  app's own admin-gating OR-check from issue #86) are both gone, replaced
  by the top rung. `sync-caddy` emits
  the `forward_auth` directive addressed at
  whichever entry has `authentik: true` (mirrors `caddy: true`'s
  single-entry role, marking which host/guest actually runs the Authentik
  instance); a no-op on an entry with no `subdomains` (no candidate to
  gate) in both commands, but `caddyManual` only silences `sync-caddy`
  (`buildCaddyBlock` skips generating any block, `forward_auth` included,
  for a `caddyManual` entry) — it is *not* a no-op for `sync-authentik`,
  which still creates/maintains that entry's Authentik Provider/
  Application/bindings regardless of `caddyManual`, since the
  operator's hand-authored Caddy block may still want to route through
  Authentik forward-auth on its own;
  `unauthenticatedPaths` (optional, hosts/guests/external_sites, same
  placement as `authGroup`) is a list of Caddy path-matcher globs (e.g.
  `/api/*`) that `sync-caddy` exempts from the `forward_auth` check on a
  gated entry -- added for issue #113, where an *arr-style
  app's server-to-server API calls (Prowlarr -> Whisparr) were getting
  redirected to an Authentik login the same as a browser request. A no-op
  when `authGroup` is unset or the entry is `caddyManual`, same as
  `insecureBackendTls`'s existing "inert when not applicable" precedent.
  Deliberately Caddy-side only, not an Authentik Proxy Provider setting --
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
  ...existing }` spread, same as `subdomains`/`port`/`caddy`); `app`
  (optional, set once by `install-app`'s apply step, never hand-edited)
  records the community-scripts slug the guest was installed from — drives
  the Dashboard's community-scripts quick-open link, preserved across
  `sync-inventory` runs and repeat `upsertGuestEntry` merges the same way
  `port` is; `caddy: true`
  on exactly one entry marks where Caddy runs — this
  cross-field rule (along with "every guest's `host` resolves to a real
  entry", "non-empty `subdomains` requires `ip` unless `caddyManual` is
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
  guest `subdomains`/`port`/`caddy` are preserved. Each host also carries an
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
  `caddy_owner` (a single-row, `CHECK (id = 1)`-enforced table recording
  which one entry has `caddy: true`; written by `saveInventory` but not
  currently read back by `loadInventory`, which instead reads the `caddy`
  boolean column already present directly on the owning `hosts`/`guests`
  row), and `meta` (`domain` plus four optional operator-specific scalars,
  issue #124: `nfsServer`, `backupStorage`, `dnsServer`, `statusPagePath`
  — see `SettingsSchema`/`SETTINGS_KEYS` in
  `src/lib/inventory.ts`, spread into `InventorySchema` rather than nested
  under their own key, same flat placement as `domain`). Each used to be a
  hardcoded literal specific to this operator's own network; each is now
  optional, and all four have the one or two commands that read them fail
  with a named error pointing at `set-config` rather than silently falling
  back to this repo author's values, since a wrong IP is worse than a
  missing one for any other operator. A fifth setting, `vpnCredentialsFile`,
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
  scope (`scripts/windows-service.ts`'s `resolveCaddyIp`) comes from
  whichever entry has `caddy: true`. `saveInventory`
  runs as a single `db.transaction`: it deletes every row from five
  tables (in FK-safe order: `subdomains`/`caddy_owner`/`guests`/
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
  rather than purely cosmetic (`sync-caddy` treats an entry's first
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
  rung -- a deliberate fail-closed choice (the narrowest audience), not
  one tuned to match any particular operator's prior Authentik state,
  though for this operator's own database it happens to match what the
  four gated Applications were already bound to, so the first
  `sync-authentik --apply` afterward is a no-op rather than a silent
  widening -- and then the `requires_auth` column itself is dropped. Once
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
  translated into the real `ExecResult` by `runRemote`'s `vm` branch.
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
  `--group pve|lxc|vm`, implemented once by `selectTargets` in
  `src/lib/targets.ts`. As of issue #120 it no longer runs one hardcoded
  apt command against every target: it probes each one first
  (`PROBE_COMMAND` in `src/lib/package-manager.ts`, a `command -v` chain)
  and dispatches to `UPDATE_COMMANDS`, a five-entry table covering
  `apt`/`dnf`/`apk`/`pacman`/`zypper`. A target whose OS isn't recognized
  lands in its own `failUnknownPm` result bucket rather than the generic
  `failCommand`, and — like every other failure bucket — fails the web job
  and sets the CLI's exit code to 1. Detection is deliberately runtime
  rather than an inventory field: Proxmox's own `ostype` is a
  creation-time label (and a useless generic `l26` for every VM), while
  `command -v` is ground truth and self-corrects if a guest's OS changes.
- **Dry-run convention**: anything that mutates infrastructure or the
  inventory file (`create-lxc`, `create-vm`, `configure-guest`,
  `sync-caddy`, `migrate-nfs-mount`, `attach-nfs-mount`, `sync-inventory`)
  defaults to printing what it would do and only executes with `--apply`.
  `create-lxc`/`create-vm`/`configure-guest` use the shared
  `confirmOrDryRun` function (`src/lib/dry-run.ts`); `sync-caddy`/
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
  just when an optional flag is set.
- **`sync-caddy`** (`src/commands/networking/sync-caddy.ts`) writes into a
  delimited managed section of the Caddyfile
  (`# BEGIN bellhop-managed` / `# END bellhop-managed`) on whichever
  inventory entry is flagged `caddy: true`, so anything hand-edited outside
  the markers survives repeated runs. `buildCaddyBlock` emits one site block
  per entry (its `subdomains[]` joined into a single comma-separated address
  list, e.g. `sonarr.example.com, shows.example.com { ... }` — matching the
  hand-authored style already live rather than repeating the same directives
  once per alias) across `hosts[]`, `guests[]`, *and* `externalSites[]`
  (`ExternalSiteSchema` in `src/lib/inventory.ts` — a Caddy reverse-proxy
  target that isn't a Proxmox host or guest at all, e.g. a NAS; never an
  SSH/exec target, only `sync-caddy` ever reads it), each getting the same
  hardcoded Cloudflare DNS-01 `tls {}` clause (not inventory-configurable —
  one domain, one DNS provider, one operator). Every generated
  `reverse_proxy` is always emitted in block form (`reverse_proxy ip:port {
  ... }`), never the bare one-line form the generator used to fall back to
  for the common case — every block unconditionally includes a `header_up
  X-Forwarded-Port 443` line (hardcoded constant `EXTERNAL_PORT`, sitting
  next to `TLS_BLOCK`) so backends that build absolute external URLs from
  that header (e.g. Dispatcharr's VOD cover art, issue #91) get the real
  external port instead of their own internal listen port, rather than
  Caddy's default of not setting `X-Forwarded-Port` at all. This is
  unconditional and independent of `insecureBackendTls` — when that entry
  also sets `insecureBackendTls: true`, its block additionally gets a
  `transport http { tls_insecure_skip_verify }` line alongside `header_up`
  in the same block, for backends that serve HTTPS with a
  self-signed/untrusted cert (Proxmox's own web UI, a NAS's web UI).
  Content outside the managed markers (a static `file_server` block for
  Caddy's own landing page, say) is never touched, but also never generated
  — the managed section only knows how to emit `reverse_proxy` blocks, so a
  site that isn't reverse-proxying to something stays permanently hand-edited.
  On a Caddyfile with no `# BEGIN bellhop-managed` marker yet (i.e. one
  hand-authored before this command was ever run against it), `--apply`
  *appends* the managed block rather than replacing anything — any
  hand-written block for a subdomain inventory now also covers becomes a
  duplicate site definition until the operator removes the old one by hand.
  When an entry with an `authGroup` set also has `unauthenticatedPaths`
  set, `buildCaddyBlock` wraps its `forward_auth` directive in a named Caddy
  matcher (`@auth_required { not path <patterns...> }`) so a request
  matching any listed pattern skips the Authentik check and falls straight
  through to the block's already-unconditional `reverse_proxy` -- the
  app's own API-key auth remains the real protection on those paths. No
  matcher is emitted when the list is empty, so existing gated entries
  with no exceptions configured are unaffected. The emitted config for a
  gated entry is otherwise byte-identical to before issue #158 introduced
  the group ladder -- which *tier* an entry sits at is enforced entirely by
  Authentik's policy bindings (see `sync-authentik` below), never by Caddy,
  so `forward_auth` itself doesn't vary by rung.
- **`sync-authentik`**
  (`src/commands/networking/sync-authentik.ts`) is `sync-caddy`'s
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
  to `homelab-app-users-open,homelab-app-users,homelab-users,authentik
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
  unchecked, on an entry with no `authGroup` at all: `buildCaddyBlock` only
  emits the `@auth_required` matcher inside its `if (entry.authGroup)`
  branch, so an exemption on an ungated entry never reaches the Caddyfile --
  there is nothing to widen. A non-admin may add path exemptions to an
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
  (printed by the CLI; returned by `syncCaddyLive` as
  `authentikConflicts` and echoed in the Dashboard guest-PATCH response
  (filtered there to the edited guest's own subdomain -- the list itself is
  inventory-wide),
  where `EditableAuthGroup`/`EditableSubdomains` render it as a warning
  banner -- that route calls `syncCaddyLive` straight from its Express
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
  The web UI's Dashboard auth-group dropdown
  (`EditableAuthGroup.tsx`, replacing the old "requires auth" checkbox,
  backed by `GET /api/auth-groups` -- authenticated but deliberately not
  admin-gated, since a non-admin needs the rung options to raise a tier)
  reaches this the same way subdomain edits
  reach `sync-caddy`: via `syncCaddyLive`, which now runs `sync-caddy`,
  `render-status-page`, and `sync-authentik` back to back, then
  `prune-acme-challenges` (below), as one combined push-live step.
- **`prune-acme-challenges`**
  (`src/commands/networking/prune-acme-challenges.ts`, issue #162) deletes
  `_acme-challenge` TXT records left behind in the inventory `domain`'s
  Cloudflare zone by Caddy's DNS-01 `TLS_BLOCK` (an aborted issuance, a
  restart mid-challenge, a removed or renamed subdomain). REST-only via
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
  delete is reported and the rest proceed (CLI exit 1). In `syncCaddyLive`
  it is the last step and **never fails the caller** (the 10s timeout on
  every request bounds how long that can take): unconfigured logs one
  skip line, and any thrown error (bad token, outage, zone not found,
  timeout) becomes a `logWarn`; `SyncCaddyLiveResult` carries nothing for
  it, since there is no Dashboard action to ask for. `syncCaddyLive` is
  reached through the shared operations layer (`src/operations/edit-guest.ts`
  and `src/operations/provisioning.ts`), so the web UI and the MCP server
  both run it. `cloudflare` is **required** on `OperationDeps`
  (`src/operations/types.ts`): `syncCaddyLive` treats a missing client as
  unconfigured and skips the prune silently, so a required field is what
  turns a forgotten deps literal into a compile error instead of a
  cleanup that quietly never runs. It stays optional on `AppDeps` and
  `syncCaddyLive`'s own deps (defaulting to `UnconfiguredCloudflareClient`,
  like `impersonationStore`) only so tests that don't care need no change;
  `src/web/server.ts` and `src/mcp/server.ts` always pass
  `buildCloudflareClient()`. Only the guest-edit and create/install/
  delete-guest paths prune: `sync-caddy`, `render-status-page`, and
  `migrate-guest` -- CLI, web, and MCP alike -- call `runSyncCaddy`/
  `runRenderStatusPage` directly rather than `syncCaddyLive`, so a guest
  migration or a manual Caddy push never cleans up stale TXT records.
- **`render-status-page`** (`src/commands/networking/render-status-page.ts`)
  regenerates a static HTML page and writes it to the operator-configured
  `statusPagePath` (issue #124) on whichever entry is `caddy: true` — the
  document root Caddy's hand-authored `caddy.example.com` block already
  serves via `file_server`. Opt-in entirely: an operator who hasn't set
  `statusPagePath` never gets a page rendered anywhere. The standalone CLI
  command itself throws, naming the `set-config statusPagePath
  </absolute/path> --apply` fix; the two automated callers below treat an
  unset `statusPagePath` as a no-op, logging one line and continuing rather
  than failing the rest of their run. The page shows two fetched-fresh
  `<pre>` blocks (HTML-escaped): a
  human-readable YAML snapshot of the current inventory (`src/cli.ts` calls
  `loadInventory` then the `yaml` package's `stringify` on the result and
  passes that string in as plain text — `inventory/bellhop.db` itself has no
  text form to `cat`, so this is a live re-render rather than a raw file
  read the way the old `inventory/hosts.yaml` version worked) and the
  *actual* currently-deployed Caddyfile, read from `CADDYFILE_PATH` (same
  env var `sync-caddy` reads/writes, defaulting to `/etc/caddy/Caddyfile`)
  rather than a path hardcoded separately from it. As a standalone CLI
  command it's still manual, on-demand — the CLI's own `sync-caddy` never
  calls it. The web UI is the exception: `src/web/caddy-sync.ts`'s
  `syncCaddyLive` (used by both `create-lxc`/`create-vm`/`install-app`
  apply when the Subdomains field was used, and the Dashboard's
  guest-subdomains PATCH endpoint — see below and "Reading/writing the
  inventory database") calls `sync-caddy` then `render-status-page`
  back to back on every web-UI-driven subdomains change, so the two never
  drift the way a CLI-only workflow could, unless `statusPagePath` is unset,
  in which case only `sync-caddy` runs. `migrate-guest` (below) skips it the
  same opt-in way on its own post-move Caddy push. That `caddy.example.com`
  block is hand-restricted to LAN/internal ranges only (a Caddy `@internal
  remote_ip` matcher + `handle`/`handle` pair, 403 otherwise) since the page
  shows real internal hostnames/IPs — neither `render-status-page` nor
  `syncCaddyLive` has any opinion on that restriction, they only ever touch
  `index.html`/the managed Caddyfile section, never the site block itself.
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
  `name`/`subdomains`/`port`/`caddy` but get `type`/`ip` refreshed (IP parsed
  from the guest's `net0`/`ipconfig0` config, mask stripped); new guests are
  added with no `subdomains`/`port`/`caddy` (unless the web UI's create-lxc/
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
  rewrite, preserving `subdomains`/`port`/`caddy`/`app`/
  `insecureBackendTls`/`authGroup`/etc., that the Dashboard's guest-PATCH
  route already does for in-place edits), and if the guest has
  `subdomains`, `sync-caddy` runs in the same `--apply` so the managed
  Caddy config points at the new IP immediately — `render-status-page` runs
  alongside it too, but only when `statusPagePath` is set (see
  `render-status-page` below for the opt-in behavior it shares with
  `syncCaddyLive`) —
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
  4") and flag a stall as a guess rather than a detected question.
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
  `subdomains` were given, it also awaits `syncCaddyLive` (see
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
- **Live TLS-backend probing** (`src/lib/tls-probe.ts`, issue #100) augments
  the previously fully-manual `insecureBackendTls` checkbox with a live
  probe of the guest's actual running app on two web-UI paths -- the
  checkbox stays authoritative for hosts, CLI usage, `caddyManual`
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
  changed `subdomains`/`port` and the resulting entry isn't `caddyManual`
  (whose Caddy block, and thus `insecureBackendTls`, is never generated).
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
  convention, not a scroll container. Theme is controlled by
  `ThemeContext`/`ThemeToggle` (`web-client/src/lib/theme.tsx`), not the
  raw `prefers-color-scheme` media query directly: the user's choice
  (`'light' | 'dark' | 'system'`, persisted in `localStorage`, defaulting
  to `'system'`) is resolved to an actual light/dark value in JS and
  written to `document.documentElement.dataset.theme`; `index.css` keys its
  dark-mode variable overrides off `:root[data-theme='dark']` rather than
  `@media (prefers-color-scheme: dark)`, so any new themed CSS should target
  that selector too.
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
  some handlers (e.g. `src/web/caddy-sync.ts`'s `syncCaddyLive`, which
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
  checks this for every `PROVISIONING_COMMANDS` field). The CLI does not use
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
  interrupts the other's in-flight jobs. Cancel/answer/dismiss only work
  from the process that owns the job (the controller lives in its memory);
  MCP-started jobs show in the web UI's Job History ("Triggered by: mcp")
  but without live streaming or controls there (issue #165). stdout is the
  protocol channel, so `src/mcp/server.ts` redirects `console.log` to
  stderr at startup. On stdin close it cancels its jobs and exits; a job
  still running when the client session ends is therefore interrupted.
- **Web UI authentication** (`src/web/auth.ts`): the entire web UI is
  gated behind a global `requireAuth` Express middleware, mounted in
  `src/web/app.ts` ahead of every route mount, that trusts the
  `X-authentik-*` identity headers Caddy's `forward_auth` adds once a
  request has been checked against a self-hosted Authentik instance —
  there is no OIDC client, login page, or session store anywhere in this
  repo; Authentik and Caddy own the actual authentication session, and
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
  -- under the default `auto`, a Caddy config that lost its `forward_auth`
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
  `addFirewallRule` installs being scoped to `remoteip=<caddy-lxc's IP>`
  rather than "any" LAN host — that scope is what prevents something other
  than Caddy from reaching the app directly and spoofing the
  `X-authentik-*` headers it trusts unconditionally. Forward-auth at Caddy
  was a deliberate choice over an app-embedded OIDC client: Authentik and
  Caddy own the session, and this app holds no session state of its own.
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
  copy `GroupsSection.tsx` had grown since): both now read `isAdmin`/
  `adminGroups`/`capabilities` off `GET /api/whoami` (`src/web/routes/
  dashboard.ts`) instead. Also gated behind the directory-capability check
  (`requireUserDirectory`, `src/web/auth.ts`) on top of `requireAdminGroup` —
  see "Running without Authentik" in `README.md` for what happens when no
  `AUTHENTIK_API_URL`/`AUTHENTIK_API_TOKEN` are configured. `AuthentikClient`
  (`src/lib/authentik-client.ts`) wraps
  Authentik's REST API v3, modeled on the `SSHClient` injection pattern:
  `RealAuthentikClient` (no automated test, verified manually, same
  precedent as `Ssh2SSHClient`) is used when `AUTHENTIK_API_URL`/
  `AUTHENTIK_API_TOKEN` are both set; otherwise `UnconfiguredAuthentikClient`
  is injected instead, so every route call fails the same clear
  "not configured" way rather than needing a null check at each call site.
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
  `push-ssh-key`, `sync-inventory`, `sync-caddy`) stay admin-only via the
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
- **Web UI Settings page** (`/settings`,
  `web-client/src/pages/SettingsPage.tsx`, nav link beside Users and
  Permissions — issue #124) is the web-UI half of the `meta` scalars
  described in "Reading/writing the inventory database" above: a
  `GET`/`PATCH /api/settings`
  (`src/web/routes/settings.ts`), gated by the same `requireAdminGroup`
  middleware as the Users/Permissions pages. `PATCH` validates against the
  exported `SettingsSchema` — the same schema `set-config` imports — so a
  value rejected by the CLI is rejected identically here, and a `null`/`''`
  submitted value clears the setting the same way `set-config --unset`
  does. The page also shows the two *derived* values (each host's
  `midScheme.gateway`, and the `caddy: true` entry's `ip`) read-only, for
  the same reason the Dashboard shows other server-computed state: nothing
  to edit, just what the toolkit currently resolves them to.
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
  `data/cloudflare-api.env` across from an existing checkout, `mkdir -p`-ing
  the worktree's `data/` first. Without them the new worktree's CLI commands
  and web UI can't reach real infrastructure or a real Authentik instance —
  commands would operate on stale/wrong hosts, and `AuthentikClient` would
  fall back to `UnconfiguredAuthentikClient`.
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
