# Research: Traefik Proxy Driver

All behavior below was checked against a real Traefik **v3.7.13** binary
(the latest release on 2026-09-29), run locally with a file provider watching
a directory, the API enabled (`api.insecure: true`, default `:8080`), a
`websecure` entry point, and an ACME resolver named `cloudflare`. API
responses were captured verbatim into `test/fixtures/traefik/` (they already
use example values: `*.example.com`, `192.0.2.0/24`).

## R1. Write path: the file provider, one owned file

**Decision**: The driver writes one dynamic-configuration YAML file that
Bellhop owns whole (`'owned'` mode with an `ownedHeader`), default
`/etc/traefik/dynamic/bellhop.yml`, overridable with `proxyConfigPath`. The
operator's static configuration points `providers.file.directory` at that
file's directory with `watch: true`.

**Rationale**: Traefik's API is read-only; the file provider is the only
write path that needs no Bellhop-hosted endpoint. Directory mode lets
Bellhop's file sit beside the operator's own dynamic files (status-page
site, `proxyManual` entries), and objects in one file can reference objects
in another within the same provider.

**Alternatives**: Docker-labels provider (inventory entries aren't
containers); HTTP provider served by Bellhop (Bellhop would have to run a
reachable endpoint for Traefik to poll; out of scope); a managed section in
an operator file (YAML has no comment-delimited region that stays valid
YAML on its own, and the operator can simply use a second file).

## R2. There is no validate command; a bad file is rejected whole

**Finding** (live): a file Traefik cannot decode is rejected in its
entirety. The log says `Error while building configuration ... headers
cannot be a standalone element`, and **none** of the file's routers,
services or middlewares appear in the API. Example trigger: a `headers`
middleware with no fields (`headers: {}`).

**Finding** (live): an object-level problem leaves the rest of the file
loaded, and the affected router is reported by the API with
`"status":"disabled"` and an `"error"` array (fixture
`router-disabled.json`). Confirmed for: a missing service, a missing
middleware, an unknown entry point (`entryPoint "nosuchentrypoint" doesn't
exist`, `no valid entryPoint for this router`), and an unparseable rule
(`unsupported function: Pathh`).

