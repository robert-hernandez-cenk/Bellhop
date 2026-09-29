# Research: nginx Proxy Driver

Decisions for issue #30. The concept mapping (nginx `auth_request`,
`location =`/prefix locations, `proxy_ssl_verify`, external certificate
tool) was already settled on paper in
`specs/006-reverse-proxy-driver/research.md` R3/R5/R6/R8; this file records
what that analysis left open.

## R1. Certificate source: one shared certificate

**Decision**: every generated `server` block uses the same
`ssl_certificate`/`ssl_certificate_key`, from two new optional settings
`proxyTlsCertificate`/`proxyTlsKey`, defaulting to
`/etc/letsencrypt/live/<domain>/fullchain.pem` and `.../privkey.pem`.

**Rationale** (user's choice during brainstorming): Caddy obtains a
certificate per site automatically, so adding a subdomain from the Dashboard
goes live in one save. nginx cannot obtain certificates, so a per-hostname
layout would make every new subdomain's sync fail `nginx -t` (and roll
back) until the operator issued its certificate by hand. A wildcard for the
domain keeps the one-save behavior and also keeps individual hostnames out
of Certificate Transparency logs. certbot names a lineage after its first
`-d` value, so `certbot certonly -d example.com -d '*.example.com'` lands
exactly at the default paths.

