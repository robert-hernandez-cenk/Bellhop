# Data Model: Nginx Proxy Manager Proxy Driver

No inventory schema change beyond one new `proxyDriver` enum value. Everything
else lives in NPM or in memory for one sync.

## NpmConnection (env, `data/nginx-proxy-manager.env`)

| Variable | Required | Meaning |
|---|---|---|
| `NPM_API_EMAIL` | yes | NPM login email |
| `NPM_API_PASSWORD` | yes | NPM login password |
| `NPM_API_URL` | no | API base, e.g. `http://192.0.2.30:81`; unset = `http://<proxy: true ip>:81` |

Missing either required variable -> `NPM_UNCONFIGURED_MESSAGE`, before any
request. A trailing `/` or `/api` on `NPM_API_URL` is normalised away.

## NpmProxyHost (read from NPM, zod-validated; unknown fields ignored)

| Field | Type | Notes |
|---|---|---|
| `id` | number | |
| `domain_names` | string[] | |
| `forward_scheme` | `'http' \| 'https'` | |
| `forward_host` | string | |
| `forward_port` | number | |
| `certificate_id` | number | `0` = none; missing reads as `0` |
| `ssl_forced`, `http2_support`, `allow_websocket_upgrade`, `block_exploits`, `caching_enabled`, `hsts_enabled`, `hsts_subdomains`, `trust_forwarded_proto` | boolean | missing reads as `false` (an older or hand-made row still parses) |
| `enabled` | boolean | required |
| `access_list_id` | number | missing reads as `0` |
| `advanced_config` | string | owned iff first line is `NPM_OWNERSHIP_MARKER`; missing reads as `''` |
| `locations` | array \| null | null read as `[]` |
| `meta` | `{ nginx_online?: boolean; nginx_err?: string \| null }` | other keys ignored |

## NpmCertificate (read from NPM; `meta` dropped by the schema)

| Field | Type | Notes |
|---|---|---|
| `id` | number | |
| `provider` | string | `letsencrypt` or `other` |
| `nice_name` | string | |
| `domain_names` | string[] | may be empty (uploaded-but-empty `other`) |
| `expires_on` | string | null | UTC `YYYY-MM-DD HH:MM:SS`; null or unparseable = treated as expired |

## NpmNameHolder (redirection hosts and 404 hosts; read only)

| Field | Type | Notes |
|---|---|---|
| `id` | number | numbered per kind, separately from proxy hosts |
| `domain_names` | string[] | |

Every other field is ignored. Bellhop never creates, updates or deletes
either kind (research R13).

## DesiredProxyHost (derived per route)

The R9 body in research.md: `domain_names`, `forward_*`, the fixed booleans,
`access_list_id: 0`, `locations: []`, `advanced_config`, and a
`certificate: { kind: 'existing', id } | { kind: 'request' }`.

## NpmSyncPlan (the `ProxyPlan.payload`)

```text
routes:     one entry per route, each exactly one of
              { action: 'create', owner, desired, certificate }
              { action: 'update', owner, hostId, desired, certificate, changed: string[] }
              { action: 'unchanged', owner, hostId }
              { action: 'conflict', owner, hostnames: string[], claimants: { kind, id }[] }
deletes:    { hostId, domainNames }[]       owned hosts matching no route
```

`certificate` is `{ kind: 'existing', id, name }` or
`{ kind: 'request', domainNames }`. `changed` lists NPM field names
(`certificate_id` included when the certificate changes), plus the
pseudo-field `nginx_online` when NPM reports the host offline (research
R6). A claimant's `kind` is `proxy`, `redirection` or `dead` (a 404
host), sorted in that order, then by id.

### Matching rules

1. Owned hosts are keyed by `domain_names[0]` (lower-cased). A route matches
   the owned host whose key equals its canonical hostname.
2. An owned host that no route matches is a delete — even if some route
   lists one of its non-canonical names; deletes run first, so that name is
   free again before the create/update that claims it.
3. For each route, any **unowned** proxy host, and any redirection host or
   404 host (never owned, research R13), whose `domain_names` intersects the
   route's hostnames (case-insensitive) makes the route a `conflict`.
4. Otherwise create or update/unchanged per the R9 field comparison; an
   owned host NPM reports offline (`meta.nginx_online === false`) is an
   update even when every field matches (research R6).

### State transitions (one proxy host)

```text
(absent) --create--> owned, online
owned --update (drift)--> owned, online
owned, offline --update (nginx_online)--> owned, online (or offline again -> apply throws)
owned --route gone--> (deleted)
owned --marker removed by hand--> unowned (never touched again; may cause a conflict)
any write --nginx rejects advanced_config--> owned, offline -> apply throws nginx_err
```
