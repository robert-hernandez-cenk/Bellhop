# Research: Caddy Admin-API Proxy Driver

Findings behind [plan.md](./plan.md). Every Caddy behavior below was
checked against a real Caddy v2.10.2 built with the `caddy-dns/cloudflare`
module (the same module the file-based driver's `tls { dns cloudflare … }`
needs), run locally with example data only.

## R1. Render the route JSON in TypeScript, pinned to Caddy's own adapter

**Decision**: the driver renders each route and the TLS policy as JSON
itself (a pure function of `ProxyRoute`/`ProxyContext`). A captured fixture
of `caddy adapt` run on the file-based Caddy driver's characterization
block (`test/lib/proxy/drivers/caddy.test.ts`'s `EXPECTED_LINES`) pins that
output: for every hostname, the API driver's route (minus `@id`) must
deep-equal the adapter's route, and its TLS policy must deep-equal the
adapter's policy.

**Rationale**: FR-008/SC-001 require the same served behavior as the file
driver. Caddy's own adapter is the definition of "what the Caddyfile
means", so comparing against its real output is the strongest parity check
available, and it runs in CI with no Caddy binary. Rendering locally keeps
`plan()` a pure function plus one read, like every other driver.

**Alternatives considered**: running `caddy adapt` on the proxy host for
every sync (exact parity by construction, but a second remote round trip
on every Dashboard edit, parsing adapter output back into per-route objects,
and a hard dependency on the adapter for routine syncs); hand-writing
"plausible" JSON (rejected by constitution Principle III).

Adapter details the renderer must reproduce (all observed):

- One route per site block: `match: [{ host: [...] }]`, `terminal: true`,
  one `subroute` handler holding the directives.
- `reverse_proxy` with `headers.request.set["X-Forwarded-Port"] = ["443"]`,
  `upstreams: [{ dial: "ip:port" }]`, and for `insecureBackendTls`
  `transport: { protocol: "http", tls: { insecure_skip_verify: true } }`.
- `forward_auth` becomes a `reverse_proxy` with `rewrite: { method: "GET",
  uri: "/outpost.goauthentik.io/auth/caddy" }`, request headers
  `X-Forwarded-Method`/`X-Forwarded-Uri`, and a `handle_response` for
  status `2xx` that first runs a `vars` handler, then one `headers` route
  per copied header (sorted: Email, Groups, Name, Uid, Username), each
  guarded by a `not vars` empty-value matcher.
- Directive order inside the subroute: `forward_auth` (with the
  `not path` matcher when exempt paths exist), then the
  `/outpost.goauthentik.io/*` handle (a nested subroute with a plain
  `reverse_proxy` to the outpost), then the backend `reverse_proxy`.
- TLS: one automation policy with every managed hostname in `subjects` and
  one `acme` issuer with `challenges.dns.provider = { name: "cloudflare",
  api_token: "{env.CLOUDFLARE_API_TOKEN}" }` and `resolvers ["1.1.1.1",
  "8.8.8.8"]`. The adapter merges every identical per-site `tls` block into
  this single policy.
- The adapter orders routes by host specificity, not file order. Bellhop's
  routes never share a hostname, so order among them doesn't change
  behavior; the parity test compares routes keyed by host.

## R2. Atomic, conditional apply with `PATCH /config/` + `If-Match`

**Decision**: `plan()` reads `GET /config/` (body plus the `Etag` response
header) and computes the complete new configuration. `apply()` sends it
with one `PATCH /config/` carrying `If-Match: <etag>`.

**Rationale** (observed):

- `GET /config/` returns `Etag: "/config/ <hash>"`.
- `PATCH /config/` with a stale `If-Match` returns `412 Precondition
  Failed` (`{"error":"If-Match header did not match current config
  hash"}`) and changes nothing, which gives FR-005.
- `POST /load` **ignores** `If-Match` (a stale load succeeded), so it can't
  provide FR-005 and is not used.
- `PATCH /config/` on an empty (`null`) configuration succeeds, so the
  empty-Caddy case needs no special write path.
- A configuration Caddy can't provision returns `500` with
  `{"error":"loading new config: …"}` and the previous configuration keeps
  running. That gives FR-004, with Caddy's own message to report.

**Alternatives considered**: per-object `PUT`/`DELETE /id/<id>` calls (each
atomic, but the set is not, and a failure midway leaves a partial update);
`POST /load` (no concurrency check).

## R3. Reach the admin API with `curl` through `runRemote`

**Decision**: every admin call is one POSIX `sh` command run on the proxy
host through `runRemote`, using `curl` against `http://localhost:2019`.
Reads use `curl -sS -D -` (headers then body). The write sends the compact
JSON on stdin from a quoted heredoc (`--data-binary @-`) and appends the
status code with `-w`.

**Rationale**: FR-002 (never exposed on the network) and constitution
Principle II (remote execution only through `runRemote`). Caddy's admin
endpoint accepts `Host: localhost:2019` from a local `curl` (verified). A
quoted heredoc passes `$`, quotes, and backslashes in the JSON through
untouched, and compact JSON is a single line, so it can never equal the
heredoc delimiter.

**Known limit**: a guest proxy host receives the whole command as one
`sh -c` argument through `pct exec`, and Linux caps one argument at 128
KiB. Compact JSON keeps a forward-gated route under about 2.5 KiB, so an
inventory would need roughly 40 or more gated routes plus a large
hand-authored configuration to approach the cap. This is documented rather
than engineered around. The file-based drivers already have the same bound
for their script.

**Alternatives considered**: calling the admin API over the network from
Bellhop (rejected by the issue and FR-002); `wget` (not installed any more
often than `curl`, and it has no simple way to send `PATCH`).

## R4. Detect a Caddyfile-mode Caddy from the packaged service

**Decision**: before reading the configuration for a sync, the read command
runs `systemctl is-active --quiet caddy.service`. If that unit is active,
the command exits with a distinct code, and the driver throws the FR-010
error without making any admin call. The API-configured service is the
packaged `caddy-api.service` (`caddy run --environ --resume`).

**Rationale**: the packaged `caddy.service` runs `caddy run --config
/etc/caddy/Caddyfile`, and `systemctl reload caddy` re-reads that file,
discarding API changes (issue #26). Refusing whenever that unit is active
catches the one realistic mistake: selecting the driver before switching
services. It doesn't require `caddy-api.service` by name, so an operator's
own unit that resumes from autosave still works. Caddy under systemd is an
existing single-operator assumption: the file driver already reloads with
`systemctl reload caddy`.

**Alternatives considered**: inspecting the running process's arguments for
`--resume` (depends on `ps`/procps, which minimal containers lack);
requiring `caddy-api.service` to be active (rejects working custom units).

## R5. Ownership, placement, and conflicts

**Decision**:

- Bellhop objects carry `@id`: `bellhop-route-<canonical hostname>` per
  route, `bellhop-tls` for the one TLS automation policy. Anything whose
  `@id` starts with `bellhop-` is Bellhop's; nothing else is ever changed.
- Routes go in the single server whose `listen` includes port 443 (for
  example `:443` or `0.0.0.0:443`). An empty configuration gets server
  `srv0` listening on `:443`, the adapter's own name. Zero HTTPS servers in
  a non-empty configuration, or more than one, is an error naming the
  servers found.
- Bellhop routes are **prepended** to that server's route list in
  `buildRoutes` order, ahead of untagged routes, so an operator catch-all
  can't shadow them. The TLS policy is prepended to
  `apps.tls.automation.policies` for the same reason: the first matching
  policy wins.
- A conflict is an untagged route in *any* server whose host matcher lists
  a Bellhop hostname exactly (case-insensitive), or an untagged automation
  policy whose `subjects` list one. Wildcards (`*.example.com`) are not
  conflicts: Bellhop's prepended exact-host routes win, which is also how
  Caddy's adapter orders specific hosts before wildcards. A conflicting
  inventory route is left out of the planned configuration entirely, both
  its route and its hostnames in the TLS policy.
- With no Bellhop routes left, the TLS policy is removed. A policy with
  empty `subjects` would match every hostname.

**Rationale**: FR-006/FR-007 and the spec's edge cases.

## R6. Change detection and the preview

**Decision**: the planner builds the new configuration from the current
one: it removes every Bellhop object, prepends the desired ones, and
compares the result structurally (key order ignored, since Caddy returns
keys sorted) with the current configuration. Equal means "no changes" and
`apply()` sends nothing (SC-003). The preview lists one line per added,
replaced, or removed route (`+`, `~`, `-`), one per conflict (`!`), and one
for the TLS policy when its subjects change. It is followed by the
pretty-printed Bellhop objects exactly as they will be written. The
payload carries the full new configuration and the `Etag`, so `apply()`
sends exactly what was previewed.

## R7. Conversion from a Caddyfile (FR-015)

**Decision**: a new CLI command, `convert-caddyfile`, runs `sh` on the proxy
host that copies the Caddyfile to a temp file **in the same directory**
(so relative `import`s still resolve), with the `# BEGIN
bellhop-managed`…`# END bellhop-managed` block removed (the same `sed`
range `buildFileDriverScript` uses). It then runs `caddy adapt --adapter
caddyfile --config <temp>` and removes the temp file on exit. An empty
remainder yields `null`. The adapted JSON is the starting configuration.
The planner from R5/R6 adds Bellhop's routes, and `--apply` writes it with
`PATCH /config/` against the live `Etag`. The command refuses when the live
configuration already holds a `bellhop-` object. The Caddyfile path is
`--caddyfile <path>`, defaulting to `proxyConfigPath` while the file-based
Caddy driver is active (it would be nginx's file under the nginx driver),
else `/etc/caddy/Caddyfile`.

**Rationale**: Caddy's own adapter is the only faithful Caddyfile→JSON
converter, and the conversion is allowed while `caddy.service` still runs,
since that is the state it starts from. Caddy autosaves every loaded
configuration, and `caddy-api.service`'s `--resume` loads that autosave, so
after the conversion the operator runs `systemctl disable --now caddy`,
`systemctl enable --now caddy-api`, and `set-config proxyDriver caddy-api
--apply`. The command prints these steps.

**Alternatives considered**: see spec Q1 (manual steps; adoption during
sync).

## R8. Driver without a configuration file

**Decision** (revised after merging `main`): follow issue #31's convention
instead of adding a flag. The Nginx Proxy Manager driver, merged while this
branch was open, already made `DriverDeps.configPath` `string | null`.
`driverDeps()` returns `null` whenever the driver's own `defaultConfigPath`
is `null`, and `proxyFieldView` hides Proxy config path for such a driver.
`caddyApiDriver` declares `defaultConfigPath: null` and gets all of that
unchanged. Unlike NPM, it suggests a status page path, so the Status page
path field stays visible.

**Superseded**: this branch first added an optional `usesConfigFile` flag
for the same purpose. It was dropped in the merge, since two signals for
one fact would be redundant.

## R9. Status-page snapshot

**Decision**: `snapshot()` runs only `curl -sS -D - …/config/` (no
Caddyfile-mode check, since it is read-only) and returns the body
pretty-printed with two-space indentation.

**Rationale**: FR-013. This matches the file-based driver, which shows the
whole Caddyfile. It never calls `buildRoutes`.

## R10. Tests without a live Caddy

- The adapter parity fixture (R1) and admin API responses (`GET /config/`
  with headers, `412`, `500`) are real captures from the local Caddy
  v2.10.2. They contain only example values, so they need no redaction.
- Driver and command logic run against `FakeSSHClient`, answering the
  generated commands from those captures.
- The generated `sh` itself is verified manually once, by running the
  driver's real commands locally against the real Caddy. That run is
  recorded in the PR description. No binaries are stubbed on `PATH`, so no
  new exception to the testing rule is needed.
