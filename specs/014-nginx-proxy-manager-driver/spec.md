# Feature Specification: Nginx Proxy Manager Proxy Driver

**Feature Branch**: `issue-31-nginx-proxy-manager-driver`

**Created**: 2026-09-29

**Status**: Draft

**Input**: User description: "Issue #31: Nginx Proxy Manager reverse-proxy driver. A driver for Nginx Proxy Manager, configured through its REST objects (proxy hosts) rather than a file."

## Background

Issue #10 put a driver seam between the inventory and the reverse proxy, and
issues #30 and #33 added the nginx and "no proxy" drivers. Both drivers that
actually manage a proxy (Caddy, nginx) write a configuration file over SSH.
An operator running [Nginx Proxy Manager](https://nginxproxymanager.com/)
(NPM) cannot use `sync-proxy`, the Dashboard's live subdomain edits, or
Authentik gating through Bellhop: NPM keeps its configuration in its own
database and regenerates nginx files from it, so a file Bellhop wrote would
be overwritten or ignored.

NPM is configured through a REST API of "proxy hosts" (one per site) and
"certificates". This feature adds a driver that reconciles the inventory's
routes against those objects: the first driver in Bellhop with no
configuration file at all, which issue #10's interface was shaped to allow
(`specs/006-reverse-proxy-driver/research.md` R1, R3, R8).

Two decisions made before specification:

- **Direct API access.** Bellhop calls NPM's API over HTTP from the machine
  it runs on, the same way it already calls Authentik and Cloudflare, rather
  than tunnelling each call through SSH to the proxy host.
- **Certificates: reuse, else request.** A site gets an existing NPM
  certificate that already covers all of its hostnames (typically a wildcard
  the operator created in NPM); when none does, Bellhop asks NPM to request
  a Let's Encrypt certificate for that site.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Publish inventory sites through Nginx Proxy Manager (Priority: P1)

An operator whose proxy host runs NPM stores NPM's admin login in a
gitignored credentials file, selects the NPM driver (`set-config proxyDriver
nginx-proxy-manager --apply`, or the Settings page dropdown), and runs
`sync-proxy`. The dry run lists the proxy hosts Bellhop would create, update,
and delete; `--apply` makes those changes in NPM. Every inventory entry with
subdomains then answers HTTPS at each of its hostnames and reaches its
backend.

**Why this priority**: this is the driver itself; nothing else in this
feature has anything to act on without it.

**Independent Test**: with an example inventory and a fake NPM client that
starts empty, select the driver and run `sync-proxy` dry run and apply;
assert the preview and the objects the fake client received.

**Acceptance Scenarios**:

1. **Given** an inventory with ungated entries, NPM with no proxy hosts, and
   `proxyDriver` set to `nginx-proxy-manager`, **When** the operator runs
   `sync-proxy` without `--apply`, **Then** it prints one proxy host to
   create per entry (its hostnames, canonical first, and its backend
   scheme, address, and port) and changes nothing in NPM.
2. **Given** the same state, **When** the operator runs `sync-proxy
   --apply`, **Then** NPM holds one proxy host per entry, each marked as
   Bellhop's, forwarding to the entry's backend with WebSocket support on
   and HTTPS enforced.
3. **Given** an entry whose backend listens on 443 or has
   `insecureBackendTls` set, **When** it is synced, **Then** its proxy host
   forwards over HTTPS; otherwise over HTTP. With `insecureBackendTls` set,
   the backend's certificate is not verified.
4. **Given** proxy hosts already in sync with the inventory, **When**
   `sync-proxy` runs again, **Then** the preview reports no changes and
   `--apply` sends no modifications to NPM.
5. **Given** an entry whose port or hostnames changed, **When** it is
   synced, **Then** its existing Bellhop proxy host is updated in place
   rather than deleted and recreated.
6. **Given** a Bellhop proxy host whose canonical hostname no longer
   belongs to any inventory route (the entry lost its subdomains, was
   deleted, or was marked `proxyManual`), **When** it is synced, **Then**
   that proxy host is deleted.
7. **Given** the operator edits a guest's subdomains on the Dashboard with
   this driver active, **When** the edit saves, **Then** the change is
   pushed to NPM in the same request, exactly as with the other drivers.

---

### User Story 2 - Never touch a proxy host Bellhop did not create (Priority: P1)

An operator already has hand-made proxy hosts in NPM. Bellhop must only ever
change or delete the proxy hosts it created itself, and must tell the
operator when a hand-made proxy host already claims a hostname the inventory
wants.

**Why this priority**: an operator adopting the driver on an existing NPM
instance must not lose working sites; a driver that deletes unrecognised
objects is unusable there.

**Independent Test**: seed the fake NPM client with an unmarked proxy host
for one hostname plus an unmarked host for an unrelated hostname; run dry
run and apply; assert neither is modified and the conflict is named.

**Acceptance Scenarios**:

1. **Given** an unmarked proxy host for a hostname no inventory entry uses,
   **When** `sync-proxy --apply` runs, **Then** it is never updated or
   deleted.
2. **Given** an unmarked proxy host claiming any hostname of an inventory
   route, **When** `sync-proxy` runs, **Then** the dry run lists it as a
   conflict naming the hostname, the entry, and the existing proxy host;
   `--apply` leaves it untouched, still applies every non-conflicting
   change, and then fails with an error naming each conflict and how to
   resolve it (delete or change the hand-made proxy host in NPM, or mark
   the entry `proxyManual`).
3. **Given** a conflict reported from a Dashboard guest edit, **When** the
   edit saves, **Then** the inventory change is kept and the push-live
   failure is reported the way any other driver's failure is.

---

### User Story 3 - Gate sites behind Authentik forward-auth (Priority: P2)

An operator gates an entry with `authGroup` in forward mode. Its NPM proxy
host must send every request through the Authentik outpost before reaching
the backend, except for the entry's `unauthenticatedPaths`.

**Why this priority**: gating is a core Bellhop feature and the driver
declares forward-auth support; without it, switching drivers would silently
ungate apps.

**Independent Test**: sync a forward-gated entry with exempt paths through
the fake client; assert the proxy host's custom configuration carries the
forward-auth check, the outpost passthrough, the sign-in redirect, and one
unauthenticated location per exempt path. Verify once against a real NPM
instance that the resulting configuration loads.

**Acceptance Scenarios**:

1. **Given** a forward-gated entry, **When** it is synced, **Then** its
   proxy host checks every request against the Authentik outpost, redirects
   an unauthenticated browser to Authentik's sign-in, and forwards the same
   identity headers the Caddy and nginx drivers forward.
2. **Given** that entry's `unauthenticatedPaths` holds `/api/*` and
   `/health`, **When** it is synced, **Then** requests to paths under
   `/api/` and to exactly `/health` reach the backend without the check,
   and every other path is still checked. A `/*` exemption removes the
   check from the whole site.
3. **Given** an entry in OIDC mode or ungated, **When** it is synced,
   **Then** its proxy host carries no forward-auth configuration.
4. **Given** the entry's gate is removed, **When** it is synced again,
   **Then** its proxy host is updated to carry no forward-auth
   configuration.

---

### User Story 4 - Certificates without manual steps (Priority: P2)

Every proxy host Bellhop creates must serve HTTPS with a valid certificate
without the operator creating one per site.

**Why this priority**: a site with no certificate is unreachable over
HTTPS; asking the operator to create a certificate for every new subdomain
would defeat live Dashboard edits.

**Independent Test**: seed the fake client with a wildcard certificate for
the domain; sync two entries; assert both proxy hosts reference it and no
certificate request was made. Then with no covering certificate, assert a
certificate request is made for the entry's hostnames and the new proxy
host references its result.

**Acceptance Scenarios**:

1. **Given** NPM holds a certificate covering all of a route's hostnames
   (by exact name, or a one-level wildcard such as `*.example.com` covering
   `app.example.com`), **When** the route is synced, **Then** its proxy
   host uses that certificate and no new certificate is requested.
2. **Given** no NPM certificate covers a route's hostnames, **When** the
   route is synced with `--apply`, **Then** Bellhop asks NPM to request a
   Let's Encrypt certificate for exactly those hostnames (NPM registers it
   under its own account's email), and the proxy host uses it. The dry run says a
   certificate will be requested.
3. **Given** NPM rejects the certificate request (for example the domain is
   not publicly reachable), **When** the route is synced, **Then** the sync
   fails with NPM's own error message and names the route; no proxy host is
   left without a certificate.
4. **Given** an existing Bellhop proxy host already has a certificate that
   still covers its hostnames, **When** it is synced, **Then** its
   certificate is left alone.

---

### User Story 5 - Configure and inspect the driver (Priority: P3)

The operator configures the driver's connection once, sees it in the
Settings page's driver dropdown, and can confirm what Bellhop manages.

**Why this priority**: needed to use the driver at all, but small and
mostly reuses existing surfaces.

**Independent Test**: run `sync-proxy` with the driver selected and no
credentials file; assert the error names the file and its variables. Load
the Settings page with the driver selected; assert the config-path and TLS
file fields are hidden.

**Acceptance Scenarios**:

1. **Given** the driver is selected but NPM credentials are not configured,
   **When** any sync runs, **Then** it fails before contacting NPM, naming
   the credentials file and the variables to set.
2. **Given** the credentials are wrong or NPM is unreachable, **When** a
   sync runs, **Then** it fails with an error naming the NPM address and
   what went wrong, within a bounded time.
3. **Given** the Settings page with the NPM driver selected, **When** it
   renders, **Then** the dropdown shows "Nginx Proxy Manager", and the
   proxy configuration path, status page path, and TLS certificate/key
   fields are hidden, since the driver uses none of them.
4. **Given** the NPM driver is active, **When** the operator runs
   `render-status-page`, **Then** it reports that this driver serves no
   status page, the same way it does for any managed driver without one.
5. **Given** no NPM address is configured, **When** the driver connects,
   **Then** it uses port 81 on the `proxy: true` entry's IP address.

### Edge Cases

- Two inventory routes cannot share a hostname (inventory validation already
  rejects it), so two Bellhop proxy hosts never compete for one hostname.
- A Bellhop proxy host whose marker was removed by hand in NPM is treated as
  hand-made from then on: never changed or deleted, and reported as a
  conflict if the inventory still wants its hostnames.
- A Bellhop proxy host edited by hand in NPM (a changed port, disabled
  WebSockets) is drifted, and the next sync restores the inventory's values.
- A Bellhop proxy host disabled by hand in NPM is re-enabled by the next
  sync, the same way any other drift is corrected.
- The inventory has no routes: every Bellhop proxy host is deleted and
  nothing else is touched.
- NPM accepts a proxy host but the nginx configuration it generates from
  the custom configuration fails to load: the sync reports NPM's error
  rather than claiming success.
- An exempt path inside Authentik's outpost namespace is skipped, as the
  nginx driver already does, so it can never misroute the forward-auth
  check.
- A certificate that covers some but not all of a route's hostnames is not
  used; a new one covering all of them is requested.
- An expired certificate is not treated as covering anything.
- NPM saves a proxy host whose custom configuration nginx rejects, marks
  it offline, and takes that site down; the sync reads the host back after
  every write and fails with nginx's own message, naming the proxy host.
- A request to NPM that stalls is abandoned after a fixed timeout, and the
  sync reports it.

## Requirements *(mandatory)*

### Functional Requirements

**Driver selection and interface**

- **FR-001**: The system MUST offer an `nginx-proxy-manager` driver,
  labelled "Nginx Proxy Manager", selectable through `proxyDriver` in the
  CLI and the Settings page, listed after the existing drivers.
- **FR-002**: The driver MUST declare support for both forward and OIDC
  auth modes, and MUST NOT declare the Cloudflare DNS-01 certificate
  capability.
- **FR-003**: The driver MUST declare that it uses no configuration file
  and serves no status page. Bellhop MUST accept a managed driver with no
  configuration file: resolving the driver's dependencies MUST NOT fail
  over a missing configuration path, and the Settings page MUST hide the
  proxy configuration path, status page path, and TLS certificate/key
  fields for such a driver.

**Connection**

- **FR-004**: The system MUST read the NPM login (email and password) and
  an optional API address from a gitignored credentials file under `data/`, loaded by every entry point
  that already loads Authentik credentials.
- **FR-005**: When no API address is configured, the driver MUST use HTTP
  on port 81 of the `proxy: true` entry's IP address.
- **FR-006**: A missing login MUST fail before any request, with an error
  naming the credentials file and variables. An authentication failure or
  unreachable NPM MUST fail with an error naming the address. Every request
  MUST time out after a fixed bound.
- **FR-007**: Responses from NPM MUST be validated before use; an
  unexpected response shape MUST fail with an error rather than be
  misread.

**Reconciliation**

- **FR-008**: The driver MUST produce one NPM proxy host per route, whose
  hostnames are the route's hostnames with the canonical hostname first,
  forwarding to the route's backend address and port, over HTTPS when the
  backend port is 443 or `insecureBackendTls` is set and over HTTP
  otherwise, with WebSocket support on, HTTPS forced, and the host enabled.
- **FR-009**: The driver MUST mark every proxy host it creates, and MUST
  identify its own proxy hosts solely by that mark. A marked proxy host is
  matched to a route by its canonical hostname.
- **FR-010**: The dry run MUST list, per route, whether its proxy host will
  be created, updated (naming the changed settings), or left unchanged;
  every marked proxy host that will be deleted; every certificate that will
  be requested; and every conflict. The dry run MUST make no changes.
- **FR-011**: Apply MUST perform exactly what the dry run listed: create
  missing proxy hosts, update drifted ones in place, and delete marked
  proxy hosts that match no route.
- **FR-012**: An unmarked proxy host claiming any hostname of a route MUST
  be reported as a conflict and never modified; that route MUST be skipped;
  every other change MUST still be applied; and apply MUST then fail with
  an error naming each conflict and its resolution.
- **FR-013**: Syncing an inventory already reflected in NPM MUST make no
  changes.
- **FR-014**: A request NPM rejects MUST fail the sync with NPM's own error
  message and the route or proxy host it concerned. A proxy host NPM saved
  but could not bring online (its generated configuration failed nginx's
  test) MUST also fail the sync, with nginx's message.

**Forward-auth**

- **FR-015**: A forward-gated route's proxy host MUST carry Authentik's
  nginx forward-auth configuration: the check against the outpost on every
  location, the outpost passthrough, the sign-in redirect, and forwarding of
  the same identity headers the other drivers forward.
- **FR-016**: Each exempt path MUST become an unchecked location (exact path
  or prefix, as the nginx driver renders them); a `/*` exemption MUST remove
  the check from the whole site; exempt paths inside the outpost's own
  namespace MUST be skipped. The forward-auth and exempt-path configuration
  MUST come from the same source as the nginx driver's, not a second copy.
- **FR-017**: A route in OIDC mode or ungated MUST carry no forward-auth
  configuration.

**Certificates**

- **FR-018**: A route MUST use an existing, unexpired NPM certificate whose
  names cover every one of the route's hostnames (exact match, or a
  one-level wildcard), when one exists.
