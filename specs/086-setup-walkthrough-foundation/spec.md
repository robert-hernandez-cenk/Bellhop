# Feature Specification: First-run setup walkthrough foundation

**Feature Branch**: `issue-86-setup-walkthrough-foundation`

**Created**: 2026-10-05

**Status**: Draft

**Input**: GitHub issue #86, the first part of #70 ("First-run setup walkthrough: Proxmox, proxy, Authentik, and Bellhop's own address"). A fresh install today needs a hand-edited `hosts.yaml` copy, `import-yaml-inventory`, a hand-distributed SSH key and many `set-config` runs, in an order nothing explains. This part adds the walkthrough itself (its one-time setup token, saved progress, and Finish), its first two steps (Proxmox, then domain and basics), and removes `import-yaml-inventory`, whose only remaining job was creating the first inventory. Later parts of #70 add the proxy (#87), Authentik (#88), Bellhop's own address and the OIDC switch (#89), install-new options (#90), the proxy adoption review (#91) and optional extras (#92). Adding hosts and editing a host's `midScheme` after setup is #93.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Open the walkthrough safely on a fresh install (Priority: P1)

A new operator installs Bellhop and starts the web service. There is no inventory and no sign-in yet. The service log shows a setup address that carries a one-time setup token. The operator opens it and lands on the walkthrough. Anyone who reaches the service without the token sees neither the walkthrough nor the rest of the web UI.

**Why this priority**: Everything else in #70 runs inside this walkthrough, and before sign-in exists the setup token is the only thing standing between the network and an unconfigured admin interface.

**Independent Test**: Start the service against an empty inventory. Confirm the log names the setup address with a token, that the address opens the walkthrough, and that the walkthrough's API and every other page or API call are refused without the token.

**Acceptance Scenarios**:

1. **Given** an install with no hosts and setup never finished, **When** the service starts, **Then** it records that setup is pending, creates a setup token if none exists, and writes the setup address including the token to the service log.
2. **Given** setup is pending and the service restarts, **When** it starts again, **Then** it logs the same token again (a token the installer already printed stays valid).
3. **Given** setup is pending, **When** a browser opens the setup address with the correct token, **Then** the walkthrough opens, and the browser stays authorized for the walkthrough without the token in the address bar.
4. **Given** setup is pending, **When** a request reaches a walkthrough action without the token (or with a wrong one), **Then** it is refused and no change is made.
5. **Given** setup is pending, **When** a browser opens any other page, **Then** it is sent to a page that says setup is in progress and how to find the setup address; any other API call is refused with a "setup required" answer.
6. **Given** an install that already has hosts and no setup record (an existing deployment upgrading), **When** the service starts, **Then** no setup token is created and the walkthrough is never shown.

---

### User Story 2 - Connect the first Proxmox host and its cluster (Priority: P1)

In the first step, the operator enters the first Proxmox host's address, SSH user and port. Bellhop has its own SSH key (generated on first use, or an existing key file the operator names). The operator installs Bellhop's public key on the host, either by typing the host's root password once (used for that one connection and never stored) or by copying the shown key into `authorized_keys` themselves. Bellhop tests the connection, records the host under its own node name, and discovers its bridges, storage and guests. If the host belongs to a cluster, Bellhop lists the other nodes and offers to add each the same way. For each host, Bellhop suggests a `midScheme` (VMID base, IP prefix, gateway) from the host's network, which the operator accepts or edits.

**Why this priority**: Every later step and every Bellhop command needs at least one reachable host. This step replaces the hand-written host entry and hand-distributed key.

**Independent Test**: With a simulated Proxmox host, run the step with each key-install method and confirm the host lands in inventory with its discovered bridges, storage and guests, that cluster peers are offered, and that the saved `midScheme` matches what the operator accepted.

**Acceptance Scenarios**:

1. **Given** Bellhop has no SSH key of its own, **When** the step opens, **Then** Bellhop generates one, shows its public key, and stores the private key only on the Bellhop machine.
2. **Given** the operator chooses an existing key file instead, **When** the file is readable and is a usable private key, **Then** Bellhop uses it for the hosts added in this step; **When** it is not, **Then** the step names the problem.
3. **Given** a host address, user, port and the host's password, **When** the operator installs the key, **Then** Bellhop connects once with the password, adds its public key to that user's `authorized_keys` (without duplicating it if already present), and does not store or log the password.
4. **Given** the manual method, **When** the step shows the key, **Then** it shows the exact line to add and where, and the operator continues with the connection test.
5. **Given** the key is installed, **When** the connection test runs, **Then** it connects with Bellhop's key and confirms the machine is a Proxmox node; on failure it shows an actionable error (wrong address, port closed, key refused, not a Proxmox node).
6. **Given** a successful test, **When** the host is saved, **Then** it is recorded under its Proxmox node name with the address, user, port and key, and Bellhop discovers its bridges, storage and guests the same way `sync-inventory` does.
7. **Given** the host is a member of a cluster, **When** discovery finishes, **Then** the step lists the other cluster nodes with their addresses, and each can be added with the same key-install and test flow (or skipped).
8. **Given** a saved host, **When** the step suggests its `midScheme`, **Then** the suggestion's IP prefix and gateway come from the host's main bridge network, the VMID base is distinct from other hosts' bases, and the operator can edit every field before saving; invalid values are rejected with the field named.
9. **Given** the step was already completed, **When** the operator re-runs it for the same host, **Then** the host is updated in place, not duplicated, and its guests are not lost.

---

### User Story 3 - Set the domain and basics, then finish (Priority: P2)

In the second step the operator sets the inventory's domain (required) and optionally the DNS server, backup storage and NFS server. Then they finish the walkthrough: setup is marked finished for good, the setup token stops working, and the operator lands on the Dashboard.

**Why this priority**: The domain is needed by every later step, and Finish is what turns the walkthrough off. Without it the install would stay locked behind setup.

**Independent Test**: Complete step 1 against a simulated host, save the domain and basics, finish, and confirm the values are saved, the token is refused afterwards, and the normal web UI is served.

**Acceptance Scenarios**:

1. **Given** step 2, **When** the operator saves a domain and optional values, **Then** they are validated by the same rules as the Settings page and `set-config`, and saved.
2. **Given** an invalid or empty domain, **When** saved, **Then** it is refused with the field named.
3. **Given** step 1 or step 2 is incomplete, **When** the operator tries to finish, **Then** finishing is refused and names the incomplete step.
4. **Given** both steps are complete, **When** the operator finishes, **Then** setup is recorded as finished, the setup token is deleted, the setup address no longer works, and the browser is sent to the Dashboard.
5. **Given** setup finished, **When** the service restarts, even if every host is later removed, **Then** no setup token is created and the walkthrough is never shown again.

---

### User Story 4 - Resume an interrupted walkthrough (Priority: P2)

The operator closes the browser halfway through, or the service restarts. When they open the setup address again, the walkthrough opens at the first incomplete step and shows what was already saved.

**Why this priority**: The steps talk to real machines and can take a while. Losing progress would make setup fragile.

**Independent Test**: Complete step 1, reload the walkthrough (and restart the service), and confirm it opens on step 2 with step 1's hosts listed.

**Acceptance Scenarios**:

1. **Given** step 1 is complete, **When** the walkthrough is reopened, **Then** it shows step 1 as done (with its hosts) and opens on step 2.
2. **Given** a completed step, **When** the operator goes back to it, **Then** it shows the saved values and can be re-run safely.

---

### User Story 5 - The domain is an ordinary setting (Priority: P3)

After setup, the operator can change the inventory domain from the Settings page or with `set-config domain <value> --apply`, like any other setting.

**Why this priority**: Without `import-yaml-inventory`, nothing else could change the domain.

**Independent Test**: Change the domain through the Settings page and through `set-config`, and confirm both validate it the same way and the change is saved.

**Acceptance Scenarios**:

1. **Given** the Settings page, **When** it renders, **Then** it shows the domain with its current value and help text.
2. **Given** `set-config domain` with an invalid value, **When** run, **Then** it is refused with the same rule the Settings page uses.
3. **Given** a domain that is set and entries with subdomains, **When** an operator tries to clear the domain, **Then** it is refused, because subdomains need a domain.

---

### User Story 6 - `import-yaml-inventory` is gone (Priority: P3)

The `import-yaml-inventory` command, its example file and every reference to it are removed. The docs say a new install starts with the walkthrough. Contributors who need a sample inventory database on disk create one from the demo inventory with a small seed script.

