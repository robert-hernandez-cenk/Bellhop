# Research: HAProxy Proxy Driver

Builds on `specs/006-reverse-proxy-driver/research.md` (R3 TLS, R6
validate-in-place, R8 concept mapping), which already analysed HAProxy on
paper.

## R1. Bellhop owns backends and a map; the operator owns the frontend

**Decision**: two Bellhop-owned files — a backends file (`configPath`,
default `/etc/haproxy/bellhop.cfg`) and `bellhop.map` in the same directory.
The operator's `haproxy.cfg` keeps the `frontend` (its `bind :443 ssl crt
<dir>`, its default backend, anything else it serves) and routes with:

```
use_backend %[req.hdr(host),field(1,:),lower,map(/etc/haproxy/bellhop.map)]
```

The backends file is loaded with an extra `-f` (on Debian/Ubuntu,
`EXTRAOPTS="-S /run/haproxy-master.sock -f /etc/haproxy/bellhop.cfg"` in
`/etc/default/haproxy`, which the packaged unit appends to its
`haproxy -Ws -f $CONFIG -p $PIDFILE` command line).

**Addendum (final review, verified in a `debian:bookworm` container)**: the
packaged `haproxy.service` sets `Environment=... "EXTRAOPTS=-S
/run/haproxy-master.sock"` and then `EnvironmentFile=-/etc/default/haproxy`,
so an `EXTRAOPTS` there *replaces* the package default rather than adding
to it — hence the `-S /run/haproxy-master.sock` repeated in the documented
value, which keeps the master socket. `ExecStart` is `/usr/sbin/haproxy -Ws
-f $CONFIG -p $PIDFILE $EXTRAOPTS` and `ExecReload` re-validates with
`/usr/sbin/haproxy -Ws -f $CONFIG -c -q $EXTRAOPTS` before `kill -USR2
$MAINPID`; a reload keeps the master's original command line, so a
`systemctl restart haproxy` is needed after first editing
`/etc/default/haproxy`.

The driver's own validate command checks `haproxy.cfg` plus `configPath`,
while the running service loads whatever `EXTRAOPTS` names and the frontend
reads whatever `map()` path it names. Changing `proxyConfigPath` therefore
also means updating `EXTRAOPTS` and the frontend's `map()` path (and a
restart); otherwise an apply succeeds while HAProxy keeps serving the old
files. Validation is deliberately left as is (a ruling in the final review);
this is documented on the driver page instead.

**Rationale**: certificates, the listening socket and any hand-written
frontend rules are inherently operator territory — HAProxy has no
per-site certificate issuance (006 R3), and a Bellhop-owned frontend would
collide with a frontend the operator already has on :443. A map lookup is
HAProxy's own idiom for host-based routing and keeps the operator's edit to
one line. `field(1,:)` drops an explicit port from `Host`.

**Alternatives considered**:
- *Bellhop-owned frontend with `bind`*: needs a certificate directory
  setting and conflicts with an existing frontend; rejected.