**Finding** (live): a router naming a certificate resolver that the static
configuration does not define stays `"status":"enabled"` in the API with no
error. The problem appears only in Traefik's log (`Router uses a
nonexistent certificate resolver`). The API check therefore **cannot**
catch a wrong `proxyCertResolver`, and the docs must say so.

**Decision**: Validation is opt-in, through the API (user decision). When
`proxyApiUrl` is set, the apply script:

1. waits for the file's generation marker (R3) to appear, which proves
   Traefik has loaded *this* version of the file (and catches the
   whole-file rejection above, since the marker never appears), then
2. fetches each Bellhop router by name and requires `"status":"enabled"`
   (catches every object-level error above).

When `proxyApiUrl` is unset there is no check at all (FR-013).

**Alternatives**: validating the YAML locally before writing (Bellhop
renders it from typed data with the `yaml` package, so syntax errors aren't
a realistic failure; semantic errors need Traefik itself); always requiring
the API (many Traefik setups leave it disabled).

## R3. Knowing Traefik loaded this version: a generation marker

**Decision**: Every rendered file carries one extra, unused middleware,
`bellhop-generation-<hash>`, a `headers` middleware that sets
`X-Bellhop-Generation: <hash>`. `<hash>` is the first 12 hex characters of
the SHA-256 of the file rendered *without* the marker. It is always
rendered, whether or not `proxyApiUrl` is set, so the preview doesn't depend
on that setting and the file is byte-identical either way.

**Finding** (live): `GET /api/http/middlewares/<name>@file` returns 200
with the middleware (`marker-present.json`) once loaded, and 404
`{"message":"middleware not found: ..."}` (`marker-missing.json`) before
the reload (or after a newer version replaced it). An unused middleware is
listed like any other, and it must have content (R2's `headers: {}`
finding), hence the header value.

**Finding** (live): reapplying an identical file produces no reload, but
the marker is already present, so the check passes immediately. That's
correct, since the configuration it describes is already live.

**Rationale**: Traefik's watcher is throttled (`providersThrottleDuration`,
default 2s), so "the routers are healthy" can't be checked the moment the
write finishes; the old version's routers would still be answering.
Content-derived naming makes the check exact without timestamps (a
timestamp would make every preview differ).

## R4. Polling budget and failure messages

**Decision**: Poll the marker once a second for up to 30 attempts, using
`curl -s -o /dev/null -w '%{http_code}' --max-time 5`. On timeout the
failure names the path, the API URL and the last result: an HTTP status,
or "unreachable" for curl's `000`. Then check each router with `curl -s
--max-time 5` and report every unhealthy router's name and response body
together, not just the first. Any failure exits non-zero inside the
validate step, so `fileDriver`'s existing restore trap puts the previous
file back.

**Rationale**: 30s comfortably covers the 2s default throttle. Reporting
the router's own `error` array (it's in the body) tells the operator
exactly what Traefik objected to. `sleep` and `curl` are the only binaries
the check needs, which makes the executed-script test straightforward:
both are stubbed on `PATH`, and a stub `sleep` keeps the 30-attempt
timeout test instant and deterministic.

**Alternatives**: `?search=bellhop-&status=disabled` on the router list.
It was rejected because `search` matched a router by its *rule* text
(`search=app.example` returned a Bellhop router whose name doesn't contain
that string), so it could sweep in the operator's own routers. Fetching by
exact name avoids that.

**Wording (final code review)**: the timeout message says "after 30 checks
one second apart", not "within 30 seconds". Each check can itself take up
to `--max-time 5`, so against a slow or unreachable API the real wait is
well over 30 seconds, and the old wording promised a bound the loop
doesn't keep. The subshell also checks `command -v curl` first: without
curl every poll would fail with "command not found" and end in the same
misleading timeout, so it fails straight away naming the fix (install
curl on the proxy host, or unset `proxyApiUrl`).

## R5. Atomic replacement, and which temp names Traefik ignores

**Decision**: An owned file flagged `atomic: true` is written to a temp
file in the same directory, named `.<basename>.XXXXXX` via `mktemp`, and
then `mv -f`'d over the real path. The same applies to its restore. The
temp file first copies the existing file with `cp -p` (so the owner and
mode survive the rename) or gets `chmod 644` when there was no file.

**Finding** (live): Traefik logs `Skipping file, unsupported extension
filename=.bellhop.yml.AbC123` for such a temp file, even one holding invalid
YAML. A rename into the watched directory triggers a reload (the new
marker returned 200 and the old one 404 within 4s).

**Rationale**: `cat > file` truncates first, so the watcher could read an
empty or partial file and log an error, or drop every Bellhop router for one
throttle window. `mktemp` creates files `0600`, which would lock out a
non-root Traefik after the rename; hence the `cp -p`/`chmod`.

**Scope**: Only the Traefik file sets `atomic`. Caddy and nginx are
reloaded explicitly after validation, so a partial file is never read, and
their scripts stay byte-identical (FR-016).

## R6. Router rules, quoting, and priority

**Decision**: The main router's rule is `Host(`a`) || Host(`b`)`
(canonical first). The outpost router's rule is `(<hosts>) &&
PathPrefix(`/outpost.goauthentik.io/`)`. The exempt router's rule is
`(<hosts>) && (Path(`/x`) || PathPrefix(`/api/`))`, with patterns in
stored order, deduplicated on kind+path, and patterns inside the outpost
namespace dropped. A value is wrapped in backticks unless it contains a
backtick, in which case it is written as a double-quoted string with `\`
and `"` escaped (`JSON.stringify`). Hostnames never need it.

