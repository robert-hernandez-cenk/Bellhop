// Shared nginx `server {}` body renderer (issue #31): the lines every
// nginx-config-emitting driver puts inside its server block, from
// `client_max_body_size 0;` through the last location -- proxy lines,
// forward-auth lines, exempt-path locations, and the outpost/sign-in
// locations for a forward-gated route. Extracted out of
// src/lib/proxy/drivers/nginx.ts (which keeps its own header, map blocks,
// and listen/server_name/ssl lines) so the upcoming Nginx Proxy Manager
// driver can reuse this exact body inside a proxy host's `advanced_config`
// (contract "advanced_config (shared renderer)") without drifting from the
// nginx driver's own output (FR-016) -- one renderer, two variable choices.
// The nginx driver's own map-block variables ($bellhop_http_host,
// $bellhop_connection_upgrade) are only valid at `http {}` level, so
// `advanced_config` -- which lands inside `server {}` -- can't reference
// them; NPM passes nginx's own built-in $http_host/$http_connection
// instead (research R5). `renderServerBody`'s vars parameter is what lets
// each caller supply its own pair without this file caring which.
import type { PathPattern, ProxyContext, ProxyRoute } from './routes.ts';

// The two variables a server body's proxy/outpost lines reference instead
// of a literal $bellhop_http_host/$bellhop_connection_upgrade -- see the
// file banner above for why they must be pluggable.
export interface ServerBodyVars {
  host: string;
  connection: string;
}

// nginx double-quoted string: backslash-escape `\` then `"` (order matters,
// so an existing backslash from the first pass is never re-escaped by the
// second). Used for certificate paths, and for every exempt-path location
// below.
export function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// The lines shared by `location /` and every exempt location, for one
// backend (contract "Proxy lines", research R4/R5).
// Parity with Caddy's reverse_proxy defaults: nginx's own defaults are the
// opposite of Caddy's on every one of these points (Host becomes the
// upstream address, no forwarded headers, no WebSocket upgrade, a 1 MB body
// limit -- capped at the server level instead, see below -- and buffered
// responses), so backends that work behind the Caddy driver today would
// otherwise break on switching drivers. X-Forwarded-For is *set* to the
// client address rather than appended to ($proxy_add_x_forwarded_for), the
// same as Caddy 2.5+ with no trusted_proxies configured: appending would
// pass through whatever X-Forwarded-For the client itself sent, letting a
// client pose as a LAN address to a backend that trusts the header.
function proxyLines(backend: ProxyRoute['backend'], ctx: ProxyContext, vars: ServerBodyVars): string[] {
  // Caddy's own rule (research R5): TLS to the upstream when insecureTls is
  // set, or the backend port is 443 -- otherwise plain http.
  const https = backend.insecureTls || backend.port === 443;
  const scheme = https ? 'https' : 'http';
  const lines = [
    `        proxy_pass ${scheme}://${backend.ip}:${backend.port};`,
    '        proxy_http_version 1.1;',
    `        proxy_set_header Host ${vars.host};`,
    '        proxy_set_header X-Forwarded-For $remote_addr;',
    '        proxy_set_header X-Forwarded-Proto $scheme;',
    `        proxy_set_header X-Forwarded-Host ${vars.host};`,
    `        proxy_set_header X-Forwarded-Port ${ctx.externalPort};`,
    '        proxy_set_header Upgrade $http_upgrade;',
    `        proxy_set_header Connection ${vars.connection};`,
  ];
  if (https) {
    if (backend.insecureTls) {
      lines.push('        proxy_ssl_verify off;');
    } else {
      // A port-443 backend without insecureTls: nginx never verifies an
      // upstream certificate unless told to, so without this a plain
      // port-443 proxy_pass would silently lose the verification Caddy
      // performs automatically (research R5). The CA bundle path is the
      // Debian/Ubuntu one, the same platform assumption as the nginx
      // driver's own conf.d default path.
      lines.push('        proxy_ssl_verify on;');
      lines.push('        proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;');
    }
  }
  return lines;
}