**Why this priority**: Two ways to create the first inventory would drift apart. The walkthrough replaces the command's only remaining job.

**Independent Test**: Confirm `bellhop import-yaml-inventory` is an unknown command, the example YAML is gone, the seed script writes a loadable inventory, and the docs' link checks pass.

**Acceptance Scenarios**:

1. **Given** the CLI, **When** `import-yaml-inventory` is run, **Then** it is an unknown command.
2. **Given** the seed script, **When** run with a target path, **Then** it writes the demo inventory as a database that loads and validates.
3. **Given** README, CONTRIBUTING, `docs/` and CLAUDE.md files, **When** read, **Then** none refer to `import-yaml-inventory` or `hosts.yaml.example`, and the README quickstart says to open the setup address with the setup token.

### Edge Cases

- The setup token is guessed or brute-forced: it is long and random, and comparison does not leak timing.
- A request presents an old setup token after setup finished: refused.
- The host's password is wrong, or password login is disabled on the host: the key install fails with a message suggesting the manual method; nothing is saved.
- The operator supplies an existing key file that is passphrase-protected: refused with a message (a passphrase key can't be used unattended).
- The host's name collides with an existing inventory entry name: the step names the collision.
- A cluster peer is unreachable: shown as failed with its error; the operator can skip it and finish step 1 with the reachable hosts.
- A host has no bridge with an IPv4 address: no `midScheme` suggestion is offered, and the operator enters one.
- The inventory database does not exist yet when the service starts: it is created empty and loads without a domain.
- Two browser tabs run the same step at once: each action is idempotent, so the last one wins without duplication.
- Setup is pending and the operator uses the CLI on the same machine: the CLI is not blocked (host trust, as today).

## Requirements *(mandatory)*

### Functional Requirements

**Setup state and token**

- **FR-001**: The system MUST treat setup as *pending* when a setup record says so, or when the inventory has no hosts and no setup record says setup finished. It MUST treat setup as *not applicable* for an install that has hosts and no setup record.
- **FR-002**: When setup is pending at start-up, the system MUST ensure a setup record and a setup token exist (creating a cryptographically random token of at least 128 bits if none exists), and MUST write the setup address including the token to the service log on every start while setup is pending.
- **FR-003**: Setup state (status, token, completed steps) MUST be stored so that it survives restarts and is never touched by the inventory's full-replace save.
- **FR-004**: Opening the setup address with the correct token MUST authorize that browser for the walkthrough through a cookie, without needing the token again, and without the token remaining in the visible address. The cookie MUST work over plain HTTP, because setup runs before any proxy or TLS exists.
- **FR-005**: Every walkthrough action MUST be refused unless the request carries a valid setup authorization; token comparison MUST be constant-time.
- **FR-006**: While setup is pending, every other web page MUST be redirected to a setup-in-progress page, and every other API call MUST be refused with a response that says setup is required. Sign-in routes MUST also be unavailable.
- **FR-007**: Finishing MUST mark setup finished permanently and delete the token; afterwards the walkthrough and its token MUST be refused, and the walkthrough MUST never be offered again on that install.

**Step 1: Proxmox**

- **FR-008**: Bellhop MUST have its own SSH key pair for reaching hosts. It MUST generate one on first need, stored only on the Bellhop machine in its data directory. The operator MAY instead name an existing unencrypted private key file on the Bellhop machine.
- **FR-009**: The step MUST show Bellhop's public key and the exact `authorized_keys` line to add for the manual method.
- **FR-010**: The step MUST offer installing the public key with the host's password: one connection using that password, which adds the key to the user's `authorized_keys` idempotently. The password MUST NOT be stored, logged, or included in any response, error message or job record.
- **FR-011**: The connection test MUST connect with Bellhop's key (not the password) and confirm the host is a Proxmox node, reporting the node name.
- **FR-012**: On a successful test the host MUST be saved under its Proxmox node name with its address, SSH user, port (when not 22) and key file, and the system MUST discover its bridges, storage and guests the same way `sync-inventory` does, reusing that logic.
- **FR-013**: When the host is a cluster member, the step MUST list the other cluster nodes and their addresses and let the operator add each one with the same key-install and test flow, or skip it.
- **FR-014**: For each saved host the step MUST suggest a `midScheme` (VMID base, IP prefix, CIDR suffix, gateway) derived from the host's main bridge network, with a VMID base not used by another host, and MUST save the operator's (possibly edited) values after validating them with the existing `midScheme` rules.
- **FR-015**: Re-running step 1 for a host already in inventory MUST update it in place and keep its guests and their data.
- **FR-016**: Step 1 is complete once at least one host is saved with a `midScheme`.

**Step 2: Domain and basics**

- **FR-017**: The step MUST set the inventory domain (required) and optionally `dnsServer`, `backupStorage` and `nfsServer`, validating each with the same rules as the Settings page and `set-config`.
- **FR-018**: Step 2 is complete once a valid domain is saved.

**Finish**

- **FR-019**: Finishing MUST be refused while step 1 or step 2 is incomplete, naming the incomplete step.
- **FR-020**: After finishing, the browser MUST land on the Dashboard. The web UI's sign-in mode is left unchanged in this part (switching to OIDC sign-in is #89).

**Progress**

- **FR-021**: The walkthrough MUST record each completed step, open on the first incomplete step, and show saved values for completed steps.
- **FR-022**: Every step action MUST be safe to repeat.

**Domain as a setting**

- **FR-023**: The domain MUST be editable on the Settings page and through `set-config domain`, validated by one shared rule.
- **FR-024**: An inventory MUST load without a domain (a fresh install). Validation MUST require a domain once any entry has subdomains, and clearing the domain while any entry has subdomains MUST be refused.

**Removal**

- **FR-025**: The `import-yaml-inventory` command, its CLI registration, its test and `inventory/hosts.yaml.example` MUST be removed, with no migration path for old `hosts.yaml` files.
- **FR-026**: A seed script MUST write the demo inventory (`scripts/demo/`) to a given database path using the normal inventory save, for contributors who need a sample database on disk.
- **FR-027**: README, CONTRIBUTING, `docs/` and every CLAUDE.md file MUST stop referring to the removed command and file; the README quickstart MUST say to open the setup address with the setup token.

**Cross-cutting**

- **FR-028**: Every step MUST validate before reporting success and show actionable errors in the existing "how to fix it" style.
- **FR-029**: The walkthrough MUST work at desktop and mobile (≤640px) widths.
- **FR-030**: All remote execution MUST go through the existing remote-execution layer; the password connection MUST be added to the one SSH client, not a new transport.

### Key Entities

- **Setup record**: Whether setup is pending or finished, the setup token while pending, and which steps are complete. One per install, outside the inventory's full-replace data.
- **Setup authorization**: The browser's proof that it presented the token; valid only while setup is pending.
- **Bellhop SSH key**: The key pair Bellhop uses to reach hosts; the private half stays on the Bellhop machine, the public half is installed on each host.
- **Host entry**: The existing inventory host (name, SSH address/user/port/key file, `midScheme`, discovered bridges and storage).
- **Domain**: The inventory's base domain, now an ordinary setting.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A new operator goes from a freshly started service with no inventory to a finished walkthrough with a reachable host, discovered guests and a saved domain without editing any file or running any CLI command.
- **SC-002**: 100% of walkthrough and other web requests made without valid setup authorization while setup is pending are refused.
- **SC-003**: The host password appears in 0 stored records, log lines or responses.
- **SC-004**: Re-running any completed step leaves the inventory with the same hosts and guests (no duplicates, no losses).
- **SC-005**: After finishing, the setup token is refused 100% of the time, including after restarts.
- **SC-006**: No tracked file mentions `import-yaml-inventory` or `hosts.yaml.example`, outside historical specs.

## Assumptions

- The LXC installer (#67) prints the setup address from the service log; this part only guarantees that the log contains it on every start while setup is pending.
- Before #89 lands, a finished install keeps the web UI's existing sign-in mode (`none` on a fresh install, as today). The setup token protects the walkthrough itself, and the rest of the web UI is unavailable until setup finishes.
- One Bellhop service process per install (as the session store already assumes).
- Hosts are reached by SSH key once added; password login is used only for the one-time key install.
- Existing deployments already have hosts and never see the walkthrough.
- Historical specs under `specs/` keep their references to the removed command; they record past work.
