# Feature Specification: HAProxy Proxy Driver

**Feature Branch**: `issue-32-haproxy-proxy-driver`

**Created**: 2026-09-29

**Status**: Draft

**Input**: User description: "Issue #32: HAProxy reverse-proxy driver, selected with `proxyDriver haproxy`. A file-configured driver that owns a backends file and a host-to-backend map file loaded alongside the operator's own HAProxy configuration. HAProxy has no forward-auth, so it is the first driver that can enforce only OIDC gating."

## Background

Issue #10 put a driver seam between the inventory and the reverse proxy.
Caddy, nginx (#30) and Nginx Proxy Manager (#31) ship through it today, and
every one of them can enforce both of Bellhop's auth modes. An operator
whose proxy host runs HAProxy still cannot use `sync-proxy`, the
Dashboard's live subdomain edits, or provisioning jobs that publish a
subdomain.

HAProxy differs from the other drivers in two ways that shape this feature:

- **No forward-auth.** HAProxy has no native equivalent of Caddy's
  `forward_auth` or nginx's `auth_request`; only a community Lua script
  exists. A forward-gated entry therefore cannot be served safely, and
  emitting it without its gate would expose an app Bellhop was told to
  protect. The driver declares that it can enforce OIDC gating only, which
  makes it the first real exercise of the capability check introduced in
  #10 (spec 006, FR-011/FR-012).
- **The operator owns the frontend.** HAProxy terminates TLS in a
  `frontend` whose `bind` line names the operator's certificates.
  Bellhop does not issue certificates and does not take over the
  operator's main configuration. It owns only the backends and the table
  that routes hostnames to them; the operator's own frontend consults that
  table.

The concept mapping this driver follows was worked out on paper in issue
#10 (`specs/006-reverse-proxy-driver/research.md`, R3/R5/R6/R8).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Generate and deploy HAProxy configuration (Priority: P1)

An operator whose proxy host runs HAProxy selects the HAProxy driver
(`set-config proxyDriver haproxy --apply`, or the Settings page) and runs
`sync-proxy`. The dry run shows both files Bellhop will own; `--apply`
writes them, checks the combined configuration with HAProxy's own
configuration check, and reloads HAProxy. Every ungated or OIDC-gated
inventory entry with subdomains is reachable at each of its hostnames
through the operator's frontend and reaches its backend.

**Why this priority**: this is the driver itself. Without it nothing else
in this feature has anything to act on.

**Independent Test**: with an example inventory and a fake SSH client,
select the HAProxy driver and run `sync-proxy` dry run and apply; assert
the previewed files and the script sent to the proxy host. Separately, run
the generated delivery script locally with stub `haproxy`/`systemctl`
commands to show that a failed configuration check restores both files.

**Acceptance Scenarios**:

1. **Given** an inventory with ungated and OIDC-gated entries and
   `proxyDriver` set to `haproxy`, **When** the operator runs `sync-proxy`
   without `--apply`, **Then** it prints the backends file (one backend per
   entry, forwarding to the entry's backend address and port) and the map
   file (one line per hostname, canonical hostname first within each entry,
   naming that entry's backend), and changes nothing.
2. **Given** the same inventory, **When** the operator runs `sync-proxy
   --apply`, **Then** Bellhop replaces its backends file on the proxy host
   (default `/etc/haproxy/bellhop.cfg`, overridable with `proxyConfigPath`)
   and its map file (`bellhop.map` in the same directory), runs HAProxy's
   configuration check over the operator's main configuration together
   with the backends file, and reloads HAProxy.
3. **Given** a generated configuration that HAProxy's check rejects,
   **When** the operator applies, **Then** both files are restored to
   their previous contents (or removed if they did not exist), HAProxy is
   not reloaded, and the command fails with HAProxy's error.
4. **Given** the HAProxy driver is active, **When** a Dashboard subdomain
   edit or a provisioning job pushes proxy configuration live, **Then** it
   goes through the HAProxy driver, and the stale-ACME-record cleanup step
   is skipped with its usual one-line note, since HAProxy never creates
   those records.
5. **Given** a backend flagged `insecureBackendTls`, **When**
   configuration is generated, **Then** HAProxy connects to it over TLS
   without verifying its certificate; **given** a backend on port 443
   without that flag, it connects over TLS and verifies the certificate
   against the system CA bundle; any other backend is reached over plain
   HTTP.
6. **Given** any generated backend, **When** a client uses it, **Then** it
   behaves like the other drivers' sites: the original `Host` is passed
   through, the backend is told the client's address (replacing, never
   appending to, any value the client sent), the scheme (`https`), the
   original host, and that the external port is 443, and long-lived
   WebSocket and server-sent-event connections are not cut off after
   HAProxy's usual idle timeout.
7. **Given** an existing file at either path whose first line is not
   Bellhop's generated header (for example the operator's own
   configuration, or a file left by another driver), **When** the operator
   applies, **Then** nothing is written, and the command fails naming the
   path and how to point `proxyConfigPath` elsewhere.

---

### User Story 2 - Forward-gated entries are refused, never exposed (Priority: P1)

An entry gated with forward-auth cannot be enforced by HAProxy. Under the
HAProxy driver, Bellhop refuses to publish configuration containing such an
entry, and refuses a guest edit that would create one, naming the entry,
the driver and the fix.

**Why this priority**: silently emitting a forward-gated entry without its
gate would make a protected app public. This is a safety property, equal
in priority to the driver itself.

**Independent Test**: with the HAProxy driver active, run `sync-proxy`
against an inventory containing a forward-gated entry, and make a guest
edit that gates a guest with forward-auth; assert both are refused with
the capability message and nothing is written.

**Acceptance Scenarios**:

1. **Given** the HAProxy driver and an inventory with a forward-gated
   entry, **When** the operator runs `sync-proxy` (dry run or apply),
   **Then** it fails before previewing or writing anything, with a message
   naming the entry, the `haproxy` driver, and the fix: set its auth mode to
   OIDC or clear its auth group.
2. **Given** the HAProxy driver, **When** a Dashboard or MCP guest edit
   would leave the edited guest forward-gated with subdomains, **Then** the
   edit is rejected with the same message and the inventory is unchanged.
3. **Given** the HAProxy driver, **When** a guest edit gates a guest in
   OIDC mode, or leaves it ungated, **Then** the edit is accepted as usual.
4. **Given** an OIDC-gated entry with `unauthenticatedPaths` saved from an
   earlier forward-auth configuration, **When** configuration is generated,
   **Then** those paths have no effect on the output.
5. **Given** a forward-gated entry that is `proxyManual`, or has no
   subdomains, **When** `sync-proxy` runs, **Then** it is not refused,
   since no route is generated for it.

---

### User Story 3 - Choose and understand the driver (Priority: P2)

An operator can find the HAProxy driver in the Settings page's proxy driver
dropdown and in the documentation, and learns from the documentation what
their own HAProxy configuration must provide before Bellhop can manage it.

**Why this priority**: the driver is usable from the CLI without this, but
an operator cannot set it up correctly without knowing the prerequisites.

**Independent Test**: load the Settings page with the HAProxy driver
selected; follow the documentation page's setup steps against a stock
HAProxy installation.

**Acceptance Scenarios**:

1. **Given** the Settings page, **When** the operator opens the proxy
   driver dropdown, **Then** "HAProxy" is listed between "Nginx Proxy
   Manager" and "No proxy".
2. **Given** HAProxy is selected, **When** the operator looks at the
   proxy-related fields, **Then** the proxy config path field shows
   `/etc/haproxy/bellhop.cfg` as its placeholder with a note that Bellhop
   replaces the whole file and writes `bellhop.map` beside it; the status
   page path and shared TLS certificate fields are not shown.
3. **Given** the documentation, **When** the operator reads the HAProxy
   driver page, **Then** it states the prerequisites: an HTTPS frontend
   with the operator's own certificates, a routing rule in that frontend
   that looks up the request's host in Bellhop's map file, loading
   Bellhop's backends file alongside the main configuration, and an
   operator-managed certificate tool; and it states that forward-auth
   gating and a status page are not available.

### Edge Cases

- **No routes**: both files are still written, containing only their
  generated headers, and the configuration check still passes.
- **Owner names that aren't valid HAProxy identifiers**: backend names are
  derived deterministically from the owner type and name, so a host and a
  guest with the same name get different backends, and characters HAProxy
  does not accept in a name never reach the file.
- **Two names that sanitise to the same backend name**: the derivation
  keeps them distinct, so two entries never share a backend by accident.
- **A hostname requested with an explicit port** (`app.example.com:443`):
  the documented frontend rule strips the port before the lookup.
- **A hostname not in the map**: falls through to whatever default the
  operator's frontend defines; Bellhop does not add a default.
- **`proxyConfigPath` pointing at another driver's file**: the map file
  always sits in the same directory as the backends file; a file Bellhop
  did not generate is refused (User Story 1, scenario 7).
- **A status page requested under HAProxy**: `render-status-page` fails
  with the existing "this driver serves no status page" message, and the
  push-live step logs its existing warning when `statusPagePath` is set.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST offer a proxy driver with id `haproxy`,
  labelled "HAProxy", selectable through the `proxyDriver` setting from the
  CLI and the Settings page, and listed between Nginx Proxy Manager and
  "No proxy".
- **FR-002**: The driver MUST own two files on the proxy host: a backends
  file at `proxyConfigPath` (default `/etc/haproxy/bellhop.cfg`) and a map
  file named `bellhop.map` in the same directory. Each MUST begin with a
  generated header line marking it as Bellhop's, and each MUST be replaced
  whole on every apply.
- **FR-003**: Before writing, apply MUST refuse to replace an existing file
  at either path whose first line is not that file's generated header,
  leaving both files untouched.
- **FR-004**: The backends file MUST contain one HTTP-mode backend per
  route, in route order, with a single server line pointing at the route's
  backend address and port.
- **FR-005**: The map file MUST contain one line per route hostname,
  mapping the lower-cased hostname to that route's backend name.
- **FR-006**: Backend names MUST be valid HAProxy identifiers, derived
  deterministically from the owner type and name, and unique across all
  routes.
- **FR-007**: Each backend MUST set the forwarded headers the other drivers
  set: client address (replacing any client-supplied value), scheme
  `https`, the original host, and the external port.
- **FR-008**: Each backend MUST allow long-lived connections (WebSocket,
  server-sent events) to stay open for at least a day of inactivity.
- **FR-009**: Backend TLS MUST follow the other drivers' rule: TLS without
  verification when the route's backend is marked insecure; TLS verified
  against the system CA bundle when the backend port is 443 and it is not
  marked insecure; plain HTTP otherwise.
- **FR-010**: Apply MUST validate the operator's main configuration
  (`/etc/haproxy/haproxy.cfg`) together with the backends file using
  HAProxy's configuration check, restore both files and fail without
  reloading when the check fails, and reload HAProxy when it passes.
- **FR-011**: The driver MUST declare OIDC as its only enforceable auth
  mode, so that the existing capability check refuses forward-gated routes
  at `sync-proxy` time and at guest-edit time (Dashboard and MCP), with a
  message naming the entry, the driver, and the fix.
- **FR-012**: The driver MUST never render `unauthenticatedPaths`.
- **FR-013**: The driver MUST declare that it does not issue certificates
  through Cloudflare DNS-01, so the stale-ACME-record cleanup is skipped
  under it.
- **FR-014**: The driver MUST declare that it serves no status page and
  does not use the shared TLS certificate settings.
- **FR-015**: `snapshot()` MUST read back both deployed files.
- **FR-016**: The dry-run preview MUST show exactly the content apply
  writes to both files.
- **FR-017**: The Settings page MUST show a note for this driver's config
  path explaining that the whole file is replaced and that `bellhop.map` is
  written beside it.
- **FR-018**: Documentation MUST describe the driver, its prerequisites
  (frontend, certificates, map lookup rule, loading the backends file), its
  limits (no forward-auth, no status page), and the single-operator
  assumptions it makes (the fixed main configuration path and CA bundle
  path).

### Key Entities

- **Backends file**: Bellhop-owned HAProxy configuration fragment; header
  line plus one backend per route.
- **Map file**: Bellhop-owned lookup table; header line plus one
  `hostname backend-name` line per route hostname. Read by the operator's
  own frontend.
- **Backend name**: identifier derived from a route's owner type and name,
  the join between the two files.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An operator with a stock HAProxy installation who follows the
  documentation can publish every ungated and OIDC-gated entry through
  HAProxy with one `sync-proxy --apply`, and the combined configuration
  passes HAProxy's own check.
- **SC-002**: 100% of forward-gated entries with subdomains are refused
  under the HAProxy driver, at both `sync-proxy` and guest edit; none ever
  appears in a generated file.
- **SC-003**: A rejected configuration leaves both files byte-for-byte as
  they were, and HAProxy is not reloaded, in every tested failure case.
- **SC-004**: Switching `proxyDriver` to or from `haproxy` changes no
  behaviour of the other drivers: their existing tests pass unchanged.

## Assumptions

- The proxy host runs a Debian/Ubuntu HAProxy package: the main
  configuration is at `/etc/haproxy/haproxy.cfg`, the reload command is
  `systemctl reload haproxy`, and the CA bundle is at
  `/etc/ssl/certs/ca-certificates.crt`. These are single-operator
  assumptions, recorded in the documentation like the nginx driver's
  equivalent paths.
- The operator configures HAProxy to load Bellhop's backends file with an
  extra configuration file argument (for example through the package's
  `EXTRAOPTS`), and writes the frontend rule that consults the map file.
  Bellhop does not edit the main configuration.
- The operator's `defaults` section supplies connect and client timeouts;
  the driver sets only the server and tunnel timeouts it needs.
- Certificates are issued and renewed outside Bellhop and referenced from
  the operator's frontend.
- Out of scope: an HAProxy Data Plane API driver, Bellhop-managed
  frontends or certificates, forward-auth via Lua, a status page, and a
  configurable main configuration path.