**Finding** (live): a rule containing `Path("/a`b\"c\\d")` parsed and the
router was `enabled`, so double-quoted Go-style escapes work. An
unsupported escape (`\d` inside double quotes) disables the router with
`unknown escape sequence`, which is why escaping has to be exact.

**Finding** (live): with no explicit `priority`, Traefik uses the rule's
length. That produced exempt 98 > outpost 96 > main 52 for the sample
route. **Decision**: no explicit priorities. The exempt and outpost rules
always contain the main rule's whole host expression plus more, so they're
always longer and win. The two never match the same request: outpost-namespace
exemptions are dropped, and a bare `/*` produces no exempt router.

## R7. Object names

**Decision**: Every name is prefixed `bellhop-`, and per-route objects are
derived from the canonical hostname by an injective encoding: lowercase,
`-` becomes `--`, and `.` becomes `-` (so `a.b-c` and `a-b.c` can't
collide). The objects are:

- router and service `bellhop-route-<enc>`
- router `bellhop-exempt-<enc>`
- router `bellhop-outpost-<enc>`
- shared middlewares `bellhop-forwarded-port` and `bellhop-authentik`
- shared service `bellhop-authentik-outpost`
- shared servers transport `bellhop-insecure-backend-tls`
- the marker `bellhop-generation-<hash>`

Shared objects are only emitted when some route uses them, except
`bellhop-forwarded-port` and the marker, which are always present so the
file is never empty (FR-005 / scenario 1.5; live-checked: a file with only
middlewares loads fine).

## R8. Backend scheme and TLS verification

**Decision**: The backend URL uses `https://` when `insecureTls` is set or
the port is 443, otherwise `http://`. That's the rule the Caddy and nginx
drivers already follow. With `insecureTls` the service names the shared
`bellhop-insecure-backend-tls` transport (`insecureSkipVerify: true`).
Otherwise Traefik's default transport verifies the certificate against the
system CA pool, matching Caddy's port-443 behavior.

## R9. Forward-auth

**Decision**: `bellhop-authentik` is a `forwardAuth` middleware with
`address: http://<outpost ip>:<outpost port>/outpost.goauthentik.io/auth/traefik`,
`trustForwardHeader: true`, and `authResponseHeaders` set to
`X-authentik-username`, `-groups`, `-email`, `-name` and `-uid`. That's the
same five headers Caddy and nginx pass (no `entitlements`, `jwt` or
`meta-*`), following Authentik's own Traefik recipe. The outpost router
sends `/outpost.goauthentik.io/` on the gated hostnames to the
`bellhop-authentik-outpost` service (`http://<outpost ip>:<port>`), which
serves the login redirect and callback. A route with a bare `/*` exemption
drops `bellhop-authentik` from its main router and gets no exempt router,
but keeps its outpost router, as the nginx driver does. Every router,
including the outpost and exempt ones, carries `bellhop-forwarded-port`.
Live-checked: the configuration loads with every router `enabled`.

**Header strip (final code review)**: every router also lists a shared
`bellhop-strip-authentik-headers` `headers` middleware first, whose
`customRequestHeaders` sets each of the five identity headers to `""`;
Traefik removes a request header whose configured value is the empty
string. Without it, a router with no forward-auth in front (an exempt path
on a gated app, an ungated or OIDC app, Bellhop's own web UI) would pass a
client-sent `X-authentik-username` straight to a backend that trusts it.
This is parity with the HAProxy driver's `del-header x-authentik- -m beg`.
On a forward-gated main router the strip runs before `bellhop-authentik`,
whose `authResponseHeaders` then set the real values.

## R10. Certificates and settings

**Decision**: Every Bellhop router sets `tls.certResolver` to
`proxyCertResolver ?? 'cloudflare'`. This is carried to the renderer as a
new `ProxyContext.certResolver` field, next to the nginx-only `tls` field,
following the same "context carries per-driver inputs derived from
settings" precedent. `acmeDns01ViaCloudflare: true` keeps
`prune-acme-challenges` running. There are two new settings:

- `proxyCertResolver`: `^[A-Za-z0-9_-]+$`, which matches Traefik's own
  resolver names and can't break the YAML or the rule.
- `proxyApiUrl`: an `http://` or `https://` URL, parsed with `new URL`,
  and it must not contain `'` (it's embedded in a single-quoted shell
  string; `singleQuote` already escapes it, so the rule is defensive
  only).

Both are shown on the Settings page through new driver metadata flags,
`usesCertResolver` and `usesApiUrl`, following `usesSharedCertificate`.

## R11. Status page

**Decision**: `statusPage: null`. Traefik has no static-file server, so an
operator who wants the page serves it elsewhere. This is the first shipped
managed driver with a `null` status page, and `render-status-page`'s
existing `statusPageUnsupportedError` and `statusPageSkipReason` paths
already cover it.

## R12. Where the check runs

**Decision**: On the proxy host, inside the same script `runRemote` sends,
as the validate step. That's POSIX `sh` (the proxy host may be an LXC
guest), with `curl` required there only when `proxyApiUrl` is set. Bellhop
never contacts Traefik directly, since the API is usually bound to the
loopback address on the proxy host.
