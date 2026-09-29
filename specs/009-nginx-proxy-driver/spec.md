# Feature Specification: nginx Proxy Driver

**Feature Branch**: `issue-30-nginx-proxy-driver`

**Created**: 2026-09-28

**Status**: Draft

**Input**: User description: "Issue #30: nginx reverse-proxy driver. A second file-configured driver, `nginx`, alongside the Caddy driver from issue #10, using one shared TLS certificate for every site."

## Background

Issue #10 put a driver seam between the inventory and the reverse proxy and
shipped Caddy as its only driver. An operator whose proxy host runs plain
nginx still cannot use `sync-proxy`, the Dashboard's live subdomain edits,
or Authentik gating through Bellhop.

nginx differs from Caddy in one way that shapes this feature: it cannot
obtain certificates on its own. Caddy requests a certificate per site
through Cloudflare DNS-01 the first time a site appears, so adding a
subdomain needs no certificate step. To keep that property, every site the
nginx driver generates uses **one shared certificate** — normally a
wildcard for the operator's domain — issued and renewed by a tool the
operator runs (for example certbot with a DNS plugin). Bellhop points nginx
at the certificate; it does not issue it.

The concept mapping this driver follows was worked out on paper in issue
#10 (`specs/006-reverse-proxy-driver/research.md`, R3/R5/R6/R8).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Generate and deploy nginx configuration (Priority: P1)

An operator whose proxy host runs nginx selects the nginx driver
(`set-config proxyDriver nginx --apply`, or the Settings page) and runs
`sync-proxy`. The dry run shows the complete configuration file Bellhop
will own; `--apply` writes it, checks it with nginx's own configuration
test, and reloads nginx. Every inventory entry with subdomains is reachable
over HTTPS at each of its hostnames and reaches its backend.

**Why this priority**: this is the driver itself. Without it nothing else
in this feature has anything to act on.

**Independent Test**: with an example inventory and a fake SSH client,
select the nginx driver and run `sync-proxy` dry run and apply; assert the
previewed file and the script sent to the proxy host. Separately, run the
generated delivery script locally with stub `nginx`/`systemctl` commands
to show a failed configuration test restores the previous file.

**Acceptance Scenarios**:

1. **Given** an inventory with ungated entries and `proxyDriver` set to
   `nginx`, **When** the operator runs `sync-proxy` without `--apply`,
   **Then** it prints one site per entry, each answering HTTPS on port 443
   (IPv4 and IPv6) for all of the entry's hostnames (canonical first) and
   forwarding to the entry's backend address and port, and changes
   nothing.
2. **Given** the same inventory, **When** the operator runs `sync-proxy
   --apply`, **Then** Bellhop replaces its own configuration file on the
   proxy host (default `/etc/nginx/conf.d/bellhop.conf`, overridable with
   `proxyConfigPath`), runs nginx's configuration test, and reloads nginx.
3. **Given** a generated configuration that nginx's test rejects (for
   example a certificate file that does not exist), **When** the operator
   applies, **Then** the previous file is restored (or the new file
   removed if there was none), nginx is not reloaded, and the command
   fails with nginx's error.
4. **Given** the nginx driver is active, **When** a Dashboard subdomain
   edit or a provisioning job pushes proxy configuration live, **Then** it
   goes through the nginx driver, and the stale-ACME-record cleanup step
   is skipped with its usual one-line note, since nginx never creates
   those records.
5. **Given** a backend flagged `insecureBackendTls`, or a backend on port
   443, **When** configuration is generated, **Then** nginx connects to it
   over HTTPS, without certificate verification when
   `insecureBackendTls` is set.
6. **Given** any generated site, **When** a client uses it, **Then** it
   behaves like the Caddy driver's sites: the original `Host` is passed to
   the backend, the backend is told the client's address and scheme and
   that the external port is 443, WebSocket connections work, uploads are
   not size-limited by the proxy, and responses are streamed rather than
   buffered.

---

### User Story 2 - Authentik forward-auth gating on nginx (Priority: P1)

An entry gated with `authGroup` in forward mode is protected by Authentik
on the nginx driver exactly as it is on Caddy: an unauthenticated browser
is sent to Authentik's sign-in and returned afterwards, the backend
receives the signed-in user's identity headers, and any
`unauthenticatedPaths` are reachable without signing in. OIDC-mode and
ungated entries get no forward-auth.

**Why this priority**: a gated app that the new driver silently left open
would be worse than no driver at all.

