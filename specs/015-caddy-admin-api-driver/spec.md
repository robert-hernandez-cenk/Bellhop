# Feature Specification: Caddy Admin-API Proxy Driver

**Feature Branch**: `claude/trusting-wright-k5310i`

**Created**: 2026-09-29

**Status**: Draft

**Input**: User description: "Issue #26: Caddy admin-API proxy driver. A second Caddy driver that configures Caddy through its admin API instead of the Caddyfile."

## Background

Issue #10 put a driver seam between the inventory and the reverse proxy.
Issues #30 and #33 then added the nginx and "no proxy" drivers. Both drivers
that actually manage a proxy (Caddy, nginx) write a configuration file over
SSH, validate it, and reload the proxy.

Caddy can also be configured through its admin API: a JSON document, read
and changed over HTTP on the proxy host (`localhost:2019` by default),
applied atomically with automatic rollback on a bad load. This feature adds
a second Caddy driver that reconciles the inventory's routes against that
live configuration instead of a Caddyfile section. It is the cheapest real
test of the driver interface's reconcile-shaped side
(`specs/006-reverse-proxy-driver/research.md` R1, R4, R8), since Caddy's own
routing, TLS, and forward-auth behavior stay exactly what the file driver
already produces. Only the delivery mechanism changes.

Decisions carried over from the issue:

- **Reached over SSH.** Bellhop talks to the admin API through the proxy
  host (the `proxy: true` entry), the same way the file drivers reach their
  files, so the admin endpoint is never exposed on the network.
- **Separate driver id.** The new driver is selected with its own
  `proxyDriver` value and coexists with the file-based `caddy` driver, which
  stays the default and is unchanged.
- **Ownership by tag.** Every configuration object Bellhop creates carries
  a Bellhop identifier. Untagged objects belong to the operator and are
  never changed or removed, the same way content outside the file driver's
  managed markers is left alone today.
- **Assisted switch (clarified 2026-09-29).** Moving from the file-based
  Caddy driver goes through a one-time, previewable conversion command
  rather than documented manual steps or automatic adoption of untagged
  routes during sync.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Publish inventory sites through Caddy's admin API (Priority: P1)

An operator runs Caddy from its API-configured service, which resumes from
its last saved configuration on restart. They select the new driver
(`set-config proxyDriver caddy-api --apply`, or the Settings page dropdown)
and run `sync-proxy`. The dry run shows the routes Bellhop would add,
replace, and remove. `--apply` makes those changes in the running Caddy.
Every inventory entry with subdomains then answers HTTPS at each of its
hostnames and reaches its backend, with no Caddyfile involved.

**Why this priority**: this is the driver itself. Nothing else in this
feature has anything to act on without it.

**Independent Test**: with an example inventory and a fake SSH client that
answers the admin API's reads from a captured, redacted Caddy configuration,
select the driver and run `sync-proxy` dry run and apply. Assert the preview
and the configuration the fake client received.

**Acceptance Scenarios**:

1. **Given** an inventory with ungated entries, a running Caddy with no
   Bellhop routes, and `proxyDriver` set to `caddy-api`, **When** the
   operator runs `sync-proxy` without `--apply`, **Then** it prints one
   route to add per entry (its hostnames, canonical first, and its backend
   address and port) and changes nothing in Caddy.
2. **Given** the same state, **When** the operator runs `sync-proxy
   --apply`, **Then** Caddy's live configuration holds one Bellhop-tagged
   route per entry, and each hostname is served over HTTPS with a
   certificate Caddy obtains the same way the file-based Caddy driver's
   sites do.
3. **Given** routes already in sync with the inventory, **When**
   `sync-proxy` runs again, **Then** the preview reports no changes and
   `--apply` sends no change to Caddy.
4. **Given** an entry whose port, hostnames, or `insecureBackendTls`
   changed, **When** it is synced, **Then** its Bellhop route is replaced
   and every other route is untouched.
5. **Given** a Bellhop route whose entry no longer produces a route (it lost
   its subdomains, was deleted, or was marked `proxyManual`), **When** it is
   synced, **Then** that route is removed.
6. **Given** the operator edits a guest's subdomains on the Dashboard with
   this driver active, **When** the edit saves, **Then** the change is live
   in Caddy in the same request, exactly as with the other drivers.

