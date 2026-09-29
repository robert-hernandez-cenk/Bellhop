# Research: Nginx Proxy Manager Proxy Driver

All findings below were verified against a real Nginx Proxy Manager 2.16.0
(`jc21/nginx-proxy-manager:latest`, 2026-09-29) run locally in a container,
using example names only (`*.example.test`, a self-signed wildcard
certificate). The captured responses, redacted per constitution Principle I
(tokens, PEM bodies, loopback addresses replaced; shape unchanged), are in
`test/fixtures/nginx-proxy-manager/`.

## R1. API surface and authentication

**Decision**: `POST /api/tokens {identity, secret}` returns `{ token,
expires }` (a JWT, valid one day); every other call sends `Authorization:
Bearer <token>`. A client logs in once per `plan()`/`apply()` call and never
refreshes.

**Evidence**: `token-create.json`; a wrong password is `400 {"error":{"code":
400,"message":"Invalid email or password"}}` (`token-create-bad-password.json`);
no token is `403 Permission Denied` (`no-token.json`). Every error body has
the shape `{ error: { code, message } }`.

**Rationale**: a sync takes seconds against a one-day token, so a refresh
path would never run. `GET /api/tokens` refreshes (`token-refresh.json`) if
that ever changes.

**Alternatives considered**: reuse one token across syncs (needs shared
state with expiry handling for no benefit); API keys (NPM has none).

## R2. Reaching the API

**Decision**: plain HTTP from the Bellhop host. `NPM_API_URL` in
`data/nginx-proxy-manager.env` overrides; unset, the base is
`http://<proxy: true entry's ip>:81`. Credentials are `NPM_API_EMAIL` and
`NPM_API_PASSWORD` in the same file, dotenv-loaded by `src/cli.ts`,
`src/web/server.ts` and `src/mcp/server.ts` (the same three entry points
that load `data/cloudflare-api.env`). Missing email or password fails before
any request, naming the file and both variables.

**Rationale**: chosen by the operator during brainstorming; matches
`AuthentikClient`/`CloudflareClient` and keeps the JSON bodies out of shell
quoting. The default URL follows the `proxy: true` entry, the same way the
firewall scope does, so there is no operator-specific literal.

**Alternatives considered**: curl over `runRemote` on the proxy host (keeps
port 81 on localhost, but every body is shell-quoted and the client becomes
hard to test).

## R3. Timeouts

**Decision**: 10 s per request (`NPM_REQUEST_TIMEOUT_MS`), except a
certificate request, which gets 180 s (`NPM_CERTIFICATE_TIMEOUT_MS`).

**Evidence**: `POST /api/nginx/certificates` with `provider: letsencrypt`
runs certbot synchronously inside the request (the failure body in
`certificate-request-letsencrypt-failure.json` carries certbot's own command
line). A successful HTTP-01 issuance takes tens of seconds.

**Rationale**: the 10 s bound matches the Cloudflare client (the Dashboard
guest PATCH awaits the push-live step); a certificate request is rare (once
per new site without a covering certificate) and cannot finish in 10 s.

## R4. Ownership marker

**Decision**: the first line of `advanced_config` is exactly
`# Managed by Bellhop sync-proxy. Do not edit: changes here are replaced on the next sync.`
(`NPM_OWNERSHIP_MARKER`). A proxy host is Bellhop's if and only if its
`advanced_config` starts with that line.