// Authentik's standalone-nginx recipe's identity-forwarding lines for
// `location /` on a forward-gated route (contract "Forward-gated route" #2,
// research R3): auth_request against the outpost, the sign-in redirect on
// 401, the Set-Cookie pass-back, and the five identity headers (username,
// groups, email, name, uid -- no entitlements, matching the Caddy driver's
// own five, research R3). Omitted entirely when the route's own '/*' exempt
// pattern already exempts everything (a second `location /` would fail
// `nginx -t` with a duplicate-location error, research R7). References no
// host/connection variable, so it needs no ServerBodyVars.
const FORWARD_AUTH_LINES = [
  '        auth_request /outpost.goauthentik.io/auth/nginx;',
  '        error_page 401 = @goauthentik_proxy_signin;',
  '        auth_request_set $bellhop_auth_cookie $upstream_http_set_cookie;',
  '        add_header Set-Cookie $bellhop_auth_cookie;',
  '        auth_request_set $bellhop_authentik_username $upstream_http_x_authentik_username;',
  '        auth_request_set $bellhop_authentik_groups $upstream_http_x_authentik_groups;',
  '        auth_request_set $bellhop_authentik_email $upstream_http_x_authentik_email;',
  '        auth_request_set $bellhop_authentik_name $upstream_http_x_authentik_name;',
  '        auth_request_set $bellhop_authentik_uid $upstream_http_x_authentik_uid;',
  '        proxy_set_header X-authentik-username $bellhop_authentik_username;',
  '        proxy_set_header X-authentik-groups $bellhop_authentik_groups;',
  '        proxy_set_header X-authentik-email $bellhop_authentik_email;',
  '        proxy_set_header X-authentik-name $bellhop_authentik_name;',
  '        proxy_set_header X-authentik-uid $bellhop_authentik_uid;',
];

// A parsed exempt pattern is the root prefix ("/*" as authored) -- the one
// pattern that, per research R7, produces no location of its own and instead
// removes the forward-auth lines from `location /` (a second `location /`
// would collide with the first under nginx's own routing rules).
// Exported for src/lib/proxy/drivers/traefik.ts (issue #35, User Story 2),
// which needs the exact same root-prefix/dedupe/outpost-namespace rules for
// its own exempt-router derivation -- one definition shared by both drivers
// rather than a second copy that could drift.
export function isRootPrefix(pattern: PathPattern): boolean {
  return pattern.kind === 'prefix' && pattern.path === '/';
}

