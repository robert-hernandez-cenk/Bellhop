# Implementation Plan: Run the web service as an LXC container

**Branch**: `issue-67-lxc-container-installer` | **Date**: 2026-10-05 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/067-lxc-container-installer/spec.md`

## Summary

Bellhop gets a Linux deployment: a community-scripts installer in the operator's ProxmoxVED fork creates a Debian 13 container. The container runs the latest Bellhop release as a systemd service (as root, the fork's convention), keeps all state in `/var/lib/bellhop` (pointed at through the existing `INVENTORY_FILE`/`WEB_DATA_DIR` variables), generates root's SSH key, and updates in place through build.func's release helpers.

Inside Bellhop, four changes:

- a `bellhopGuest` setting, plus a shared guard that makes `update-app`, `delete-guest`, `migrate-guest` and guest power refuse that guest, and makes `update-all` skip it;
- a fix to `bin/bellhop.js`, which only works from the repository root (research R5);
- a deprecation notice on the Windows service;
- a new `docs/lxc-container.md`, linked from the README.

## Technical Context

**Language/Version**: TypeScript on Node >= 24 (Bellhop); bash (community-scripts installer)

**Primary Dependencies**: existing only: zod, better-sqlite3, tsx; community-scripts `build.func` helpers (`setup_nodejs`, `fetch_and_deploy_gh_release`, `check_for_gh_release`)

**Storage**: the inventory SQLite database's `meta` table (one new setting row)

**Testing**: `node --test` with `FakeSSHClient` and temporary SQLite fixtures; `bash -n`/`shellcheck` for the fork scripts

**Target Platform**: Bellhop on Windows (dev) and Debian 13 LXC (new deployment target)

**Project Type**: CLI + web service + MCP server (one package), plus shell installer files in a second repository

**Performance Goals**: N/A

**Constraints**: the installer must be non-interactive and secret-free; an update must never touch `/var/lib/bellhop`; the guard must behave identically across CLI, web and MCP

**Scale/Scope**: one setting, one guard helper, five command touch points, one shim fix, one script notice, one new docs page plus small doc edits; three files in the fork

## Constitution Check

*Gate evaluated before Phase 0 and again after Phase 1.*

- **I. No real operational data**: pass. Docs and specs use `web-lxc`, `pve1`, `192.0.2.x` and placeholder keys. The fork scripts name only the public Bellhop repository and the author handle, both already public. The seeded `bellhopGuest` is the container's runtime hostname, never a committed value. There is no new operator-specific default.
- **II. Code quality**: pass. No remote path is added (the guard runs before `runRemote`). The setting is validated by zod in `SettingsSchema`. The guard lives in one place (`src/lib/bellhop-guest.ts`) and is not copied. Its error names the setting and how to change it.
- **III. Testing**: pass. Every behavior change gets tests with `FakeSSHClient` and temporary fixtures, and the shim fix gets a test that fails without it. No third-party fixture is needed. The fork installer cannot be exercised by `npm test`, and creating a real container is a real-infrastructure change the operator runs. It is recorded as unverified in the PR, in line with how `Ssh2SSHClient` changes are handled.
- **IV. UX consistency**: pass. The refusal applies in dry run and apply, and identically across front ends through the shared `run*` functions. There is no new flag. The Settings page change is verified at desktop and mobile widths. README, docs, CLAUDE.md and CONTRIBUTING are updated in the same change.

**Single-operator assumptions**: none introduced. The container hostname is read at install time, and the repository and owner names are the project's public identity. The docs note that the cluster-wide `authorized_keys` behavior is Proxmox's, not one deployment's.

Post-design re-check: unchanged, pass.

## Project Structure

### Documentation (this feature)

```text
specs/067-lxc-container-installer/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── self-guard.md
│   └── installer.md
└── tasks.md            # /speckit-tasks
```

### Source Code

```text
bin/bellhop.js                              # resolve tsx relative to the shim (R5)
scripts/windows-service.ts                  # deprecation notice (R9)
src/lib/inventory.ts                        # bellhopGuest in SettingsSchema
src/lib/bellhop-guest.ts                    # new: isBellhopGuest / assertNotBellhopGuest
src/commands/maintenance/update-app.ts      # guard
src/commands/maintenance/guest-power.ts     # guard
src/commands/maintenance/update-all.ts      # skip + skippedSelf
src/commands/provisioning/delete-guest.ts   # guard
src/commands/provisioning/migrate-guest.ts  # guard
src/operations/provisioning.ts              # delete-guest apply: guard before Authentik teardown
src/operations/maintenance.ts               # update-all preview names the skipped guest
web-client/src/api/types.ts                 # SettingsValues.bellhopGuest
web-client/src/lib/settings-display.ts      # General tab field
web-client/src/pages/SettingsPage.tsx       # label/help
docs/lxc-container.md                       # new
README.md, docs/configuration.md, docs/web-ui.md, docs/environment-variables.md,
docs/authentik.md, CONTRIBUTING.md, CLAUDE.md + nested CLAUDE.md files   # deployment/deprecation/setting mentions
test/...                                    # per quickstart.md

ProxmoxVED fork, branch `bellhop`:
ct/bellhop.sh
install/bellhop-install.sh
json/bellhop.json
```

**Structure Decision**: existing single-package layout. The guard is a `src/lib/` helper because it is infrastructure-level policy read by commands, not a web/MCP-only operation.

## Complexity Tracking

No violations.
