# Nginx Proxy Manager driver

Select it with `bellhop set-config proxyDriver nginx-proxy-manager --apply`
(or the Settings page, where it's the "Nginx Proxy Manager" option).
Everything the drivers share (how a driver is chosen, capability checks,
the dry run) is described in [Reverse proxy drivers](README.md). Unlike
Caddy and nginx, it owns no file on the proxy host at all — it reconciles
routes with [Nginx Proxy Manager](https://nginxproxymanager.com/)'s (NPM's)
own REST API instead, so the Settings page hides Proxy config path, Status
page path, and the TLS certificate/key fields entirely: none of them apply
when there's no config file, no status page, and no shared certificate to
configure. Tested against NPM 2.16.

## Credentials

Create `data/nginx-proxy-manager.env` (same convention as
`data/authentik.env`/`data/cloudflare-api.env` — see [Environment
variables](../environment-variables.md)):

```text
NPM_API_EMAIL=admin@example.com
NPM_API_PASSWORD=your-npm-admin-password
```

`NPM_API_URL` is optional. Unset, Bellhop reaches NPM at
`http://<the proxy: true entry's ip>:81` — NPM's own admin UI/API port; set
it if NPM's admin API is reachable at a different address. Either way,
**NPM's admin API must be reachable over HTTP from wherever Bellhop
runs** — a LAN address is fine, the same posture this toolkit already
assumes for Authentik's own API. A missing or rejected credential fails
with an error naming the file and which of `NPM_API_EMAIL`/
`NPM_API_PASSWORD` (or the login itself) is at fault.

## Ownership

Every proxy host `sync-proxy` creates or updates opens with a marker line
in its Custom Nginx Configuration:

```text
# Managed by Bellhop sync-proxy. Do not edit: changes here are replaced on the next sync.
```

A proxy host is Bellhop's if and only if that line is the *first* line of
its configuration — visible in NPM's own UI, so the warning reaches
whoever is about to hand-edit the host. **Delete that line and the host is
yours**: the next sync stops treating it as that route's own host and
leaves it alone. Its hostnames then look unclaimed by Bellhop, so a route
that still wants one of them reports a conflict (below) instead of quietly
reclaiming the host.

Everything below the marker — a plain reverse-proxy `location /`, or the
whole Authentik forward-auth check plus exempt-path locations for a gated
route — is the same body the [nginx driver](nginx.md) renders inside its
own `server {}` block, so switching between the two drivers never changes
what a backend receives.

## Settings Bellhop forces

`sync-proxy` sends the complete desired configuration on every create and
update — SSL Forced, HTTP/2 Support, Websockets Support, Block Common
Exploits (off), Cache Assets (off), HSTS (off), the forward
hostname/port, the certificate, and the Custom Nginx Configuration above —
so hand-editing any of them on a Bellhop-owned host in NPM's UI is drift
the very next sync silently reverts, not a setting Bellhop reads first.

## Certificates

`sync-proxy` reuses a certificate already in NPM whenever one covers every
hostname a route needs (an exact name, or a wildcard covering that one
extra label) and isn't expired. A wildcard you create yourself in NPM (SSL
Certificates → Add → a DNS-challenge Let's Encrypt certificate, or your own
uploaded one) is picked up automatically this way, so adding a new
subdomain under an existing wildcard needs no certificate step of its own.

With no covering certificate, `sync-proxy --apply` has NPM request one
over its default HTTP-01 challenge, using the login email above as the
certificate's contact address — **the hostname must already be reachable
from the internet on port 80 through NPM** before the sync that creates
it runs. A certificate Bellhop requested is never deleted later, even
once no proxy host still uses it — remove an unused one by hand in NPM if
you want it gone.

## Conflicts

A route whose hostname a proxy host NPM already has claims — one with no
marker, or a different first line — is a **conflict**, never claimed or
overwritten:

```text
! conflict docs.example.com: already claimed by proxy host #9 (not created by Bellhop), entry 'docs-lxc' -- delete or change it in Nginx Proxy Manager, or mark the entry proxyManual
```

`--apply` still applies every other route's create, update, and delete;
only once those finish does it fail, naming every conflicting route, its
inventory entry, and the claiming proxy host id(s). Resolve it by deleting
or renaming the hand-made host in NPM, or by marking the inventory entry
`proxyManual` if its proxy configuration is meant to stay hand-authored.

## When nginx rejects a generated host

NPM saves a created or updated proxy host before nginx ever validates it,
so a broken configuration (in practice only reachable by hand-editing a
host Bellhop still owns, since Bellhop itself renders it) can be accepted
by NPM and then rejected by nginx. `sync-proxy` re-reads every host it
just wrote and fails loudly when NPM reports it offline:

```text
Nginx Proxy Manager saved proxy host #12 (media.example.com) but nginx rejected its configuration: nginx: [emerg] unknown directive "bogus" in /data/nginx/proxy_host/12.conf:61 -- the site is offline until the next successful sync
```

The site stays offline until the next successful sync fixes it — nothing
here rolls the configuration back automatically.

## No status page

This driver has no document root of its own to serve a status page from —
`render-status-page` fails naming it, the same as any managed driver with
no status page, and the web UI's push-live step skips the render with a
warning if `statusPagePath` happens to still be set.

## Single-deployment assumptions

- One NPM instance fronts every route; a deployment with more than one
  reverse proxy isn't something this driver supports.
- NPM's admin API is reachable over HTTP from wherever Bellhop runs.
- A port-443 backend's certificate is verified against the Debian CA
  bundle path baked into NPM's own container image
  (`/etc/ssl/certs/ca-certificates.crt`) — the same assumption the [nginx
  driver](nginx.md) makes about its own host, just inside NPM's image
  instead.
