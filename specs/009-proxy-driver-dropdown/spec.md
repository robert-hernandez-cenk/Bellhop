# Feature Specification: Proxy driver dropdown with a "no proxy" option

**Feature Branch**: `issue-33-proxy-driver-dropdown`
**Created**: 2026-09-28
**Status**: Draft
**Input**: Issue #33 — "the proxy driver field in settings should be a dropdown list showing the supported options. No proxy must be allowed. Only show proxy config path if the associated provider uses a config. Change the suggestion text to match the provider if applicable."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Choose the proxy driver from a list (Priority: P1)

An admin opens the Settings page and picks the reverse-proxy driver from a dropdown of the drivers Bellhop supports, instead of typing an id into a free-text box and finding out on Save whether it was valid.

**Why this priority**: This is the core of the issue. It removes a whole class of typo errors and makes the supported choices discoverable without reading the docs.

**Independent Test**: Open Settings, confirm the Proxy driver control lists every supported driver (and nothing else), pick one, Save, reload, and confirm the saved choice is shown.

**Acceptance Scenarios**:

1. **Given** the proxy driver setting is unset, **When** the admin opens Settings, **Then** the Proxy driver dropdown shows the default driver (Caddy) as the current choice and marks it as the default.
2. **Given** the dropdown is open, **When** the admin looks at the options, **Then** exactly the supported drivers are listed, each with a readable name: Caddy and "No proxy".
3. **Given** the admin selects a driver and presses Save, **When** the page reloads, **Then** the saved driver is shown as selected.
4. **Given** a driver is saved, **When** the admin presses Clear, **Then** the setting returns to unset and the dropdown shows the default driver again.

---

### User Story 2 - Run Bellhop without a managed reverse proxy (Priority: P1)

An operator whose reverse proxy is managed by hand (or who has none) sets the proxy driver to "No proxy". Bellhop then never writes, validates, or reloads any proxy configuration, and never fails an action because no inventory entry is flagged as the proxy host.

**Why this priority**: The issue requires "no proxy" to be allowed. Without defined behavior, choosing it would either be rejected or make every push-live step fail.

**Independent Test**: With the driver set to "No proxy" and no inventory entry marked as the proxy host, run a proxy sync (CLI, web, and MCP) and a Dashboard subdomain edit; confirm each succeeds, reports that there is nothing to write, and touches no host.

**Acceptance Scenarios**:

1. **Given** the driver is "No proxy", **When** the operator runs the proxy sync in dry-run or apply mode, **Then** it succeeds, makes no remote calls, and states that Bellhop manages no reverse proxy so there is nothing to write.
2. **Given** the driver is "No proxy" and no inventory entry is flagged as the proxy host, **When** the proxy sync runs, **Then** it does not fail over the missing proxy host.
3. **Given** the driver is "No proxy", **When** a Dashboard guest edit or a provisioning job triggers the combined push-live step, **Then** the proxy write is a no-op, the status page render is skipped with one log line, the stale ACME challenge cleanup is skipped with its existing "driver does not use ACME DNS-01" line, and the Authentik reconcile still runs exactly as before.
4. **Given** the driver is "No proxy" and an entry is gated with forward-auth, **When** the entry is saved or synced, **Then** it is accepted (not rejected by capability checks), and the Authentik side is reconciled as it is today; the operator's own proxy is assumed to perform forward-auth.
5. **Given** the driver is "No proxy", **When** the operator runs the standalone status-page render command, **Then** it fails with an error saying there is no managed proxy to serve the page and naming the setting to change.
6. **Given** the driver is "No proxy", **When** a guest migration finishes and would normally push the proxy configuration, **Then** the proxy push is a no-op and the status page render is skipped, and the migration still reports success.

---

### User Story 3 - Only see proxy fields that apply, with matching suggestions (Priority: P2)

When the admin changes the Proxy driver selection, the Settings page immediately shows or hides the fields that depend on it, and the placeholder suggestions reflect the selected driver.

**Why this priority**: It keeps the page from inviting input that has no effect, and stops Caddy-specific hints from misleading operators of other drivers. Valuable, but the page is usable without it.

**Independent Test**: Toggle the dropdown between Caddy and "No proxy" without saving and observe the Proxy config path and Status page path fields appear/disappear and their placeholders change.

**Acceptance Scenarios**:

1. **Given** the selected driver uses a configuration file (Caddy), **When** the page renders, **Then** the Proxy config path field is shown, and its placeholder and help text name that driver's own default path.
2. **Given** the selected driver uses no configuration file ("No proxy"), **When** the page renders, **Then** the Proxy config path field is hidden.
3. **Given** the selected driver serves no status page ("No proxy"), **When** the page renders, **Then** the Status page path field is hidden; for a driver that does, it is shown with a placeholder suggested by that driver.
4. **Given** a field is hidden because of the selected driver, **When** the admin saves the driver, **Then** the hidden field's stored value is kept unchanged (it is inert, not cleared), and it reappears with that value if a driver that uses it is selected again.
5. **Given** the admin changes the dropdown but has not saved, **When** they look at the dependent fields, **Then** visibility and placeholders follow the dropdown's current (unsaved) selection.

