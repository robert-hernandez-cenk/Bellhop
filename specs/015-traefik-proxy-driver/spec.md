# Feature Specification: Traefik Proxy Driver

**Feature Branch**: `issue-35-traefik-proxy-driver`

**Created**: 2026-09-29

**Status**: Draft

**Input**: User description: "Issue #35: Traefik proxy driver. A Traefik driver, selected with `proxyDriver traefik`, configured through Traefik's file provider."

## Background

Issue #10 put a driver seam between the inventory and the reverse proxy.
Caddy and nginx (issue #30) write a configuration file over SSH, Nginx
Proxy Manager (issue #31) is reconciled over its REST API, and `none`
(issue #33) manages nothing. An operator running
[Traefik](https://traefik.io/) cannot use `sync-proxy`, the Dashboard's live
subdomain edits, or Authentik gating through Bellhop.

Traefik's API is read-only, so the only write path Bellhop has is Traefik's
**file provider**: a directory of dynamic-configuration files that Traefik
watches and reloads on change. Traefik's usual Docker-labels provider does
not fit, because inventory entries are Proxmox hosts, guests and external
sites, not containers on the proxy host.

Traefik differs from the existing file-configured drivers in two ways that
shape this feature:

- **No validate command.** Traefik has no equivalent of `caddy validate` or
  `nginx -t` for dynamic configuration. A bad file is logged, and the
  affected routers are dropped or the previous configuration is kept.
- **Hot reload.** The file is live as soon as it is written, so there is no
  separate reload step, and no two-phase "check then activate" apply.

Two decisions made before specification:

- **Validation is optional, through Traefik's API.** When the operator
  configures the address of Traefik's API (a new `proxyApiUrl` setting),
  every apply waits until Traefik has loaded the new file and checks that
  none of Bellhop's routers reports an error, restoring the previous file
  if it does. When the setting is unset, the file is written without a
  check.
- **The certificate resolver name is a setting.** Routers name a Traefik
  certificate resolver that the operator defines in Traefik's own static
  configuration. A new `proxyCertResolver` setting names it, defaulting to
  `cloudflare`.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Publish inventory sites through Traefik (Priority: P1)

An operator whose proxy host runs Traefik points Traefik's file provider at
a directory (with watching on), defines a certificate resolver and a
`websecure` entry point in Traefik's static configuration, selects the
Traefik driver (`set-config proxyDriver traefik --apply`, or the Settings
page dropdown), and runs `sync-proxy`. The dry run prints the dynamic
configuration file Bellhop would write; `--apply` writes it. Every inventory
entry with subdomains then answers HTTPS at each of its hostnames with a
certificate from the named resolver, and reaches its backend.

**Why this priority**: this is the driver itself; everything else in this
feature builds on it.

**Independent Test**: with an example inventory, select the driver and run
`sync-proxy` dry run and apply against a fake SSH client; assert the
previewed file and the script sent to the proxy host.

**Acceptance Scenarios**:

1. **Given** an inventory with ungated entries and `proxyDriver` set to
   `traefik`, **When** the operator runs `sync-proxy`, **Then** the preview
   is one dynamic-configuration file with one router and one service per
   entry, each router matching all of that entry's hostnames (canonical
   first) on the `websecure` entry point with the configured certificate
   resolver, and nothing is written.
2. **Given** the same inventory, **When** the operator runs `sync-proxy
   --apply`, **Then** the file is written to the configured path on the
   proxy host exactly as previewed, and no reload command is run.
3. **Given** an entry whose backend port is 443, or which has
   `insecureBackendTls` set, **When** the file is rendered, **Then** its
   service reaches the backend over HTTPS; with `insecureBackendTls` the
   backend certificate is not verified, and otherwise it is.
4. **Given** any rendered file, **Then** every Bellhop router sends
   `X-Forwarded-Port: 443` to its backend, matching the Caddy and nginx
   drivers.
5. **Given** an inventory with no routable entries, **When** the file is
   rendered, **Then** it is still a valid, non-empty dynamic-configuration
   file.
6. **Given** the configured path holds a file Bellhop did not write (its
   first line is not Bellhop's generated header), **When** the operator
   runs `sync-proxy --apply`, **Then** the apply is refused before anything
   is touched, naming the path and how to change it.

---

### User Story 2 - Gate sites with Authentik forward-auth (Priority: P1)

An entry with an `authGroup` in forward mode is served only to users
Authentik lets through, exactly as under the Caddy and nginx drivers, and
its `unauthenticatedPaths` stay reachable without a login.

**Why this priority**: gating is why most operators route through Bellhop;
a driver that could not enforce it would reject every gated entry.

**Independent Test**: render a forward-gated entry, with and without exempt
paths, and assert the routers and middlewares in the file.

**Acceptance Scenarios**:

1. **Given** a forward-gated entry, **When** the file is rendered, **Then**
   its router runs a forward-auth check against the Authentik outpost's
   Traefik endpoint, trusting forwarded headers and passing the username,
   groups, email, name and uid identity headers on to the backend.
2. **Given** a forward-gated entry, **Then** requests under
   `/outpost.goauthentik.io/` on its hostnames go straight to the outpost,
   ahead of the gated router.
3. **Given** a forward-gated entry with exempt paths `/health` and
   `/api/*`, **Then** requests to exactly `/health` or anything under
   `/api/` reach the backend without the forward-auth check, and every
   other path is still checked.
4. **Given** a forward-gated entry whose only exempt path is `/*`, **Then**
   its router has no forward-auth check and no separate exempt router.
5. **Given** an exempt path inside the outpost namespace, **Then** it is
   skipped rather than rendered, so it can never capture outpost traffic.
6. **Given** an OIDC-mode or ungated entry, **Then** no forward-auth check
   and no outpost router is rendered for it.

---

### User Story 3 - Catch a configuration Traefik rejects (Priority: P2)

An operator who has Traefik's API enabled sets `proxyApiUrl` to its address
as reachable from the proxy host. From then on, every apply waits for
Traefik to load the new file and checks Bellhop's routers. If Traefik never
loads the file, or any Bellhop router reports an error or warning, the
previous file is put back and the apply fails with a message saying what
went wrong.

**Why this priority**: without it, a file Traefik rejects (a resolver name
the static configuration doesn't define, a missing entry point) is only
visible in Traefik's own log; with it, `sync-proxy` and the Dashboard
report the failure the same way a failed `nginx -t` is reported.

**Independent Test**: execute the generated apply script locally with a
stubbed `curl` on `PATH` that simulates Traefik loading, not loading, and
loading with an errored router; assert the file on disk and the exit
status in each case.

**Acceptance Scenarios**:

1. **Given** `proxyApiUrl` is unset, **When** the operator applies,
   **Then** the file is written and no check is made.
2. **Given** `proxyApiUrl` is set and Traefik loads the new file with every
   Bellhop router healthy, **When** the operator applies, **Then** the
   apply succeeds and the new file stays in place.
3. **Given** `proxyApiUrl` is set and Traefik does not load the new file
   within 30 checks one second apart, **When** the operator applies, **Then** the previous
   file is restored (or the new file removed, if there was none) and the
   apply fails, naming the timeout.
4. **Given** `proxyApiUrl` is set and Traefik loads the file but a Bellhop
   router reports an error or warning, **When** the operator applies,
   **Then** the previous file is restored and the apply fails, naming the
   router(s).
5. **Given** `proxyApiUrl` is set but unreachable from the proxy host,
   **When** the operator applies, **Then** the previous file is restored
   and the apply fails.

---

### User Story 4 - Configure the Traefik-only settings (Priority: P2)

The operator sets `proxyCertResolver` and `proxyApiUrl` with `set-config`
or on the Settings page. The Settings page shows those two fields only
while the Traefik driver is selected, the same way it shows nginx's TLS
certificate fields only for nginx.

**Why this priority**: the defaults work for an operator whose resolver is
named `cloudflare` and who skips the API check, so this is needed for the
rest, not for a first working setup.

**Independent Test**: set and clear each setting through `set-config` and
the settings API; render the Settings page with each driver selected and
assert which fields appear.

**Acceptance Scenarios**:

1. **Given** no `proxyCertResolver`, **Then** routers name the `cloudflare`
   resolver; **Given** it is set, **Then** they name that value.
2. **Given** a `proxyApiUrl` that is not an `http://` or `https://` URL,
   **When** it is submitted through `set-config` or the Settings page,
   **Then** both reject it with the same message.
3. **Given** the Settings page with Traefik selected, **Then** the resolver
   and API URL fields are shown; with any other driver selected they are
   hidden, and their stored values are left untouched.
4. **Given** the Settings page with Traefik selected, **Then** the status
   page path field is hidden, since this driver serves no status page.

### Edge Cases

- A `proxyManual` entry and the operator's status-page site are never
  rendered; they stay in the operator's own dynamic files.
- Two routers for different entries never collide: router, service and
  middleware names are derived from each entry's canonical hostname, which
  the inventory already keeps unique. The name encoding is only injective
  for valid DNS hostnames, so two canonical hostnames that still encode to
  the same name (`a-.b` and `a.-b`, say) make the render fail, naming
  both, rather than one overwriting the other.
- A `proxyConfigPath` ending in `/` (a directory), or not ending in
  `.yml`/`.yaml`, would be written somewhere Traefik's file provider never
  loads; the render (dry run and apply alike) fails naming the path and the
  `set-config` fix instead.
- A reapply that produces an identical file succeeds even though Traefik
  sees no change to reload.
- The driver serves no status page: `render-status-page` fails with the
  existing "driver serves no status page" error, and the automated callers
  skip it with a warning when `statusPagePath` is set.
- `prune-acme-challenges` keeps running after a Dashboard edit, since
  Traefik's own DNS-01 issuance can leave challenge records behind.
- A backend hostname or path containing characters that need quoting in
  Traefik's rule syntax is rendered so it matches literally.
- The file is replaced atomically, so Traefik never reads a half-written
  file, and the temporary file's name is one Traefik's file provider does
  not load.
- Because the file is live the moment it is written, a configuration the
  API check rejects was briefly served before the restore. This is
  documented, not prevented.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST offer a `traefik` proxy driver, selectable
  through the `proxyDriver` setting (CLI and Settings page dropdown, labelled
  "Traefik").
- **FR-002**: The driver MUST write exactly one Traefik file-provider
  dynamic-configuration file, owned whole by Bellhop, at `proxyConfigPath`
  when set, else `/etc/traefik/dynamic/bellhop.yml`.
- **FR-003**: The file MUST start with a generated-by-Bellhop header line,
  and an apply MUST refuse to replace an existing file whose first line is
  not that header.
- **FR-004**: For each routed entry the driver MUST render one router
  matching every hostname (canonical first) on the `websecure` entry point
  with TLS from the resolver `proxyCertResolver` names (default
  `cloudflare`), and one service pointing at the entry's backend.
- **FR-005**: A service MUST use HTTPS to the backend when the entry has
  `insecureBackendTls` set or its port is 443, and HTTP otherwise; with
  `insecureBackendTls` the backend certificate MUST NOT be verified.
- **FR-006**: Every Bellhop router MUST send `X-Forwarded-Port: 443` to its
  backend.
- **FR-007**: A forward-gated route MUST be checked by Authentik's Traefik
  forward-auth endpoint on the outpost, trusting forwarded headers and
  passing on the same five identity headers the other drivers pass.
- **FR-008**: A forward-gated route MUST also route
  `/outpost.goauthentik.io/` on its hostnames directly to the outpost, at a
  higher priority than its other routers.
- **FR-009**: A forward-gated route's exempt paths MUST be served by a
  higher-priority router without the forward-auth check (exact path for an
  exact pattern, prefix for a `/*` pattern); a bare `/*` among the
  patterns MUST instead drop the check from the main router and render no
  exempt router at all; patterns inside the outpost namespace MUST be
  skipped.
- **FR-010**: The driver MUST declare support for the `forward` and `oidc`
  auth modes and for ACME DNS-01 via Cloudflare, and MUST declare no status
  page.
- **FR-011**: An apply MUST replace the file atomically and MUST NOT run a
  reload command.
- **FR-012**: When `proxyApiUrl` is set, an apply MUST wait for Traefik to
  load the new file for up to 30 checks one second apart, then fail if any
  Bellhop router reports an error or warning; any such failure (including
  an unreachable API, or no `curl` on the proxy host) MUST restore the
  previous file and report what failed.
- **FR-013**: When `proxyApiUrl` is unset, an apply MUST NOT contact
  Traefik's API.
- **FR-014**: `proxyCertResolver` and `proxyApiUrl` MUST be settable and
  clearable through `set-config` and the Settings page, validated by the
  same rule in both (a resolver name of letters, digits, `-` and `_`; an
  `http(s)://` URL).
- **FR-015**: The Settings page MUST show the two fields only for a driver
  that declares it uses them, decided from driver metadata rather than the
  driver's id.
- **FR-016**: The existing file-configured drivers (Caddy, nginx) MUST keep
  producing the same configuration and apply scripts as before.
- **FR-017**: Documentation MUST describe the Traefik setup the operator
  owns (file provider directory with watching, `websecure` entry point,
  certificate resolver, optional API), the two settings, and the
  hot-reload limitation.
- **FR-018**: Every Bellhop router MUST remove client-supplied
  `X-authentik-*` identity headers (the five the forward-auth passes on)
  before any backend or forward-auth check sees the request, so a client
  can never pose as an Authentik-verified user to a backend that trusts
  those headers (added by the final code review, matching the HAProxy
  driver's own header strip).

### Key Entities

- **Dynamic-configuration file**: the one Bellhop-owned Traefik file:
  header, shared middlewares, and per-route routers and services.
- **Generation marker**: an inert entry in the file whose name is derived
  from the rest of the file's content, so the API check can tell when
  Traefik has loaded this exact version.
- **`proxyCertResolver` / `proxyApiUrl`**: inventory settings, inert for
  every driver except Traefik.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An operator with the documented Traefik static configuration
  can publish every routed inventory entry with one `sync-proxy --apply`
  and no hand-edits to Bellhop's file.
- **SC-002**: Every forward-gated entry is unreachable without an Authentik
  login except on its exempt paths, as under the Caddy driver.
- **SC-003**: With `proxyApiUrl` set, 100% of applies that Traefik rejects
  end with the previous file restored and a failure reported, after at
  most 30 checks one second apart.
- **SC-004**: Switching an existing deployment's driver among Caddy, nginx
  and Traefik changes nothing in the other two drivers' output.

## Assumptions

- The operator owns Traefik's static configuration: entry points, the
  certificate resolver's definition (including its DNS provider
  credentials), the file provider's directory and watching, and the API.
- The entry point is always named `websecure` (Traefik's documented
  convention); a configurable name is out of scope.
- The API check runs on the proxy host, so it needs `curl` there and an API
  address reachable from it (typically `http://127.0.0.1:8080` with the API
  enabled); Bellhop itself never contacts Traefik directly.
- Traefik v3's router rule syntax and API are the target; Traefik v2 is not
  explicitly supported.
- The Docker-labels provider, an HTTP provider served by Bellhop, managing
  Traefik's static configuration, and a configurable entry point name are
  out of scope.