**Alternatives considered**: per-hostname certbot layout (closest to
Caddy's per-site certificates, but breaks one-save subdomain edits); a
`{hostname}` path template (covers both, more to explain, no current need).

## R2. Where the certificate paths live in the driver model

**Decision**: `ProxyContext` gains a required `tls: { certificatePath,
keyPath }`, resolved by `buildProxyContext` from the settings, else the
domain-derived default. The Caddy driver ignores it.

**Rationale**: `render(routes, ctx, configPath)` is the only input a file
driver gets; `ctx` is already the "proxy-neutral facts every driver needs"
object (`outpost`, `externalPort`), and a future HAProxy driver (#32) needs
the same certificate. Required rather than optional because
`buildProxyContext` can always derive it (the domain is mandatory), so a
driver never has to handle "no certificate".

**Alternatives considered**: widening `render` to receive `DriverDeps`
(leaks SSH/inventory into a function that is pure today); reading the
settings inside the nginx driver (a second place resolving the default).

## R3. Following Authentik's own nginx recipe

**Decision**: the forward-auth block follows Authentik's standalone-nginx
documentation (`website/docs/add-secure-apps/providers/proxy/_nginx_standalone.mdx`
in goauthentik/authentik, read 2026-09-28):

- `location /` gets `auth_request /outpost.goauthentik.io/auth/nginx`,
  `error_page 401 = @goauthentik_proxy_signin`, the `Set-Cookie`
  pass-back, and `auth_request_set` + `proxy_set_header` for each identity
  header.
- `location /outpost.goauthentik.io` proxies to
  `http://<outpost ip>:<port>/outpost.goauthentik.io` with `Host`,
  `X-Original-URL`, `proxy_pass_request_body off`, and an empty
  `Content-Length`.
- `location @goauthentik_proxy_signin` (internal) returns
  `302 /outpost.goauthentik.io/start?rd=$scheme://<host>$request_uri`.
- `proxy_buffers 8 16k; proxy_buffer_size 32k;` on gated sites, which the
  recipe gives for Authentik's large response headers.

Differences from the recipe, each deliberate:

- **Five identity headers, not six**: username, groups, email, name, uid —
  the same five the Caddy driver copies. The recipe's `entitlements` header
  is left out so both drivers hand backends the same identity.
- **Bellhop-prefixed variables and map names** (`$bellhop_http_host`,
  `$bellhop_connection_upgrade`, `$bellhop_auth_cookie`,
  `$bellhop_authentik_*`): `map` and variable names are global across the
  whole nginx configuration, and the operator's own files may already
  define the recipe's `$connection_upgrade_keepalive`/`$ak_http_host`.
  Defining a `map` twice fails `nginx -t`.
- **One unique named location per site is not needed**: named locations
  are scoped to their `server` block, so `@goauthentik_proxy_signin` is
  reused in each gated site as the recipe writes it.
- **No `server_name _`/`listen ... http2`**: see R6.

## R4. Parity with Caddy's `reverse_proxy` defaults

**Decision**: every proxied location sets `proxy_http_version 1.1`,
`Host $bellhop_http_host`, `X-Forwarded-For $proxy_add_x_forwarded_for`,
`X-Forwarded-Proto $scheme`, `X-Forwarded-Host $bellhop_http_host`,
`X-Forwarded-Port 443`, `Upgrade $http_upgrade`,
`Connection $bellhop_connection_upgrade`; the server sets
`client_max_body_size 0` and `proxy_buffering off`.

**Rationale**: Caddy passes the original `Host`, sets
`X-Forwarded-For/Proto/Host`, proxies WebSockets, never caps request
bodies, and streams responses. nginx's defaults are the opposite on each
point (`Host` becomes the upstream address, no forwarded headers, HTTP/1.0
without upgrade, a 1 MB body limit, buffered responses). Backends that work
behind the Caddy driver today (photo uploads, WebSocket UIs, server-sent
events) would break on switching drivers otherwise. `X-Forwarded-Port 443`
matches the Caddy driver's unconditional `header_up` (issue #91).

`$bellhop_http_host` is the recipe's `$ak_http_host` map: `$http_host`,
falling back to `$host`, so an explicit port in `Host` survives.

`proxy_set_header` is inherited from the `server` level only by locations
that define none of their own, and every location here defines some, so
the header set is repeated per location rather than hoisted.

## R5. HTTPS upstreams

**Decision**: `proxy_pass https://` when `insecureTls` is set or the backend
port is 443; plain `http://` otherwise. `insecureTls` adds
`proxy_ssl_verify off`. A port-443 backend without it adds
`proxy_ssl_verify on` and
`proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt`.

**Rationale**: this is Caddy's rule — `reverse_proxy` enables TLS to a
port-443 upstream automatically, and `tls_insecure_skip_verify` in a
`transport http` block enables TLS without verification. nginx never
verifies upstream certificates unless told to, so without the explicit
`on` a port-443 backend would silently lose the verification Caddy
performs. The CA bundle path is the Debian/Ubuntu one, the same platform
assumption as the `conf.d` default path (spec Assumptions).

## R6. Listening and scope

**Decision**: `listen 443 ssl;` and `listen [::]:443 ssl;`, no `http2`, no
port-80 server, no `default_server`.

**Rationale**: the HTTP/2 directive changed in nginx 1.25.1 (`http2 on;`
replaces the `listen ... http2` parameter, which now warns); picking either
breaks or warns on some supported distribution release. A port-80 redirect
would compete with the operator's own default server and with certbot's
HTTP-01 webroot if they use one. Both are left to the operator's own
configuration and listed as out of scope in the spec.

## R7. Exempt paths

**Decision**: for a forward-gated route with `unauthenticatedPaths`, each
unique parsed pattern (from `route.auth.exemptPaths`, deduplicated on
`kind`+`path`, in stored order) becomes a location with the same proxy
settings as `location /` and no `auth_request`:

- exact `/health` -> `location = "/health"`
- prefix `/api/*` -> `location ^~ "/api/"`
- prefix `/*` -> no extra location; `location /` itself drops
  `auth_request` (and its sign-in/identity lines), since a second
  `location /` fails `nginx -t` with a duplicate-location error.

Paths are written as double-quoted strings with `\` and `"` escaped, so
spaces, `;`, `{`, or `#` in a path are matched literally instead of
breaking the file. `^~` makes the prefix win over any regex location an
operator include might add, and matches Caddy's `path /api/*` semantics
(everything beginning with `/api/`).

**Rationale**: `exemptPaths` is the parsed form issue #10 added precisely
so drivers other than Caddy don't reparse strings (006 research R5).

## R8. Owned file content and ordering

**Decision**: the file starts with a comment header saying it is generated
by Bellhop's `sync-proxy` and replaced on every apply, then the two `map`
blocks, then one `server` block per route in `buildRoutes` order. The maps
are emitted even when there are no routes, so the file's shape does not
depend on the inventory.

**Rationale**: `'owned'` mode replaces the file whole (006 R6); a header
tells anyone opening it not to hand-edit. Emitting maps unconditionally
keeps the render simple and costs nothing.

## R9. Testing the delivery path

**Decision**: nginx-driver unit tests assert rendered text for each
feature, plus one executed-script test that runs the nginx driver's real
`apply` script (via `buildFileDriverScript` with the driver's own
validate/reload commands and an owned `FileSpec`) under `sh` with stub
`nginx` (exits 1) and `systemctl` (records calls) on `PATH`, asserting the
old file is restored byte for byte, a previously absent file is removed,
and nothing is reloaded.

**Rationale**: same technique issue #10 established in
`test/lib/proxy/file-driver.test.ts` for Caddy's managed-section mode; this
covers the `'owned'` mode path with nginx's real commands, which no test
executes today. Constitution III is unaffected: command logic is still
tested via `FakeSSHClient`.

## R10. Tests that used "nginx" as an unknown driver id

**Decision**: four existing tests (`test/lib/inventory.test.ts`,
`test/lib/proxy/index.test.ts`, `test/commands/set-config.test.ts`,
`test/web/routes/settings.test.ts`) use `'nginx'` as their example of an
id no driver has. They switch to `'unknown-provider'`, a name no real driver will ever take -- `'traefik'` was avoided because Traefik is a plausible future driver.