---

### User Story 2 - Never touch configuration Bellhop did not create (Priority: P1)

An operator's Caddy also serves hand-authored sites: a landing page, the
status-page site, and the blocks behind `proxyManual` entries. Bellhop must
only ever change or remove the objects it tagged itself, and must say so
when a hand-authored route already claims a hostname the inventory wants.

**Why this priority**: an operator adopting the driver on a Caddy that
already serves real sites must not lose any of them. A driver that removes
unrecognised routes is unusable there.

**Independent Test**: seed the fake configuration with untagged routes for
an unrelated hostname and for one inventory hostname. Run dry run and apply,
and assert neither untagged route is modified and the conflict is named.

**Acceptance Scenarios**:

1. **Given** an untagged route for a hostname no inventory entry uses,
   **When** `sync-proxy --apply` runs, **Then** it is left exactly as it
   was, including its position relative to other untagged routes.
2. **Given** an untagged route that claims a hostname of an inventory
   route, **When** `sync-proxy` runs, **Then** the dry run lists it as a
   conflict naming the hostname and the inventory entry. `--apply` leaves
   the untagged route alone, applies every non-conflicting change, and then
   fails with an error naming each conflict and how to resolve it (remove
   or change the hand-authored route, or mark the entry `proxyManual`).
3. **Given** a conflict found during a Dashboard guest edit, **When** the
   edit saves, **Then** the inventory change is kept and the push-live
   failure is reported the way any other driver's failure is.

---

### User Story 3 - Gate sites behind Authentik forward-auth (Priority: P1)

An operator gates an entry with `authGroup` in forward mode. Its Caddy
route must send every request through the Authentik outpost before it
reaches the backend, except for the entry's `unauthenticatedPaths`, and
must behave the same as the file-based Caddy driver's site block.

**Why this priority**: gating is a core Bellhop feature. The file-based
Caddy driver supports it, so switching to this driver must never silently
ungate an app.

**Independent Test**: sync a forward-gated entry with exempt paths through
the fake client. Assert the route checks requests against the outpost,
passes the outpost's own paths straight through, forwards the identity
headers, and skips the check for the exempt paths only.

**Acceptance Scenarios**:

1. **Given** a forward-gated entry, **When** it is synced, **Then** its
   route checks every request against the Authentik outpost, passes
   requests under the outpost's own path prefix straight to the outpost,
   and forwards the same five identity headers the file-based Caddy driver
   forwards.
2. **Given** that entry's `unauthenticatedPaths` holds `/api/*` and
   `/health`, **When** it is synced, **Then** requests under `/api/` and
   to exactly `/health` reach the backend without the check, and every
   other path is still checked.
3. **Given** an entry in OIDC mode or ungated, **When** it is synced,
   **Then** its route carries no forward-auth check.
4. **Given** a gated entry whose gate is removed, **When** it is synced,
   **Then** its route no longer checks requests against the outpost.

---

### User Story 4 - Refuse a Caddy that would lose Bellhop's changes (Priority: P2)

Configuration set through the admin API is discarded whenever Caddy
reloads a Caddyfile. An operator who selects this driver while Caddy is
still running from a Caddyfile must be stopped before any change is made,
rather than finding their sites gone after the next reload or restart.

**Why this priority**: without this check the driver appears to work and
then loses every change later, with no connection to the cause.

**Independent Test**: have the fake SSH client report the Caddyfile-based
service as the one running, and assert `sync-proxy` (dry run and apply)
fails with the named error and sends no change.

**Acceptance Scenarios**:

1. **Given** the proxy host runs Caddy from a Caddyfile, **When**
   `sync-proxy` runs with this driver in either dry run or `--apply`,
   **Then** it fails before changing anything, with an error explaining
   that API changes would be lost and naming how to switch Caddy to its
   API-configured, resuming service.
2. **Given** the admin API is unreachable on the proxy host, **When**
   `sync-proxy` runs, **Then** it fails with an error naming the proxy host
   and the admin address it tried.

---

### User Story 5 - Move from the Caddyfile driver to this one (Priority: P2)

