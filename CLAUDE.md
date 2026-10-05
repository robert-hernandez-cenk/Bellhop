# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository. It is always loaded; subsystem detail lives in nested `CLAUDE.md` files (see "Architecture map") that load automatically when a file in that directory is read.

"`CLAUDE.md`" in the constitution, `CONTRIBUTING.md` and the PR template means this file plus the nested ones. A convention or architecture change updates whichever file describes it; a new subsystem-specific detail goes in the nested file for its directory, not here.

## Commands

```bash
npm run typecheck   # tsc --noEmit — run after editing any TypeScript file
npm test            # node's built-in test runner, all *.test.ts under test/
```

Run any command from the repo root as `npm run bellhop -- <command> [flags]` (or `bellhop <command> [flags]` once `npm link` has been run once to expose the `bellhop` bin globally). Provisioning and networking commands default to a dry run that only prints what they would do; pass `--apply` to actually execute.

### Testing

- **Real CLI against a fixture**: override `INVENTORY_FILE` to point at a temp SQLite fixture rather than the real `inventory/bellhop.db` (`inventoryPath()` in `src/cli.ts` honors it, defaulting to `inventory/bellhop.db`). Build one with `saveInventory(tempPath, inv)` (a `mkdtempSync`'d directory plus a `bellhop.db` filename — see any file under `test/commands/` or `test/web/routes/`), or with `npm run demo:seed -- <tempPath>` for one seeded from the demo inventory (`scripts/demo/seed-db.ts`).
- **Command logic**: inject a `FakeSSHClient` (`test/support/fake-ssh-client.ts`) as the command's `ssh` dependency — built with a `(sshTarget, sshUser, command) => ExecResult` responder, passed as `ssh` in the function's `deps` — and assert on `ssh.history` and the return value. Never mock `ssh`/`pct`/`qm` binaries on `PATH`: remote execution goes through the `ssh2` npm library, so there is no `PATH`-binary layer to mock.
- **The one local-`sh` exception**: a file-configured proxy driver's generated shell script (`src/lib/proxy/file-driver.ts`) may be executed locally under `sh` with that proxy's own binaries (e.g. `caddy`, `systemctl`) stubbed on `PATH`, to prove its backup/restore control flow actually restores — see `test/lib/proxy/file-driver.test.ts`. The SSH/exec layer itself stays `FakeSSHClient`-only.
- `src/lib/ssh-client.ts`'s `Ssh2SSHClient` is the only file that actually opens an SSH connection; it has no automated test (verify it manually against real infrastructure). Every other file is covered by `npm test`.

## Architecture map

Every command imports from `src/lib/`, the single place that knows how to reach a target and the only code that talks to `ssh2` directly. Nested guidance files:

| File | Covers |
|---|---|
| `src/lib/CLAUDE.md` | Inventory schema and validation, the SQLite read/write path (`sortInventoryForFile`, migrations), target resolution and `Ssh2SSHClient`, Machine ID, `update-all` targeting and package-manager detection, TLS-backend probing, Proxmox ACLs for VM creators, the Settings store/config accessor, and the cluster note |
| `src/lib/proxy/CLAUDE.md` | The reverse-proxy driver interface, `sync-proxy`/`runSyncProxy`: `buildRoutes`/`buildProxyContext`, `getDriver`/`driverDeps`, the `none` driver, capability enforcement, `fileDriver` |
| `src/lib/proxy/drivers/CLAUDE.md` | Each shipped driver: Caddy, Caddy admin API (incl. `convert-caddyfile`), nginx, Nginx Proxy Manager, HAProxy, Traefik |
| `src/commands/networking/CLAUDE.md` | `sync-authentik` (forward and OIDC reconcile, mobile consent), OIDC credentials/adoption, `prune-acme-challenges`, `render-status-page` |
| `src/commands/provisioning/CLAUDE.md` | `install-app`/`update-app`, script catalog and custom script sources, `attach-nfs-mount`, `migrate-nfs-mount`, `migrate-guest`, VPN gateway deploy credentials |
| `src/commands/maintenance/CLAUDE.md` | `sync-inventory`, `audit-nfs-mounts`, `check-app-updates`, `backfill-guest-creators` |
| `src/operations/CLAUDE.md` | The shared `Operation` layer used by web and MCP, `previewAndEnqueue`, `commitGuestEdit` |
| `src/web/CLAUDE.md` | Web server: inventory reload, Web UI authentication, users/groups, per-resource permissions and creator access, impersonation, `syncProxyLive`, Settings page API |
| `src/web/jobs/CLAUDE.md` | Job runner, prompt relay and detection tiers, cross-process job watching and control |
| `src/web/tasks/CLAUDE.md` | The daily task scheduler and `task_schedules` |
| `src/mcp/CLAUDE.md` | MCP server tools, `wait_for_job` elicitation, job ownership |
| `web-client/CLAUDE.md` | React client: responsive layout, theming, field help, Advanced modal, Settings page UI |

Mental model: `inventory/bellhop.db` is a gitignored SQLite database of Proxmox hosts, their LXC/VM guests, and external sites, validated by the zod schema in `src/lib/inventory.ts`. A guest has no SSH login of its own and is always reached via its parent host. At most one entry has `proxy: true` (where the reverse proxy runs), and exactly one proxy driver is active per deployment (`proxyDriver`). Authentik gating is per entry via `authGroup`, one rung of an ordered group ladder; `effectiveAuth()` says whether an entry is ungated, forward-auth gated, or OIDC gated. Web UI and MCP actions share `src/operations/`; the CLI does not. The web UI signs users in through its own OIDC client against Authentik (`src/web/login/`) and trusts no identity headers. Settings and secrets live in one store, always read through `src/lib/config.ts`.

## Rules that apply everywhere

**runRemote is the only remote path.** `runRemote` (`src/lib/targets.ts`) is the only function that executes something remote, and `Ssh2SSHClient` is the only file that opens an SSH connection. Every command goes through them.

**POSIX sh to guests.** Every command `runRemote` sends to an `lxc`/`vm` guest is wrapped as `sh -c ${shellQuote(cmd)}`, because `pct exec`/`qm guest exec` don't invoke a shell. It is `sh`, not `bash`, because a default Alpine container has only busybox ash — so these commands must be POSIX sh: no `[[ ]]`, `<<<`, arrays, or `pipefail`. The `pve` branch hands the command straight to `ssh.exec`, which runs it in the host's own login shell (bash on Proxmox), so a host-targeted command is not bound by this. Documented exceptions:
- `deploy-vpn-gateway` builds its own `pct exec <vmid> -- bash -c '...'` calls rather than using `runRemote`, because it creates its own Debian container and `apt-get install`s into it.
- `update-app` sends `bash -c "$(curl ...)"` *as* its command to a guest: the outer wrapper is still `sh -c`; the inner `bash` is deliberate because community-scripts require it.
- `install-app` runs the same `bash -c "$(curl ...)"` against a `pve` host, so it takes the direct-SSH branch.

A new exception is recorded here (constitution Principle II).

**Dry-run convention.** Anything that mutates infrastructure or the inventory (`create-lxc`, `create-vm`, `configure-guest`, `sync-proxy`, `migrate-nfs-mount`, `attach-nfs-mount`, `sync-inventory`) prints what it would do and only executes with `--apply`. `create-lxc`/`create-vm`/`configure-guest` use the shared `confirmOrDryRun` (`src/lib/dry-run.ts`); `sync-proxy`/`migrate-nfs-mount`/`attach-nfs-mount` hand-roll the check because they return a multi-line block/script for the CLI to print. `sync-inventory` always computes and prints its new/updated/removed summary and only gates the write; `check-app-updates` always runs the real check and only gates writing `app_update_status`. Some dry runs are not fully local, so the preview is provably identical to what apply sends:
- `create-lxc` and `install-app` read the target host's `authorized_keys` (`readHostAuthorizedKeys`) on every dry run;
- NFS options make a live `pvesh get /storage/<id>` call (`resolveNfsMountPath`);
- `configure-guest --packages` probes the guest's package manager (`detectPackageManager`); `--ssh-key` alone makes no remote call;
- `check-app-updates` makes every live call (GitHub, the guest) a real run would.

**Inventory writes are a full replace, sorted.** `saveInventory` deletes and re-inserts every inventory row in one transaction, and `sortInventoryForFile` gives a deterministic order on both load and save (which is what makes `sync-inventory --apply` idempotent). Tables outside that set (permissions, script catalog, schedules, secrets) are never touched by it. Detail in `src/lib/CLAUDE.md`.

**Secrets never leave the settings store.** A secret is never in an API response, log line, job record, error message, status page, inventory snapshot, or MCP tool response — errors name the key, never the value. `set-config` takes a secret only from `--stdin` or a no-echo prompt and refuses it as an argument. Secrets are plain text in `bellhop.db` (write-only, not encrypted at rest).

**Web UI authorization is a correctness requirement.** A restricted web user must not be able to see or act on what an admin has blocked them from; a leak past that boundary is a bug fixed with the same rigor as any other (see "Project philosophy").

**Record single-operator assumptions.** A branch that introduces, fixes, or invalidates something that only holds for one deployment's topology — a hardcoded literal, an assumption about how many hosts or operators exist — says so in the branch, so the project's record of those assumptions stays true. They are recorded in the nested file for the subsystem, under a "Single-operator assumptions" heading or note.

**Example data only.** Tracked files (code, docs, specs, screenshots) use example values only — never real hostnames, domains, IPs, or credentials (constitution Principle I).

## Project philosophy

This toolkit is for the user's own personal homelab — they are the sole operator and author of the inventory (`inventory/bellhop.db`); there is no other user or attacker in this threat model for the CLI or the inventory data model itself. Validation is still worth adding when it also catches typos/misconfiguration (e.g. rejecting a non-numeric `vmid`), but don't add effort or complexity purely to defend against a hypothetical malicious operator or attacker-controlled inventory. Favor simplicity and functional correctness over security-hardening-for-its-own-sake.

This does not extend to the web UI: once a second, less-trusted user exists there (user/group management, per-resource permissions), correct authorization enforcement for that real co-user is in scope and worth real effort — not defended against a malicious external attacker, but a restricted user genuinely should not be able to see or act on what an admin has blocked, and bugs that leak past that boundary are fixed with the same rigor as any other correctness bug.

## Workflow conventions

- **Infra changes are sequenced real-world-first.** `inventory/bellhop.db` is a live pointer commands use to reach hosts (`ssh_target`, etc.). For any real infrastructure change (host IP, storage move, cluster topology), do the real change first, and only edit the inventory (`sync-inventory --apply`, `set-config`, the Dashboard, or `bellhop.db` directly) and docs once the user confirms it landed. Editing ahead makes commands try to reach a host that isn't there yet and leaves the repo describing infrastructure that doesn't exist.
- **New branches are git worktrees, created at the start of work on an issue — before brainstorming, not deferred until implementation.** Use `git worktree add` (or the `superpowers:using-git-worktrees` skill), never `git checkout -b` in the main working directory, even for small tasks — switching branches in place disrupts other work or a long-running process (a running `npm run web:dev`) pinned to that checkout.
  - Make every change in the worktree itself, never in the main checkout with files copied over afterward.
  - **Never move the Claude session into a worktree.** Changing the session's working directory (`cd`, `Set-Location`) into one corrupts sessions: the primary directory drifts and later commands (a `specify extension add`, say) land in the wrong checkout. Reach the worktree by absolute path — Read/Edit/Write with full paths, `git -C <worktree>`, `npm --prefix <worktree>`. A tool that can only resolve the repo from its current directory (Spec Kit's PowerShell scripts) runs in a one-command subshell, `(cd <worktree> && <cmd>)`.
  - Any specification, plan or task list for an issue belongs on that issue's branch, committed like any other change, and follows constitution Principle I. A design note that genuinely needs real values does not belong in the repository at all — keep it gitignored or outside it.
  - **A fresh worktree has neither an inventory database nor a `data/` directory** (`data/` is gitignored whole; `inventory/bellhop.db` is gitignored within the tracked `inventory/`). Copy `inventory/bellhop.db` plus its `-wal`/`-shm` sidecars from the operator's deployment checkout (the one the web service runs from); since the settings store holds every setting and secret, that alone reaches the same Authentik/Cloudflare/NPM/GitHub. Copy `data/authentik.env`, `data/cloudflare-api.env` or `data/nginx-proxy-manager.env` too (`mkdir -p` the worktree's `data/` first) only while the deployment checkout still has them — they act as environment overrides there. (Retiring them: confirm each pinned field's "Stored copy" on the Settings page, delete the files, restart the web service and any long-running MCP server — see "Moving off the data/*.env files" in `docs/configuration.md`.) **Never seed from the main checkout**: it holds no real data, so running it shows what a fresh clone would. The deployment checkout is the only authoritative copy (any other checkout's database is a snapshot that drifts from it); its location is operator-specific and deliberately not recorded here. Without the database, CLI commands and the web UI operate on stale/wrong hosts and `AuthentikClient` falls back to `UnconfiguredAuthentikClient`.
