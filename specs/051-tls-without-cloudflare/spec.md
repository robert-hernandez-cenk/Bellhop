# Feature Specification: TLS Without Cloudflare

**Feature Branch**: `issue-51-tls-without-cloudflare`

**Created**: 2026-10-03

**Status**: Draft

**Input**: GitHub issue #51, "TLS without Cloudflare: Let's Encrypt and self-signed
options for every proxy driver".

## Background

Both Caddy proxy drivers hardcode Cloudflare DNS-01 for certificates: the
file-based `caddy` driver writes the same `tls { dns cloudflare … }` clause on
every site, and the admin-API `caddy-api` driver writes the equivalent automation
policy. No setting changes this, and Caddy rejects the configuration outright on
a build without the Cloudflare DNS module. Cloudflare is therefore effectively
required for anyone running Bellhop with Caddy. Spec 006 (reverse-proxy driver)
deliberately kept this hardcoded; this feature supersedes that out-of-scope line.

The other drivers already let an operator obtain certificates without Cloudflare,
but the documentation mostly shows only the Cloudflare route, and Traefik cannot
be told to use no certificate resolver at all.

Certificate handling stays **per driver**. Bellhop never issues or renews a
certificate itself; it only tells each proxy how to obtain or find one.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Caddy without Cloudflare (Priority: P1)

