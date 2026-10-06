# Feature Specification: First-run setup, reverse-proxy step

**Feature Branch**: `issue-87-setup-reverse-proxy-step`

**Created**: 2026-10-05

**Status**: Draft

**Input**: GitHub issue #87, part of #70 (first-run setup walkthrough). Builds on #86 (merged into `issue-70-first-run-setup`), which added the walkthrough, its setup token, saved progress, the Proxmox step, the domain-and-basics step and Finish. After those two steps a new install still has no reverse proxy configured. This part adds step 3: configure an **existing** proxy. Installing a new proxy with `install-app` is #90; reviewing an existing proxy's hand-written routes is #91.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Point Bellhop at an existing proxy (Priority: P1)

After the Proxmox and basics steps, the operator opens the reverse-proxy step. They choose which proxy they run (Caddy, Caddy admin API, nginx, Nginx Proxy Manager, HAProxy, Traefik) and pick the inventory host or guest it runs on. They fill in the driver's settings (for example the config path, or Nginx Proxy Manager's URL, email and password). Bellhop saves the driver choice, marks the chosen entry as the proxy, and stores any password as a write-only secret.

**Why this priority**: Every later part of #70 (Authentik, Bellhop's own address) needs a working proxy configuration. This is the core of the step.

**Independent Test**: With a fixture inventory holding one host and one guest, choose a driver and entry, save, and confirm the setting, the proxy flag and the secret are stored, and that reading the step back reveals only whether each secret is set.

**Acceptance Scenarios**:

1. **Given** the step opens, **When** it lists drivers, **Then** it offers every registered driver, including "No proxy", with each driver's label.
2. **Given** a driver other than "No proxy", **When** the operator picks an inventory entry and saves, **Then** exactly that entry is marked as the proxy and no other entry is.
3. **Given** another entry already holds the proxy flag, **When** the operator picks a different entry, **Then** the flag moves and the previous holder loses it.
4. **Given** a driver that takes its own settings (config path, Traefik certificate resolver and API URL, Nginx Proxy Manager URL, email and password), **When** the operator saves, **Then** the fields that driver uses are shown and saved, validated by the same rules as `set-config` and the Settings page; an invalid value is refused with the field named.
5. **Given** a secret field (the Nginx Proxy Manager password), **When** it is saved, **Then** it goes into the settings store as a write-only value, and no response, log line or error message ever contains it; the step shows only "set" or "not set" and leaves the stored value alone when the field is left blank.
6. **Given** the entry list, **When** the operator has no host or guest to choose, **Then** the step says the proxy must be an entry from step 1's inventory and points back to it.

---

### User Story 2 - Choose how certificates are obtained (Priority: P1)