- *Data Plane API*: a REST driver; out of scope per the issue ("start with
  files").
- *Editing a managed section of `haproxy.cfg`*: possible with the
  `managed-section` mode, but mixes Bellhop's output into the operator's
  file and still needs the frontend rule; the separate-file approach
  matches the nginx driver's owned-file precedent.

## R2. Live validation with real HAProxy

**Decision**: the rendered shape in `contracts/haproxy-config.md` was
checked with real `haproxy -c -f haproxy.cfg -f bellhop.cfg` against the
official `haproxy:lts` (3.4.6) and `haproxy:2.6` (Debian bookworm's
packaged branch) images, run through Docker in WSL on 2026-09-29.

**Findings**:
- A backends file with ungated, `ssl verify none`, and `ssl verify required
  ca-file /etc/ssl/certs/ca-certificates.crt` backends is valid in both.
- Header-only files (zero routes) are valid in both: an empty backends file
  and a map file holding only a `#` comment.
- The frontend rule above (map lookup with `field(1,:)`, and a
  `-m found` guard) is valid in both.
- A backend name containing `/` fails the check (`character '/' is not
  permitted in 'backend' name`); a name containing a space is split into
  two tokens and fails too. Permitted characters are letters, digits, `-`,
  `_`, `.`, `:`.

This was a one-off manual check; `npm test` does not need Docker.

## R3. Backend naming

**Decision**: `bellhop_<ownerType>_<name>`, where `ownerType` is `host`,
`guest` or `externalSite` and every character of `name` outside
`[A-Za-z0-9_.:-]` becomes `_`. If that name is already taken by an earlier
route (a sanitisation collision), `_2`, `_3`, … is appended in route order.

**Rationale**: deterministic from inventory state (routes are in
`buildRoutes`'s sorted order), readable in the file, distinct across owner
types (a host and a guest may share a name), and always a legal identifier
(R2). The `bellhop_` prefix keeps Bellhop's backends from colliding with
backends in the operator's own configuration.

**Alternatives considered**: hashing the name (unreadable in the preview);
rejecting unsanitisable names (would make valid inventory fail to sync).

## R4. Fixed paths and single-operator assumptions

**Decision**: the main configuration path `/etc/haproxy/haproxy.cfg`, the
CA bundle `/etc/ssl/certs/ca-certificates.crt` and `systemctl reload
haproxy` are fixed. No new setting (decided with the user during
brainstorming).

**Rationale**: all three are the Debian/Ubuntu package defaults, the same
platform the nginx driver already assumes for its CA bundle and `conf.d`
default. They are recorded as single-operator assumptions in the driver's
docs page and CLAUDE.md.

## R5. Backend behaviour parity

**Decision**: each backend is

```
backend bellhop_guest_web-lxc
    mode http
    timeout server 1d
    timeout tunnel 1d
    http-request del-header x-authentik- -m beg
    http-request set-header X-Forwarded-For %[src]
    http-request set-header X-Forwarded-Proto https
    http-request set-header X-Forwarded-Host %[req.hdr(host)]
    http-request set-header X-Forwarded-Port 443
    server app 192.0.2.10:8080
```

- `Host` passes through unchanged (HAProxy's default), matching Caddy and
  the nginx drivers.
- `X-Forwarded-For` is *set* to the client address, never appended, the
  same anti-spoofing choice the nginx driver made.
- `X-Forwarded-Proto` is the literal `https`: every request reaching a
  Bellhop backend came through the operator's TLS frontend (R1).
- `X-Forwarded-Port` comes from `ctx.externalPort` (443), like every
  driver (issue #91).
- `timeout server`/`timeout tunnel 1d` matches the nginx driver's `1d`
  read/send timeouts on the backend side. `timeout tunnel` applies to both
  sides of an upgraded WebSocket, so a quiet one is not cut off. A
  server-sent-events stream is never a tunnel, though: its client side stays
  under the operator frontend's own `timeout client` (50s in Debian's
  default `haproxy.cfg`), which a backend cannot override. For long-idle SSE
  the operator raises `timeout client` in their own frontend or `defaults`
  (documented on the driver page). HAProxy passes WebSocket upgrades natively
  in HTTP mode and neither buffers bodies nor limits their size by default.
- `http-request del-header x-authentik- -m beg` is the first rule. No
  Bellhop HAProxy backend is ever behind forward-auth (R8), so any
  `X-authentik-*` header reaching one is client-supplied, and a backend that
  trusts those headers (Bellhop's own web UI does) would otherwise accept a
  spoofed identity. Checked valid with a real `haproxy -c` on 2.6 and 3.4.6.
- No health `check` on the server line: a single-server backend gains
  nothing from it, and a failing check would turn a slow backend into a 503.

## R6. Backend TLS

**Decision**: `insecureTls` → `ssl verify none`; port 443 without
`insecureTls` → `ssl verify required ca-file
/etc/ssl/certs/ca-certificates.crt`; otherwise plain HTTP. Same rule as
Caddy and nginx.

**Known difference**: with no `sni`/`verifyhost`, HAProxy verifies the
backend certificate's chain against the CA bundle but not its name. Caddy
and nginx verify against the upstream IP address, which a publicly issued
certificate almost never carries, so in practice such a backend is marked
`insecureBackendTls` under every driver. Adding `verifyhost <ip>` would not
restore parity (HAProxy matches DNS names and CN, not IP SANs). Documented
on the driver page rather than worked around.

## R7. Status page and certificates

**Decision**: `statusPage: null`, `usesSharedCertificate` unset,
`acmeDns01ViaCloudflare: false` (decided with the user). HAProxy has no
static document root; `http-request return file` is read only at reload.
The existing `statusPageUnsupportedError`/`statusPageSkipReason` paths and
the ACME-prune skip apply unchanged.

## R8. Capability enforcement needs no new code

**Decision**: `capabilities.authModes = ['oidc']`. `checkCapabilities`
already produces "Entry '<name>' uses forward-auth gating, but the
'haproxy' proxy driver cannot enforce it -- set its authMode to oidc or
clear authGroup", and `runSyncProxy`/`commitGuestEdit` already call it
before previewing, writing or saving. Until now it was exercised only with
test-registered fake drivers; this feature adds tests against the real
registered driver.

**Addendum (final review)**: one piece of new code was needed after all.
`runSyncProxy` calls `buildRoutes()` before `checkCapabilities()`, and
`buildRoutes` throws "Entry '<name>' has an 'authGroup' set but no inventory
entry has 'authentik: true' with an ip set" for a forward-gated entry when no
outpost exists — so under HAProxy, which can never use an outpost, the
operator was told to add one instead of getting the capability refusal.
`buildRoutes` now takes `{ requireOutpost = true }`, and `runSyncProxy`
passes `requireOutpost: driver.capabilities.authModes.includes('forward')`.
Caddy, nginx and Nginx Proxy Manager all support forward, so their output and
errors are unchanged; `buildRoutes` has no other caller.

## R9. Map path derivation

**Decision**: `mapPath(configPath)` is the POSIX directory of `configPath`
joined with `bellhop.map`. `render()` throws (naming `proxyConfigPath`)
when `configPath` itself is that map path once normalised
(`posix.normalize`, so `/etc/haproxy//bellhop.map` and
`/etc/haproxy/./bellhop.map` are caught too), since both files would be the
same file. It also throws, naming `proxyConfigPath`, for a `configPath`
ending in `/`: `SettingsSchema` only requires an absolute path, so such a
value can be set, and `mapPath` would put the map one directory up.