**Independent Test**: render configuration for forward-gated entries with
and without exempt paths and assert the generated gating, sign-in
redirect, identity headers, and exempt locations.

**Acceptance Scenarios**:

1. **Given** a forward-gated entry, **When** configuration is generated,
   **Then** every request to it is checked against the Authentik outpost
   before reaching the backend; a request that fails the check is
   redirected to Authentik's sign-in and returned to the original URL
   afterwards; Authentik's own outpost paths on that hostname are passed
   to the outpost; and the backend receives the username, groups, email,
   name, and uid identity headers.
2. **Given** a forward-gated entry with `unauthenticatedPaths` containing an
   exact path and a `/*` prefix, **When** configuration is generated,
   **Then** requests to exactly that path, and to anything under that
   prefix, reach the backend without the Authentik check, and every other
   path is still checked.
3. **Given** exempt paths that repeat, or an exempt `/*`, **When**
   configuration is generated, **Then** the result still passes nginx's
   configuration test (no duplicate locations), and an exempt `/*` leaves
   the whole site unchecked, matching Caddy.
4. **Given** an OIDC-mode or ungated entry, **When** configuration is
   generated, **Then** it has no forward-auth check and no outpost
   passthrough.

---

### User Story 3 - Choose the shared certificate (Priority: P2)

The operator tells Bellhop where the shared certificate and key live with
two settings, `proxyTlsCertificate` and `proxyTlsKey`, from `set-config`
or the web Settings page. When they are unset, Bellhop uses certbot's
layout for a certificate named after the inventory domain.

**Why this priority**: the defaults cover the common certbot wildcard
setup, so the driver is usable without these settings; they matter for
anyone whose certificate lives elsewhere.

**Independent Test**: set, show, and unset both settings through
`set-config` and the Settings API; assert the generated configuration
references the configured paths, or the defaults when unset.

**Acceptance Scenarios**:

1. **Given** neither setting is set and the inventory domain is
   `example.com`, **When** configuration is generated, **Then** every site
   uses `/etc/letsencrypt/live/example.com/fullchain.pem` and
   `/etc/letsencrypt/live/example.com/privkey.pem`.
2. **Given** both settings are set, **When** configuration is generated,
   **Then** every site uses those paths.
3. **Given** a relative path, **When** the operator tries to save either
   setting from the CLI or the Settings page, **Then** it is rejected with
   the same "must be an absolute path" rule in both.
4. **Given** the Caddy driver is active, **When** either setting is set,
   **Then** Caddy's generated configuration is unchanged.

### Edge Cases

- No entry has subdomains: the owned file still exists, holding only its
  "managed by Bellhop" header, so nginx serves nothing from it.
- A forward-gated entry with no `authentik: true` entry to address: the
  existing missing-authentik error is raised before anything is written,
  as with Caddy.
- The configured certificate is missing or unreadable on the proxy host:
  nginx's configuration test fails and the previous configuration is
  restored (User Story 1, scenario 3).
- An exempt path containing characters nginx treats specially (spaces,
  quotes, `;`, `{`): the path is quoted so it is matched literally and the
  file still parses.
- The operator's own nginx configuration already serves one of the same
  hostnames on 443: nginx reports a conflicting server name; resolving
  that overlap is the operator's job (Bellhop only owns its own file).
- Switching `proxyDriver` from `caddy` to `nginx` does not remove the old
  Caddyfile managed section; the operator retires Caddy themselves.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST offer `nginx` as a `proxyDriver` value in
  every place the setting is accepted (CLI `set-config`, web Settings
  page), validated by the same rule in both.
- **FR-002**: The nginx driver MUST own one whole configuration file on
  the proxy host, defaulting to `/etc/nginx/conf.d/bellhop.conf` and
  honouring `proxyConfigPath`; it MUST NOT modify any other nginx file.
- **FR-003**: Applying MUST back up the existing file, write the new one,
  run nginx's configuration test, and on failure restore the backup (or
  remove the new file) and not reload; on success it MUST reload nginx.
  The dry-run preview MUST be exactly the file apply writes.
- **FR-004**: The driver MUST declare support for both forward-auth and
  OIDC gating, and MUST declare that it does not create Cloudflare
  DNS-01 challenge records, so the push-live step skips stale-record
  cleanup.
- **FR-005**: Each route MUST become one HTTPS site on port 443, IPv4 and
  IPv6, answering for all of the route's hostnames with the canonical one
  first, and using the shared certificate and key.