In the same step the operator picks the certificate source: DNS-01 with a Cloudflare token, HTTP-01 (Let's Encrypt), self-signed, an existing certificate and key on the proxy host, or managed outside Bellhop. Only the sources the chosen driver can serve are offered, with the driver's default marked. The fields each source needs appear (the Cloudflare token for DNS-01; certificate and key paths for existing files).

**Why this priority**: A proxy that cannot get certificates cannot serve Bellhop or anything else over HTTPS, and the choice depends on the driver, so it belongs in the same step.

**Independent Test**: For each driver, confirm the offered sources equal what the driver supports, that each source's fields are required and validated, and that the Cloudflare token is stored write-only.

**Acceptance Scenarios**:

1. **Given** a driver, **When** the operator opens the certificate choice, **Then** only that driver's supported sources are offered and its default is preselected.
2. **Given** DNS-01 with Cloudflare, **When** the operator saves, **Then** the Cloudflare token is required (unless one is already stored) and stored write-only.
3. **Given** existing files, **When** the operator saves, **Then** the certificate and key paths are required and must be absolute paths.
4. **Given** the operator changes the driver after choosing a certificate source the new driver cannot serve, **When** they save, **Then** the save is refused naming the unsupported source and the sources the driver does support.
5. **Given** "No proxy", **When** the step is shown, **Then** no certificate fields are offered.

---

### User Story 3 - Prove the proxy before moving on (Priority: P1)

Before the step completes, the operator runs a check. Bellhop looks at the proxy without changing it: it confirms the driver's configuration is present and valid (or, for API-managed proxies, that the API answers and accepts the credentials). When the check passes, the step shows what the first `sync-proxy` would write, exactly as `sync-proxy`'s dry run prints it, and the step is complete. Nothing is written to the proxy in this step.

**Why this priority**: The issue requires the proxy to validate before the step completes, and the preview lets the operator see the consequences of enabling management before anything happens.

**Independent Test**: With a simulated proxy host, run the check for a passing and a failing configuration for each driver, and confirm a pass shows the dry-run preview and completes the step, a failure shows an actionable error and does not, and the simulated host recorded no write.

**Acceptance Scenarios**:

1. **Given** a file-configured driver, **When** the check runs, **Then** it confirms the configuration file exists on the proxy host and passes the driver's own validation command, without writing, restoring or reloading anything.
2. **Given** Traefik with an API URL set, **When** the check runs, **Then** it confirms the API answers; with no API URL set, it checks the configuration directory is present.
3. **Given** the Caddy admin API driver, **When** the check runs, **Then** it confirms the admin endpoint answers from the proxy host.
4. **Given** Nginx Proxy Manager, **When** the check runs, **Then** it signs in with the saved URL, email and password and reports success or the reason it failed.
5. **Given** a failing check, **When** it finishes, **Then** the step shows an actionable error in the same "how to fix it" style used elsewhere, names the setting to change where one applies, and stays incomplete.
6. **Given** a passing check, **When** it finishes, **Then** the step shows the dry-run output of `sync-proxy` for the current inventory and marks the step complete.
7. **Given** a passing check but a preview that cannot be built because the inventory is not ready, **When** it finishes, **Then** the step reports that reason and does not mark the step complete, since the operator could not see what the first sync would do.
8. **Given** "No proxy", **When** the operator saves, **Then** the step completes with no check and says Bellhop will manage no proxy.

---

### User Story 4 - Re-run and resume safely (Priority: P2)

The operator can leave the step and return, change any choice, and re-run the check. Progress is saved, and an interrupted walkthrough reopens with the step's saved values (secrets shown only as set or not set). Finish requires this step to be complete.

**Why this priority**: Matches the walkthrough's resumable, idempotent behavior from #86; a step that is not safe to repeat would make mistakes costly.

**Independent Test**: Complete the step, reopen the walkthrough, change the driver, and confirm the saved values are shown, the step is marked incomplete until the new choice passes its check, and Finish refuses until then.

**Acceptance Scenarios**:

1. **Given** a completed step, **When** the walkthrough is reopened, **Then** the step shows its saved driver, entry and settings, with secrets as set or not set.
2. **Given** a completed step, **When** the operator changes the driver, the entry or any proxy or certificate setting and saves, **Then** the step is no longer complete until the check passes again (or "No proxy" is saved).
3. **Given** the step is incomplete, **When** the operator tries to finish, **Then** finishing is refused naming this step.
4. **Given** the operator repeats a save with the same values, **Then** nothing changes and nothing is duplicated.

### Edge Cases

- The chosen entry is a guest that is stopped or a host Bellhop cannot reach: the check reports that it could not connect, naming the entry, and the step stays incomplete.
- The config path does not exist on the proxy host: the check says so and names the setting that controls the path.
- The proxy's own validation reports a problem in its existing, hand-written configuration: that output is shown as the failure, and the step stays incomplete (adopting hand-written routes is #91).
- A secret is left blank on a later save: the stored secret is kept.
- A setting is pinned by an environment variable (an upgraded deployment): the save is refused the same way the Settings page refuses it. A fresh install has none.
- Switching the driver leaves settings that belong to another driver in place; they are not shown or used.
- Two tabs save at once: the last save wins, with at most one proxy entry at any time.

## Requirements *(mandatory)*

### Functional Requirements

**Choosing the proxy**

- **FR-001**: The system MUST offer a reverse-proxy step after the domain-and-basics step and before Finish, and Finish MUST be refused while it is incomplete.
- **FR-002**: The step MUST let the operator choose any registered proxy driver, including "No proxy", showing each driver's label.
- **FR-003**: For every driver except "No proxy", the step MUST require an inventory host or guest to be chosen and MUST mark that entry as the proxy. At most one entry holds the proxy flag after any save; saving a different entry moves it.
- **FR-004**: The step MUST show and save the settings the chosen driver uses (config path; certificate resolver and API URL for Traefik; API URL, email and password for Nginx Proxy Manager) and no others, validating them with the same rules as `set-config` and the Settings page and naming the field on a failure.
- **FR-005**: Secret values (the Nginx Proxy Manager password, the Cloudflare token) MUST be stored only in the settings store as write-only values. They MUST NOT appear in any response, log line, error message, job record or saved inventory; the step MUST show only whether each is set, and a blank secret field on save MUST leave the stored value unchanged.

**Certificates**

- **FR-006**: The step MUST offer the certificate sources the chosen driver supports, preselect the driver's default, and show the fields each source needs: the Cloudflare token for DNS-01, an absolute certificate path and key path for existing files.
- **FR-007**: A save that would leave a certificate source the driver cannot serve MUST be refused, naming the source and the supported ones. No certificate choice is offered under "No proxy".

**Checking and previewing**

- **FR-008**: Each proxy driver MUST be able to run a read-only check of the live proxy that makes no change to it: no file is written, backed up, restored or reloaded, and no route is created or changed.
- **FR-009**: For a file-configured driver the check MUST confirm the configuration file is present on the proxy host and passes that driver's own validation of the live configuration. For Traefik it MUST confirm its API answers when an API URL is set and otherwise that the configuration location exists. For the Caddy admin API driver it MUST confirm the admin endpoint answers. For Nginx Proxy Manager it MUST sign in with the saved credentials.
- **FR-010**: A failing check MUST report an actionable error naming the entry or setting to fix, and MUST leave the step incomplete. A secret value MUST NOT appear in it.
- **FR-011**: After a passing check the step MUST show the output `sync-proxy`'s dry run produces for the current inventory, and MUST mark the step complete. Nothing is written to the proxy at any point in the step.
- **FR-012**: "No proxy" MUST complete the step on save with no check, stating that Bellhop will manage no proxy.

**Progress**

- **FR-013**: The step MUST be marked complete only by a passing check (or by saving "No proxy"), and MUST become incomplete again when the driver, the proxy entry or any proxy or certificate setting changes.
- **FR-014**: The step MUST show its saved values when reopened, and every action in it MUST be safe to repeat.
- **FR-015**: Every action in the step MUST be available only with the setup authorization from #86 and only while setup is pending.

**Cross-cutting**

- **FR-016**: The step MUST work at desktop and mobile (≤640px) widths.
- **FR-017**: All remote work MUST go through the existing remote-execution layer and the existing Nginx Proxy Manager client; the step adds no new transport.
- **FR-018**: User documentation and the nested CLAUDE.md files that describe the walkthrough and the proxy driver interface MUST be updated in the same change.

### Key Entities

- **Proxy choice**: the active driver, the inventory entry carrying the proxy flag, and the driver's and certificate settings.
- **Proxy check result**: pass or fail, an actionable message on failure, and on a pass the dry-run preview text.
- **Setup step record**: the existing setup progress record, with `proxy` added as a required step.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An operator with a running proxy completes the step (choose, fill in, check, see the preview) in one sitting with no file edits and no CLI commands.
- **SC-002**: A check against every driver leaves the proxy unchanged: 0 writes, backups, restores, reloads or route changes are recorded in any test.
- **SC-003**: A secret value appears in 0 responses, log lines and error messages across save, read-back and check.
- **SC-004**: After any number of saves, 0 or 1 inventory entries carry the proxy flag.
- **SC-005**: Every failing check names what to fix; no failure ends in a bare "failed".
- **SC-006**: Changing any proxy or certificate choice leaves the step incomplete until it passes again, 100% of the time.

## Assumptions

- The setup token, cookie, saved progress, Finish and the routes' authorization come from #86 and are reused unchanged.
- The proxy already exists and Bellhop can reach the chosen entry (a host in inventory from step 1, or one of its discovered guests, reached through its parent host).
- Choosing a host or guest of the Proxmox inventory is enough; an external (non-Proxmox) proxy is out of scope for this part.
- A newly installed Bellhop has no Authentik entry yet, so no route is forward-gated and the dry-run preview builds without one.
- A fresh install has no environment-variable overrides; an upgraded deployment never sees the walkthrough.
- Installing a new proxy (#90), the per-route adoption review (#91), Authentik (#88) and Bellhop's own address (#89) are separate parts of #70.
