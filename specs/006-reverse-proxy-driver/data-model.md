# Data Model: Reverse-Proxy Driver Interface

## Runtime types (not persisted)

### ProxyRoute

One reverse-proxied site, derived by `buildRoutes(inventory)` from a host,
guest, or external site. See [contracts/driver-interface.md](./contracts/driver-interface.md).

| Field | Type | Source / rule |
|---|---|---|
| `owner.type` | `'host' \| 'guest' \| 'externalSite'` | which inventory array the entry came from |
| `owner.name` | string | entry `name` |
| `hostnames` | string[] (≥ 1) | `publicHostname(sub, inventory.domain)` for each subdomain, in stored order; first is canonical |
| `backend.ip` | string | entry `ip` (required for non-manual entries with subdomains, already enforced by `validateInventory`) |
| `backend.port` | number | entry `port`, default `80` |
| `backend.insecureTls` | boolean | entry `insecureBackendTls === true` |
| `auth` | `{mode:'ungated'} \| {mode:'oidc'} \| {mode:'forward', exemptPaths}` | `effectiveAuth(entry)`; `exemptPaths` from `unauthenticatedPaths` (forward only) |

Derivation rules (unchanged from `buildCaddyBlock`):
- entries with `proxyManual: true` produce no route;
- entries with no subdomains produce no route;
- routes are emitted in the order hosts, guests, external sites, each in
  `loadInventory`'s sorted order;
- if any route is `forward` and no host/guest has `authentik: true` with an
  `ip`, derivation throws `Entry '<name>' has an 'authGroup' set but no
  inventory entry has 'authentik: true' with an ip set`.

### PathPattern

| Stored string | Parsed |
|---|---|
| `/health` (no `*`) | `{ kind: 'exact', path: '/health' }` |
| `/api/*` (ends `/*`, no other `*`) | `{ kind: 'prefix', path: '/api/' }` |
| `/a*b`, `*/x`, `/api*`, `/*/x` | rejected by the schema |

`/*` alone is accepted as a prefix of `/`. Schema rule: must start with
`/`; `*` may appear only as the final character and only immediately after
`/`.

### ProxyContext

| Field | Value |
|---|---|
| `outpost` | `{ ip, port }` of the `authentik: true` entry and `authentikConfig().outpostPort`; absent when no such entry has an ip |
| `externalPort` | `443` |

### ProxyPlan

| Field | Meaning |
|---|---|
| `preview` | exact text the dry run prints; for a file driver, the rendered content |
| `payload` | driver-private data `apply` consumes; for a file driver, the `FileSpec[]` |

### FileSpec (file drivers)

| Field | Meaning |
|---|---|
| `path` | absolute path on the proxy host |
| `content` | full file content (`owned`) or the managed block including markers (`managed-section`) |
| `mode` | `owned`: replace the whole file. `managed-section`: replace the `# BEGIN bellhop-managed` … `# END bellhop-managed` block, or append it if absent, keeping everything else |

### Driver capabilities

| Driver | `authModes` | `acmeDns01ViaCloudflare` | default `configPath` |
|---|---|---|---|
| `caddy` | `['forward', 'oidc']` | `true` | `/etc/caddy/Caddyfile` |

## Persisted changes

### Inventory schema (`src/lib/inventory.ts`)

| Entity | Old field | New field |
|---|---|---|
| HostEntry | `caddy?: boolean` | `proxy?: boolean` |
| HostEntry | `caddyManual?: boolean` | `proxyManual?: boolean` |
| GuestEntry | `caddy?: boolean` | `proxy?: boolean` |
| GuestEntry | `caddyManual?: boolean` | `proxyManual?: boolean` |
| Host/Guest/ExternalSite | `unauthenticatedPaths?: string[]` (must start `/`) | same field; pattern tightened per PathPattern |

`validateInventory` keeps its rules with renamed messages: at most one
entry with `proxy: true`; non-empty `subdomains` requires `ip` unless
`proxyManual`.

### Settings (`SettingsSchema`, `meta` table)

| Key | Type | Default when unset |
|---|---|---|
| `proxyDriver` | enum of `PROXY_DRIVER_IDS` (`'caddy'`) | `caddy` |
| `proxyConfigPath` | string, absolute path (`^/`) | the driver's default `configPath` |

### SQLite (`inventory/bellhop.db`)

| Object | Before | After |
|---|---|---|
| `hosts.caddy` | `INTEGER NOT NULL DEFAULT 0` | `hosts.proxy` (same type) |
| `hosts.caddy_manual` | `INTEGER` | `hosts.proxy_manual` |
| `guests.caddy` | `INTEGER NOT NULL DEFAULT 0` | `guests.proxy` |
| `guests.caddy_manual` | `INTEGER` | `guests.proxy_manual` |
| `caddy_owner` table | single-row owner record | dropped; `proxy_owner` (same shape) |

### Migration states

```text
old schema (caddy, caddy_manual?, caddy_owner)
   │ openInventoryDb: schema runs (creates empty proxy_owner)
   │ migrateCaddyToProxy (one transaction):
   │   RENAME COLUMN caddy → proxy          (hosts, guests; if present)
   │   RENAME COLUMN caddy_manual → proxy_manual (if present)
   │   DROP TABLE IF EXISTS caddy_owner
   │ ensureColumn proxy_manual (adds it if the DB predated caddy_manual)
   ▼
new schema ── reopen: guard false, nothing runs
fresh DB  ── created with new schema, guard false from the start
```

## Characterization fixture (test only)

An example inventory (`example.com`, RFC 5737 addresses, generic names)
whose `buildCaddyBlock` output is captured before the refactor. It must
include at least:

- a host with two subdomains and `insecureBackendTls: true`;
- a guest with a non-default `port`;
- a guest with no `port` (defaults to 80);
- an external site;
- a forward-gated guest with no exempt paths;
- a forward-gated guest with exempt paths in both forms (`/health`,
  `/api/*`);
- an OIDC-mode gated guest with `oidcRedirectUris`;
- a `caddyManual`/`proxyManual` entry with subdomains (no block);
- an entry with no subdomains (no block);
- the `authentik: true` guest with an ip.

A second case asserts the missing-authentik error text.
