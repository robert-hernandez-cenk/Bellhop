# Reverse-proxy drivers

Per-driver detail for the shipped `ReverseProxyDriver` implementations: Caddy (file), nginx, Nginx Proxy Manager, HAProxy, Traefik, and Caddy admin API (plus `convert-caddyfile`). The interface, `getDriver`/`driverDeps`, the `none` driver, `checkCapabilities`, and `fileDriver` are in `src/lib/proxy/CLAUDE.md`.

Shared rules every driver follows:

- Backend scheme: `https://` when the route's `insecureTls` is set (verification off), `https://` with verification when the backend port is 443, else `http://` (Caddy's own rule; every other driver reproduces it).
- `X-Forwarded-Port` is always `ctx.externalPort` (443), so backends building absolute external URLs get the real port (#91).
- Forward-auth passes the same five identity headers: username, groups, email, name, uid (no `entitlements`).
- `ctx.outpost` is only read for a `'forward'` route, which `buildRoutes` never produces without an outpost (it throws its missing-authentik error first).

## Caddy certificate modes (`proxyCaddyTls`)

Both Caddy drivers (`caddy`, `caddy-api`) obtain a site certificate one of four ways, set by `proxyCaddyTls` (read as `ctx.caddyTls`; inert for other drivers):

- `cloudflare` (default; unset means this, byte-identical to the original output): Cloudflare DNS-01 with the fixed `ACME_DNS_RESOLVERS`.
- `letsencrypt`: Caddy's own automatic HTTPS, no DNS provider.
- `internal`: Caddy's own self-signed CA.
- `files`: the shared `proxyTlsCertificate`/`proxyTlsKey` pair (`ctx.tls`) the nginx driver also reads.

`caddyAcmeDns01ViaCloudflare` (`caddyTlsMode(inventory) === 'cloudflare'`) is exported from `caddy.ts` and used by both Caddy drivers' `capabilities.acmeDns01ViaCloudflare`, so `prune-acme-challenges` runs only in `cloudflare` mode.

## Caddy driver (`caddy.ts`)

The default driver, built with `fileDriver`. `capabilities: { authModes: ['forward', 'oidc'], acmeDns01ViaCloudflare: caddyAcmeDns01ViaCloudflare }`, `defaultConfigPath: '/etc/caddy/Caddyfile'`, `validateCommand: caddy validate --adapter caddyfile --config <path>`, `reloadCommand: systemctl reload caddy`. Writes a `'managed-section'` file (`fileDriver` adds the markers); content outside the markers is never touched, and on a Caddyfile with no marker yet the section is appended.

`render()` reads the proxy-neutral `ProxyRoute[]`/`ProxyContext`. Output must stay byte-identical to the original generator: `unauthenticatedPaths` are emitted from the route's raw stored strings in stored order, never reconstructed from the parsed `PathPattern[]`, which keeps the `not path ...` line identical.

- One site block per entry across hosts, guests, and external sites (`ExternalSiteSchema` in `src/lib/inventory.ts`: a proxy target that is not a Proxmox host/guest, e.g. a NAS; never an SSH/exec target). Hostnames joined into one comma-separated address list, canonical first.
- A per-mode TLS clause on every block (`tlsClause(ctx)`): `cloudflare` emits `CLOUDFLARE_TLS_BLOCK`; `letsencrypt` emits none; `internal` emits `tls internal`; `files` emits `tls <cert> <key>` from `ctx.tls`, quoted by `caddyfileToken` when a path holds whitespace, `"` or `\`, escaping only `"` (`\"` is Caddy's only escape inside a quoted token).
- Every `reverse_proxy` in block form with an unconditional `header_up X-Forwarded-Port 443` (`EXTERNAL_PORT`); `insecureTls: true` adds `transport http { tls_insecure_skip_verify }` in the same block.
- A forward-gated route with exempt paths wraps `forward_auth` in a named `@auth_required { not path <patterns...> }` matcher, omitted when the list is empty. `handle /outpost.goauthentik.io/*` routes outpost traffic regardless of any `not path` exemption.
- An `'oidc'` route gets no `forward_auth`/`@auth_required`/outpost passthrough at all.

Exports `OUTPOST_AUTH_URI`/`OUTPOST_PATH_PREFIX`/`AUTHENTIK_COPY_HEADERS`/`CLOUDFLARE_TOKEN_PLACEHOLDER`/`ACME_DNS_RESOLVERS` so the admin-API driver renders identical values.

### Single-operator assumptions

- Within `cloudflare` mode only: the fixed `ACME_DNS_RESOLVERS`, one domain, one DNS provider (`CLOUDFLARE_TLS_BLOCK`). The other three modes avoid it.

## nginx driver (`nginx.ts`)

Built with `fileDriver`. `capabilities: { authModes: ['forward', 'oidc'], acmeDns01ViaCloudflare: () => false }` (nginx cannot obtain its own certificate, so never leaves a stale `_acme-challenge` record). `label: 'nginx'`, `defaultConfigPath: '/etc/nginx/conf.d/bellhop.conf'`, `statusPage: { suggestedPath: '/var/www/html/index.html' }` (Debian/Ubuntu default document root; serving it is the operator's own hand-authored `server` block's job), `usesSharedCertificate: true`, a `configPathNote` warning that the whole file is replaced and a file it didn't generate is refused, `validateCommand: nginx -t`, `reloadCommand: systemctl reload nginx`.

Everything from the `map` blocks through the last `location` of a `server {}` body is rendered by the shared `renderServerBody` (`src/lib/proxy/nginx-locations.ts`), so the Nginx Proxy Manager driver's `advanced_config` can never drift from this driver's output.

### Ownership

The file is `'owned'`, replaced whole on every apply. It opens with a "generated by Bellhop, do not edit" header that is its `ownedHeader`: `buildFileDriverScript` refuses (before any backup or write, non-zero exit, message naming the path and the `set-config proxyConfigPath` fix) to replace an existing file whose first line isn't exactly that header. Reason: `proxyConfigPath` is shared across drivers, and a leftover Caddyfile path would otherwise be replaced whole while `nginx -t` still passed.

### File shape

- Two `map` blocks, emitted unconditionally even with zero routes (file shape never depends on inventory): `$bellhop_connection_upgrade` (WebSocket `Upgrade` -> `Connection: upgrade`, else `''`, mirroring Caddy's automatic passthrough) and `$bellhop_http_host` (Authentik's `$ak_http_host` recipe: `$http_host`, falling back to `$host`, so an explicit port survives). Bellhop-prefixed because `map`/variable names are global in nginx and defining one twice fails `nginx -t`.
- One `server` per route: `listen 443 ssl;` and `listen [::]:443 ssl;` (no `http2` parameter, whose directive differs between supported releases; no port-80 server; both left to the operator), `server_name` = `route.hostnames` canonical-first, `ssl_certificate`/`ssl_certificate_key` from `ctx.tls` (double-quoted), `client_max_body_size 0;`, `proxy_buffering off;`, `proxy_request_buffering off;`, `proxy_read_timeout 1d;`/`proxy_send_timeout 1d;` (nginx's 60s default would cut off a quiet WebSocket/SSE stream; Caddy has none).
- Every proxied location repeats the full proxy-line block rather than hoisting it (nginx only inherits `proxy_set_header` onto a location that defines none): `proxy_http_version 1.1;`, `Host $bellhop_http_host`, `X-Forwarded-For` *set* to `$remote_addr` (never appended, matching Caddy 2.5+ without `trusted_proxies`, so a client can't pose as a LAN address), `X-Forwarded-Proto`/`-Host`, `X-Forwarded-Port` `ctx.externalPort`, and `Upgrade`/`Connection $bellhop_connection_upgrade`. nginx's defaults are the opposite of Caddy's on each point, so a backend would otherwise break on switching drivers.
- Backend TLS: `insecureTls` -> `https://` + `proxy_ssl_verify off;`; port 443 -> `https://` + `proxy_ssl_verify on;` + `proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;` (without the explicit `on`, nginx silently skips the verification Caddy performs); else `http://`.

### Forward-auth

A forward-gated route gets `proxy_buffers 8 16k;`/`proxy_buffer_size 32k;` at server level (sized for Authentik's large headers) and, on `location /`, Authentik's standalone-nginx recipe under bellhop-prefixed names: `auth_request /outpost.goauthentik.io/auth/nginx;`, `error_page 401 = @goauthentik_proxy_signin;`, the `Set-Cookie` pass-back, and the five identity headers. The `location /outpost.goauthentik.io` / `location @goauthentik_proxy_signin` pair is always present on a forward-gated route. OIDC and ungated routes get none of this.

Exempt paths: each unique parsed `unauthenticatedPaths` pattern (deduped on kind+path) becomes its own location with the proxy lines and no `auth_request`: exact path as `location = "<path>"`, `/api/*`-style prefix as `location ^~ "/api/"` (beats any operator regex location, matching Caddy's `path /api/*`). Paths are double-quoted with `\`/`"` backslash-escaped. The bare `/*` pattern produces no location; it removes the forward-auth lines from `location /` itself (a second `location /` would fail `nginx -t` as a duplicate).

A pattern inside `/outpost.goauthentik.io` (exact or beneath) is silently skipped: an exact or `^~` location there would outrank the outpost-passthrough location and misroute the `auth_request` subrequest to the backend. A guest edit (`parseUnauthenticatedPaths`, via `commitGuestEdit`) rejects such a path, so the skip only applies to entries saved earlier or written directly into `bellhop.db`; `UnauthenticatedPathSchema` still accepts it so a saved inventory never becomes unloadable.

### Certificate

Every server block uses `ctx.tls`: one operator-managed certificate (in practice a wildcard, renewed by e.g. `certbot`) covers every site, since nginx cannot obtain per-site certificates. The default path is certbot's for the inventory `domain`.

### Single-operator assumptions

- The CA bundle path `/etc/ssl/certs/ca-certificates.crt` and the `conf.d` default config path assume a Debian/Ubuntu nginx layout. (The shared-certificate default is derived from `domain`, not hardcoded.)

## Nginx Proxy Manager driver (`nginx-proxy-manager.ts`, `src/lib/npm-client.ts`)

A managed driver with no configuration file: `defaultConfigPath: null`, so `driverDeps` resolves `configPath: null` (`DriverDeps.configPath` is `string | null` for this), and the Settings page hides Proxy config path, Status page path, and the TLS fields. It sets `usesNpmApi: true` (#73), so the Settings page shows `npmApiUrl`/`npmApiEmail`/`npmApiPassword` at the end of the Proxy tab while it is selected. `capabilities: { authModes: ['forward', 'oidc'], acmeDns01ViaCloudflare: () => false }`; `statusPage: null`. Tested against NPM 2.16; an older release may reject the fields Bellhop sends.

### `NpmClient`

Same injection pattern as `AuthentikClient`/`CloudflareClient`: a plain interface, a `zod`-validated `RealNpmClient`, and `buildNpmClient(inventory)`, which reads the `npmApiEmail` setting, `npmApiPassword` secret, and optional `npmApiUrl` (else the `proxy: true` entry's `ip` at port 81) through the config accessor at call time (`NPM_API_EMAIL`/`NPM_API_PASSWORD`/`NPM_API_URL` override; see `Settings store` in `src/lib/CLAUDE.md`). Throws a named error before any request when a credential is missing or no URL can be derived.

- Logs into `/api/tokens` lazily, once per `plan()`/`apply()`/`snapshot()` call (each builds its own client via `clientFor`); never refreshes (a sync takes seconds against NPM's one-day token).
- Every request carries `AbortSignal.timeout(NPM_REQUEST_TIMEOUT_MS)` (10s), except `requestCertificate`, which gets `NPM_CERTIFICATE_TIMEOUT_MS` (180s) because NPM runs certbot synchronously inside it.
- `NpmCertificateSchema` has no `meta` field, so a custom certificate's PEM body/private key is dropped at the parse boundary and can never reach a preview, log, `snapshot()`, or error message.
- Every proxy-host field except `id`/`domain_names`/the `forward_*` target/`enabled` is optional with a default (`false` flags, `0` for `certificate_id`/`access_list_id`, `''` for `advanced_config`), so an older-release row still parses (an owned one just shows drift). A certificate's `expires_on` may be `null`, which counts as expired.

### Ownership and conflicts

The first line of every Bellhop-owned proxy host's `advanced_config` is `NPM_OWNERSHIP_MARKER` (`# Managed by Bellhop sync-proxy...`, visible in NPM's UI). `isOwned(host)` is the one predicate; deleting that line by hand hands the host back to the operator.

`planNpmSync` (pure, called by `plan()`) matches each route to the owned host keyed by its canonical (`hostnames[0]`) name. An unowned host claiming any of a route's names (canonical or alias) makes the route a `conflict`. "Unowned" includes every redirection host and 404 host (`listRedirectionHosts`/`listDeadHosts`; live-verified that NPM refuses a proxy host naming a hostname either kind holds); those are never owned, written, or deleted, and the conflict line names the kind (`proxy host #N` / `redirection host #N` / `404 host #N`, since ids are per kind). A route's own owned host is marked matched *before* the conflict check, so a conflicting route's live host is never deleted as stale. Matching is case-insensitive on both sides (every hostname lower-cased first).

### Update ordering

NPM rejects a write naming a hostname another proxy host holds (`"<name> is already in use"`), so an alias moving between two Bellhop hosts must be released before it is claimed. `orderUpdates` is a stable topological sort (`x` before `y` when `x`'s *current* names include one of `y`'s *desired* names); ties keep route order; a genuine cycle (two hosts swapping aliases) keeps route order and fails loudly on NPM's rejection. Deletes always run first, creates last.

### Certificates

`chooseCertificate` keeps the host's current certificate while it covers every route hostname and isn't expired; otherwise picks the qualifying one with the latest `expires_on` (lowest id on a tie). With none, `apply()` requests one over NPM's default HTTP-01 right before that route's create/update (`requestCertificate`, login email as certbot contact; 2.16 has no `letsencrypt_email` field). A failed request throws naming the route and NPM's error, leaving the existing host (update) or no host (create) untouched.

### Read-back

NPM accepts a host nginx later rejects, so after every create/update the driver re-`GET`s it and throws if `meta.nginx_online === false`, quoting `meta.nginx_err` and naming the id, canonical hostname, and that the site is offline until the next successful sync. `planNpmSync` treats an owned host with `meta.nginx_online === false` as drift even when every field matches (pseudo-field `nginx_online` in the changed list), so the next sync rewrites and re-checks it. The first NPM error stops `apply()`; a non-empty `conflicts` list throws only after every other create/update/delete has run, naming all conflicting routes together.

### Rendering

`desiredProxyHost` calls the shared `renderServerBody`, passing NPM's template built-ins (`$http_host`/`$http_connection`) instead of nginx's `map` variables, since `advanced_config` sits inside NPM's own `server {}` and a `map` is only valid at `http {}` level. Every Bellhop host is sent the same fixed settings in full on every create/update (`ssl_forced`/`http2_support`/`allow_websocket_upgrade`: on; `block_exploits`/`caching_enabled`/`hsts_*`/`trust_forwarded_proto`: off; `access_list_id: 0`; `locations: []`), so a hand-edit in NPM's UI is drift the next sync reverts.

### Tests

`test/support/fake-npm-client.ts`'s `FakeNpmClient` is the in-memory `NpmClient` for driver tests (assigns ids like NPM, replicates the duplicate-hostname rejection, can mark writes offline or fail a certificate request). `test/lib/npm-client.test.ts` pins `RealNpmClient` against captured, redacted NPM 2.16.0 fixtures in `test/fixtures/nginx-proxy-manager/` (tokens/PEM bodies/loopback addresses replaced, shape unchanged), same convention as `authentik-client.test.ts`.

## HAProxy driver (`haproxy.ts`)

Built with `fileDriver` over **two** `'owned'` files:

- a backends file at `configPath` (default `/etc/haproxy/bellhop.cfg`), one `backend` per route;
- a map file, `mapPath(configPath)` = `bellhop.map` in `configPath`'s POSIX directory (derived, never configured, so one `proxyConfigPath` moves both), one lower-cased `<hostname> <backend>` line per route hostname, canonical first.

`render()` throws naming `proxyConfigPath` if the two paths coincide once normalised, or if `proxyConfigPath` ends in `/` (which `SettingsSchema` accepts). Both files open with "Generated by Bellhop sync-proxy for HAProxy. Do not edit", deliberately different from nginx's header, and that is each `FileSpec`'s `ownedHeader`, so an apply refuses to replace a Caddyfile or nginx file left at a shared path. `configFiles()` returns both (`snapshot()` reads both, though nothing calls it since `statusPage` is `null`).

### Operator-owned side (documented in `docs/reverse-proxy/haproxy.md`, never generated)

The operator keeps the `frontend` in `/etc/haproxy/haproxy.cfg` (`bind :443 ssl crt <dir>`, their own `default_backend`, one `use_backend %[req.hdr(host),field(1,:),lower,map(/etc/haproxy/bellhop.map)]` line), loads the backends file with `EXTRAOPTS="-S /run/haproxy-master.sock -f /etc/haproxy/bellhop.cfg"` in `/etc/default/haproxy` (the `-S` repeats the Debian unit's default, which that file replaces; one `systemctl restart` needed after the first edit), and runs their own certificate tool. Changing `proxyConfigPath` also requires updating `EXTRAOPTS` and the `map()` path (and a restart); this is documented, not validated.

### Commands

`validateCommand`: `haproxy -c -f /etc/haproxy/haproxy.cfg -f '<configPath>'` (the backends file alone has no frontend/`global`). `reloadCommand`: `systemctl reload haproxy`.

### Backends

- Names: `bellhop_<owner.type>_<name>` (`backendNames`), every char outside `[A-Za-z0-9_.:-]` replaced by `_` (a `/` or space fails `haproxy -c`), `_2`, `_3`, ... appended in route order on collision. The name is the join key between the two files.
- Body: `mode http`; `timeout server`/`timeout tunnel 1d` (a quiet SSE stream's client side stays under the frontend's `timeout client`, which the docs tell operators to raise); first rule `http-request del-header x-authentik- -m beg` (no Bellhop HAProxy backend is behind forward-auth, so any such header is client-supplied and spoofable); `X-Forwarded-For` *set* to `%[src]`; `X-Forwarded-Proto https`; `X-Forwarded-Host` the original Host; `X-Forwarded-Port` `ctx.externalPort`; one `server app <ip>:<port>` with no health `check`.
- TLS suffix: `ssl verify none` for `insecureTls`; `ssl verify required ca-file /etc/ssl/certs/ca-certificates.crt` for port 443; else plain HTTP. HAProxy verifies the chain only, not the name (no `sni`/`verifyhost`); documented, not worked around.

### Auth

`capabilities: { authModes: ['oidc'], acmeDns01ViaCloudflare: () => false }`. No forward-auth, so `checkCapabilities` refuses a forward-gated entry; `render()` still throws `HAProxy cannot enforce forward-auth for entry '<name>'` as a backstop so a forward route can never deploy ungated. An `oidc` route renders like an ungated one; `unauthenticatedPaths` never appear. `statusPage: null`, no `usesSharedCertificate` (certificates live in the operator's frontend), so the Settings page shows only Proxy config path, with a `configPathNote` about the map file and ownership refusal.

Checked by hand with a real `haproxy -c` against HAProxy 2.6 and 3.4; `npm test` needs no HAProxy.

### Single-operator assumptions

- Main config path `/etc/haproxy/haproxy.cfg`, CA bundle path (shared with nginx), and `systemctl reload haproxy` are fixed Debian/Ubuntu package defaults, not settings.

## Traefik driver (`traefik.ts`)

Built with `fileDriver` over one `'owned'`, `atomic: true` file at `configPath` (default `/etc/traefik/dynamic/bellhop.yml`). `atomic` because Traefik's file provider watches the directory live and an in-place truncate could expose a half-written file (see `fileDriver` in `src/lib/proxy/CLAUDE.md`). Checked against Traefik v3.7.13; Traefik v2 is unsupported.

### Rendering and object names

`render()` emits one `http:` document: `routers`/`services` omitted when empty, `middlewares` always present (file never empty). Every name is prefixed `bellhop-`; a route's names derive from its canonical hostname via `encodeHostname`: lowercase, double every `-`, *then* turn each `.` into `-`. Doubling first keeps it injective for valid DNS names (`a.b-c.example.com` vs `a-b.c.example.com`). A label starting/ending in `-` can still collide (`a-.b` vs `a.-b`), so `render()` throws naming both canonical hostnames. `render()` also throws (dry run included) when `proxyConfigPath` ends in `/` or doesn't end in `.yml`/`.yaml` (the file provider would never load it), naming the path and the `settingFix` remedy. Both `stringify` passes use `lineWidth: 0` so long rules never fold.

- Per route: router+service `bellhop-route-<enc>`; router `bellhop-exempt-<enc>` (forward-gated with exempt paths left after dropping outpost-namespace ones, and no bare `/*`); router `bellhop-outpost-<enc>` (forward-gated only).
- Shared: middleware `bellhop-strip-authentik-headers` (always present; sets the five `X-authentik-*` headers to `""`, which Traefik treats as remove; every router lists it first, so a client-sent identity header never reaches a backend, including via an exempt path or Bellhop's own web UI); middleware `bellhop-forwarded-port` (always present, `X-Forwarded-Port: 443` via `customRequestHeaders`); middleware `bellhop-authentik` (only when some route is forward-gated, listed after the strip); service `bellhop-authentik-outpost`; `serversTransports` entry `bellhop-insecure-backend-tls` (`insecureSkipVerify: true`, only when some backend needs it).
- A forward-gated main router carries `bellhop-authentik` unless its exempt patterns include a bare `/*`; then the middleware is dropped and no exempt router is rendered. The outpost router stays either way.
- `candidateExemptPatterns` (dedup plus outpost-namespace skip) and `isRootPrefix` are imported from `nginx-locations.ts`, so nginx and Traefik share one definition.
- `backendUrl`: `https://` when `insecureTls` or port 443, else `http://`. With `insecureTls` the service names the insecure transport; otherwise Traefik's default transport verifies a 443 backend against the system CA pool.

### Rule syntax

Main: `Host(`a`) || Host(`b`)` (canonical first). Outpost: `(<hosts>) && PathPrefix(`/outpost.goauthentik.io/`)`. Exempt: `(<hosts>) && (Path(`/x`) || PathPrefix(`/api/`))`, patterns in stored order. `ruleValue` backtick-quotes unless the value contains a backtick, then falls back to `JSON.stringify` (live-verified to parse identically). No router sets `priority`: Traefik then ranks by rule length, and the exempt/outpost rules embed the main rule's host expression plus more, so they always win.

### Forward-auth

`bellhop-authentik` is a `forwardAuth` middleware at `http://<outpost ip>:<port>/outpost.goauthentik.io/auth/traefik` with `trustForwardHeader: true` and the five identity headers (Authentik's Traefik recipe).

### Certificate resolver and settings

Every router's `tls.certResolver` is `certResolverName(inventory)` = `inventory.proxyCertResolver ?? DEFAULT_CERT_RESOLVER` (`'cloudflare'`, `src/lib/proxy/routes.ts`), carried as `ProxyContext.certResolver` (always present). The reserved value `NO_CERT_RESOLVER = 'none'` (also in `routes.ts`, already admitted by the regex) makes `routerTls(ctx)` render `tls: {}`, so Traefik serves a certificate from its file provider or default certificate.

`capabilities: { authModes: ['forward', 'oidc'], acmeDns01ViaCloudflare: traefikAcmeDns01ViaCloudflare }` (`certResolverName(inventory) !== NO_CERT_RESOLVER`): any named resolver might be Cloudflare DNS-01 in the operator's static config, so `prune-acme-challenges` keeps running; only `none` skips it. `statusPage: null` (Traefik serves no static files; existing `statusPageUnsupportedError`/`statusPageSkipReason` paths cover it).

Two settings, inert for other drivers, shown only while Traefik is selected (driver flags `usesCertResolver`/`usesApiUrl`): `proxyCertResolver` (`^[A-Za-z0-9_-]+$`, Traefik's own resolver-name rule) and `proxyApiUrl` (`new URL`, must be `http:`/`https:`; the no-single-quote check is defensive, since it is embedded in a `singleQuote`-escaped string).

### API check (opt-in)

Traefik has no validate command: a file it can't decode as YAML is rejected entirely, while an object-level problem (missing service/middleware, unknown entry point, bad rule) leaves the rest loaded and reports that router `"status":"disabled"` with an `"error"` array. So `def.validateCommand` returns `null` unless `proxyApiUrl` is set; `reloadCommand` is always `null` (a write is live the moment the rename lands).

`buildApiCheck(apiUrl, configPath, content)` builds the POSIX `sh` subshell sent as the validate step:

1. `command -v curl`; if missing, fail at once naming the fix (install curl on the proxy host, or unset `proxyApiUrl`).
2. Poll `GET /api/http/middlewares/<marker>@file` (`curl -s -o /dev/null -w '%{http_code}' --max-time 5`, once a second, up to 30 tries) until `200`. The marker's name is a SHA-256 of the file rendered without it, proving Traefik loaded this exact version. `generationMarkerName`/`routerNames` parse the marker and router names back out of the rendered `content`, so the check matches exactly what was written.
3. `GET /api/http/routers/<name>@file` for every router in the file, by exact name (not `?search=`, which also matches rule text and could sweep in an operator router), collecting every one not `"status":"enabled"` before failing, so all are reported at once.

On failure `fileDriver`'s trap restores the previous file. Tests stub `curl` and `sleep` on `PATH` (stub `sleep` keeps the 30-attempt timeout instant).

Known gaps (documented in `docs/reverse-proxy/traefik.md`):

- The timeout is fixed at 30 checks one second apart, no override. Each check can take up to `--max-time 5`, so the message says "after 30 checks one second apart", never "within 30 seconds".
- A router naming a `certResolver` the static config doesn't define stays `"status":"enabled"` with no error (live-verified; only Traefik's log shows `Router uses a nonexistent certificate resolver`), so a wrong `proxyCertResolver` is not caught.

### Scope

Out of scope: the Docker-labels provider, an HTTP provider served by Bellhop, and Traefik's static configuration. This driver only writes into the file provider's directory.

### Single-operator assumptions

- Every router uses entry point `websecure` (not configurable).
- An unset `proxyCertResolver` means a resolver named `cloudflare`.
- The API check's load timeout is fixed at 30 checks one second apart.

## Caddy admin-API driver (`caddy-api.ts`)

`proxyDriver: 'caddy-api'`, label "Caddy (admin API)". Serves exactly what the file-based Caddy driver serves, but reconciles Caddy's live JSON configuration through its admin API. Not built on `fileDriver`; `defaultConfigPath: null`, so `driverDeps()` resolves `configPath: null` and the Settings page hides Proxy config path but still shows Status page path (suggestion `/usr/share/caddy/index.html`). Capabilities match Caddy's (`forward` + `oidc`, `acmeDns01ViaCloudflare: caddyAcmeDns01ViaCloudflare`).

### `src/lib/proxy/caddy-json.ts` (pure)

- `renderRoute` produces route JSON. `renderTlsObjects(hostnames, ctx)` produces each mode's TLS objects: `{ policy }` (automation policy) for `cloudflare`/`internal`; `{ loadFile, connectionPolicy }` for `files`; `{}` for `letsencrypt`. `renderDefaultConnectionPolicy()` is the adapter's trailing catch-all connection policy, placed by `planCaddyConfig` because whether it's needed depends on the live server.
- Output equals what Caddy's own adapter makes from the Caddy driver's site block, pinned by a parity test against `test/fixtures/caddy/{characterization,tls-internal,tls-files,tls-letsencrypt}-adapted.json` (real Caddy v2.10.2 `caddy adapt` captures of `caddy.test.ts`'s characterization block per mode).

### `planCaddyConfig(current, routes, ctx, host)`

- Every Bellhop object carries an `@id` starting `bellhop-`: `bellhop-route-<canonical hostname>` per route; per mode, zero or more of `bellhop-tls` (automation policy, `cloudflare`/`internal`), `bellhop-tls-files` (`load_files` entry, certificate tagged `bellhop-cert` instead of the adapter's `cert0`, `files` only), `bellhop-tls-connection` (SNI-matched connection policy selecting that tag, `files` only), `bellhop-tls-default` (catch-all connection policy, `files` only, and only when the server has no untagged catch-all already). Nothing untagged is ever changed.
- Routes are prepended to the single server listening on 443 (an empty config gets `srv0` on `:443`; zero or several HTTPS servers throws naming them). The automation policy is prepended to `apps.tls.automation.policies` and removed once no route is left (an empty-`subjects` policy would match every hostname); `files`-mode objects are pruned the same way when their containers would be empty.
- Conflicts (`CaddyConflict`): an untagged route in any server naming an inventory hostname exactly (case-insensitive; wildcards don't count) always; an untagged automation policy naming one only in `cloudflare`/`internal` mode (in `letsencrypt`/`files` Bellhop writes no policy, so an operator catch-all policy is meant to apply). A conflicting route is left out.
- Comparison is key-order-insensitive (`canonicalJson`; Caddy returns keys sorted), so an unchanged inventory plans `config: null` and writes nothing, in every mode.

### `src/lib/proxy/caddy-admin.ts` (remote half, POSIX `sh` via `runRemote`)

- `readCaddyConfig` runs `curl -sS -D - http://localhost:2019/config/`, parses the `Etag`, and validates the body with a passthrough zod schema. For a sync it is preceded by `systemctl is-active --quiet caddy.service`; exit 3 gives the "running from a Caddyfile" refusal, because `systemctl reload caddy` would discard every API change. Skipped for `snapshot()` and `convert-caddyfile`.
- `writeCaddyConfig` sends the whole config as compact JSON in a quoted heredoc with one `PATCH /config/` + `If-Match: <etag>`. Live-verified against Caddy v2.10.2: `PATCH /config/` honors `If-Match` (412 on a stale one, nothing written), `POST /load` silently ignores it, and a config Caddy can't provision gets a 500 with the previous config still running.
- `apply()` writes the non-conflicting config first, then throws one line per conflict. `snapshot()` pretty-prints `GET /config/`.

### `convert-caddyfile`

`convert-caddyfile [--caddyfile <path>] [--apply]` (`src/commands/networking/convert-caddyfile.ts`, CLI-only, one-time) switches a deployment over: copies the Caddyfile minus the bellhop-managed block to a temp file *beside* it (so relative `import`s resolve), runs `caddy adapt`, runs the same planner to add Bellhop's routes, and `PATCH`es the result against the live `Etag` while `caddy.service` is still running (Caddy autosaves it, and `caddy-api.service`'s `--resume` loads the autosave). Refuses once the live config already holds a `bellhop-` object.

### Limits

A guest proxy host receives the whole config as one `sh -c` argument through `pct exec`, so it is bounded by Linux's 128 KiB single-argument limit (documented in `docs/reverse-proxy/caddy-api.md`, not engineered around).

### Single-operator assumptions

- Admin address fixed at Caddy's default `localhost:2019` on the `proxy: true` entry.
- Caddy runs under systemd with the packaged unit names (`caddy.service` for the Caddyfile check, `caddy-api.service` as the documented target).
- `curl` is installed on the proxy host.
- Within `cloudflare` mode only: the fixed `ACME_DNS_RESOLVERS` shared with the Caddy driver.