- **FR-006**: Each site MUST forward to the route's backend, passing the
  original host, client address, scheme, and external port 443; supporting
  WebSocket upgrades; with no request-body size limit; and without
  response buffering.
- **FR-007**: The backend connection MUST use HTTPS when the route has
  `insecureBackendTls` (with certificate verification disabled) or its
  backend port is 443, and plain HTTP otherwise.
- **FR-008**: A forward-gated route MUST check every request against the
  Authentik outpost's nginx endpoint, redirect a failed check to
  Authentik's sign-in with the original URL as the return address, pass
  the outpost's own paths through to the outpost, and forward the five
  identity headers the Caddy driver forwards.
- **FR-009**: A forward-gated route's `unauthenticatedPaths` MUST be
  exempt from the check: an exact path matches only that path, a `/*`
  prefix matches everything under it. Duplicates MUST NOT produce
  duplicate locations, an exempt `/*` MUST disable the check for the whole
  site, and every path MUST be emitted so that it is matched literally.
- **FR-010**: OIDC-mode and ungated routes MUST get no forward-auth check
  or outpost passthrough.
- **FR-011**: The system MUST provide two optional settings,
  `proxyTlsCertificate` and `proxyTlsKey`, each an absolute path, settable
  and clearable through `set-config` and the web Settings page under the
  same validation rule.
- **FR-012**: When `proxyTlsCertificate`/`proxyTlsKey` are unset, the
  certificate paths MUST default to
  `/etc/letsencrypt/live/<domain>/fullchain.pem` and
  `/etc/letsencrypt/live/<domain>/privkey.pem`, where `<domain>` is the
  inventory's `domain` — derived from the operator's own inventory, not a
  hardcoded operator value.
- **FR-013**: Adding the nginx driver and the two settings MUST NOT change
  the Caddy driver's generated configuration for any inventory.
- **FR-014**: README and CLAUDE.md MUST describe the nginx driver, its
  certificate prerequisite (issuing and renewing the shared certificate,
  and reloading nginx after renewal, are the operator's job), and the two
  new settings.

### Key Entities

- **Shared TLS certificate**: the certificate and private-key file paths on
  the proxy host every nginx site uses. Resolved from `proxyTlsCertificate`
  / `proxyTlsKey`, else the certbot default for the inventory domain. Part
  of the proxy-neutral context every driver receives; the Caddy driver
  ignores it.
- **nginx configuration file**: the single file on the proxy host Bellhop
  owns and replaces whole on every apply.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An operator with nginx on the proxy host and a wildcard
  certificate in certbot's default location can go from selecting the
  driver to every inventory site being served through nginx with one
  `set-config` and one `sync-proxy --apply`, with no hand-written nginx
  configuration for those sites.
- **SC-002**: 100% of forward-gated entries are gated on nginx; no
  combination of auth mode and exempt paths produces an ungated site that
  Caddy would have gated.
- **SC-003**: A configuration nginx rejects never reaches the running
  proxy: after a failed apply, the file on disk is byte-identical to the
  one before it and nginx was not reloaded.
- **SC-004**: The Caddy driver's generated configuration is byte-identical
  before and after this change for every existing test inventory.
- **SC-005**: Adding a subdomain from the Dashboard on the nginx driver
  goes live in the same save, with no certificate step, as it does on
  Caddy.

## Assumptions

- The proxy host runs a distribution-packaged nginx managed by systemd,
  whose main configuration includes `/etc/nginx/conf.d/*.conf` inside its
  `http` block (the Debian/Ubuntu and upstream-package default). Other
  layouts use `proxyConfigPath`.
- nginx on the proxy host was built with the `auth_request` module (it is
  in the standard Debian/Ubuntu and nginx.org packages).
- The operator obtains and renews the shared certificate outside Bellhop,
  and arranges for nginx to reload after renewal (for example a certbot
  deploy hook).
- One certificate covers every hostname Bellhop serves, which in practice
  means a wildcard for the inventory domain.
- Out of scope: redirecting HTTP (port 80) to HTTPS — left to the
  operator's own configuration so it cannot clash with their certificate
  tool or default server; HTTP/2 (its directive differs between nginx
  versions); Bellhop-issued certificates; Nginx Proxy Manager (#31) and
  HAProxy (#32).
- The CLAUDE.md single-operator assumption list gains nothing new: the
  certificate default is derived from the inventory domain, not hardcoded.
