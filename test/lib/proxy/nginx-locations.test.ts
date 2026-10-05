// issue #31 (T006): renderServerBody is the shared body renderer both the
// nginx driver and (later) the Nginx Proxy Manager driver use --
// test/lib/proxy/drivers/nginx.test.ts already pins the nginx driver's own
// byte-identical output (with its own $bellhop_http_host/
// $bellhop_connection_upgrade variables); this file only pins the
// pluggable-variable contract itself: a caller-supplied vars pair actually
// reaches every line that references the host/connection, and none of the
// nginx driver's own map-block variable names leak through when a
// different pair is supplied (contract "advanced_config (shared
// renderer)").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Inventory } from '../../../src/lib/inventory.ts';
import { buildRoutes, buildProxyContext } from '../../../src/lib/proxy/routes.ts';
import { nginxDriver } from '../../../src/lib/proxy/drivers/nginx.ts';
import { renderServerBody } from '../../../src/lib/proxy/nginx-locations.ts';

const NPM_VARS = { host: '$http_host', connection: '$http_connection' };

const ORIGINAL_OUTPOST_PORT = process.env.AUTHENTIK_OUTPOST_PORT;

function withPinnedOutpostPort(fn: () => void): void {
  process.env.AUTHENTIK_OUTPOST_PORT = '9000';
  try {
    fn();
  } finally {
    if (ORIGINAL_OUTPOST_PORT === undefined) delete process.env.AUTHENTIK_OUTPOST_PORT;
    else process.env.AUTHENTIK_OUTPOST_PORT = ORIGINAL_OUTPOST_PORT;
  }
}

function inv(overrides: Partial<Inventory> = {}): Inventory {
  return {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: '192.0.2.1', ssh_user: 'root', proxy: true }],
    guests: [],
    ...overrides,
  };
}

// A forward-gated route (one authentik:true entry plus one gated guest with
// an exempt path) so the body exercises proxy lines, forward-auth lines, an
// exempt location, and the outpost/sign-in locations all in one render --
// every place NPM_VARS.host/connection could leak an nginx-driver-only
// variable name.
function gatedInventory(): Inventory {
  return inv({
    guests: [
      { name: 'auth-lxc', type: 'lxc', vmid: 130, host: 'pve1', ip: '192.0.2.20', authentik: true },
      {
        name: 'app-lxc',
        type: 'lxc',
        vmid: 120,
        host: 'pve1',
        ip: '192.0.2.30',
        port: 8080,
        subdomains: ['app'],
        authGroup: 'bellhop-users',
        unauthenticatedPaths: ['/health'],
      },
    ],
  });
}

test('renderServerBody for a forward-gated route with exempt paths: the NPM variables appear, and no nginx-driver map variable remains', () => {
  withPinnedOutpostPort(() => {
    const inventory = gatedInventory();
    const routes = buildRoutes(inventory);
    const ctx = buildProxyContext(inventory, nginxDriver);
    const route = routes.find((r) => r.owner.name === 'app-lxc')!;
    const body = renderServerBody(route, ctx, NPM_VARS).join('\n');

    assert.match(body, /proxy_set_header Host \$http_host;/);
    assert.match(body, /proxy_set_header X-Forwarded-Host \$http_host;/);
    assert.match(body, /proxy_set_header Connection \$http_connection;/);
    assert.match(body, /proxy_set_header X-Original-URL \$scheme:\/\/\$http_host\$request_uri;/);
    assert.match(body, /return 302 \/outpost\.goauthentik\.io\/start\?rd=\$scheme:\/\/\$http_host\$request_uri;/);

    assert.doesNotMatch(body, /\$bellhop_http_host/);
    assert.doesNotMatch(body, /\$bellhop_connection_upgrade/);

    // Still the shared, variable-independent shape: proxy lines, the
    // forward-auth block, the exempt location, and the outpost/sign-in
    // locations are all present.
    assert.match(body, /auth_request \/outpost\.goauthentik\.io\/auth\/nginx;/);
    assert.match(body, /location = "\/health" \{/);
    assert.match(body, /location \/outpost\.goauthentik\.io \{/);
    assert.match(body, /location @goauthentik_proxy_signin \{/);

    // The body never includes the surrounding server {}/listen/server_name/
    // TLS lines or the closing brace -- those stay the caller's own to
    // render (the nginx driver's head, or NPM's advanced_config wrapper).
    assert.doesNotMatch(body, /^server \{/m);
    assert.doesNotMatch(body, /listen 443 ssl;/);
    assert.doesNotMatch(body, /ssl_certificate/);
    // A location's own closing brace is indented ("    }"); an unindented
    // "}" line would be the surrounding server block's own close, which
    // the body never includes.
    assert.doesNotMatch(body, /^\}$/m, 'no unindented closing brace (the surrounding server block is the caller\'s own)');
  });
});

test('renderServerBody for an ungated route uses the supplied host variable and stays free of nginx-driver-only variables', () => {
  const inventory = inv({
    guests: [{ name: 'app-lxc', type: 'lxc', vmid: 100, host: 'pve1', ip: '192.0.2.10', port: 8080, subdomains: ['app'] }],
  });
  const routes = buildRoutes(inventory);
  const ctx = buildProxyContext(inventory, nginxDriver);
  const body = renderServerBody(routes[0], ctx, NPM_VARS).join('\n');

  assert.match(body, /proxy_set_header Host \$http_host;/);
  assert.match(body, /proxy_set_header Connection \$http_connection;/);
  assert.doesNotMatch(body, /\$bellhop_http_host/);
  assert.doesNotMatch(body, /\$bellhop_connection_upgrade/);
  assert.doesNotMatch(body, /auth_request/, 'an ungated route gets no forward-auth lines');
});
