# Feature Specification: Reverse-Proxy Driver Interface

**Feature Branch**: `issue-10-reverse-proxy-driver`

**Created**: 2026-09-26

**Status**: Draft

**Input**: User description: "Issue #10: Reverse-proxy driver interface. Put a driver seam between the inventory and the reverse proxy, with Caddy as the only implementation this round, and rename every Caddy-specific name in the inventory, database, settings, CLI, web UI, and MCP surfaces to a proxy-neutral one."

## Background

Bellhop generates reverse-proxy configuration from its inventory, but the
generator is Caddy through and through: the inventory marks "the Caddy
host", entries are flagged "Caddy manual", the command is `sync-caddy`, and
the path-exemption field stores Caddy-specific globs. Supporting any other
proxy would mean untangling all of that at once.

This feature introduces the seam without adding a second proxy. Its shape
was checked on paper against four other ways of driving a proxy — plain
nginx, Nginx Proxy Manager, HAProxy, and Caddy's own admin API (see
`research.md`) — so the boundary is not guessed from Caddy alone. Tailscale
Serve was considered and dropped as too specialized.

Bellhop is public but pre-release, so renames are total: no aliases, no
fallbacks for old names. Existing inventories are upgraded automatically.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Upgrading changes nothing about the running proxy (Priority: P1)

An operator who already runs Bellhop with Caddy pulls the new version and
restarts. Their inventory upgrades itself on first open, and the next proxy
sync produces exactly the configuration it produced before. Every route,
alias, auth gate, path exemption, backend-TLS setting, and certificate
setting is unchanged.

**Why this priority**: the refactor is only acceptable if it is invisible
in effect. A silent change to generated proxy configuration could ungate an
app or break a route.

**Independent Test**: build an example inventory that exercises every kind
of entry the generator handles, capture the generated configuration with
the current version, upgrade, and compare. The two must be identical byte
for byte.

**Acceptance Scenarios**:

1. **Given** an inventory created by the previous version, **When** the new
   version opens it for the first time, **Then** it is upgraded to the new
   field names without any operator action, and every entry keeps its
   proxy-host role and manual-config flag.
2. **Given** the upgraded inventory, **When** the operator runs a proxy
   sync dry run, **Then** the previewed managed block is byte-identical to
   the block the previous version generated for the same inventory.
3. **Given** the upgraded inventory, **When** the operator applies the
   sync, **Then** the proxy is validated and reloaded exactly as before,
   and a configuration that fails validation leaves the proxy's previous
   configuration in place.
4. **Given** an upgraded inventory, **When** it is opened again, **Then**
   no upgrade runs a second time.

---

### User Story 2 - Proxy-neutral names everywhere the operator looks (Priority: P1)

The operator sees one vocabulary across the CLI, the web UI, the MCP
server, the settings, and the docs: "proxy", not "Caddy". The command is
`sync-proxy`; an entry is marked as the proxy host or as having manual
proxy configuration; the proxy in use and the location of its
configuration are ordinary settings, editable the same way from the CLI
and the web Settings page.

**Why this priority**: the rename is the visible half of the seam. Left
half-done, the next proxy would inherit a Caddy-named data model.

**Independent Test**: exercise each front end (CLI help and commands, web
Dashboard and Settings, MCP tool list and `edit_guest`) and confirm the new
names work and the old ones are gone.

**Acceptance Scenarios**:

1. **Given** the new version, **When** the operator lists CLI commands, MCP
   tools, or web maintenance actions, **Then** a proxy sync is offered as
   `sync-proxy` / "Sync Proxy" / `sync_proxy`, and no `sync-caddy`
   variant exists.
2. **Given** a guest edit from the Dashboard or MCP, **When** it sets the
   manual-proxy-config flag, **Then** the flag is named `proxyManual`, and
   a request using the old `caddyManual` name does not set it.