- **FR-019**: When none exists, apply MUST ask NPM to request a Let's
  Encrypt certificate for exactly the route's hostnames before creating or
  updating that proxy host (NPM registers it under the login account's
  email); a failed request MUST fail that
  route without leaving a proxy host behind that lacks a certificate.
- **FR-020**: A proxy host whose current certificate still covers its
  hostnames MUST keep that certificate.

**Inspection**

- **FR-021**: The driver's snapshot MUST return a readable rendering of
  every Bellhop proxy host (hostnames, backend, certificate, whether gated).
- **FR-022**: The documentation (README/docs and CLAUDE.md) MUST describe
  the driver, its credentials file, the certificate behaviour, and the
  ownership rule, and MUST record the single-deployment assumptions it
  makes.

### Key Entities

- **NPM proxy host**: NPM's object for one site: hostnames, backend
  scheme/address/port, certificate, HTTPS and WebSocket settings, and a
  free-text custom configuration. Bellhop's own are those carrying its
  mark.
- **NPM certificate**: a certificate NPM holds, with the names it covers and
  its expiry. May be operator-made (for example a wildcard) or requested by
  Bellhop.
- **Proxy route**: the existing driver-neutral route Bellhop derives from
  the inventory (owner, hostnames, backend, auth mode, exempt paths).
