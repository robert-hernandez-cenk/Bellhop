# Maintenance commands

Guidance for `src/commands/maintenance/`: `sync-inventory`, `audit-nfs-mounts`, `check-app-updates`, `backfill-guest-creators`. The dry-run convention, the POSIX sh rule for guest commands, and `runRemote` as the only remote path are in the root CLAUDE.md.

Other commands here have their detail elsewhere:

- `update-all` targeting (`selectUpdateTargets`, VM exclusion) and package-manager detection: see `src/lib/CLAUDE.md` (targets, package managers).
- `update-app`: `src/commands/provisioning/CLAUDE.md` (install-app/update-app). It re-runs the same `ct/<app>.sh` inside the guest via `runRemote`, exporting `TERM`/`PHS_SILENT` but not `mode`; the inner `bash -c` is deliberate (community-scripts needs it).
- `set-config`: Settings store in `src/lib/CLAUDE.md`; secrets rule in the root CLAUDE.md.
- The daily scheduler that runs `check-app-updates`: see `src/web/tasks/CLAUDE.md` (scheduler).

## `sync-inventory`

`src/commands/maintenance/sync-inventory.ts` queries every `pve`-type host directly (never a guest, so it is the one command that never exercises `runRemote`'s `pct`/`qm` wrapping path) and reconciles inventory with live state.

- **Guests**: via `pvesh get /nodes/$(hostname)/{lxc,qemu}`, keyed by `(host, vmid)`.
  - Existing entries keep `name`/`subdomains`/`port`/`proxy` and get `type`/`ip` refreshed (IP parsed from the guest's `net0`/`ipconfig0`, mask stripped).
  - New guests are added with no `subdomains`/`port`/`proxy`. If the web UI's create-lxc/create-vm/install-app apply already added the entry, the `{ ...existing }` merge preserves whatever `subdomains` that apply set.
  - Guests no longer present are dropped.
- **Bridges**: queries `/nodes/$(hostname)/network`, filters `type: 'bridge'`, and fully replaces that host's `bridges[]` (`alias` from the interface's Proxmox `comments`, default `'LAN'`).
- **Storages**: does the same for `/nodes/$(hostname)/storage` -> `.hosts[].storages` (what is kept vs. dropped is in `src/lib/CLAUDE.md`'s inventory schema section).
- The bridge and storage queries are independent. A host whose query fails keeps its previous `bridges[]`/`storages[]` unchanged rather than being blanked out, reported via `bridgeFailures`/`storageFailures` and `formatSyncInventory`.
- It always computes and prints its new/updated/removed summary. `--apply` calls `saveInventory`, which replaces `.hosts` and `.guests` wholesale, sorted. See `src/lib/CLAUDE.md` (`sortInventoryForFile`) for the sort order and why the apply is idempotent.

`import-yaml-inventory` is gone (#86): the first-run setup walkthrough (`src/web/CLAUDE.md`) creates the first inventory; a sample database for CLI work comes from `npm run demo:seed -- <path>`.

## `audit-nfs-mounts`

`src/commands/maintenance/audit-nfs-mounts.ts` is read-only and has no NFS-server parameter: host-relay bind-mounts (see `attach-nfs-mount`/`migrate-nfs-mount` in `src/commands/provisioning/CLAUDE.md`) are the only supported pattern, and it inventories current NFS usage against that topology.

- Iterates every `lxc`-type guest (or one via `--host`, which throws if the named entry isn't type `lxc`), runs `pct config <vmid>` on the guest's *parent host* through `runRemote`, and parses its `mpN:` lines with `parseMpEntries` (`src/lib/nfs.ts`) into `{ hostPath, mountPoint }` pairs.
- Each `mpN` host path is matched, per parent host, against `knownNfsPaths`, a `Map` built from that host's `nfsMounts[]` (sync-inventory's discovered fstab mounts) plus a deterministic `/mnt/pve/<name>` entry for every `nfs:`-type storage in `storages[]` (Proxmox's fixed mount convention, so no extra `pvesh` call). A path matching neither is not NFS-backed and is skipped.
- Matches aggregate by share name into `usages: NfsMountUsage[]` (`{ name, export?, hostPath, users: string[] }`, `users` listing each `<guest> (<container mount point>)`). Keyed by inventory-known name rather than export string because a host-relay mount's identity is its name; a guest may not carry a live export string post-migration.
- A guest whose `pct config` can't be read is counted as `unreachable`, never silently treated as "no NFS mounts."

## `check-app-updates`

`src/commands/maintenance/check-app-updates.ts` and `src/lib/app-update-check.ts`. It is the one registered scheduled task (04:00 server-local by default; scheduler mechanics in `src/web/tasks/CLAUDE.md`). It compares every `lxc` guest's installed community-scripts app version against its latest stable upstream release.

It deliberately mirrors `check_for_gh_release` from community-scripts' own `misc/tools.func` line for line rather than inventing a version comparison: the badge must agree with what happens when the operator presses the real update button.

### Parsing the script

`parseReleaseCheck` finds the first `check_for_gh_release` call in the guest's resolved `ct/<slug>.sh` and tokenizes its arguments as shell words. The script is resolved via `createAppSourceResolver`, the same custom-script-repository resolution `install-app`/`update-app` use, so a configured fork's own script is read here too.

- The name and repo arguments must be literal.
- The pin argument may instead be a bare `$VAR`/`${VAR}` reference resolved through exactly one literal assignment elsewhere in the same script (including the self-referential `VAR="${VAR:-default}"` form community-scripts uses).
- The tag-prefix argument, if present, must be literal.
- Anything it can't pin down (no call at all, non-literal name/repo, unresolvable pin, non-literal prefix) is `unsupported`, not an error. Roughly a third of community-scripts apps update through a package repository or another forge, and showing nothing for them is correct, not a gap.

### Fetching the latest release

`fetchLatestRelease` follows upstream's own request order:

- Unpinned and unprefixed: tries `/releases/latest` directly.
- Anything else (a prefix, or any non-clean response to a pin's direct `/releases/tags/<pin>` lookup: a 404, a 200 that is a draft/pre-release, anything but 403/429): falls back to walking the full `/releases?per_page=100` list and re-deriving the candidate there, matching upstream's "never trust a single direct hit blindly".
- 403/429 from either path is always `GITHUB_RATE_LIMIT_MESSAGE`, with no fallback. It is reported per guest and never retried within the same run.
- The optional `githubApiToken` secret authenticates every `api.github.com` request via `githubApiHeaders` (see `src/lib/CLAUDE.md`, Settings store). Without a token, one run a day plus the caches below keeps a homelab-sized inventory under GitHub's anonymous 60-requests-per-hour limit.

### Outcome and installed version

- `decideOutcome` is upstream's own inequality, not a semver comparison. Pinned: "update available" when `installed != pin`. Unpinned: when `installed` is empty or `!= latest`. Both sides are normalized by stripping a leading `v` only when followed by a digit.
- The installed version is read from inside the guest by one POSIX `sh` script (`buildInstalledVersionScript`, via `runRemote`) that mirrors upstream's current-version lookup read-only: `$HOME/.<app_lc>` first, then exactly one `/opt/*_version.txt` match. It never writes or migrates either file the way upstream's installer does.
- No match at all (`exit 3`) is an `error` naming the missing `~/.<name>` file and suggesting the operator run the app's update once to create it. This is distinct from `unsupported`: the app is checkable, the record just doesn't exist yet.

### Caching and concurrency

- A `ReleaseCache` and a script cache, both scoped to one run (or one single-guest check) and shared via `CheckAppUpdatesContext`, make two guests running the same app query GitHub and fetch the script exactly once between them.
- A full run checks up to `CHECK_CONCURRENCY` (4) guests at once. Every cache holds promises, so a request already in flight is shared.
- A stopped guest is never contacted. The full run queries `getGuestStatuses` once up front (the same one-status-query-for-everyone pattern `update-all`'s targeting uses) and reports `not-checked`/"Guest is stopped" for it directly.

### Storage: `app_update_status`

Results live in `src/lib/app-update-store.ts`'s `app_update_status` table (one row per guest). It sits outside `saveInventory`'s delete-and-reinsert, same precedent as `task_schedules`.

- A full run calls `replaceAppUpdateResults`: one transaction that deletes everything and re-inserts the new set, so a guest removed from inventory or no longer eligible leaves no stale row.
- `--guest` and the post-update re-check call `upsertAppUpdateResult`, touching just one guest's row.

`GET /api/app-updates` (`src/web/routes/app-updates.ts`) filters rows by guest eligibility, recorded `app`, and caller visibility: see `src/web/CLAUDE.md` (app-updates route).

### Re-check after `update-app`

After a successful web/MCP `update-app` apply, the same job calls `checkOneGuest` for that guest and upserts its result, so the Update page's badge never claims an update is still available right after one was applied. A failed re-check is only `logWarn`ed; a non-zero script exit skips it. Full rules: see `src/operations/CLAUDE.md` (post-update re-check).

### CLI and limits

- `check-app-updates [--guest <name>] [--apply]` (`src/cli.ts`) is the manual/debugging path. Like every mutating command it is dry-run by default, but it still makes every live call (GitHub, the guest) a real apply would; `--apply` only gates writing `app_update_status`.
- Output is one line per guest sorted by name. Exit code is 0 even when individual guests report `error` (those are results, not command failures). A non-eligible `--guest` target (not an `lxc` guest, or no `app` recorded) fails outright with a named reason.
- Known limitation: only apps whose script uses this one `check_for_gh_release` mechanism are checked. Codeberg, GitLab, and package-repository-based updates all read as `unsupported`; covering them is out of scope.

## `backfill-guest-creators`

`src/commands/maintenance/backfill-guest-creators.ts` (#58) is a one-time, **CLI-only** migration that attributes a `creator` (see `src/web/CLAUDE.md`, per-resource group permissions) to a guest created before that field existed, by mining `data/jobs.sqlite3`'s job history rather than touching live infrastructure. CLI-only is deliberate, same reasoning as `convert-caddyfile`: a one-time operator migration with no ongoing use, and an `Operation` would expose a fleet-wide inventory rewrite to the web UI/MCP server for nothing.

`bellhop backfill-guest-creators [--map <old=new>]... [--apply]`, dry-run by default.

### Which jobs count

Only job rows whose `command` is `create-lxc`/`create-vm`/`install-app`/`deploy-vpn-gateway`, whose `status` is `success`, and whose `triggered_by_username` is non-null whose `triggered_via` is not `mcp` (MCP never records a creator; since #65 its jobs carry the real caller), and is neither the literal `mcp` (what MCP jobs were recorded under before #65) nor the synthetic local operator's username (`localOperatorUsername()`, `src/web/auth.ts`, `WEB_UI_LOCAL_USER`, default `local`, passed in as the run function's `localOperator` option). Never a failed/cancelled/interrupted job, never one with no recorded human triggerer.

### Matching

- From each candidate's `args_json` (the raw form input, secrets already redacted) it reads `host`, `mid`, and the guest's name (`hostname` for create-lxc/install-app, `name` for create-vm/deploy-vpn-gateway), derives the VMID with the same `resolveMid` every creation command uses, and matches a *current* inventory guest with that exact host+VMID+name. A guest whose name matches but whose host/VMID differs (a deleted-and-reused name) is not matched.
- When several successful jobs match the same guest, the newest wins and the rest are reported `superseded`.
- A guest that already has a creator is never touched (`already-has-creator`), so the command is safe to re-run.
- Each recorded creator's `since` is the matched job's `startedAt`, so its job lift covers that job and later ones only.

### Identity resolution

- The job's recorded login is resolved against `AuthentikClient.listUsers()` (which has a `uid` field for this) to attach the identity provider's stable uid alongside the username.
- Repeatable `--map old=new` flags translate a recorded login to its current one before that lookup, for a user renamed since the job ran. A name neither mapped nor found is skipped as `unknown-user`, naming the `--map` flag that would fix it.
- Requires Authentik configured (`authentikConfigured()`: the API URL and token settings, or their env overrides). Without it, it fails with the same "not configured" message the Users page gives, since a username-only record would silently reintroduce the rename problem the uid exists to solve.

### Output and apply

- Every run prints every guest it (would) update and every job it skipped with a reason, whether or not `--apply` was passed. Exit code is always 0; a skip is informational.
- `--apply` re-checks every planned update against the inventory reloaded just before writing. An update dropped there (its guest gained a creator, or left the inventory) moves from `updates` to `skipped` (`already-has-creator`/`no-matching-guest`), so the report lists only what was actually written.
