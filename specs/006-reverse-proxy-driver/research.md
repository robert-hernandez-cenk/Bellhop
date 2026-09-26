# Research: Reverse-Proxy Driver Interface

Decisions made during brainstorming (2026-09-26) and the evidence behind
them. No open unknowns remained for the plan.

## R1. Interface shape: reconcile contract with a file-driver helper

**Decision**: one `ReverseProxyDriver` interface whose top-level contract is
"reconcile these routes" (`plan` → preview + opaque payload, `apply`,
`snapshot`). Drivers configured by files are built with a shared
`fileDriver(...)` helper that owns render → back up → write → validate →
restore-or-reload.

**Rationale**: of the five mechanisms analysed (R8), three have no file to
write (Nginx Proxy Manager's REST API, HAProxy's Data Plane API, Caddy's
admin API), including the follow-up Caddy admin-API driver agreed for this
issue. A file-only contract would break at the very next driver. The helper
keeps what a render-only design is good at (pure rendering, SSH-free
driver tests, one delivery path) for file drivers.

**Alternatives considered**:
- *Render-only drivers, core owns delivery*: simpler today; cannot express
  REST-configured proxies, so it would be redesigned for the next driver.
- *No interface, per-proxy commands sharing a route model*: least
  abstraction; forces a proxy-type switch into the push-live step, the
  status page, and the firewall code.

## R2. One active driver per deployment

**Decision**: a single `proxyDriver` setting; one entry holds `proxy: true`.

**Rationale**: the only case for running two proxies at once was Tailscale
Serve (tailnet-only apps alongside public ones), which was dropped (R8).
Among the remaining proxies there is no reason to front different entries
with different proxies.

**Alternatives considered**: per-entry driver selection with several proxy
hosts — touches subdomain uniqueness, the push-live step, and the Dashboard
for no current need.

## R3. TLS stays out of the interface except for one flag

**Decision**: the only TLS knowledge in the core is
`capabilities.acmeDns01ViaCloudflare`, which gates `prune-acme-challenges`.
Proxies without built-in certificate issuance (plain nginx, HAProxy) rely
on an operator-managed certificate tool, documented as a prerequisite;
certificate file locations belong to those drivers' own configuration when
they are written.

**Rationale**: Caddy and NPM issue certificates themselves; nginx and
HAProxy cannot. Having Bellhop issue and renew certificates is a separate
subsystem (renewal scheduling, key storage, key deployment).

**Alternatives considered**: a `tls: 'self-managed' | 'external-files'`
enum (dropped as YAGNI: nothing reads it this round); Bellhop-managed
certificates (out of scope).

## R4. Caddy stays file-configured this round

**Decision**: the Caddy driver writes the Caddyfile managed section, as
today. A Caddy admin-API driver is a follow-up issue.

**Rationale**: the byte-identical managed block is the proof that the
refactor changed nothing; switching mechanism in the same change removes
that proof and enlarges the live cutover. API changes are also discarded by
a Caddyfile reload, so the API driver requires running Caddy without a
Caddyfile (the packaged `caddy-api.service`, which resumes from
`autosave.json`) and moving hand-authored sites to JSON.

## R5. Path exemptions: exact path or `/*` prefix

**Decision**: `unauthenticatedPaths` entries must be an exact path with no
`*`, or a path ending in `/*`. Parsed into
`{ kind: 'exact' | 'prefix', path }`. Stored unchanged as strings.

**Rationale**: these two forms are expressible by every analysed proxy
(Caddy `path`, nginx `location =`/prefix `location`, HAProxy
`path`/`path_beg`). The live inventory was checked read-only: every value
in use already has one of these two shapes, so tightening rejects nothing
that exists.

**Caddy rendering**: unchanged. The strings are emitted verbatim into
`not path …` as today, so an exact path and a `/*` prefix keep Caddy's
existing semantics and the block stays byte-identical.

## R6. File-driver delivery: validate in place, restore on failure

**Decision**: the helper's script backs up each target file, writes the new
content in place, runs the driver's validate command against the real
paths, restores every backup and exits non-zero if validation fails, and
reloads otherwise. Today's `sync-caddy` instead validates a temp copy
before overwriting.

**Rationale**: `nginx -t` and `haproxy -c` check the configuration tree as
the service will load it; they cannot simply be pointed at a stray temp
file. Validating in place works for Caddy, nginx, and HAProxy with one
helper. The running proxy is never reloaded with invalid configuration
either way; the difference is a short window in which the invalid file is
on disk before it is restored.

