# Feature Specification: Run the web service as an LXC container

**Feature Branch**: `issue-67-lxc-container-installer`

**Created**: 2026-10-05

**Status**: Draft

**Input**: GitHub issue #67, "Run the web service as an LXC container, installed via a community-scripts installer in the ProxmoxVED fork", plus the design decisions recorded below.

## Background

Today the only supported way to run Bellhop's web service is as a Windows service (`scripts/windows-service.ts`). Every other service in the homelab runs as an LXC container on Proxmox, installed and updated by a community-scripts installer. This feature gives Bellhop the same: an installer in the operator's ProxmoxVED fork that creates a Bellhop container and updates it in place, plus the changes inside Bellhop that a container deployment needs.

The work spans two repositories:

- **The ProxmoxVED fork** holds the installer (`ct/bellhop.sh`, `install/bellhop-install.sh`, `json/bellhop.json`). It lives on a `bellhop` branch that is merged into the fork's `local` integration branch, the same way the fork's other app scripts are kept.
- **This repository** gains a guard that stops Bellhop from disrupting its own container, the documentation for the container deployment, and a deprecation notice on the Windows service.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Install Bellhop as a container (Priority: P1)

The operator runs the Bellhop installer on a Proxmox host, the way they install any community script. Without answering any questions beyond the standard container prompts (or none at all, in an unattended install), they end up with a running container whose web UI answers on its port. The installer finishes by showing the container's SSH public key and what to do with it.

**Why this priority**: this is the feature. Without it nothing else here matters.

**Independent Test**: run `ct/bellhop.sh` on a Proxmox host (or with `var_*` defaults, unattended), then open `http://<container-ip>:3000` and see the web UI. Run `bellhop --help` inside the container.

**Acceptance Scenarios**:

1. **Given** a Proxmox host with the fork's script source, **When** the operator runs the Bellhop installer with default settings, **Then** a container is created running the latest Bellhop release, the web service starts at boot and restarts if it crashes, and the web UI answers on port 3000.
2. **Given** an unattended install (all `var_*` values supplied), **When** the installer runs, **Then** it never stops for input and never asks for a secret.
3. **Given** a finished install, **When** the operator reads the installer's final output, **Then** it shows the web UI address, the container's SSH public key, and a pointer to the container documentation.
4. **Given** a finished install, **When** the operator runs `bellhop <command>` inside the container, **Then** the command runs against the same inventory database and data directory the web service uses.
5. **Given** a finished install, **When** the operator inspects the running service, **Then** it runs under systemd as root inside the unprivileged container, the convention for the fork's app scripts.

---

### User Story 2 - Update in place without losing data (Priority: P1)

When a new Bellhop release is published, the operator runs the script's update (inside the container, or from Bellhop's own update-app flow for other guests) and the container moves to the new release. The inventory, settings, secrets, job history and SSH key are untouched.

**Why this priority**: a container that cannot be updated safely is not a supported deployment.

**Independent Test**: install, add a host to the inventory and a setting, publish (or simulate) a newer release, run the update, and confirm the inventory, settings, job history and SSH key are unchanged and the new version is running.

**Acceptance Scenarios**:

1. **Given** a container on release N and a newer release N+1, **When** the update runs, **Then** the service stops, the application code is replaced by N+1, its dependencies and web client are rebuilt, and the service starts again.
2. **Given** a container already on the latest release, **When** the update runs, **Then** it reports that nothing needs updating and changes nothing.
3. **Given** any update, **When** it completes, **Then** the inventory database, the data directory (job history, logs, any env files) and the SSH key are byte-for-byte what they were before.
4. **Given** a container without a Bellhop installation, **When** the update runs, **Then** it stops with a "no installation found" error.

---

### User Story 3 - Bellhop refuses to disrupt its own container (Priority: P2)

Once Bellhop manages the Proxmox cluster from inside one of its guests, some actions on that guest would cut off the service performing them: updating its app, deleting it, migrating it, or shutting it down. Bellhop knows which guest is its own and refuses those actions on it, from every front end.

**Why this priority**: without it, a routine `update-all` or a misclick on the dashboard takes the web service down mid-job. It is not needed for the container to work, so it ranks below the install and update.

**Independent Test**: set the own-guest setting to a guest's name, then try each guarded action on that guest from the CLI, the web UI and the MCP server; each is refused with a message saying why, and `update-all` skips that guest.

**Acceptance Scenarios**:

1. **Given** the own-guest setting names guest `bellhop`, **When** the operator runs `update-app`, `delete-guest`, `migrate-guest`, or a guest power action (start or shutdown) against `bellhop`, with or without `--apply`, **Then** the command refuses before doing anything and the message names the setting and explains that the action would disrupt the running Bellhop service.
2. **Given** the same setting, **When** the same actions are attempted from the web UI or the MCP server, **Then** they are refused with the same message.
3. **Given** the same setting, **When** the operator runs `update-all` over a set of guests that includes `bellhop`, **Then** every other guest is processed and `bellhop` is reported as skipped, with the reason.
4. **Given** the setting is unset, **When** any of these actions run, **Then** they behave exactly as they do today.
5. **Given** a fresh container install, **When** the installer finishes, **Then** its final output gives the exact command that sets the setting to the container's hostname, and the first-run documentation includes that step right after the inventory import, so the guest is protected once `sync-inventory` adds it under that name.
6. **Given** the operator wants to change or clear the setting, **When** they use `set-config` or the Settings page, **Then** the new value takes effect for the next action.

