# Feature Specification: One TLS source setting, independent of the proxy driver

**Feature Branch**: `issue-72-tls-source-setting`

**Created**: 2026-10-05

**Status**: Draft

**Input**: Issue #72 — "Separate TLS certificate management from the reverse-proxy driver" (Option A).

## Background

How Bellhop's reverse proxy gets its TLS certificates is currently a
per-driver concern, with a different setting for each driver:

| Driver | How it gets certificates today |
|---|---|
| Caddy / Caddy (admin API) | `proxyCaddyTls`: `cloudflare` (default) / `letsencrypt` / `internal` / `files` |
| Traefik | `proxyCertResolver`, with the reserved value `none` meaning "no resolver" |
| nginx (and Caddy in `files` mode) | `proxyTlsCertificate` / `proxyTlsKey` |
| Nginx Proxy Manager | Its own HTTP-01 request through NPM, with no Bellhop setting |
| HAProxy | The operator's own frontend config, outside Bellhop |

As a result, switching drivers means learning a different TLS setting; the
Settings page shows or hides TLS fields through three per-driver flags;
`prune-acme-challenges` has to work backwards from driver-specific settings
to decide whether Cloudflare DNS-01 is in use; and Cloudflare being the only
DNS-01 provider is tied to one Caddy mode rather than being a setting of its
own.

This feature replaces those per-driver settings with one deployment-wide
**TLS source** setting plus an **ACME DNS provider** setting, declared
against by every driver the same way drivers already declare which auth
modes they support.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Choose where certificates come from with one setting (Priority: P1)

An operator sets `tlsSource` (for example `acme-http`) once, with
`bellhop set-config tlsSource acme-http --apply` or from the Settings page,
and the active proxy driver renders its configuration accordingly. Leaving
`tlsSource` unset keeps each driver's current behavior.

**Why this priority**: This is the core of the issue: one setting with one
vocabulary across all drivers. Everything else builds on it.

**Independent Test**: With a fixture inventory, run `sync-proxy` (dry run)
for each driver with `tlsSource` unset and set to each supported value, and
compare the previewed configuration with the expected output.

**Acceptance Scenarios**:

1. **Given** the Caddy driver and `tlsSource` unset, **When** the operator
   runs `sync-proxy`, **Then** every site block uses Cloudflare DNS-01 with
   the fixed resolvers, byte-identical to today's default output.
2. **Given** the Caddy driver (file or admin API) and `tlsSource` set to
   `acme-dns`, `acme-http`, `internal` or `files`, **When** the operator
   runs `sync-proxy`, **Then** the output is byte-identical to today's
   output for `proxyCaddyTls` `cloudflare`, `letsencrypt`, `internal` or
   `files` respectively.
3. **Given** the Traefik driver and `tlsSource` unset, `acme-dns` or
   `acme-http`, **When** the operator runs `sync-proxy`, **Then** every
   router names the resolver from `proxyCertResolver` (default
   `cloudflare`).
4. **Given** the Traefik driver and `tlsSource: external`, **When** the
   operator runs `sync-proxy`, **Then** every router has an empty TLS
   section, byte-identical to today's `proxyCertResolver: none` output.
5. **Given** the Traefik driver and `tlsSource: files`, **When** the
   operator runs `sync-proxy`, **Then** every router has an empty TLS
   section and the file also lists the shared certificate/key pair
   (`proxyTlsCertificate`/`proxyTlsKey`, defaulting to certbot's path for
   the inventory domain) so Traefik serves it.
6. **Given** nginx, Nginx Proxy Manager or HAProxy and `tlsSource` unset,
   **When** the operator runs `sync-proxy`, **Then** the output is
   byte-identical to today's.

---

### User Story 2 - Unsupported combinations are refused with a fix (Priority: P1)

When the chosen `tlsSource` is something the active driver cannot do (for
example `internal` with nginx), `sync-proxy` refuses before previewing or
writing anything and tells the operator which values the driver supports
and the command that fixes it. Saving the setting and loading the inventory
are never blocked by the combination.

**Why this priority**: Without the refusal, a driver would silently ignore
a TLS choice and deploy something other than what the operator asked for.

**Independent Test**: Set an unsupported `tlsSource` for a driver in a
fixture inventory; run `sync-proxy` with and without `--apply`; confirm
both refuse with the expected message and nothing is sent to the proxy
host. Load the same inventory and confirm it loads.

**Acceptance Scenarios**:

1. **Given** the nginx driver and `tlsSource: internal`, **When** the
   operator runs `sync-proxy` (dry run or `--apply`), **Then** it fails
   with a message naming `internal`, the `nginx` driver, its supported
   values (`files`), and a `bellhop set-config tlsSource ... --apply` fix,
   and nothing is written.
2. **Given** an inventory with an unsupported combination, **When** any
   command or the web UI loads it, **Then** it loads normally.
3. **Given** a Dashboard guest edit while the combination is unsupported,
   **When** the edit saves, **Then** the edit is kept and the live proxy
   push reports the same refusal as a failed proxy sync.
4. **Given** the `none` driver, **When** `tlsSource` is any value, **Then**
   nothing is refused (Bellhop writes no proxy configuration).

---

### User Story 3 - Stale ACME challenge cleanup follows the TLS setting (Priority: P2)

After a live proxy sync, Bellhop prunes stale Cloudflare ACME DNS-01
challenge records only when the effective TLS source is `acme-dns` and the
ACME DNS provider is `cloudflare`, regardless of which driver is active.

**Why this priority**: Removes driver-specific inference from a step that
touches DNS; it is correct today for the default case, so it ranks below
the setting itself.

**Independent Test**: Run the live-sync path against fake Cloudflare and
SSH clients with each driver/`tlsSource` combination and assert whether the
prune ran.

**Acceptance Scenarios**:

1. **Given** Caddy or Traefik with `tlsSource` unset or `acme-dns` (and
   `acmeDnsProvider` unset or `cloudflare`), **When** a live proxy sync
   completes, **Then** the prune runs (subject to Cloudflare credentials
   being configured, as today).
2. **Given** any driver with an effective `tlsSource` other than
   `acme-dns`, **When** a live proxy sync completes, **Then** the prune is
   skipped with a log line saying why.
3. **Given** Traefik with `tlsSource: acme-http`, **When** a live sync
   completes, **Then** the prune is skipped (today any named resolver
   counts as Cloudflare).

---

### User Story 4 - Existing deployments migrate without any change in output (Priority: P1)

An operator upgrades Bellhop on a deployment that has `proxyCaddyTls` or
`proxyCertResolver: none` stored. The first time the inventory database is
opened, the old value is converted to the matching `tlsSource`, the old
setting is removed, and `sync-proxy` renders exactly the same
configuration as before. A `hosts.yaml` file using the old settings imports
the same way.

**Why this priority**: The old settings are removed outright (Bellhop is
pre-release, no compatibility layer), so a deployment that had them set
must not silently change certificate behavior.

**Independent Test**: Build fixture databases with each legacy value and
driver, open them, and assert the stored settings and the rendered
configuration before and after.

**Acceptance Scenarios**:

1. **Given** a database with the Caddy driver (explicit or unset) and
   `proxyCaddyTls` `cloudflare`/`letsencrypt`/`internal`/`files`, **When**
   it is opened, **Then** `tlsSource` becomes
   `acme-dns`/`acme-http`/`internal`/`files`, `proxyCaddyTls` is gone, and
   the rendered output is unchanged.
2. **Given** a database with the Traefik driver and
   `proxyCertResolver: none`, **When** it is opened, **Then** `tlsSource`
   becomes `external`, `proxyCertResolver` is removed, and the rendered
   output is unchanged.
3. **Given** a database whose legacy value belongs to a driver that is not
   active (e.g. `proxyCaddyTls: letsencrypt` with the nginx driver),
   **When** it is opened, **Then** the legacy value is removed and no
   `tlsSource` is written, so the active driver's output is unchanged.
4. **Given** a database that already has `tlsSource` set, **When** it is
   opened, **Then** `tlsSource` is left as it is and only the legacy rows
   are removed.
5. **Given** a database with none of the legacy values, **When** it is
   opened, **Then** nothing changes and nothing is logged.
6. **Given** a `hosts.yaml` containing `proxyCaddyTls` or
   `proxyCertResolver: none`, **When** it is imported, **Then** the same
   mapping applies.

---

### User Story 5 - The Settings page shows TLS fields by TLS source (Priority: P2)

On the Settings page's Proxy tab, an admin picks the TLS source from one
dropdown that lists only what the selected driver supports, with that
driver's default marked. The certificate/key fields, DNS provider and
Traefik resolver appear only when the chosen source uses them. If the
stored value is not supported by the selected driver, the page says so.