**Testing**: the script's restore path is new shell logic, and asserting
on its text cannot show that a restore actually restores. One test
executes the generated script under `sh` in a temp directory with stub
`caddy` (exits non-zero) and `systemctl` (records calls) earlier on `PATH`,
and asserts the original file is back byte for byte and no reload
happened. CI runs on Ubuntu, where `sh` is always present; local Windows
runs use Git Bash's `sh`. This does not conflict with constitution III's
rule against mocking `ssh`/`pct`/`qm` on `PATH`: command logic is still
tested through `FakeSSHClient`; this test targets the generated script
itself.

## R7. Upgrade by on-open migration

**Decision**: `migrateCaddyToProxy(db)` in `src/lib/inventory.ts`, run from
`openInventoryDb` inside one transaction before the `ensureColumn` calls:
rename `caddy` → `proxy` and `caddy_manual` → `proxy_manual` in `hosts`
and `guests` when present (each column checked independently), and
`DROP TABLE IF EXISTS caddy_owner`.

**Rationale**:
- Same pattern as #158's `migrateRequiresAuthToAuthGroup`: guarded by
  `PRAGMA table_info`, self-idempotent, logs what it changed.
- `openDb` executes the full schema first, so by the time the migration
  runs, `CREATE TABLE IF NOT EXISTS proxy_owner` has already created an
  empty table and a rename onto it would fail. `caddy_owner` is written by
  `saveInventory` on every save and never read by `loadInventory`, so
  dropping it loses nothing; the next save fills `proxy_owner`.
- The existing `ensureColumn(…, 'caddy_manual', …)` calls become
  `proxy_manual` and must follow the rename, or they would add a second
  column and make the rename fail with a duplicate-column error.
- SQLite's `ALTER TABLE … RENAME COLUMN` (3.25+) is available in the
  bundled `better-sqlite3`.

**Alternatives considered**: manual SQL steps in the PR description (the
#179 rename's approach) — rejected by the user in favour of an automatic,
repeatable upgrade.

## R8. Validation against other proxies

How each concept maps, and what it forced into the interface.

| Concept | Caddy (file) | Caddy (API) | nginx | Nginx Proxy Manager | HAProxy |
|---|---|---|---|---|---|
| Apply mechanism | Managed section in Caddyfile | `@id`-tagged routes via the admin API on `localhost:2019`, reached over SSH | Bellhop-owned `conf.d` file | REST objects ("proxy hosts") | Bellhop-owned map + backends files (extra `-f`), or Data Plane API |
| Validate | `caddy validate` | Atomic load with automatic rollback | `nginx -t` | Server-side | `haproxy -c` |
| TLS | Built-in DNS-01 (Cloudflare) | Same | External tool | Built-in Let's Encrypt, Cloudflare DNS supported | External tool (built-in ACME in newer releases is limited) |
| Authentik forward-auth | `forward_auth` → `/outpost.goauthentik.io/auth/caddy` | Same, as JSON | `auth_request` → `/outpost.goauthentik.io/auth/nginx` | `auth_request` in each proxy host's advanced config | No native support (community Lua script only) |
| Exempt paths | `not path` | JSON path matchers | `location =` / prefix `location` | Same as nginx | `path` / `path_beg` ACLs |
| Untrusted backend TLS | `tls_insecure_skip_verify` | Same, as JSON | `proxy_ssl_verify off` | Per-host setting | `ssl verify none` |

What this forced:

- **Declared auth-mode capabilities** (HAProxy cannot forward-auth; silently
  emitting nothing would leave a gated app ungated).
- **A reconcile-shaped contract** (three of five mechanisms have no file).
- **A file helper supporting both a managed section and owned, possibly
  multiple, files** (Caddyfile vs nginx/HAProxy).
- **Exact-or-prefix exempt paths**, the common subset.
- **TLS reduced to one capability flag.**
- **Outpost endpoint and passthrough as driver internals** (`/auth/caddy`
  vs `/auth/nginx`).

**Tailscale Serve** was analysed and dropped: routes are keyed by the
node's tailnet name plus a path or port rather than subdomains of the
operator's domain, it has no forward-auth (it supplies its own identity
headers instead), and it is tailnet-only unless Funnel is used.

## R9. What does not change

- `bellhop-managed` markers.
- `insecureBackendTls`, `unauthenticatedPaths`, `authentik: true` (none
  names a proxy).
- The Caddy block's single-operator TLS settings (Cloudflare DNS-01, fixed
  resolvers), now contained in the Caddy driver.
- Historical job rows keep their recorded `sync-caddy` type.
- `prune-acme-challenges` keeps its name and behaviour; only when it runs
  inside `syncProxyLive` is now gated on the driver capability.