---

### User Story 4 - The Windows service is marked deprecated (Priority: P3)

An operator still running Bellhop as a Windows service keeps it working, but learns that it is deprecated and where the container instructions are.

**Why this priority**: informational only; nothing breaks without it.

**Independent Test**: run `npm run service:install` (or read the docs) and see the deprecation notice naming the container documentation.

**Acceptance Scenarios**:

1. **Given** the Windows service script, **When** it runs `install` or `uninstall`, **Then** it prints a deprecation notice pointing to the container documentation, then does its job exactly as before.
2. **Given** the documentation, **When** an operator reads how to run the web service, **Then** the container is the recommended way and the Windows service is marked deprecated, with its removal tracked in #68.

---

### User Story 5 - Documented first run (Priority: P2)

A new container starts with no inventory. The documentation takes the operator from the installer's final output to a working, signed-in deployment: trust the container's SSH key on every host, import or build the inventory, set the integration settings, configure sign-in before exposing the UI, and know how updates and the own-guest guard work.

**Why this priority**: the install is not usable without these steps, and the installer deliberately does not prompt for any of them.

**Independent Test**: follow `docs/lxc-container.md` from a fresh container to a dashboard listing the operator's hosts, with no step missing.

**Acceptance Scenarios**:

1. **Given** a fresh container, **When** the operator follows the documentation, **Then** they can make every Proxmox host trust the container's key, create the inventory with `import-yaml-inventory` (into the container's data location), and run `sync-inventory` successfully.
2. **Given** the documentation, **When** the operator reads about network exposure, **Then** it states that no firewall rule is required because the web UI authenticates with its own sign-in, and that sign-in should be configured before the UI is reachable from untrusted networks.

### Edge Cases

- The installer is re-run against an existing container's data: the SSH key is generated only when none exists, and an existing inventory database is never overwritten.
- The own-guest setting names a guest that is not in the inventory: nothing is guarded (no matching guest), and nothing fails.
- The own-guest setting matches a guest name but the operator really means to update it: there is no override. The operator updates Bellhop's own container through the script's in-container update, or acts on it directly in Proxmox.
- A guest power action is "start" on Bellhop's own guest: refused as well. If Bellhop is running it is already started, so there is never a legitimate need, and one rule is simpler than two.
- `update-all` targets only Bellhop's own guest: it reports the guest as skipped and does nothing else.
- No GitHub release of Bellhop exists yet: the installer cannot deploy. Cutting the first release is a prerequisite (see Assumptions).
- The release's native module build fails (missing toolchain): the installer stops with the build error rather than starting a broken service.

## Requirements *(mandatory)*

### Functional Requirements

**Installer (ProxmoxVED fork)**

- **FR-001**: The fork MUST provide `ct/bellhop.sh`, `install/bellhop-install.sh` and `json/bellhop.json` that follow the fork's existing community-scripts conventions and build on the shared container build engine, so Bellhop is installable and updatable like the fork's other apps, including through Bellhop's own custom script source.
- **FR-002**: The default container MUST be Debian 13, unprivileged, with 2 CPU cores, 2048 MB RAM and an 8 GB disk, each overridable through the standard `var_*` variables.
- **FR-003**: The installer MUST install the Node version Bellhop's `engines` field requires (24) and the build toolchain its native SQLite module needs, deploy the latest published Bellhop release to the application directory, install its dependencies from the lockfile, and build the production web client.
- **FR-004**: The service MUST run as root inside an unprivileged container, following the fork's convention that app containers have no dedicated service user (its `AGENTS.md` anti-patterns 9 and 12). The issue asked for a dedicated user only "if practical", and the fork's rules settle that.
- **FR-005**: The inventory database and the data directory MUST live in the data location, outside the application directory, so an update that replaces the application directory never touches them. The service and the CLI MUST be pointed at them through Bellhop's existing inventory-path and data-directory environment variables.
- **FR-006**: The installer MUST generate an ed25519 SSH key for root when root has none, without prompting, and MUST print the public key at the end of the install with instructions to trust it on every Proxmox host.
- **FR-007**: The installer MUST register a system service that runs the web service on port 3000, starts at boot, and restarts on failure.
- **FR-008**: The installer MUST install a `bellhop` command inside the container that runs the CLI with the same environment as the service.
- **FR-009**: The installer's final output MUST give the exact command that records the container's hostname as Bellhop's own guest (FR-013), and the first-run documentation MUST include that step after the inventory import. The installer cannot set it itself: a fresh install has no inventory to write a setting into (an inventory needs a `domain`), and `import-yaml-inventory` replaces every setting with what the YAML file holds.
- **FR-010**: The installer MUST NOT prompt for anything beyond the standard container-creation prompts, and MUST NOT ask for or write any secret.
- **FR-011**: The script's update MUST check for a newer Bellhop release and, only if one exists, stop the service, replace the application directory with the new release, reinstall dependencies, rebuild the web client and start the service. It MUST NOT modify the data location.
- **FR-012**: The installer's final output MUST show the web UI address, the SSH public key, and a pointer to Bellhop's container documentation.