**Why this priority**: The CLI already covers configuration; the page
makes it discoverable and removes per-driver TLS flags.

**Independent Test**: Load the Settings page with each driver selected and
each TLS source chosen (saved and unsaved) at desktop and mobile widths;
check which fields appear and the warning.

**Acceptance Scenarios**:

1. **Given** the Caddy driver is selected, **When** the admin opens the
   TLS source dropdown, **Then** it lists `acme-dns (default)`,
   `acme-http`, `internal` and `files`.
2. **Given** the shown TLS source is `files`, **Then** the certificate and
   key path fields are shown; otherwise they are hidden.
3. **Given** the shown TLS source is `acme-dns`, **Then** the ACME DNS
   provider field is shown; otherwise it is hidden.
4. **Given** Traefik and a shown TLS source of `acme-dns` or `acme-http`,
   **Then** the cert resolver field is shown; with `files` or `external`
   it is hidden.
5. **Given** `tlsSource: internal` is stored and the admin selects nginx
   in the (unsaved) driver dropdown, **Then** a warning says nginx does
   not support `internal` and lists what it supports.
6. **Given** the `No proxy` driver is selected, **Then** no TLS fields are
   shown.
7. **Given** a viewport 640px wide or narrower, **Then** the TLS fields
   and warning lay out without horizontal scrolling.

### Edge Cases

- `tlsSource: files` with no certificate/key settings: the default
  certbot path for the inventory domain is used, as nginx does today.
- `acmeDnsProvider` set while `tlsSource` is not `acme-dns`: stored but
  inert; it has no effect on output or the prune.
- Switching drivers with `tlsSource` unset: the new driver's own default
  applies, so the switch never trips the unsupported-combination refusal.
- Switching drivers with `tlsSource` set to something the new driver does
  not support: the switch is saved; the next `sync-proxy` refuses with the
  fix; the Settings page warns as soon as the driver is selected.
- A hand-edited database holding a `tlsSource` value outside the allowed
  list: rejected at load the same way any other invalid enum setting is.
- Legacy `proxyCertResolver` holding a real resolver name (not `none`):
  kept unchanged; it still names Traefik's resolver.
- Both `proxyCaddyTls` and `proxyCertResolver: none` stored: only the one
  the active driver read is converted; both legacy values are removed.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide a deployment-wide `tlsSource` setting
  with the values `acme-dns`, `acme-http`, `internal`, `files` and
  `external`, settable from the CLI (`set-config`) and the Settings page.
- **FR-002**: The system MUST provide an `acmeDnsProvider` setting whose
  only value is `cloudflare`; unset MUST mean `cloudflare`.
- **FR-003**: Every proxy driver MUST declare the TLS sources it supports
  and its own default TLS source:
  Caddy and Caddy (admin API): `acme-dns` (default), `acme-http`,
  `internal`, `files`; Traefik: `acme-dns` (default), `acme-http`, `files`,
  `external`; nginx: `files` only; Nginx Proxy Manager: `acme-http` only;
  HAProxy: `external` only; No proxy: every value (nothing is written).
- **FR-004**: When `tlsSource` is unset, the effective TLS source MUST be
  the active driver's default.
- **FR-005**: `sync-proxy` (dry run and `--apply`, CLI, web, MCP and live
  pushes) MUST refuse an effective TLS source the active driver does not
  support, before producing a preview or contacting the proxy, with a
  message naming the source, the driver, the driver's supported sources and
  the `set-config` command that fixes it.
- **FR-006**: The supported-combination check MUST NOT run when the
  inventory is loaded or validated, nor when a setting is written.
- **FR-007**: With an unchanged effective TLS source, every driver's
  rendered configuration MUST be byte-identical to its output before this
  feature (Caddy `acme-dns`/`acme-http`/`internal`/`files` = old
  `cloudflare`/`letsencrypt`/`internal`/`files`; Traefik `external` = old
  `proxyCertResolver: none`; nginx, Nginx Proxy Manager, HAProxy
  unchanged).
- **FR-008**: The Traefik driver MUST support `tlsSource: files` by
  rendering routers with an empty TLS section and listing the shared
  certificate/key pair in its dynamic configuration file.
- **FR-009**: The Cloudflare ACME challenge prune after a live sync MUST
  run only when the effective TLS source is `acme-dns` and the ACME DNS
  provider is `cloudflare`; the skip log line MUST name the reason.