- **Sync plan**: the per-route create/update/unchanged decisions, deletions,
  certificate requests, and conflicts computed by the dry run and carried
  out by apply.
- **NPM connection settings**: login email and password and an optional
  API address, kept only in the gitignored credentials file.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An operator with a running NPM instance goes from selecting
  the driver to every inventory site served through NPM with one
  `sync-proxy --apply`, with no manual proxy host or certificate creation
  when a covering wildcard certificate exists.
- **SC-002**: Across repeated syncs of an unchanged inventory, zero changes
  are made to NPM after the first.
- **SC-003**: Zero hand-made proxy hosts are modified or deleted by any
  sync, in every tested scenario.
- **SC-004**: Every change the dry run lists is the change apply makes, and
  apply makes no change the dry run did not list.
- **SC-005**: A forward-gated site synced through the driver refuses an
  unauthenticated request to a non-exempt path and allows one to an exempt
  path, verified against a real NPM instance.
- **SC-006**: Every failure (missing credentials, unreachable NPM, rejected
  object, conflict) produces an error that names what failed and what to
  do next, within the fixed request timeout.

## Assumptions

- NPM version 2.x, whose REST API has proxy hosts, certificates, and token
  login, is the supported target; behaviour is verified against a current
  release run locally in a container, and fixtures are captured from it and
  redacted.
- NPM's admin API is reachable over HTTP from the machine Bellhop runs on
  (the operator's LAN); exposing it is the operator's decision, the same as
  Authentik's API today.
- Certificates Bellhop requests use NPM's default HTTP challenge, so the
  hostnames must be reachable from the internet on port 80 through NPM.
  Wildcard and DNS-challenge certificates are created by the operator in
  NPM's own interface and are then reused automatically.
- One NPM instance per deployment, fronting every route; the NPM login is
  an admin account (or one allowed to manage proxy hosts and certificates).
- `prune-acme-challenges` is not run for this driver: Bellhop never starts
  a DNS challenge through it.
- Out of scope: DNS-challenge certificate requests from Bellhop, NPM access
  lists, streams, redirection and 404 hosts, deleting certificates Bellhop
  requested once no proxy host uses them, and any web UI beyond the Settings
  dropdown listing the driver.