An operator running either Caddy driver picks how Caddy gets certificates for the
sites Bellhop manages: Cloudflare DNS-01 (today's behaviour), Let's Encrypt over
Caddy's built-in HTTP/TLS-ALPN challenges, Caddy's own internal (self-signed) CA,
or a certificate/key file pair they manage themselves. A deployment that never
sets the option keeps exactly today's configuration.

**Why this priority**: Caddy is the default driver and the only one where
Cloudflare is currently unavoidable. This is the code gap the issue exists for.

**Independent Test**: With each of the four modes set, run a `sync-proxy` dry run
under each Caddy driver and confirm the rendered configuration carries that
mode's TLS settings; with the mode unset, confirm the output is byte-identical to
before the feature.

**Acceptance Scenarios**:

1. **Given** the Caddy TLS mode is unset, **When** `sync-proxy` renders, **Then**
   every site carries today's Cloudflare DNS-01 clause, unchanged byte for byte,
   under both Caddy drivers.
2. **Given** the mode is `letsencrypt`, **When** `sync-proxy` renders, **Then** no
   Bellhop TLS clause or Bellhop automation policy is written, leaving Caddy's
   automatic HTTPS to obtain certificates.
3. **Given** the mode is `internal`, **When** `sync-proxy` renders, **Then** every
   Bellhop site is served from Caddy's internal CA.
4. **Given** the mode is `files`, **When** `sync-proxy` renders, **Then** every
   Bellhop site is served with the certificate/key paths from the shared
   certificate settings (or their default certbot paths for the inventory
   domain).
5. **Given** the admin-API driver and any mode, **When** the configuration is
   rendered, **Then** Bellhop's JSON matches what Caddy's own Caddyfile adapter
   produces from the file-based driver's output for that mode.
6. **Given** the admin-API driver with Bellhop TLS objects from one mode already
   live, **When** the mode is changed and `sync-proxy --apply` runs, **Then**
   Bellhop's old TLS objects are replaced by the new mode's, and every TLS object
   the operator wrote by hand is left untouched.

---

### User Story 2 - Settings page shows the Caddy TLS option (Priority: P2)

An admin selects a Caddy driver on the Settings page and sees a Caddy TLS mode
dropdown. Choosing `files` also shows the certificate and key path fields. Neither
appears for a driver that doesn't read them.

**Why this priority**: the CLI (`set-config`) already makes the option usable;
the web UI is the second way to reach it.

**Independent Test**: On the Settings page, switch the driver dropdown between
Caddy, Caddy (admin API), nginx, and Traefik, and switch the Caddy TLS dropdown
between modes, checking which fields are visible at each step.

**Acceptance Scenarios**:

1. **Given** a Caddy driver is selected, **When** the page renders, **Then** the
   Caddy TLS dropdown is shown, with the default mode (`cloudflare`) shown as
   selected when unset.
2. **Given** a non-Caddy driver is selected, **When** the page renders, **Then**
   the Caddy TLS dropdown is hidden.
3. **Given** a Caddy driver with mode `files` selected (saved or not), **When** the
   page renders, **Then** the certificate and key path fields are shown; with any
   other mode they are hidden.
4. **Given** an invalid mode is submitted through the CLI or the Settings API,
   **When** it is saved, **Then** it is rejected the same way by both.

---

### User Story 3 - Traefik with no certificate resolver (Priority: P3)

An operator running the Traefik driver who loads certificates through Traefik's
own file provider (or relies on its default certificate) sets the certificate
resolver setting to `none`, and Bellhop's routers enable TLS without naming any
resolver.

**Why this priority**: it closes Traefik's only gap; HTTP-01 through an
operator-defined resolver already works today.

**Independent Test**: Render the Traefik configuration with the resolver set to
`none` and confirm every router has TLS enabled with no resolver named.

**Acceptance Scenarios**:

1. **Given** the resolver setting is `none`, **When** the Traefik driver renders,
   **Then** every Bellhop router enables TLS with no certificate resolver.
2. **Given** the resolver setting is any other name or unset, **When** the driver
   renders, **Then** output is unchanged from today.

---

### User Story 4 - Stale challenge cleanup follows the TLS mode (Priority: P3)

The automatic cleanup of stale `_acme-challenge` DNS records in Cloudflare runs
only when the active driver is configured to use Cloudflare DNS-01.

**Why this priority**: without it, a deployment that moved off Cloudflare would
keep calling Cloudflare (or logging a needless skip) for no reason.

**Independent Test**: Push a change live with each driver/mode combination and
check whether the Cloudflare cleanup ran or logged its driver skip line.

**Acceptance Scenarios**:

1. **Given** a Caddy driver with mode unset or `cloudflare`, **When** a change is
   pushed live, **Then** the cleanup runs as today.
2. **Given** a Caddy driver with mode `letsencrypt`, `internal`, or `files`,
   **When** a change is pushed live, **Then** the cleanup is skipped with the
   driver skip message.
3. **Given** the Traefik driver with resolver `none`, **When** a change is pushed
   live, **Then** the cleanup is skipped; with any other resolver it runs.

---

### User Story 5 - Every driver documents both routes (Priority: P2)

An operator reading any proxy driver's documentation finds a way to get a Let's
Encrypt certificate without Cloudflare and a way to use a self-signed
certificate, plus a summary table comparing drivers.

**Why this priority**: for nginx, Nginx Proxy Manager, and HAProxy this is the
whole feature; the capability exists but is undocumented.

**Independent Test**: Read each driver page under `docs/reverse-proxy/` and the
index; each names both routes.

**Acceptance Scenarios**:

1. **Given** the reverse-proxy documentation index, **When** an operator reads it,
   **Then** a table lists, per driver, its Let's Encrypt-without-Cloudflare route
   and its self-signed route.
2. **Given** any driver page, **When** read, **Then** both routes are described,
   with what each needs (open ports, a trusted CA, a module build, etc.).
3. **Given** the driver-authoring guidance, **When** a new driver is written,
   **Then** it states that the driver's page must document both routes.

### Edge Cases

- `files` mode pointing at a certificate that doesn't exist on the proxy host:
  the file-based driver's existing validate step fails, the previous Caddyfile is
  restored, and Caddy's error is reported; the admin-API driver's load is
  rejected by Caddy and the job fails with Caddy's message. Bellhop does not
  check the paths in advance.
- `cloudflare` mode on a Caddy build without the Cloudflare DNS module: fails the
  same existing ways.
- `letsencrypt` mode under the admin-API driver with an operator catch-all
  automation policy (one with no subjects): that policy now applies to Bellhop's
  hostnames. This is intended.
- Switching modes: every sync rebuilds Bellhop's TLS objects from the current
  setting; certificates Caddy already obtained under an old mode stay in its
  storage unused. No migration step exists.
- No routes at all: no Bellhop TLS objects are written in any mode.
- A Traefik operator whose real resolver is literally named `none`: not
  supported; the docs say the name is reserved.
- The Caddy TLS mode set while a non-Caddy driver is active: inert, like every
  other driver-specific setting.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The inventory settings MUST accept a Caddy TLS mode setting with
  exactly four values: `cloudflare`, `letsencrypt`, `internal`, `files`. Any other
  value MUST be rejected identically by the CLI (`set-config`) and the Settings
  page.
- **FR-002**: An unset Caddy TLS mode MUST behave as `cloudflare`, and output
  under both Caddy drivers MUST be byte-identical to the output before this
  feature.
- **FR-003**: The file-based Caddy driver MUST render, per site: today's
  Cloudflare DNS-01 clause (`cloudflare`); no TLS clause (`letsencrypt`); an
  internal-CA clause (`internal`); a clause naming the shared certificate and key
  paths (`files`).
- **FR-004**: `files` mode MUST reuse the existing shared certificate/key settings
  and their existing defaults (the certbot paths for the inventory domain). No new
  path settings are added.
- **FR-005**: The admin-API Caddy driver MUST, for each mode, produce the same
  TLS-related JSON objects Caddy's own Caddyfile adapter produces from the
  file-based driver's output for that mode, with each Bellhop object carrying
  Bellhop's ownership tag. This parity MUST be pinned by tests against fixtures
  captured from a real Caddy adapter, not hand-written.
- **FR-006**: The admin-API driver MUST reconcile its TLS objects the way it
  already reconciles routes and its automation policy: on every sync it removes
  every Bellhop-tagged TLS object, adds the objects the current mode needs, and
  never modifies an untagged object.
- **FR-007**: The Traefik driver MUST treat the certificate resolver value `none`
  as "no resolver": every router enables TLS without naming a resolver. Any other
  value, or unset, MUST render as today.
- **FR-008**: The driver contract MUST let a driver declare that it reads the
  Caddy TLS mode; both Caddy drivers declare it and no other driver does.
- **FR-009**: Whether a driver uses Cloudflare DNS-01 MUST be derived from the
  current settings rather than fixed per driver: Caddy drivers only when the mode
  is `cloudflare` or unset; Traefik unless the resolver is `none`; every other
  driver never.
- **FR-010**: The automatic stale-challenge cleanup in the push-live step MUST use
  the derived value from FR-009 to decide whether to run.
- **FR-011**: The Settings page MUST show the Caddy TLS mode dropdown only for a
  driver that declares it reads that setting, with the default mode marked and
  shown selected when unset.
- **FR-012**: The Settings page MUST show the certificate and key path fields for
  a driver that uses the shared certificate (as today), and also for a Caddy
  driver while the Caddy TLS dropdown's current (possibly unsaved) value is
  `files`. Hiding a field MUST NOT change its stored value.
- **FR-013**: Configuration failures caused by a TLS mode (missing certificate
  files, missing Caddy module) MUST surface through the existing failure paths;
  no new advance checks are added.
- **FR-014**: Documentation MUST give every driver a Let's Encrypt route that
  doesn't need Cloudflare and a self-signed route, include a per-driver TLS
  options table on the reverse-proxy index page, document the new setting and the
  reserved Traefik value in the configuration reference, and add a
  driver-authoring rule requiring both routes for any future driver.
- **FR-015**: Documentation of what each Caddy mode requires MUST state:
  `letsencrypt` needs ports 80/443 reachable from the internet; `internal` needs
  Caddy's root CA trusted on clients; `cloudflare` needs a Caddy build with the
  Cloudflare DNS module.
- **FR-016**: The project's record of single-operator assumptions MUST be
  updated: the hardcoded Cloudflare DNS-01 is no longer unavoidable, and spec
  006's out-of-scope line is marked superseded.

### Key Entities

- **Caddy TLS mode**: a deployment-wide setting naming how the Caddy drivers
  obtain certificates. Values: `cloudflare` (default), `letsencrypt`, `internal`,
  `files`. Inert for other drivers.
- **Certificate resolver (Traefik)**: existing setting; gains the reserved value
  `none`.
- **Shared certificate/key paths**: existing settings, now read by the Caddy
  drivers in `files` mode as well as by nginx.
- **Bellhop TLS objects (Caddy admin API)**: the automation policy, loaded
  certificate entries, and connection policy Bellhop owns in Caddy's live
  configuration, identified by Bellhop's ownership tag.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An operator with no Cloudflare account can run Bellhop with either
  Caddy driver and obtain valid certificates for every managed site, by changing
  one setting.
- **SC-002**: 100% of existing deployments that never set the new option see no
  change in their rendered proxy configuration.
- **SC-003**: For each of the four Caddy modes, the admin-API driver's TLS JSON
  matches the real Caddy adapter's output for the equivalent file-based
  configuration.
- **SC-004**: Every one of the seven drivers' documentation pages names both a
  Let's Encrypt route without Cloudflare and a self-signed route (or states why
  the driver has nothing to configure, for the no-proxy driver).
- **SC-005**: Switching between any two Caddy modes requires only the setting
  change and one sync, with no manual cleanup of Caddy's configuration.

## Assumptions

- No ACME contact email setting is needed; Caddy's default is acceptable.
- DNS-01 providers other than Cloudflare are out of scope.
- One general TLS setting interpreted by every driver is out of scope; each
  driver keeps its own mechanism.
- Bellhop never issues or renews certificates itself.
- Changing how the push-live step decides on the Cloudflare cleanup is a breaking
  change to the driver contract; that is acceptable while Bellhop is pre-release.
- nginx, Nginx Proxy Manager, and HAProxy need documentation only. Nginx Proxy
  Manager's choice of an uploaded custom certificate is checked against its
  existing selection logic before it is documented.