An operator already using the file-based Caddy driver wants to switch. Their
Caddyfile holds both a Bellhop-managed section and hand-authored sites.
After switching, the hand-authored sites must keep working and the
inventory's sites must end up as Bellhop-tagged routes, without every
inventory hostname being reported as a conflict.

**Why this priority**: most operators who want this driver are coming from
the file-based one, so this is the realistic adoption path. It comes after
the driver itself works.

Bellhop provides a one-time conversion command for this, with the usual dry
run and `--apply`. It reads the live Caddyfile on the proxy host, sets aside
the Bellhop-managed section, converts the rest into Caddy's configuration
using Caddy's own converter, and adds the inventory's routes as
Bellhop-tagged routes. The result is one previewable starting
configuration. The operator then switches Caddy to its API-configured
service and selects the new driver.

**Independent Test**: with a fake SSH client that returns an example
Caddyfile (hand-authored sites plus a managed section) and a captured,
redacted output of Caddy's converter, run the conversion's dry run and
apply. Assert the preview, that no managed-section site appears untagged,
that every inventory route appears tagged, and what the fake client
received.

**Acceptance Scenarios**:

1. **Given** an operator on the file-based Caddy driver, **When** they run
   the conversion without `--apply`, **Then** it shows the hand-authored
   sites it will keep, the Bellhop routes it will add, and any conflicts,
   and changes nothing on the proxy host.
2. **Given** the same state, **When** they run it with `--apply`, **Then**
   the resulting configuration is loaded into Caddy and saved so that the
   API-configured service resumes from it. The Caddyfile itself is left in
   place, unchanged, as a fallback.
3. **Given** the conversion was applied and the operator followed the
   documented remaining steps (switch the Caddy service, select the
   driver), **When** they check each site, **Then** every hand-authored
   site still answers and every inventory site is served by a
   Bellhop-tagged route.
4. **Given** the switch is done, **When** `sync-proxy` runs, **Then** it
   reports no changes and no conflicts caused by the old managed section.
5. **Given** a hand-authored site in the Caddyfile claims an inventory
   hostname, **When** the conversion runs, **Then** it reports the conflict
   the same way `sync-proxy` does (User Story 2), keeps the hand-authored
   site, and does not add the conflicting Bellhop route.
6. **Given** the Caddyfile has no managed section (the operator never used
   the file-based driver), **When** the conversion runs, **Then** it
   converts the whole file and adds the inventory's routes.

---

### User Story 6 - See the deployed configuration on the status page (Priority: P3)

The status page's "Deployed proxy configuration" section shows what Caddy is
actually running when this driver is active, instead of a file's contents.

**Why this priority**: useful for checking what is live, but everything else
works without it.

**Independent Test**: render the status page with the fake client's
configuration and assert the section shows it in readable form.

**Acceptance Scenarios**:

1. **Given** this driver is active and `statusPagePath` is set, **When** the
   status page is rendered, **Then** the section shows Caddy's live
   configuration, formatted for reading.
2. **Given** the current inventory is invalid (for example a missing
   Authentik address), **When** the status page is rendered, **Then** the
   section still shows the live configuration, as it does for the file
   drivers.

---

### Edge Cases

- **Configuration changed between read and write.** If Caddy's live
  configuration changes after Bellhop reads it and before Bellhop writes,
  the apply is abandoned without changing anything and fails with an error
  saying to run it again.