- **Whenever superpowers is invoked on an issue, make sure the issue is assigned to the person doing the work first.** Check with `gh issue view <number> --json assignees`; assign with `gh issue edit <number> --add-assignee <user>`.
- **Once a worktree exists for the branch, never pass `isolation: "worktree"` on an `Agent` dispatch for that branch's work.** It silently creates a second, separate worktree, risking an implementer's commits landing off the tracked branch. Dispatch a plain `Agent` call and point it at the existing worktree path in the prompt ("Work from: `<worktree-path>`").
- **Commit and push freely.** Personal, single-operator repo: once a change is verified (typecheck/tests/live check as appropriate), commit and push without a separate confirmation round-trip. Still surface what was committed/pushed in the summary.
- **Finishing a branch: use the `finishing-a-development-branch` skill's standard push-and-PR flow, targeting `main`, with no custom process layered on top.** Push and open a PR against `main` (check `gh pr list --head <branch>` first; run `gh pr create` only if none exists — otherwise just push). Never choose the skill's "merge locally" option.
  - Local `main` stays in sync with `origin/main` by a **fast-forward-only pull** (`git fetch origin main && git merge --ff-only origin/main`, or `git pull --ff-only`) — never a local merge into `main`, never followed by a push. If `--ff-only` fails, local `main` has commits `origin/main` lacks (a policy violation) — stop and investigate rather than forcing past it.
  - Leave the worktree and local branch alone once the PR is open, until it actually closes on GitHub. Cleanup is always a separate, explicit action (when asked, or after confirming with `gh pr view <branch-or-number> --json state,mergedAt` that it merged) — never automatic after pushing or merging.
