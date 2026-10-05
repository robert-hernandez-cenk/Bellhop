# Research: Run the web service as an LXC container

## R1. What the installer deploys

- **Decision**: the latest GitHub release of Bellhop, as a source tarball, through build.func's `fetch_and_deploy_gh_release "bellhop" "<owner>/Bellhop" "tarball"`. The update uses `check_for_gh_release` and `CLEAN_INSTALL=1 fetch_and_deploy_gh_release`.
- **Rationale**: the operator chose releases. It is the convention every other updatable community script follows: `check_for_gh_release` records the deployed version and makes the update a no-op when nothing is newer, so FR-011 and US2 scenario 2 come for free.
- **Alternatives considered**: tracking the newest `main` commit (works without a release, but needs a hand-rolled version check); a configurable ref (extra surface nobody asked for).
- **Consequence**: no release exists yet. The installer cannot deploy until the operator cuts one after this change merges. Recorded as a follow-up.

## R2. Node runtime and build

- **Decision**: `NODE_VERSION="24" setup_nodejs`, then `npm ci` and `npm run web:build` in `/opt/bellhop`. `build-essential` and `python3` are installed first, so `better-sqlite3` can compile from source when no prebuilt binary matches.
- **Rationale**: upstream Node 24 scripts (for example `install/chartdb-install.sh` on upstream `main`) use the same helper and sequence. `npm ci` installs dev dependencies too, which Bellhop needs at runtime: the server runs TypeScript through `tsx`, a dev dependency. `web-client` is an npm workspace, so the root `npm ci` covers it.
- **Alternatives considered**: `npm ci --omit=dev` (breaks `tsx` at runtime); moving `tsx` to dependencies (a packaging change with no other benefit here). `node-windows` has no `os` restriction in its manifest, so it installs harmlessly on Linux.
- **Note**: unlike chartdb, `node_modules` stays in place. The service runs from source.

## R3. Data location and environment

- **Decision**: data lives in `/var/lib/bellhop`. The inventory database is `/var/lib/bellhop/inventory/bellhop.db` and the data directory is `/var/lib/bellhop/data`. `/etc/default/bellhop` sets `PORT=3000`, `INVENTORY_FILE` and `WEB_DATA_DIR`. The systemd unit loads it with `EnvironmentFile=`, and the CLI wrapper sources it.
- **Rationale**: `src/lib/paths.ts` already honors `INVENTORY_FILE` and `WEB_DATA_DIR` for every entry point (CLI, web server, MCP server), so no code change is needed. Keeping data out of `/opt/bellhop` means `CLEAN_INSTALL=1` can wipe the application directory without a backup and restore step.
- **Alternatives considered**: keeping data in the checkout and using `create_backup`/`restore_backup` around the update (a window in which a failed update loses data); a new `BELLHOP_HOME` variable (duplicates two variables that already exist).

## R4. Service account and SSH identity

- **Decision**: a system user `bellhop` with home `/var/lib/bellhop` and shell `/bin/bash` (so the operator can `su` to it for debugging). The installer runs `ssh-keygen -t ed25519 -N "" -C bellhop@<hostname> -f /var/lib/bellhop/.ssh/id_ed25519` only if that file does not exist.
- **Rationale**: `resolvePrivateKey` (`src/lib/ssh-client.ts`) looks in `os.homedir()/.ssh/` for `id_ed25519` first, and `os.homedir()` is the account's home on Linux. With the home set to the data location, the default lookup finds the key without a per-host `ssh_identity_file`, and the key survives updates along with the rest of the data.
- **Host trust**: the docs tell the operator to append the printed public key to `/root/.ssh/authorized_keys` on a Proxmox host. In a Proxmox cluster that file is a symlink to the cluster-shared `/etc/pve/priv/authorized_keys`, so one append covers every node. `push-ssh-key` cannot bootstrap this, because it needs SSH access already.
- **Alternatives considered**: running as root, which is what most community scripts do (`User=root`), but the issue asks for a dedicated user where practical, and nothing Bellhop does locally needs root; having the operator supply a key (breaks unattended installs).

## R5. The `bellhop` CLI inside the container

- **Decision**: `/usr/local/bin/bellhop` is a small shell wrapper. It sources `/etc/default/bellhop` with `set -a`, then runs `node /opt/bellhop/bin/bellhop.js "$@"`, through `runuser -u bellhop --` when invoked as root.
- **Finding (bug)**: `bin/bellhop.js` spawns `node --import tsx <cli>`. Node resolves a bare `--import` specifier against the current working directory, so the shim fails with `ERR_MODULE_NOT_FOUND` when run from outside the repository. Reproduced on this branch by running the shim from a temp directory. This already breaks an `npm link`ed `bellhop` used outside the checkout.
- **Fix**: resolve `tsx` relative to the shim (`import.meta.resolve('tsx')`) and pass that URL to `--import`. The wrapper can then run from any directory, and relative path arguments still resolve against the caller's directory.
- **Alternatives considered**: `cd /opt/bellhop` in the wrapper (breaks relative path arguments such as `--yaml-path ./hosts.yaml`).

