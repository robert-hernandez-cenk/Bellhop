# Code review findings (open)

**Status**: blocked on #70 (first-run setup walkthrough). The operator decided that how a fresh install behaves before an inventory exists belongs to #70, so work on #67 stops until #70 closes. Nothing below is fixed yet. Resume from here: re-check each item against whatever #70 changed, then fix, test and update spec/research as needed.

The review covered `main...HEAD` (at 7d77cd7) and the fork commit 793c6986. Every item was verified by a separate pass, and most were reproduced.

## Decided by #70

1. **Fresh install crash-loops.** `install/bellhop-install.sh` starts `bellhop.service` (`enable --now`) before any inventory exists. `src/web/server.ts` `loadInventory` then fails `domain: String must contain at least 1 character(s)`, and `Restart=on-failure` restarts it every 5 s. The footer's `http://${IP}:3000` refuses connections until an inventory is imported, so spec US1 scenario 1 and SC-001 fail. Options weighed: a `ConditionPathExists=` on the database plus "import, then `systemctl start bellhop`", or a server that starts without an inventory and shows a first-run page.

## Open, to fix when resuming

2. **The guard misses reboot paths.** `set-guest-vpn` (`pct reboot`), `attach-nfs-mount` and `migrate-nfs-mount` (`src/lib/nfs.ts`) can reboot Bellhop's own guest and do not call `assertNotBellhopGuest`. Root CLAUDE.md says they are covered.
3. **Web/MCP update-app resolves the app source before refusing.** `previewAndEnqueue` (`src/operations/core.ts`) runs `resolveAppSource` first, so a GitHub error or rate limit masks the refusal and spends API calls. contracts/self-guard.md says the refusal comes first. Candidate fix: an operation-level `refusesBellhopGuest` checked at the top of `previewAndEnqueue`/`enqueueWithoutPreview`.
4. **No Go toolchain in the container.** `deploy-vpn-gateway` runs `go build` (`src/lib/go-build.ts`) after `pct create`, so in the container it fails and leaves an orphan gateway CT. Add `setup_go` to the installer, or document the limit.
5. **A failed update can't be retried.** `fetch_and_deploy_gh_release` records the new version before `npm ci`/`web:build` run. If either fails, the service stays stopped and a re-run reports "No update available". Candidate fix: build in a staging directory, swap, and drop the version file on failure.
6. **Footer prints the runtime hostname, not `$HN`.** With an FQDN hostname, `bellhopGuest` won't match the name sync-inventory uses, so the guard silently protects nothing.
7. **The CLI wrapper overrides per-call env.** It sources `/etc/default/bellhop` with `set -a`, clobbering `INVENTORY_FILE=... bellhop ...`, and parses as shell a file systemd reads as an `EnvironmentFile`. Candidate fix: a read loop that exports only unset keys, without shell evaluation.
8. **Shim test touches the checkout's real database.** `test/bin/bellhop-shim.test.ts` spawns the CLI without `INVENTORY_FILE`/`WEB_DATA_DIR`, so `importEnvFilesAndUseStore` writes to the checkout's `inventory/bellhop.db`. Use `test/cli.test.ts`'s `isolatedEnv()`.

### docs/lxc-container.md

9. **No install command.** The page never gives the command that installs the container. Running the update one-liner on a host fails, because `COMMUNITY_SCRIPTS_URL` must point at the fork (fork `docs/guides/source-origin.md`).
10. **No migration path from the Windows service.** The page only covers a fresh start. Following it, permission rules, secrets, schedules and job history are lost. With no permission rules, every group is unrestricted, which is an authorization leak. Add: stop the old service, copy `bellhop.db` (+`-wal`/`-shm`) and `data/` into `/var/lib/bellhop`, and skip the import.
11. **The MCP claim is wrong.** The page says the guard applies to the MCP server alike, but the MCP server runs elsewhere against its own checkout's database, which has no `bellhopGuest`. Document running the MCP server inside the container over SSH, and fix docs/mcp-server.md's job-history claim.
12. **DHCP address.** The default `ip=dhcp` makes sync-inventory store `ip: dhcp`, and proxy routes to `dhcp:3000` break sign-in setup. Tell the operator to give the container a static IP.
13. **Bootstrapping `hosts.yaml`.** The schema requires `guests:`, and the example's guests reference the example hosts. Tell the operator to keep `guests: []`.
14. **docs/commands.md and the operation descriptions are stale.** They still describe update-all and the guarded commands without the skip/refusal, and nothing says how Bellhop's own container gets OS updates (`apt` inside it).
15. **Root CLAUDE.md overstates the deployment.** It says the web service "is deployed as an LXC container", but no release exists and the Windows service is what runs today. Reword it as "can be deployed (recommended)".

### Lower severity

- The comment at `src/lib/inventory.ts` (`bellhopGuest`) still says the installer seeds it.
- The update-all skip is computed in both `runUpdateAll` and the preview. Share one helper, per src/lib/CLAUDE.md's "Only `selectUpdateTargets`" rule.
- The update-all preview prints "nothing" for an empty selection, while apply throws "No targets matched". Make the preview throw too.
- The refusal hand-writes its fix text instead of using `settingFix`.
- `bin/bellhop.js` forwards no signals and turns a child killed by a signal into a plain exit 1 (pre-existing).

## Already shipped outside this branch

The fork's `bellhop` branch (793c6986) is merged into its `local` branch (01cd2e54) and pushed. It is not installable yet, because Bellhop has no GitHub release. Findings 1, 4, 5, 6, 7 and 9 apply to it.