- **A branch that changes a single-operator assumption records it** (see "Rules that apply everywhere").
- **`CONTRIBUTING.md` restates contributor-facing rules — keep it in sync.** It summarizes the constitution and README for outside contributors (dry-run convention, `FakeSSHClient` testing, example data only, the three CI checks, branch-per-issue-via-PR). A change to any convention it restates updates it in the same change, as with README/CLAUDE.md.
- **User documentation is split between `README.md` and `docs/`.** The README is the newcomer's page — intro, prerequisites, quickstart, a main-commands table, a documentation index — and must stay within 200 lines; reference material lives in `docs/` (one page per topic, one per proxy driver under `docs/reverse-proxy/`). A behavior change updates whichever page describes it. `test/docs/links.test.ts` (part of `npm test`) enforces the README line budget and a 250-line budget for this root `CLAUDE.md` (subsystem detail goes in the nested file instead), and fails on any relative link or heading anchor that doesn't resolve in `README.md`, `CONTRIBUTING.md`, `docs/`, this file, or a nested `CLAUDE.md` under `src/`/`web-client/` — so renaming a heading updates the links to it in the same change.
- **The demo instance (`scripts/demo/`) regenerates screenshots.** `npm run demo` is a throwaway 127.0.0.1:3100 instance with example inventory, simulated Proxmox via `DemoSSHClient`, a fixed app catalog, seeded jobs, and a signed-in admin — never touching the real `inventory/bellhop.db` or `data/`. `npm run docs:screenshots` regenerates `docs/images/` through installed Chrome/Edge (`playwright-core`, no bundled browser; not in CI). A UI change that alters a screenshotted screen regenerates the images and verifies them by eye for example-only values (Principle I applies to screenshots). `test/scripts/demo/demo-inventory.test.ts` enforces the example-data invariant. Design: `specs/014-web-ui-screenshots/`.
- **GitHub operations go through the `gh` CLI, not the GitHub MCP tools.** The GitHub MCP server's token is not reliably scoped to this repository (`mcp__github__*` calls return 404/422); `gh` is authenticated with proper access.
- **Mobile is a first-class target for the web UI.** Any UI/frontend change is verified in a browser at both a desktop-width and a mobile-width viewport (≤640px, the CSS breakpoint in `web-client/src/index.css`) before it's reported complete — a change that only looks right on desktop is not done (desktop-only verification once shipped several mobile layout breaks on the Users/Groups page).

## Development environment notes (Windows)

- **Verifying a process is actually stopped needs PowerShell, not bash.** `concurrently`, `npm --prefix`, and Node's per-file test-isolation workers are spawned through `npm.cmd`/`cmd.exe` shim chains that produce real Windows process trees git-bash's `ps`/`kill` doesn't reliably see or terminate. Kill a Windows-spawned node tree with `taskkill /PID <pid> /T /F`. Before reporting a server/test process stopped, confirm with `Get-Process -Name node` and `Get-NetTCPConnection -State Listen` on the relevant port — don't trust bash `ps` alone.
- **Kill background dev servers/shells by PID once done with them** — don't leave orphaned processes. Match the specific PID (by start time or port ownership) rather than a broad `taskkill /IM node.exe`, and verify the tree is actually gone, not just that the stop call returned success.
- **Never kill Chrome by image name** (`taskkill //F //IM chrome.exe`) when cleaning up a headless test instance — the user runs their own Chrome windows on this machine. Capture the headless instance's PID at launch and kill only that PID.