## R6. Network exposure and firewall

- **Decision**: no firewall rule in the container. The docs say sign-in (`webUiAuthMode oidc`) should be configured before the UI is reachable from an untrusted network.
- **Rationale**: since #69 the web UI is its own OIDC client and never reads `X-authentik-*` headers (`src/web/CLAUDE.md`), and the Windows rule lost its `remoteip=` scope for the same reason (`scripts/firewall-rule.ts`). The session cookie, not the caller's address, is the boundary. The issue's firewall concern predates #69.

## R7. The own-guest mark

- **Decision**: a new inventory-wide setting `bellhopGuest` (string, optional) in `SettingsSchema` (`src/lib/inventory.ts`), next to `nfsServer` and the others. It is stored as a `meta` row and is therefore editable through `set-config` (CLI and MCP `set_config`) and the Settings page's General tab.
- **Rationale**: the per-entry role flags (`proxy`, `authentik`) can only be set by a YAML import, and the installer cannot reach the operator's inventory entry for its own guest anyway. A setting is editable everywhere settings already are, and `set-config` can seed it. Guests are addressed by name everywhere else.
- **Seeding (revised during implementation, T011)**: the installer cannot seed the setting. Verified against a temporary database: on a fresh database, `set-config` fails with `Inventory validation: domain: String must contain at least 1 character(s)`, because an inventory with no `domain` is invalid. Once a database exists, a later `import-yaml-inventory --apply` replaces every setting with what the YAML holds, so a value set before the import is gone afterwards (the `meta` row was absent after re-import). Instead, the installer's final output prints `bellhop set-config bellhopGuest <hostname> --apply` with the hostname filled in, and `docs/lxc-container.md` puts that step right after the import, noting that a `bellhopGuest:` key in `hosts.yaml` works too, since the import reads settings from the file.
- **Alternatives considered**: a per-entry `bellhop: true` flag (no editor; validation for "at most one"); auto-detecting the guest by hostname at runtime (hostnames are not unique across a Windows dev machine and a guest, and an implicit match is surprising).

## R8. Where the guard is enforced

- **Decision**: one helper in `src/lib/` (`bellhop-guest.ts`): `isBellhopGuest(inventory, name)` and `assertNotBellhopGuest(inventory, name, action)`. The assert throws the refusal message. It is called first thing in `runUpdateApp`, `runDeleteGuest`, `runMigrateGuest` and `runGuestPower`, before any remote call or argument resolution that touches the network. The `delete-guest` operation's apply also calls it before its Authentik teardown, which runs before `runDeleteGuest` (same place as its existing `proxy: true` refusal). `runUpdateAll` filters the guest out of its targets and returns it in a new `skippedSelf` list. `formatUpdateAll` prints it only when non-empty, so existing output is unchanged. The `update-all` operation's preview names it as skipped.
- **Rationale**: CLI, web and MCP all reach these four `run*` functions through `src/operations/` or `src/cli.ts`, so one check per function covers every front end (FR-015). Routes that enqueue without a preview (`guest-power`) report the refusal as a failed job carrying the same message.
- **Message**: `Refusing to <action> '<name>': it is Bellhop's own guest (the bellhopGuest setting), and <action> would disrupt the running Bellhop service. Act on it in Proxmox directly, or update Bellhop with its own update script. If the setting names the wrong guest, change it with "bellhop set-config bellhopGuest <name> --apply" or on the Settings page.`

## R9. Windows service deprecation

- **Decision**: `scripts/windows-service.ts`'s `main()` prints the notice first on every run, before the elevation check (so it appears in the non-elevated console the operator is watching): `The Windows service is deprecated: run Bellhop as an LXC container instead (see docs/lxc-container.md). It will be removed in a future update (#68).`

## R10. Installer files in the fork

- **Decision**: three files on a new `bellhop` branch created from the fork's `main`, following the layout of `shelfarr` (the operator's most recent app branch). The branch is then merged into `local` and both are pushed. Author line `robert-hernandez-cenk`, `Source:` the Bellhop repository URL. `json/bellhop.json` uses category 0 or the closest category in the fork's category list, with `interface_port` 3000, `config_path` `/etc/default/bellhop`, and notes covering the SSH key, sign-in, and the data location.
- **Verification**: `bash -n` on both scripts, plus `shellcheck` if available. A live install is out of scope (spec Assumptions).