3. **Given** the Settings page or `set-config`, **When** the operator views
   or sets the proxy driver and the proxy configuration path, **Then**
   both front ends accept and reject the same values, and leaving either
   unset uses the default (Caddy, and Caddy's standard configuration path).
4. **Given** the status page, **When** it is regenerated, **Then** its
   configuration section describes the deployed proxy configuration
   without naming a specific proxy in its heading.

---

### User Story 3 - An auth mode the proxy cannot enforce is refused, never silently dropped (Priority: P2)

Some reverse proxies cannot perform forward-auth. When the active proxy
cannot enforce an entry's auth mode, Bellhop refuses — at edit time and at
sync time — with a message naming the entry, the proxy, and the fix,
rather than generating configuration that would leave the app ungated.

**Why this priority**: Caddy supports every mode, so this never triggers
today. It is the guarantee every future driver inherits, and it must exist
before one is written.

**Independent Test**: with a test-only proxy that declares no forward-auth
support, attempt a sync and a guest edit involving a forward-gated entry;
both must be refused with nothing written.

**Acceptance Scenarios**:

1. **Given** an active proxy that does not support forward-auth and an
   entry gated in forward mode, **When** a proxy sync runs (dry run or
   apply), **Then** it fails before writing anything, naming the entry and
   suggesting OIDC mode.
2. **Given** the same proxy, **When** a Dashboard or MCP edit would leave
   the edited entry forward-gated, **Then** the save is rejected with the
   same message and the inventory is unchanged.
3. **Given** the same proxy and an unrelated entry that it cannot serve,
   **When** a different entry is edited, **Then** that edit is not blocked
   by the unrelated entry.
4. **Given** an inventory whose proxy driver setting changes, **When** the
   inventory is loaded, **Then** it still loads; the mismatch is reported
   only when syncing or editing.

---

### User Story 4 - Path exemptions use a form every proxy can express (Priority: P3)

The operator can exempt an exact path (`/health`) or everything under a
prefix (`/api/*`) from forward-auth. Any other wildcard placement is
rejected when saved, with a message showing the two accepted forms.

**Why this priority**: every current use already fits these two forms; the
restriction exists so a future proxy never meets a pattern it cannot
express.

**Independent Test**: save exemptions in each accepted form and in several
rejected forms, from each front end.

**Acceptance Scenarios**:

1. **Given** a gated entry, **When** the operator saves `/health` and
   `/api/*`, **Then** both are accepted and generated as before.
2. **Given** a gated entry, **When** the operator saves `/a*b` or `*/x`,
   **Then** the save is rejected with a message naming the accepted forms.

---

### User Story 5 - A contributor can add a proxy by writing one driver (Priority: P3)

A contributor who wants another proxy writes one driver that describes
what the proxy supports and how configuration reaches it, and registers
it. Route selection, auth-mode validation, the combined push-live step,
the status page, and the firewall scope need no changes.

**Why this priority**: this is the purpose of the seam, but it is
demonstrated rather than exercised this round, since no second proxy
ships.

**Independent Test**: a test-only driver, registered alongside Caddy,
receives the same routes Caddy does and participates in sync and the
status page without any change outside the driver and its registration.

**Acceptance Scenarios**:

1. **Given** a test-only driver, **When** it is selected, **Then** sync
   passes it the same routes the Caddy driver would receive, and its
   preview is what the dry run shows.
2. **Given** the README's proxy-driver section, **When** a contributor
   reads it, **Then** it states what a driver must provide and that proxies
   without built-in certificate issuance require an operator-managed
   certificate tool.

### Edge Cases

- An inventory that predates the manual-proxy-config flag entirely still
  upgrades, and gains the new flag unset.
- An upgraded inventory opened by an older version of Bellhop fails loudly
  rather than being partially read (forward-only upgrade, same as the
  auth-group upgrade before it).
- No entry is marked as the proxy host: sync fails naming the missing
  marker, as it does today.
- A forward-gated entry exists but no entry runs Authentik: sync fails
  naming the missing marker, as it does today.
- An unknown proxy driver value is stored in settings: rejected when set;
  if present anyway, sync fails naming the setting and the accepted values.
- The generated configuration fails the proxy's own validation: the
  previous configuration file is restored and the proxy is not reloaded.
- The Caddyfile has no managed block yet: the block is appended, and all
  hand-written content is kept, as today.
- The active proxy does not issue certificates through Cloudflare DNS-01:
  stale ACME challenge pruning is skipped rather than run.
- Historical job-history entries recorded as `sync-caddy` keep that label.

## Requirements *(mandatory)*

### Functional Requirements

**Driver seam**

- **FR-001**: The system MUST derive a proxy-neutral list of routes from
  the inventory — hostnames, backend address and port, whether the backend
  uses untrusted TLS, and the auth mode (ungated, forward with exempt
  paths, or OIDC) — and give proxy implementations only that list plus
  shared context (the Authentik outpost address and the external port).
- **FR-002**: Route derivation MUST keep today's rules: skip entries with
  manual proxy configuration or no subdomains, default the backend port to
  80, and fail when a forward-gated route exists but no entry is marked as
  running Authentik with an address.
- **FR-003**: Routes MUST NOT carry the auth tier; tier enforcement stays
  entirely in Authentik.
- **FR-004**: Each proxy implementation MUST declare which auth modes it
  can enforce and whether it issues certificates through Cloudflare DNS-01.
- **FR-005**: Each proxy implementation MUST be able to produce a preview,
  apply it, and report the currently deployed configuration as text; the
  dry-run preview MUST be exactly what apply sends.
- **FR-006**: The active proxy MUST be chosen by a `proxyDriver` setting;
  unset means Caddy; an unknown value MUST fail with an error naming the
  setting and the accepted values.
- **FR-007**: Proxies configured through files MUST share one delivery
  mechanism that backs up each target file, writes it (either replacing a
  managed section while preserving everything else, or replacing a file
  Bellhop owns outright), runs the proxy's validation, restores every
  backup and stops if validation fails, and reloads the proxy otherwise.
- **FR-008**: One place MUST build an entry's public hostname from a
  subdomain and the inventory domain; every server-side consumer uses it.

**Caddy driver**

- **FR-009**: Caddy MUST be provided as a file-configured driver that
  supports both auth modes and issues certificates through Cloudflare
  DNS-01.
- **FR-010**: For any inventory, the Caddy driver's managed block MUST be
  byte-identical to the block the previous version generated.

**Capability enforcement**

- **FR-011**: A proxy sync MUST refuse, before previewing or writing
  anything, when any route needs an auth mode the active proxy cannot
  enforce, naming the entry, the proxy, and the fix.
- **FR-012**: A guest edit (Dashboard or MCP) MUST be rejected when the
  edited entry's resulting route needs an auth mode the active proxy cannot
  enforce; other entries' mismatches MUST NOT block it.
- **FR-013**: Capability mismatches MUST NOT make an inventory fail to load.

**Path exemptions**

- **FR-014**: A path exemption MUST be either an exact path containing no
  `*`, or a path ending in `/*` meaning that prefix; anything else MUST be
  rejected on save with a message naming both forms.

**Renames and settings**

- **FR-015**: The inventory marker for the proxy host MUST be `proxy`, and
  the manual-configuration flag MUST be `proxyManual`, in the schema,
  storage, YAML import, web API, MCP, and UI. The old names MUST NOT be
  accepted.
- **FR-016**: The proxy sync action MUST be named `sync-proxy` in the CLI,
  web UI, and MCP (`sync_proxy`), with no `sync-caddy` alias.
- **FR-017**: The proxy configuration location MUST be a `proxyConfigPath`
  setting (optional, absolute path; unset means the driver's default),
  honored identically by the CLI, web UI, and MCP. The `CADDYFILE_PATH`
  environment variable MUST be removed.
- **FR-018**: The web Settings page MUST show and edit `proxyDriver` and
  `proxyConfigPath`, validated by the same rules as `set-config`, and label
  the derived proxy-host address "Proxy IP".
- **FR-019**: The status page's configuration section MUST come from the
  active driver's report of its deployed configuration.
- **FR-020**: Stale ACME challenge pruning in the combined push-live step
  MUST run only when the active driver issues certificates through
  Cloudflare DNS-01.
- **FR-021**: The Windows service's firewall scope MUST be derived from the
  proxy-host entry, with messages naming `proxy: true`.

**Upgrade**

- **FR-022**: Opening an inventory created by the previous version MUST
  upgrade it automatically, once, preserving every entry's proxy-host role
  and manual-configuration flag; opening it again MUST NOT repeat the
  upgrade, and a newly created inventory MUST never need it.
- **FR-023**: The upgrade MUST log what it changed.

**Documentation**

- **FR-024**: README, CLAUDE.md, and CONTRIBUTING MUST use the new names
  and describe the driver seam, what a driver provides, and that proxies
  without built-in certificate issuance need an operator-managed
  certificate tool.
- **FR-025**: A follow-up issue MUST be filed for a Caddy admin-API driver.

### Key Entities

- **Proxy route**: one reverse-proxied site — its hostnames (canonical
  first), its backend (address, port, untrusted-TLS flag), and its auth
  mode with any exempt paths. Derived from a host, guest, or external site.
- **Proxy driver**: one way of configuring one kind of proxy — its
  identity, its declared capabilities, and how it previews, applies, and
  reports configuration.
- **Proxy host**: the single inventory entry marked `proxy: true`, where
  the proxy runs.
- **Path exemption**: an exact path or a path prefix exempt from
  forward-auth on a gated entry.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For an example inventory covering every entry shape the
  generator handles, and for the operator's real deployment (checked
  read-only), the generated managed block is identical to the previous
  version's in 100% of cases.
- **SC-002**: Upgrading an existing installation needs zero manual data
  steps: pulling the code and restarting is enough.
- **SC-003**: Outside the Caddy driver itself and historical job records,
  no command, setting, field, UI label, or MCP tool uses a Caddy-specific
  name.
- **SC-004**: In every tested case where the active proxy cannot enforce
  an entry's auth mode, zero configurations are written that would leave
  that entry ungated.
- **SC-005**: Adding a test-only driver requires no changes outside the
  driver and its one-line registration.
- **SC-006**: The Dashboard and Settings changes render correctly at a
  desktop width and at a mobile width of 640px or narrower.

## Assumptions

- One proxy driver is active per deployment; running two proxies at once is
  out of scope.
- No driver other than Caddy ships in this change. nginx, Nginx Proxy
  Manager, and HAProxy drivers wait for a real request, with the analysis
  in `research.md` ready for them.
- Caddy stays configured through its Caddyfile this round; an admin-API
  driver is a follow-up.
- Certificate handling for proxies without built-in issuance is the
  operator's job; Bellhop will not issue or renew certificates.
- The existing single-operator certificate settings inside the Caddy
  configuration (Cloudflare DNS-01 with fixed resolvers) move into the Caddy
  driver unchanged; making them configurable is out of scope.
- Bellhop is pre-release, so breaking renames without aliases are
  acceptable; the upgrade is forward-only, like the earlier auth-group
  upgrade.
- The managed-block markers (`bellhop-managed`) and the fields
  `insecureBackendTls`, `unauthenticatedPaths`, and `authentik` keep their
  names, since none names a proxy.
- Every path exemption currently in use is already an exact path or a
  `/*` prefix.