- **A rejected change.** If Caddy rejects the new configuration, the running
  configuration stays exactly as it was (Caddy's own rollback) and the
  apply fails with Caddy's error message.
- **Several HTTPS servers.** If Caddy's configuration has more than one
  server listening on the HTTPS port, or none, Bellhop cannot tell where its
  routes belong. It fails with an error naming what it found and how to fix
  it, and makes no change.
- **Empty Caddy.** A Caddy with no configuration yet gets an HTTPS server
  created to hold Bellhop's routes.
- **Route order.** Bellhop's routes are placed so that no hand-authored
  catch-all route can shadow them. A hand-authored route that claims the
  same hostname is a conflict (User Story 2), not a silent override.
- **A tagged object edited by hand.** A Bellhop-tagged route that an
  operator changed by hand is replaced with what the inventory says on the
  next sync, the same way hand edits inside the file driver's managed
  section are overwritten today.
- **Certificate settings.** Bellhop tags its own certificate-automation
  settings for its hostnames and never changes untagged certificate
  settings. If an untagged certificate policy already covers a Bellhop
  hostname, that is reported as a conflict, not overwritten.
- **Conversion run twice.** Once Caddy holds Bellhop-tagged routes, the
  conversion refuses to run again and points at `sync-proxy`, so it can
  never replace a live API configuration with an old Caddyfile's content.
- **Conversion while Caddy still runs from the Caddyfile.** The conversion
  is the one action allowed in that state (FR-010 applies to `sync-proxy`,
  not to the conversion). Its output tells the operator to switch the
  service next, since a reload before that would discard the load.
- **Switching back.** Changing `proxyDriver` from this driver to another
  leaves Caddy's live configuration as it is. Bellhop does not clean up its
  tagged routes on a driver change. Removing them is documented as part of
  switching away.
- **The status page site.** The status page site itself is hand-authored and
  untagged, so it is never managed by this driver.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST offer a new reverse-proxy driver, selectable
  through the existing `proxyDriver` setting from the CLI (`set-config`) and
  the Settings page dropdown, alongside and independent of the existing
  Caddy, nginx, and "no proxy" drivers. The existing Caddy driver MUST stay
  the default and MUST behave exactly as before.
- **FR-002**: The driver MUST reach Caddy's admin API only through the proxy
  host (the `proxy: true` entry) using the toolkit's existing remote
  execution path. It MUST NOT require the admin endpoint to be reachable
  from the network.
- **FR-003**: `sync-proxy`'s dry run MUST list every route the driver would
  add, replace, or remove and every conflict it found, and MUST change
  nothing. `--apply` MUST make exactly the changes the dry run listed.
- **FR-004**: Applying MUST be all-or-nothing. Either every non-conflicting
  change takes effect or, if Caddy rejects the result, none does and the
  running configuration is unchanged.
- **FR-005**: The driver MUST detect a change to Caddy's configuration made
  between reading it and writing it, and MUST abandon the write rather than
  overwrite that change.
- **FR-006**: Every object the driver creates MUST carry a Bellhop
  identifier derived from the entry's canonical subdomain. The driver MUST
  NOT change, move, or remove any object without that identifier.
- **FR-007**: An untagged route or certificate policy that claims a hostname
  of an inventory route MUST be reported as a conflict naming the hostname,
  the entry, and how to resolve it. The conflicting inventory route MUST be
  skipped, all other changes MUST still be applied, and the apply MUST then
  fail with the conflicts listed.
- **FR-008**: For each route, the served behavior MUST match the file-based
  Caddy driver's site block for the same inventory: hostnames, backend
  address and port, the `X-Forwarded-Port` header, untrusted backend TLS
  when `insecureBackendTls` is set, certificates obtained through
  Cloudflare DNS-01, and, for a forward-gated route, the outpost check,
  outpost passthrough, the five identity headers, and exempt paths.
- **FR-009**: The driver MUST declare forward and OIDC auth modes and
  Cloudflare DNS-01 certificate issuance, so the capability check accepts
  the same entries as the file-based Caddy driver and stale ACME challenge
  records keep being pruned after Dashboard edits.
- **FR-010**: Before any change, in both dry run and apply, the driver MUST
  refuse to proceed when Caddy on the proxy host is running from a
  Caddyfile, with an error that explains API changes would be lost and
  names how to switch to the API-configured, resuming service.
- **FR-011**: When the admin API cannot be reached, or its configuration
  cannot be read, the driver MUST fail with an error naming the proxy host,
  the address tried, and the underlying failure.
- **FR-012**: The Dashboard guest edit, provisioning jobs, `migrate-guest`,
  the MCP server, and the CLI MUST all use this driver through the existing
  driver interface, with the same failure reporting the other drivers have
  (for example `proxySynced: false` on a Dashboard edit).
- **FR-013**: The driver's status-page snapshot MUST show Caddy's live
  configuration in readable form, and MUST NOT depend on the inventory
  being valid.
- **FR-014**: The Settings page MUST NOT show the proxy config path or TLS
  certificate fields for this driver, since it uses no configuration file.
  It MUST show the status page path field.
- **FR-015**: The system MUST provide a one-time conversion action from a
  Caddyfile to this driver's configuration, reachable from the CLI. It MUST
  default to a dry run and act only with `--apply`. It MUST drop the
  Bellhop-managed section, convert the remaining Caddyfile content with
  Caddy's own converter on the proxy host, add the inventory's routes
  tagged as Bellhop's, report conflicts by the same rules as FR-007, load
  the result into Caddy all-or-nothing, and leave the Caddyfile unchanged.
  It MUST fail with a named error if the Caddyfile cannot be read or Caddy
  cannot convert it, and MUST refuse to overwrite a Caddy that already
  holds Bellhop-tagged routes, since the conversion is for the first switch
  only.
- **FR-016**: The documentation MUST describe the driver's prerequisites
  (the API-configured, resuming Caddy service; the Cloudflare token in
  Caddy's environment), how hand-authored sites live alongside Bellhop's
  routes, how to switch to the driver (the conversion, then switching the
  Caddy service, then selecting the driver) and away from it, and that there is no
  longer a human-readable configuration file of record.
- **FR-017**: The branch MUST record the single-operator assumptions this
  driver keeps or adds: the fixed admin address on the proxy host, Caddy
  running under systemd, and the hardcoded Cloudflare DNS-01 issuance shared
  with the file-based Caddy driver.

### Key Entities

- **Bellhop route**: one Caddy route per inventory route, tagged with a
  Bellhop identifier from the entry's canonical subdomain. It holds the
  route's hostnames, backend, header, TLS-transport settings, and, when
  forward-gated, the outpost check and passthrough.
- **Bellhop certificate policy**: Caddy's certificate-automation settings
  for the hostnames of Bellhop routes (Cloudflare DNS-01, fixed resolvers),
  tagged the same way.
- **Operator configuration**: every untagged object in Caddy's
  configuration, including hand-authored sites and `proxyManual` blocks.
  It is read (for conflict detection and placement) but never changed.
- **Conflict**: an inventory hostname already claimed by an untagged route
  or certificate policy. It carries the hostname, the inventory entry, and
  what claims it.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For the example inventory, every site the new driver
  publishes behaves the same as the file-based Caddy driver's site for the
  same entry: the same hostnames, backend, headers, gating, exempt paths,
  and certificate issuance. This is verified once against a real Caddy
  instance by comparing the two drivers' output as Caddy itself interprets
  it.
- **SC-002**: Across a sync that adds, replaces, and removes Bellhop routes,
  100% of untagged configuration objects are unchanged afterwards.
- **SC-003**: A second `sync-proxy --apply` with no inventory change sends
  zero changes to Caddy.
- **SC-004**: A rejected or interrupted apply leaves Caddy serving exactly
  what it served before, with no partial update.
- **SC-005**: An operator with Caddy still running from a Caddyfile is
  stopped before the first change, with an error that tells them how to
  fix it. No sync leaves changes that a later reload silently discards.
- **SC-006**: A Dashboard subdomain edit is live in Caddy when the edit's
  request completes, the same as with the file-based Caddy driver.

## Assumptions

- The admin API listens at Caddy's default `localhost:2019` on the proxy
  host, and the proxy host has `curl` (or an equivalent HTTP client)
  available to reach it. A configurable admin address is out of scope for
  this issue.
- Caddy runs under systemd on the proxy host (the same assumption the
  file-based driver's reload command already makes), using the packaged
  API-configured service that resumes from its autosaved configuration.
- The Cloudflare API token stays in Caddy's own environment and is
  referenced by placeholder, never written into the configuration by
  Bellhop, as with the file-based driver.
- Caddy's version supports the admin API's object identifiers and
  conditional writes (current stable Caddy 2 releases do).
- The snapshot shows the whole live configuration, matching the file-based
  driver, which shows the whole Caddyfile. The status page stays LAN-only as
  it is today.
- Test fixtures for Caddy's configuration are captured from a real Caddy
  instance and redacted to example values (constitution Principles I and
  III), not hand-authored.
- An admin-API variant for nginx, Nginx Proxy Manager (#31), and HAProxy is
  out of scope.