**Evidence**: NPM stores `advanced_config` verbatim and shows it in its own
UI. A custom `meta` key also persists (`meta.bellhop: true` survived a create
and NPM's later `nginx_online` patch, which merges into `meta`), but it is
invisible in NPM's UI.

**Rationale**: the marker is visible to anyone editing the host in NPM, so
the "do not edit" warning reaches the person about to edit, and removing it
deliberately hands the host back to the operator (spec edge case). Mirrors
the nginx driver's owned-file header.

**Alternatives considered**: `meta.bellhop` (invisible; NPM's UI may drop
unknown meta keys when it saves); a name/nice_name field (proxy hosts have
none).

## R5. What goes in `advanced_config`

**Decision**: every Bellhop proxy host (gated or not) carries, after the
marker, the nginx driver's server-level directives and its own `location /`,
plus for a forward-gated route the exempt-path locations, the outpost
passthrough and the sign-in location — the same body the nginx driver
renders inside its `server {}` block, produced by one shared function with
two variable choices:

| nginx driver | NPM driver | Why |
|---|---|---|
| `$bellhop_http_host` (a `map`) | `$http_host` | `advanced_config` is inside `server {}`; a `map` is only valid at `http {}` level |
| `$bellhop_connection_upgrade` (a `map`) | `$http_connection` | same; `$http_connection` is what NPM's own template uses |

**Evidence**: NPM's `templates/proxy_host.conf` inserts `{{ advanced_config }}`
inside `server {}` and emits its own `location /` only when
`advancedConfigHasDefaultLocation` (`/^(?:.*;)?\s*?location\s*?\/\s*?{/im`)
does not match — so a Bellhop `location /` replaces NPM's. NPM's default
location includes `proxy.conf`, which *appends* `X-Forwarded-For`
(`$proxy_add_x_forwarded_for`) and sends no `X-Forwarded-Port`. Live:
`$host` dropped a non-443 port from the sign-in `rd=` URL; `$http_host`
keeps it. The generated `proxy_host/<id>.conf` for a gated host loaded
(`nginx_online: true`); a request to `/` without the outpost cookie got
`302 .../outpost.goauthentik.io/start?rd=...`, with it `200`; `/api/x` and
`/health` bypassed the check. `/etc/ssl/certs/ca-certificates.crt` exists in
the image (Debian 13), so the nginx driver's port-443 verification lines
work unchanged.

**Rationale**: owning `location /` for every route gives the same header,
timeout and body-size parity with Caddy that the nginx driver guarantees
(issue #91's `X-Forwarded-Port`, non-appended `X-Forwarded-For`), and one
renderer for both drivers is what keeps them from drifting (FR-016).

**Alternatives considered**: NPM's own default location for ungated routes
(loses parity: appended `X-Forwarded-For`, no `X-Forwarded-Port`, 60 s
timeouts); `locations[]` objects (per-location config is templated with
NPM's own header set, and `auth_request` would still need free text).

## R6. Configuration errors are not API errors

**Decision**: after every create or update, the driver re-reads the proxy
host with `GET /api/nginx/proxy-hosts/<id>` and fails if
`meta.nginx_online === false`, quoting `meta.nginx_err`.

**Evidence**: a host with an invalid directive in `advanced_config` was
accepted with `201`; NPM then patched `meta` to `{ nginx_online: false,
nginx_err: "nginx: [emerg] unknown directive ... in /data/nginx/proxy_host/3.conf:61 ..." }`
and renamed its config to `.err`, taking the site offline
(`proxy-hosts-list.json`, id 3). The create response itself is returned
before that patch and carries no `nginx_online` (`proxy-host-create.json`).

**Rationale**: without the read-back, a broken sync would report success
while the site is down.

## R7. Request-level validation and errors

- Unknown fields are rejected (`additionalProperties: false`):
  `400 data must NOT have additional properties`
  (`proxy-host-update-unknown-field.json`). The driver sends exactly the
  documented fields.
- A hostname already on another proxy host: `400 "<name> is already in
  use"` (`proxy-host-create-duplicate-domain.json`) — the reason conflicts
  must be detected before apply (a hand-made host would otherwise fail the
  create anyway).
- `GET`/`DELETE` of a missing id: `404 "Not Found - <id>"`.
- `DELETE` returns `200 true`.
- `PUT` accepts a partial body (`minProperties: 1`); the driver sends the
  full desired body so a drifted field it didn't compare is still reset.
- `locations` reads back `null` on a host created without it and `[]` when
  sent; both mean "none".

## R8. Certificates

**Decision**: list certificates once per plan. A certificate *covers* a
hostname when one of its `domain_names` equals it (case-insensitive) or is
`*.<rest>` where the hostname is exactly one label followed by `.<rest>`. A
route uses a certificate only if it covers **every** hostname and
`expires_on` is in the future. Keep a host's current certificate if it still
qualifies; otherwise pick the qualifying certificate with the latest
`expires_on` (lowest id on a tie). With none, apply requests one:
`POST /api/nginx/certificates { provider: 'letsencrypt', domain_names:
<route hostnames>, meta: { dns_challenge: false } }`, then uses its `id`.

**Evidence**: `certificates-list.json` (fields `id`, `provider`,
`nice_name`, `domain_names`, `expires_on` as UTC `YYYY-MM-DD HH:MM:SS`,
`meta`). NPM recorded only the uploaded certificate's CN (`*.example.test`)
in `domain_names`, not its SAN `example.test` — coverage is judged from
`domain_names` only, as NPM itself shows it. The 2.16 schema has no
`letsencrypt_email`/`letsencrypt_agree`; certbot ran with `-m <login email>
--agree-tos` (`certificate-request-letsencrypt-failure.json`), so no
contact-email setting exists. A failed request returns `500 Internal Error`
with certbot's output in `debug.stack` and leaves no certificate row.
Creating a proxy host with `certificate_id: "new"` also returned `500` but
**left the proxy host behind with no certificate**
(`proxy-host-create-certificate-new.json`), so the driver never uses `"new"`.

**Security note**: a custom certificate's `meta` carries its PEM and
**private key**. The client's certificate schema drops `meta` entirely, so a
key never reaches a preview, log, snapshot or error.

**Not captured**: a successful Let's Encrypt row (needs public DNS). The
driver reads only the columns common to every provider (`id`,
`domain_names`, `expires_on`, `nice_name`, `provider`), all present in the
captured `other` row; verify on first real use (quickstart §5).

**Rationale**: chosen by the operator (reuse, else request). HTTP-01 needs
no DNS credentials in Bellhop; wildcard/DNS certificates stay in NPM's UI
and are reused automatically. `acmeDns01ViaCloudflare: false`: Bellhop never
starts a DNS challenge through this driver.

**Alternatives considered**: per-host certificates always (slow, rate
limits); existing certificates only (every new subdomain without a wildcard
would need a manual NPM step).

## R9. Desired proxy host body and drift

**Decision**: the desired body for a route is

```text
domain_names           route.hostnames (canonical first, order compared)
forward_scheme         https if backend.insecureTls or port 443, else http
forward_host/port      route.backend.ip / port
certificate_id         per R8
ssl_forced             true
http2_support          true
allow_websocket_upgrade true
block_exploits         false
caching_enabled        false
hsts_enabled           false
hsts_subdomains        false
trust_forwarded_proto  false
access_list_id         0
advanced_config        marker + shared renderer output (R5)
enabled                true
locations              []
```

A Bellhop host is *drifted* when any of these differs (with `locations:
null` treated as `[]`); the preview names the drifted fields, and apply
`PUT`s the full body. `forward_*` duplicates what `advanced_config`'s own
`proxy_pass` already does, but keeps NPM's UI and `$server`/`$port`
variables truthful.

**Rationale**: `block_exploits`/`caching_enabled` default off because
Caddy and the nginx driver do neither; `hsts` stays off for the same reason.

## R10. Plan/apply shape

**Decision**: `plan()` logs in, lists proxy hosts and certificates, and
computes an `NpmSyncPlan` (data-model.md): `creates`, `updates` (with changed
field names), `deletes`, `certificateRequests`, `conflicts`, `unchanged`.
`apply()` runs deletes, then updates, then creates (so a hostname moving
between two Bellhop hosts is freed before it is claimed), requesting a
route's certificate right before its create/update, re-reading each written
host (R6), and finally throws a conflict error if `conflicts` is non-empty.
The first NPM error stops the apply.

**Rationale**: FR-011/FR-012; the preview is rendered from the same
`NpmSyncPlan` apply executes, so they cannot disagree (SC-004). Continuing
after an NPM error could leave several half-applied sites; conflicts are
the one expected, non-exceptional failure worth applying around.

## R11. Interface changes for a file-less managed driver

**Decision**: `DriverDeps.configPath` becomes `string | null`;
`driverDeps()` returns `null` for a driver whose `defaultConfigPath` is
`null` (ignoring any `proxyConfigPath`), instead of throwing. `fileDriver`
throws a programming-error message if it ever sees `null`. The Settings
page's `proxyFieldView` shows the config path field only when the driver has
a `defaultConfigPath`. Status page and TLS fields already follow
`statusPage`/`usesSharedCertificate`.

**Rationale**: `defaultConfigPath: null` was already documented as "uses no
configuration file"; no shipped managed driver had it, so the old
"Required: this driver has no default" state was never reachable in
practice.

## R12. Client injection

**Decision**: `src/lib/npm-client.ts` exports an `NpmClient` interface,
`RealNpmClient` (fetch-backed, zod-validated responses), and
`buildNpmClient(inventory)`, which reads the env and throws the unconfigured
message when credentials are missing. The driver is
`createNpmDriver({ clientFor })`; the registered instance uses
`buildNpmClient`, tests pass a fake client. `RealNpmClient` gets
stubbed-fetch tests over the captured fixtures, as `authentik-client.test.ts`
does.

**Rationale**: `DriverDeps` stays free of an NPM-specific field, and the
driver is testable without a network.
