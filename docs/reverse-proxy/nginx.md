# nginx driver

Select it with `bellhop set-config proxyDriver nginx --apply` (or the
Settings page). It owns one whole file on the proxy host, defaulting to
`/etc/nginx/conf.d/bellhop.conf` (override with `proxyConfigPath`) —
everything else already on the box is left alone. `sync-proxy` renders one
HTTPS `server` block per subdomain-bearing entry, forwarding to its
backend the same way the Caddy driver does (the original `Host`, the
client's address — `X-Forwarded-For` is set to the connecting address, not
appended to, so a client can't pose as a LAN address — and scheme,
external port 443, WebSocket upgrades, unbuffered streaming of responses
and request bodies, a one-day idle timeout so quiet WebSocket and
server-sent-events connections stay open, no request-body size limit) and,
for a
forward-gated entry, checks every request against the embedded Authentik
outpost the same way Caddy's `forward_auth` does, including
`unauthenticatedPaths` exemptions; an `oidc`-mode or ungated entry gets no
forward-auth at all.

Its status page follows the same opt-in `statusPagePath` setting as
Caddy's; the Settings page suggests `/var/www/html/index.html`, the
Debian/Ubuntu nginx package's default document root. Serving that page
(and restricting it to your LAN) is your own hand-authored `server`
block's job, exactly as the status page's site block is for Caddy.

Because nginx cannot obtain a certificate the way Caddy does through
Cloudflare DNS-01, every site this driver generates shares one
certificate/key pair — normally a wildcard for your domain, so that adding
a subdomain never needs a certificate step of its own. Point Bellhop at it
with the `proxyTlsCertificate`/`proxyTlsKey` settings (see [Inventory-wide
settings](../configuration.md#inventory-wide-settings)); left unset, it looks for certbot's own default path for
a certificate named after the inventory `domain`
(`/etc/letsencrypt/live/<domain>/fullchain.pem`/`.../privkey.pem`). certbot
names a certificate lineage after its first `-d`, so this issues it at
exactly that path:

```bash
certbot certonly --dns-cloudflare -d example.com -d '*.example.com'
```

A wildcard covers one label only: `*.example.com` matches
`grafana.example.com` but not `grafana.lab.example.com`. A multi-label
subdomain such as `grafana.lab` needs its own coverage on the same
certificate (for example an extra `-d '*.lab.example.com'`) — nginx serves
the certificate regardless and does not warn, so browsers see a name
mismatch instead.

Add a certbot deploy hook that reloads nginx after every renewal (for
example a script under `/etc/letsencrypt/renewal-hooks/deploy/` running
`systemctl reload nginx`) — issuing and renewing the certificate, and
making nginx pick up a renewal, are the operator's job; Bellhop only ever
points nginx at the configured paths.

Out of scope: redirecting port 80 to HTTPS (left to your own
configuration, so it never clashes with your certificate tool's own
webroot or default server) and HTTP/2 (its directive differs between
supported nginx releases). Assumes a distribution-packaged nginx managed
by systemd whose main configuration includes `/etc/nginx/conf.d/*.conf`
inside its `http` block (the Debian/Ubuntu and upstream-package default —
use `proxyConfigPath` for a different layout) and that it was built with
the `auth_request` module (standard in the Debian/Ubuntu and nginx.org
packages).

No generated block is a `default_server`, so a request on port 443 for a
hostname (or TLS SNI name) no block claims falls through to nginx's default
server — the first generated block, unless your own configuration declares
a `default_server` — and gets that site's certificate and backend. Bellhop
doesn't emit one itself, since it would collide with a `default_server` of
your own and fail `nginx -t`. To reject unknown names instead, add a
catch-all to your own configuration (nginx 1.19.4 or later):

```nginx
server {
    listen 443 ssl default_server;
    listen [::]:443 ssl default_server;
    ssl_reject_handshake on;
}
```

Switching `proxyDriver` from `caddy` to `nginx` (or back) leaves the other
driver's own files in place: an old Caddyfile's `bellhop-managed` section
stays, still valid, for you to retire by hand once nginx is serving the
same sites. `proxyConfigPath` is shared by both drivers, though, so clear
it (`bellhop set-config proxyConfigPath --unset --apply`) or repoint it
when switching. The nginx driver replaces its file whole, so it refuses to
overwrite an existing file whose first line isn't its own generated header
— an apply with `proxyConfigPath` still pointing at a Caddyfile fails with
that error and leaves the Caddyfile untouched.