// Dedupe on (kind, path), keeping first-seen (stored) order -- two
// unauthenticatedPaths entries that parse to the same pattern (e.g. a typo'd
// duplicate) must still produce only one location, or nginx -t fails with a
// duplicate-location error.
export function dedupeExemptPatterns(patterns: PathPattern[]): PathPattern[] {
  const seen = new Set<string>();
  const result: PathPattern[] = [];
  for (const pattern of patterns) {
    const key = `${pattern.kind}:${pattern.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(pattern);
  }
  return result;
}

// A pattern whose path is the outpost's own namespace -- exactly
// `/outpost.goauthentik.io`, or anything under `/outpost.goauthentik.io/`
// (a deeper exact path, or the `/outpost.goauthentik.io/*` prefix, which
// parses to path `/outpost.goauthentik.io/`). Skipped (never rendered as a
// location, never thrown on) rather than exempted: an exact location always
// wins nginx's location-matching, and `^~` beats a bare-string prefix, so
// either shape would outrank the `location /outpost.goauthentik.io`
// passthrough below and send the `auth_request` subrequest to the site's
// own backend instead of the outpost -- a backend answering 2xx for an
// unrecognized path would then ungate the whole site. Caddy's
// `handle /outpost.goauthentik.io/*` sends these requests to the outpost
// regardless of any `not path` exemption (issue #10), so silently skipping
// the pattern here reproduces that same behavior rather than failing a
// sync over an entry Caddy handles fine. A guest edit now rejects such a
// path outright (parseUnauthenticatedPaths in src/lib/inventory.ts); this
// skip stays as defense in depth for an entry saved before that rule, or
// written straight into bellhop.db.
export function isOutpostPrefixed(pattern: PathPattern): boolean {
  return pattern.path === '/outpost.goauthentik.io' || pattern.path.startsWith('/outpost.goauthentik.io/');
}

// The route's exempt patterns, deduped and with the outpost's own namespace
// silently dropped (see isOutpostPrefixed) -- computed once by
// renderServerBody and threaded through to both the `location /`
// root-exemption check and exemptLocations below, rather than each
// recomputing it from the route's raw exemptPaths.
function candidateExemptPatterns(route: ProxyRoute): PathPattern[] {
  if (route.auth.mode !== 'forward') return [];
  return dedupeExemptPatterns(route.auth.exemptPaths).filter((pattern) => !isOutpostPrefixed(pattern));
}

// One location per unique exempt pattern other than the root prefix
// (contract "Forward-gated route" #3, research R7): exact -> `location =`,
// prefix -> `location ^~` (wins over any regex location an operator include
// might add, matching Caddy's own `path /api/*` semantics). Each contains
// only the proxy lines -- no auth_request -- and is preceded by a blank line,
// since every location in a server block is blank-line-separated. Takes the
// already-deduped, already outpost-filtered pattern list (see
// candidateExemptPatterns) rather than the route's raw exemptPaths.
function exemptLocations(patterns: PathPattern[], backend: ProxyRoute['backend'], ctx: ProxyContext, vars: ServerBodyVars): string[] {
  const lines: string[] = [];
  for (const pattern of patterns) {
    if (isRootPrefix(pattern)) continue;
    const selector = pattern.kind === 'exact' ? '=' : '^~';
    lines.push('', `    location ${selector} ${quote(pattern.path)} {`, ...proxyLines(backend, ctx, vars), '    }');
  }
  return lines;
}

// The outpost passthrough and sign-in named locations (contract
// "Forward-gated route" #4, research R3), verbatim from Authentik's
// standalone-nginx recipe under bellhop-prefixed variable names. Always
// present on a forward-gated route, including when the '/*' exempt pattern
// has emptied `location /` of its own auth lines -- both are still reachable
// destinations (the sign-in redirect, and the auth_request subrequest
// target on every other location).
function outpostLocations(ctx: ProxyContext, vars: ServerBodyVars): string[] {
  // ctx.outpost is guaranteed set here: buildRoutes already throws the
  // missing-authentik error before producing a 'forward' route when no
  // authentik:true entry has an ip, and buildProxyContext derives outpost
  // from that same entry (same justification as the Caddy driver).
  const outpostAddr = `${ctx.outpost!.ip}:${ctx.outpost!.port}`;
  return [
    '',
    '    location /outpost.goauthentik.io {',
    `        proxy_pass http://${outpostAddr}/outpost.goauthentik.io;`,
    `        proxy_set_header Host ${vars.host};`,
    `        proxy_set_header X-Original-URL $scheme://${vars.host}$request_uri;`,
    '        add_header Set-Cookie $bellhop_auth_cookie;',
    '        auth_request_set $bellhop_auth_cookie $upstream_http_set_cookie;',
    '        proxy_pass_request_body off;',
    '        proxy_set_header Content-Length "";',
    '    }',
    '',
    '    location @goauthentik_proxy_signin {',
    '        internal;',
    '        add_header Set-Cookie $bellhop_auth_cookie;',
    `        return 302 /outpost.goauthentik.io/start?rd=$scheme://${vars.host}$request_uri;`,
    '    }',
  ];
}

// The shared server-body renderer (contract "advanced_config (shared
// renderer)"): every line a route's server block carries between its TLS
// lines and its closing `}`, from `client_max_body_size 0;` through the
// last location. An ungated or OIDC-mode route gets the fixed body lines
// plus a single plain `location /`; a forward-gated route additionally gets
// the server-level buffer lines Authentik's recipe calls for (research R3),
// the identity lines on `location /` (unless a '/*' exempt pattern removes
// them), one location per other exempt pattern, and the outpost/sign-in
// locations. The nginx driver calls this with
// `{ host: '$bellhop_http_host', connection: '$bellhop_connection_upgrade' }`
// (its own map-block variables) and wraps the result in its own
// `server { ... }` head and closing brace; the Nginx Proxy Manager driver
// calls it with `{ host: '$http_host', connection: '$http_connection' }`
// (nginx's own built-ins, since a map is only valid at http {} level) and
// puts the result straight into a proxy host's `advanced_config`.
export function renderServerBody(route: ProxyRoute, ctx: ProxyContext, vars: ServerBodyVars): string[] {
  const body = [
    '    client_max_body_size 0;',
    '    proxy_buffering off;',
    // Caddy streams request bodies and has no upstream read timeout; nginx
    // buffers a whole upload before proxying it and drops an upstream
    // connection idle for 60s -- which would cut off a quiet WebSocket or
    // server-sent-events stream, and stall a large upload (research R4).
    '    proxy_request_buffering off;',
    '    proxy_read_timeout 1d;',
    '    proxy_send_timeout 1d;',
  ];

  if (route.auth.mode !== 'forward') {
    return [...body, '', '    location / {', ...proxyLines(route.backend, ctx, vars), '    }'];
  }

  const exemptPatterns = candidateExemptPatterns(route);
  const rootExempted = exemptPatterns.some(isRootPrefix);

  const locationRoot = [
    '    location / {',
    ...proxyLines(route.backend, ctx, vars),
    ...(rootExempted ? [] : FORWARD_AUTH_LINES),
    '    }',
  ];

  return [
    ...body,
    '    proxy_buffers 8 16k;',
    '    proxy_buffer_size 32k;',
    '',
    ...locationRoot,
    ...exemptLocations(exemptPatterns, route.backend, ctx, vars),
    ...outpostLocations(ctx, vars),
  ];
}
