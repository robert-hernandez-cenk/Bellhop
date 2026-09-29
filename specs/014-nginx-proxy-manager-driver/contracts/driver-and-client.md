# Contract: NPM driver, client, and messages

Example values only. `app.example.com` etc. stand for any route.

## Driver registration

- `PROXY_DRIVER_IDS` = `['caddy', 'nginx', 'nginx-proxy-manager', 'none']`;
  `listDrivers()` order: Caddy, nginx, Nginx Proxy Manager, No proxy.
- `nginxProxyManagerDriver`: `id: 'nginx-proxy-manager'`,
  `label: 'Nginx Proxy Manager'`, `capabilities: { authModes: ['forward',
  'oidc'], acmeDns01ViaCloudflare: false }`, `defaultConfigPath: null`,
  `statusPage: null`, no `usesSharedCertificate`, no `configPathNote`.
- `driverDeps()` returns `configPath: null` for it (and for any driver with
  `defaultConfigPath: null`), even if `proxyConfigPath` is set.

## `NpmClient` (src/lib/npm-client.ts)

```ts
interface NpmClient {
  readonly baseUrl: string;                       // for messages/snapshot
  listProxyHosts(): Promise<NpmProxyHost[]>;
  getProxyHost(id: number): Promise<NpmProxyHost>;
  createProxyHost(body: NpmProxyHostBody): Promise<{ id: number }>;
  updateProxyHost(id: number, body: NpmProxyHostBody): Promise<void>;
  deleteProxyHost(id: number): Promise<void>;
  listCertificates(): Promise<NpmCertificate[]>;
  requestCertificate(domainNames: string[]): Promise<{ id: number }>;
}
```

- Logs in lazily on first call (`POST /api/tokens`), once per client.
- Every request: `AbortSignal.timeout(NPM_REQUEST_TIMEOUT_MS)` (10 000);
  `requestCertificate`: `NPM_CERTIFICATE_TIMEOUT_MS` (180 000).
- Non-2xx -> `Error("Nginx Proxy Manager API <status> <METHOD> <path>: <error.message>")`,
  plus, when the body has `debug.stack`, its non-empty lines joined with
  `' / '` (certbot's reason for a failed certificate).
- Network failure/timeout -> `Error("Could not reach Nginx Proxy Manager at <baseUrl>: <cause>")`.
- Login `400` -> `Error("Nginx Proxy Manager at <baseUrl> rejected the login for <email>: Invalid email or password -- check NPM_API_EMAIL/NPM_API_PASSWORD in data/nginx-proxy-manager.env")`.
- `buildNpmClient(inventory, fetchImpl?)` throws
  `NPM_UNCONFIGURED_MESSAGE` = `"Nginx Proxy Manager API not configured -- set NPM_API_EMAIL and NPM_API_PASSWORD (and optionally NPM_API_URL) in data/nginx-proxy-manager.env"`
  when either credential is missing, and
  `"No NPM_API_URL is set and no inventory entry has 'proxy: true' with an ip -- set NPM_API_URL in data/nginx-proxy-manager.env"`
  when it can't derive a URL.

## `plan()` preview

Header line, then one line per route in route order, then deletes:

```text
Nginx Proxy Manager at http://192.0.2.30:81
  + create  app.example.com, www.example.com -> http://192.0.2.10:8080  [certificate: #3 Wildcard example.com]
  ~ update  media.example.com (#12): forward_port, advanced_config
  = ok      wiki.example.com (#14)
  + create  new.example.com -> https://192.0.2.11:443  [certificate: request Let's Encrypt for new.example.com]
  ! conflict docs.example.com: already claimed by proxy host #9 (not created by Bellhop) -- delete or change it in Nginx Proxy Manager, or mark the entry proxyManual
  - delete  old.example.com (#7)
N change(s), M conflict(s)
```

With no changes and no conflicts, the last line is `No changes`.

## `apply()`

Order: deletes -> updates -> creates. For a route needing
`{ kind: 'request' }`, `requestCertificate` runs immediately before its
create/update. After each create/update, `getProxyHost(id)`; if
`meta.nginx_online === false`:
`Error("Nginx Proxy Manager saved proxy host #<id> (<canonical>) but nginx rejected its configuration: <nginx_err> -- the site is offline until the next successful sync")`.
The first error stops the apply. After all changes, when conflicts exist:
`Error("<n> route(s) skipped because a proxy host not created by Bellhop already claims their hostnames: <canonical> (#<ids>)[, ...] -- delete or change those proxy hosts in Nginx Proxy Manager, or mark the entries proxyManual")`.

## `snapshot()`

```text
Nginx Proxy Manager at http://192.0.2.30:81 -- N proxy host(s) managed by Bellhop

#12 media.example.com -> http://192.0.2.12:8096
    certificate: #3 Wildcard example.com   forward-auth: yes   online: yes
    <advanced_config, indented 4 spaces>
```

Never includes certificate PEMs or keys (the certificate schema drops `meta`).

## `advanced_config` (shared renderer)

`src/lib/proxy/nginx-locations.ts` exports
`renderServerBody(route, ctx, vars): string[]` — the lines the nginx driver
puts inside `server {}` after its TLS lines (from `client_max_body_size 0;`
to the last location), with
`vars = { host: string; connection: string }`. The nginx driver passes
`{ host: '$bellhop_http_host', connection: '$bellhop_connection_upgrade' }`
and its output stays byte-identical; the NPM driver passes
`{ host: '$http_host', connection: '$http_connection' }` and builds
`advanced_config = [NPM_OWNERSHIP_MARKER, ...lines].join('\n')`, indentation
unchanged.

## Settings page

`proxyFieldView` for a managed driver with `defaultConfigPath: null`:
`showConfigPath: false`. So for Nginx Proxy Manager all of config path,
status page path, and TLS fields are hidden.