- **FR-010**: The `proxyCaddyTls` setting and the reserved
  `proxyCertResolver` value `none` MUST be removed; `proxyCertResolver`
  MUST keep naming Traefik's resolver and `proxyTlsCertificate`/
  `proxyTlsKey` MUST keep naming the shared pair.
- **FR-011**: Opening an inventory database MUST migrate legacy values
  once: the value the active driver read is converted (`proxyCaddyTls`
  `cloudflare`→`acme-dns`, `letsencrypt`→`acme-http`,
  `internal`→`internal`, `files`→`files` for the Caddy drivers or an unset
  driver; `proxyCertResolver: none`→`external` for Traefik), unless
  `tlsSource` is already set; a legacy value the active driver did not
  read is not converted; every legacy value is removed; one log line is
  written only when something changed. (Each conversion targets only the
  driver that read the value, and that driver supports every converted
  value, so a migration can never produce an unsupported combination.)
- **FR-012**: Importing a `hosts.yaml` inventory MUST apply the same
  conversion to legacy values in the file.
- **FR-013**: The Settings page's Proxy tab MUST show one TLS source
  dropdown for any driver that manages a proxy, listing only that driver's
  supported sources in a fixed order and marking its default.
- **FR-014**: The Settings page MUST show the certificate/key fields only
  when the shown TLS source is `files`, the ACME DNS provider field only
  when it is `acme-dns`, and the cert resolver field only for a driver that
  reads it when the shown source is `acme-dns` or `acme-http`; "shown"
  means the unsaved selection when there is one, otherwise the stored
  value, otherwise the selected driver's default.
- **FR-015**: The Settings page MUST warn when the shown TLS source is not
  supported by the selected driver, naming the supported sources.
- **FR-016**: The per-driver Settings hints for Caddy TLS and the shared
  certificate MUST be replaced by the drivers' declared TLS sources.
- **FR-017**: The fixed ACME DNS resolvers and Cloudflare being the only
  DNS-01 provider MUST be recorded as single-operator assumptions that
  apply only under `tlsSource: acme-dns` with `acmeDnsProvider: cloudflare`.
- **FR-018**: User documentation and contributor guidance describing TLS
  settings MUST be updated to the new settings in the same change.

### Key Entities

- **TLS source**: Where the deployment's certificates come from. One of
  `acme-dns` (the proxy obtains them over DNS-01), `acme-http` (the proxy
  obtains them over HTTP-01/TLS-ALPN), `internal` (the proxy self-issues),
  `files` (one operator-supplied certificate/key pair), `external` (handled
  entirely outside Bellhop).
- **ACME DNS provider**: The DNS provider used for DNS-01 challenges;
  `cloudflare` only.
- **Driver TLS capability**: Per driver, the set of supported TLS sources
  and the default used when `tlsSource` is unset.
- **Shared certificate pair**: The existing `proxyTlsCertificate`/
  `proxyTlsKey` settings, used under `files`.
- **Certificate resolver**: The existing `proxyCertResolver` setting,
  Traefik's resolver name under `acme-dns`/`acme-http`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For every existing driver/legacy-setting combination, the
  configuration rendered after migration is byte-for-byte the same as
  before (0 differences across the test matrix).
- **SC-002**: An operator changes how certificates are obtained by editing
  exactly one setting, whichever driver is active.
- **SC-003**: 100% of unsupported driver/TLS-source combinations are
  refused before anything reaches the proxy host, and each refusal names a
  command that resolves it.
- **SC-004**: No inventory that loaded before this change fails to load
  after it.
- **SC-005**: The Settings page decides which TLS fields to show from the
  TLS source alone plus the driver's declared support list, with no
  per-driver TLS flags remaining.

## Assumptions

- Bellhop is pre-release: removing `proxyCaddyTls` and the `none`
  resolver value without a compatibility layer is acceptable, provided the
  migration keeps existing output identical.
- The live deployment stores none of the legacy TLS values today, so the
  migration is a no-op there; it exists for correctness on other
  deployments and backups.
- Traefik reads a `tls.certificates` list from the same dynamic
  configuration file the driver already writes; the certificate files
  themselves are the operator's to provide and renew, as with nginx.
- Out of scope (possible follow-ups): Bellhop running its own ACME client
  (Option B, e.g. a future `tlsSource: bellhop`); Nginx Proxy Manager
  custom-certificate upload for `files`; HAProxy certificate directory
  writing for `files`; DNS providers other than Cloudflare.
