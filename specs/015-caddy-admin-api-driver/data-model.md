# Data Model: Caddy Admin-API Proxy Driver

No inventory schema or database change. `proxyDriver` gains one enum value
(`caddy-api`) through `PROXY_DRIVER_IDS`. Everything else is in-memory
shapes around Caddy's JSON configuration.

## ProxyDriverId (extended)

`'caddy' | 'nginx' | 'nginx-proxy-manager' | 'none' | 'caddy-api'` in `src/lib/proxy/ids.ts`.
Registration order, which is also the Settings dropdown order, becomes
Caddy, Caddy (admin API), nginx, Nginx Proxy Manager, No proxy.

## Driver seam (from issue #31, unchanged here)

`DriverDeps.configPath` is `string | null`, and `driverDeps()` returns `null`
for a driver whose `defaultConfigPath` is `null`. The Settings page hides
Proxy config path for such a driver (research R8).

`caddyApiDriver`: `id 'caddy-api'`, `label 'Caddy (admin API)'`,
`capabilities { authModes: ['forward','oidc'], acmeDns01ViaCloudflare: true }`,
`defaultConfigPath: null`, `statusPage { suggestedPath: '/usr/share/caddy/index.html' }`.

## CaddyConfig

Caddy's JSON configuration as returned by `GET /config/`: `null` (empty)
or an object. It is parsed with a permissive `zod` schema (constitution
Principle II). Only the paths below are interpreted; every other key is
carried through untouched.

- `apps.http.servers.<name>.listen: string[]`
- `apps.http.servers.<name>.routes: CaddyRoute[]`
- `apps.tls.automation.policies: CaddyTlsPolicy[]`

**CaddyRoute**: `{ "@id"?: string, match?: [{ host?: string[] , … }], handle?, terminal? , … }`

**CaddyTlsPolicy**: `{ "@id"?: string, subjects?: string[], issuers?, … }`

## BellhopObject ids

| Object | `@id` |
| --- | --- |
| Route for a `ProxyRoute` | `bellhop-route-<route.hostnames[0]>` |
| TLS automation policy | `bellhop-tls` |

An object is Bellhop's if and only if its `@id` starts with `bellhop-`.

## CaddyPlan (the driver's `ProxyPlan.payload`)

| Field | Meaning |
| --- | --- |
| `etag` | The `Etag` header from the `GET /config/` the plan was built from. |
| `config` | The complete new configuration, or `null` when there are no changes. |
| `changes` | `{ kind: 'add' \| 'replace' \| 'remove', id, hostnames }[]` and TLS policy changes, for the preview. |
| `conflicts` | `CaddyConflict[]`. |

`apply()` sends nothing when `config` is `null`. Otherwise it sends one
`PATCH /config/` with `If-Match: etag`. After a successful write it throws
when `conflicts` is non-empty (FR-007).

## CaddyConflict

`{ hostname, owner: ProxyRoute['owner'], claimedBy: 'route' | 'tls-policy', server?: string }`
is an inventory hostname that an untagged object already claims. Its whole
`ProxyRoute` is left out of the planned configuration.

## ConvertCaddyfileResult

| Field | Meaning |
| --- | --- |
| `proxyHost` | The `proxy: true` entry. |
| `caddyfile` | The resolved Caddyfile path. |
| `preview` | The same format as `sync-proxy`'s preview, plus the kept hand-authored servers. |
| `conflicts` | As above. |
| `applied` | Whether the configuration was loaded. |
| `nextSteps` | The fixed text: switch service, then select driver. |

## State transitions (operator's Caddy)

```text
caddy.service (Caddyfile)
  └─ convert-caddyfile --apply ─▶ same service, API config loaded + autosaved
       └─ systemctl disable --now caddy; enable --now caddy-api
            └─ caddy-api.service (--resume)  ◀─ sync-proxy with proxyDriver caddy-api
```

`sync-proxy` under `caddy-api` refuses in the first two states, while
`caddy.service` is still active.