**Self-management guard (Bellhop)**

- **FR-013**: Bellhop MUST have a setting naming its own guest, stored with the other settings and settable through `set-config`, the Settings page and every other path that writes settings. It MUST be unset by default.
- **FR-014**: When the setting is set, `update-app`, `delete-guest`, `migrate-guest` and the guest power actions MUST refuse to act on the guest of that name, in a dry run as well as with `--apply`, before any remote call. The refusal MUST name the setting and say that the action would disrupt the running Bellhop service.
- **FR-015**: The refusal MUST be enforced in the shared command logic, so the CLI, the web UI and the MCP server refuse identically. There MUST be no override flag.
- **FR-016**: When the setting is set, `update-all` MUST skip the named guest, process every other targeted guest as before, and report the skipped guest with the reason.
- **FR-017**: When the setting is unset, or names no guest in the inventory, every command MUST behave exactly as before.

**Windows service and documentation (Bellhop)**

- **FR-018**: The Windows service script MUST print a deprecation notice pointing to the container documentation on every run, and otherwise behave exactly as before.
- **FR-019**: Bellhop MUST document the container deployment on its own documentation page covering: installing, where the data lives, trusting the SSH key, bootstrapping the inventory, setting up sign-in before exposure, updating, and the own-guest guard. The README MUST link it and present the container as the recommended way to run the web service, within the README's line budget.
- **FR-020**: The documentation MUST state that the container needs no firewall rule restricting who can reach the web UI, because the web UI authenticates with its own sign-in and trusts no identity headers.
- **FR-021**: Every documentation page that describes running the web service as a Windows service MUST mark it deprecated, with removal tracked in #68.

### Key Entities

- **Own-guest setting**: the inventory name of the guest Bellhop itself runs in. One optional value. Read by the guarded commands. Written by `set-config`, the Settings page, or a `bellhopGuest` key in the YAML file the inventory is imported from.
- **Data location**: the directory holding the inventory database, the data directory (job history, job logs, sessions, optional env files). Survives every update, as does root's SSH key.
- **Application directory**: the deployed release's code and built web client. Replaced on every update.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An operator can go from running the installer to a web UI answering in the browser with zero answers typed beyond the standard container prompts, and zero with an unattended install.
- **SC-002**: After an update, 100% of the inventory, settings, secrets, job history and the SSH key are unchanged.
- **SC-003**: Each of the five guarded actions (update-app, delete-guest, migrate-guest, start, shutdown) is refused for Bellhop's own guest in every front end that offers it, and `update-all` never acts on that guest.
- **SC-004**: With the own-guest setting unset, the full existing test suite passes unchanged.
- **SC-005**: An operator following only `docs/lxc-container.md` reaches a dashboard listing their own hosts without needing any other page, apart from the pages it links for sign-in and settings.

## Assumptions

- **A GitHub release exists before the installer is used.** The operator chose GitHub releases as what the installer deploys and updates to. No release exists yet, so cutting the first one (after this change merges) is a prerequisite and is not part of this feature.
- **The installer is not live-tested in this change.** Creating a real container is a change to real infrastructure, which the operator will run after the fork branch is pushed. Bellhop-side behavior is covered by automated tests.
- **The fork's `bellhop` branch is merged into its `local` branch** (the operator's integration branch) and both are pushed, following the fork's existing branch-per-app layout.
- **Data location is `/var/lib/bellhop`** and the application directory is `/opt/bellhop`, matching common Linux and community-scripts conventions.
- **No firewall rule.** Since #69 the web UI signs users in through its own OIDC client and never trusts identity headers, so the network address of the caller is no longer a security boundary.
- **The MCP server's second service unit is out of scope.** It waits on #65, which gives the MCP server a network transport. Until then the MCP server runs over stdio from wherever the operator's MCP client runs.
- **The Windows service is not removed here.** Removal is tracked in #68.
- **The own-guest mark is a setting, not a per-entry inventory flag.** The existing per-entry role flags (`proxy`, `authentik`) can only be set by importing a YAML file. A setting is editable from the CLI and the Settings page, and the installer can seed it. A guest is matched by name, which is how every other command addresses guests.
- **The container's hostname is the guest's inventory name.** `sync-inventory` names guests after their Proxmox hostname, and the installer's default hostname is the app name, so setting it to the hostname protects the guest once it is synced.
- **Upstreaming the installer to community-scripts is out of scope.**