---

### Edge Cases

- A stored proxy config path or status page path while "No proxy" is selected: kept, hidden, and ignored by every command.
- The setting is unset: behaves exactly as Caddy does today, in every command and on the page.
- The CLI `set-config` for the proxy driver accepts the same set of values as the Settings page and rejects anything else with the same rule.
- A stored driver id that is no longer supported (only reachable by hand-editing the database) continues to fail inventory loading as it does today; the page does not need to render it.
- Mobile width (640px or narrower): the dropdown and the conditionally shown fields lay out without horizontal overflow.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The set of valid proxy driver values MUST include a "no proxy" value in addition to Caddy, accepted identically by the CLI settings command, the web Settings page, and every other writer of that setting.
- **FR-002**: An unset proxy driver MUST continue to mean Caddy, with no behavior change for existing deployments.
- **FR-003**: Each supported driver MUST declare a human-readable name, whether it uses a configuration file (and if so its default path), and whether it serves a status page (and if so a suggested status page path).
- **FR-004**: The Settings page MUST obtain the list of supported drivers and their declared properties from the server, including which driver is the default, rather than holding its own copy.
- **FR-005**: The Settings page MUST present the proxy driver as a single-choice dropdown of exactly the supported drivers, showing the default driver as selected (and labelled as the default) when the setting is unset. Save and Clear MUST behave as they do for the other settings.
- **FR-006**: The Settings page MUST show the Proxy config path field only when the driver currently selected in the dropdown uses a configuration file, and its placeholder and help text MUST reflect that driver's default path.
- **FR-007**: The Settings page MUST hide the Status page path field when the selected driver serves no status page, and otherwise use that driver's suggested path as the placeholder.
- **FR-008**: Hiding a dependent field MUST NOT change or clear its stored value.
- **FR-009**: With "no proxy" selected, the proxy sync MUST succeed without writing, validating, or reloading anything, MUST NOT require an inventory entry flagged as the proxy host, and MUST report that there is nothing to write, the same way in the CLI, web UI, and MCP server.
- **FR-010**: With "no proxy" selected, capability enforcement MUST NOT reject any gating mode (forward-auth and OIDC entries are both accepted), and the Authentik reconcile MUST behave exactly as it does today.
- **FR-011**: With "no proxy" selected, the standalone status page render MUST fail with an error that names the proxy driver setting as the fix; automated callers (the combined push-live step and the guest migration's post-move push) MUST instead skip it with one log line and continue.
- **FR-012**: With "no proxy" selected, the stale ACME challenge cleanup MUST be skipped, through the existing driver-capability check.
- **FR-013**: The CLI's description of the settings command MUST list the proxy driver and proxy config path settings alongside the others.
- **FR-014**: The Settings page changes MUST work at desktop width and at mobile width (640px or narrower).

### Key Entities

- **Proxy driver**: a supported way of managing (or not managing) the reverse proxy. Attributes: id, display name, default configuration path (or none), suggested status page path (or none), which gating modes it can enforce, whether it uses ACME DNS-01 through Cloudflare.
- **Proxy settings**: the stored driver choice (optional; unset means the default driver) and the optional configuration path override. Unchanged in shape; gains one allowed driver value.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An admin can change the proxy driver on the Settings page without typing any text, and it is impossible to submit an unsupported driver value from the page.
- **SC-002**: With "no proxy" selected, 100% of proxy sync, push-live, and migration runs complete without contacting any proxy host and without failing over a missing proxy host.
- **SC-003**: With the setting unset or set to Caddy, generated proxy configuration and command behavior are byte-for-byte identical to before this change.
- **SC-004**: Changing the dropdown updates dependent field visibility and placeholders immediately, with no save or reload needed.

## Assumptions

- "No proxy" means Bellhop manages no reverse proxy; it does not mean the deployment has no proxy at all. An operator's hand-managed proxy may still front entries and perform forward-auth (user decision during design).
- The default driver stays Caddy; changing the default is out of scope.
- No new real proxy driver (nginx, HAProxy, Caddy admin API, ...) is added.
- The derived "Proxy IP (firewall scope)" value and the web UI's own authentication assumptions are unchanged; they depend on the entry flagged as the proxy host, not on the driver setting.
- Stored values of hidden fields stay in place, following the existing precedent that inert settings are kept rather than cleared.
- Single-operator assumption change: the toolkit no longer assumes every deployment has a Bellhop-managed reverse proxy.
