import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Inventory } from '../../../src/lib/inventory.ts';
import {
  parsePathPattern,
  buildRoutes,
  buildProxyContext,
  buildRouteForEntry,
  DEFAULT_CERT_RESOLVER,
  type ProxyRoute,
} from '../../../src/lib/proxy/routes.ts';

// buildProxyContext reads authentikConfig().outpostPort from
// AUTHENTIK_OUTPOST_PORT -- pinned for the duration of a test the same way
// test/lib/proxy/drivers/caddy.test.ts pins it, and restored after.
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

test('parsePathPattern: /health is an exact path', () => {
  assert.deepEqual(parsePathPattern('/health'), { kind: 'exact', path: '/health' });
});

test('parsePathPattern: /api/* is a prefix ending at /api/', () => {
  assert.deepEqual(parsePathPattern('/api/*'), { kind: 'prefix', path: '/api/' });
});

test('parsePathPattern: /* alone is a prefix of /', () => {
  assert.deepEqual(parsePathPattern('/*'), { kind: 'prefix', path: '/' });
});

test('parsePathPattern: rejects a star that is not the final character right after a slash', () => {
  assert.throws(() => parsePathPattern('/api*'));
  assert.throws(() => parsePathPattern('/a*b'));
  assert.throws(() => parsePathPattern('/*/x'));
  assert.throws(() => parsePathPattern('*/x'));
});

// Covers every rule T004 lists: manual/subdomain-less entries produce no
// route; hostnames fully qualified in stored order; port defaults to 80;
// backend.insecureTls mirrors insecureBackendTls === true; auth is
// ungated/oidc/forward via effectiveAuth(), with exemptPaths parsed and
// rawExemptPaths in stored order for forward only; route order is hosts,
// guests, external sites.
function fixtureInventory(): Inventory {
  return {
    domain: 'example.com',
    hosts: [
      { name: 'pve1', ssh_target: '192.0.2.1', ssh_user: 'root' },
      {
        name: 'proxmox-host',
        ssh_target: '192.0.2.2',
        ssh_user: 'root',
        ip: '198.51.100.10',
        port: 8006,
        subdomains: ['proxmox'],
      },
    ],
    guests: [
      { name: 'media', type: 'lxc', vmid: 105, host: 'pve1', ip: '192.0.2.50', subdomains: ['media', 'media-alt'] },
      {
        name: 'secure-app',
        type: 'lxc',
        vmid: 106,
        host: 'pve1',
        ip: '192.0.2.51',
        port: 8443,
        subdomains: ['secure'],
        insecureBackendTls: true,
      },
      {
        name: 'gated-app',
        type: 'lxc',
        vmid: 107,
        host: 'pve1',
        ip: '192.0.2.52',
        subdomains: ['gated'],
        authGroup: 'bellhop-users',
      },
      {
        name: 'api-app',
        type: 'lxc',
        vmid: 108,
        host: 'pve1',
        ip: '192.0.2.53',
        subdomains: ['api'],
        authGroup: 'bellhop-users',
        unauthenticatedPaths: ['/health', '/api/*'],
      },
      {
        name: 'oidc-app',
        type: 'lxc',
        vmid: 109,
        host: 'pve1',
        ip: '192.0.2.54',
        subdomains: ['oidc'],
        authGroup: 'bellhop-users',
        authMode: 'oidc',
      },
      {
        name: 'manual-app',
        type: 'lxc',
        vmid: 110,
        host: 'pve1',
        ip: '192.0.2.55',
        subdomains: ['manual'],
        proxyManual: true,
      },
      { name: 'no-subdomain-app', type: 'lxc', vmid: 111, host: 'pve1', ip: '192.0.2.56' },
      { name: 'auth-host', type: 'lxc', vmid: 112, host: 'pve1', ip: '192.0.2.9', authentik: true },
    ],
    externalSites: [{ name: 'nas', ip: '198.51.100.20', port: 5001, subdomains: ['nas'] }],
  };
}

test('buildRoutes: manual and subdomain-less entries produce no route', () => {
  const routes = buildRoutes(fixtureInventory());
  const names = routes.map((r) => r.owner.name);
  assert.ok(!names.includes('manual-app'), 'proxyManual entry must not produce a route');
  assert.ok(!names.includes('no-subdomain-app'), 'entry with no subdomains must not produce a route');
  assert.ok(!names.includes('auth-host'), 'authentik entry with no subdomains must not produce a route');
  assert.ok(!names.includes('pve1'), 'host with no subdomains must not produce a route');
});

test('buildRoutes: route order is hosts, guests, external sites', () => {
  const routes = buildRoutes(fixtureInventory());
  assert.deepEqual(
    routes.map((r) => r.owner),
    [
      { type: 'host', name: 'proxmox-host' },
      { type: 'guest', name: 'media' },
      { type: 'guest', name: 'secure-app' },
      { type: 'guest', name: 'gated-app' },
      { type: 'guest', name: 'api-app' },
      { type: 'guest', name: 'oidc-app' },
      { type: 'externalSite', name: 'nas' },
    ]
  );
});

test('buildRoutes: hostnames are fully qualified in stored order', () => {
  const routes = buildRoutes(fixtureInventory());
  const media = routes.find((r) => r.owner.name === 'media')!;
  assert.deepEqual(media.hostnames, ['media.example.com', 'media-alt.example.com']);
});

test('buildRoutes: port defaults to 80 when unset, otherwise the entry port', () => {
  const routes = buildRoutes(fixtureInventory());
  const media = routes.find((r) => r.owner.name === 'media')!;
  assert.equal(media.backend.port, 80);
  const proxmoxHost = routes.find((r) => r.owner.name === 'proxmox-host')!;
  assert.equal(proxmoxHost.backend.port, 8006);
});

test('buildRoutes: backend.insecureTls mirrors insecureBackendTls === true', () => {
  const routes = buildRoutes(fixtureInventory());
  const secure = routes.find((r) => r.owner.name === 'secure-app')!;
  assert.equal(secure.backend.insecureTls, true);
  const media = routes.find((r) => r.owner.name === 'media')!;
  assert.equal(media.backend.insecureTls, false);
});

test('buildRoutes: auth is ungated by default', () => {
  const routes = buildRoutes(fixtureInventory());
  const media = routes.find((r) => r.owner.name === 'media')!;
  assert.deepEqual(media.auth, { mode: 'ungated' });
});

test('buildRoutes: auth is forward with no exempt paths', () => {
  const routes = buildRoutes(fixtureInventory());
  const gated = routes.find((r) => r.owner.name === 'gated-app')!;
  assert.deepEqual(gated.auth, { mode: 'forward', exemptPaths: [], rawExemptPaths: [] });
});

test('buildRoutes: auth is forward with exemptPaths parsed and rawExemptPaths in stored order', () => {
  const routes = buildRoutes(fixtureInventory());
  const api = routes.find((r) => r.owner.name === 'api-app')!;
  assert.deepEqual(api.auth, {
    mode: 'forward',
    exemptPaths: [
      { kind: 'exact', path: '/health' },
      { kind: 'prefix', path: '/api/' },
    ],
    rawExemptPaths: ['/health', '/api/*'],
  });
});

test('buildRoutes: auth is oidc with no exemptPaths/rawExemptPaths fields', () => {
  const routes = buildRoutes(fixtureInventory());
  const oidc = routes.find((r) => r.owner.name === 'oidc-app')!;
  assert.deepEqual(oidc.auth, { mode: 'oidc' });
});

test('buildRoutes: throws the exact missing-authentik message for a forward-gated entry with no authentik ip', () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: '192.0.2.1', ssh_user: 'root' }],
    guests: [
      {
        name: 'app-lxc',
        type: 'lxc',
        vmid: 120,
        host: 'pve1',
        ip: '192.0.2.20',
        subdomains: ['app'],
        authGroup: 'bellhop-users',
      },
    ],
  };
  assert.throws(
    () => buildRoutes(inv),
    /^Error: Entry 'app-lxc' has an 'authGroup' set but no inventory entry has 'authentik: true' with an ip set$/
  );
  // requireOutpost defaults to true: passing it explicitly changes nothing.
  assert.throws(() => buildRoutes(inv, { requireOutpost: true }), /no inventory entry has 'authentik: true'/);
});

test('buildRoutes: requireOutpost: false derives the forward-gated route with no authentik ip instead of throwing', () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: '192.0.2.1', ssh_user: 'root' }],
    guests: [
      { name: 'app-lxc', type: 'lxc', vmid: 120, host: 'pve1', ip: '192.0.2.20', subdomains: ['app'], authGroup: 'bellhop-users' },
    ],
  };
  const routes = buildRoutes(inv, { requireOutpost: false });
  assert.equal(routes.length, 1);
  assert.equal(routes[0].owner.name, 'app-lxc');
  assert.equal(routes[0].auth.mode, 'forward');
});

test('buildRoutes: throws naming the entry and both accepted forms for an invalid unauthenticatedPaths pattern', () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: '192.0.2.1', ssh_user: 'root' }],
    guests: [
      { name: 'auth-host', type: 'lxc', vmid: 130, host: 'pve1', ip: '192.0.2.9', authentik: true },
      {
        name: 'bad-pattern-app',
        type: 'lxc',
        vmid: 121,
        host: 'pve1',
        ip: '192.0.2.53',
        subdomains: ['bad'],
        authGroup: 'bellhop-users',
        unauthenticatedPaths: ['/api*'],
      },
    ],
  };
  assert.throws(
    () => buildRoutes(inv),
    /^Error: Entry 'bad-pattern-app' has an invalid unauthenticatedPaths pattern '\/api\*': must be an exact path \(\/health\) or a prefix ending in \/\* \(\/api\/\*\)$/
  );
});

test('buildRoutes: rawExemptPaths is a copy, not the inventory\'s own array', () => {
  const inv = fixtureInventory();
  const routes = buildRoutes(inv);
  const api = routes.find((r) => r.owner.name === 'api-app')!;
  assert.ok(api.auth.mode === 'forward');
  if (api.auth.mode === 'forward') {
    api.auth.rawExemptPaths.push('/mutated');
  }
  const apiGuest = inv.guests.find((g) => g.name === 'api-app')!;
  assert.deepEqual(apiGuest.unauthenticatedPaths, ['/health', '/api/*']);
});

const DEFAULT_TLS = {
  certificatePath: '/etc/letsencrypt/live/example.com/fullchain.pem',
  keyPath: '/etc/letsencrypt/live/example.com/privkey.pem',
};

test('buildProxyContext: returns the outpost address and port when an authentik entry with an ip exists', () => {
  withPinnedOutpostPort(() => {
    const ctx = buildProxyContext(fixtureInventory());
    assert.deepEqual(ctx, {
      outpost: { ip: '192.0.2.9', port: 9000 },
      externalPort: 443,
      tls: DEFAULT_TLS,
      certResolver: 'cloudflare',
    });
  });
});

test('buildProxyContext: omits outpost when no authentik entry has an ip', () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: '192.0.2.1', ssh_user: 'root' }],
    guests: [],
  };
  const ctx = buildProxyContext(inv);
  assert.deepEqual(ctx, { externalPort: 443, tls: DEFAULT_TLS, certResolver: 'cloudflare' });
  assert.ok(!('outpost' in ctx));
});

test('buildProxyContext: tls defaults to /etc/letsencrypt/live/<domain>/{fullchain,privkey}.pem when neither setting is set', () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: '192.0.2.1', ssh_user: 'root' }],
    guests: [],
  };
  assert.deepEqual(buildProxyContext(inv).tls, DEFAULT_TLS);
});

test('buildProxyContext: tls uses the configured proxyTlsCertificate/proxyTlsKey when both are set', () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: '192.0.2.1', ssh_user: 'root' }],
    guests: [],
    proxyTlsCertificate: '/opt/certs/example.crt',
    proxyTlsKey: '/opt/certs/example.key',
  };
  assert.deepEqual(buildProxyContext(inv).tls, {
    certificatePath: '/opt/certs/example.crt',
    keyPath: '/opt/certs/example.key',
  });
});

test('buildProxyContext: proxyTlsCertificate and proxyTlsKey default independently when only one is set', () => {
  const withCertOnly: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: '192.0.2.1', ssh_user: 'root' }],
    guests: [],
    proxyTlsCertificate: '/opt/certs/example.crt',
  };
  assert.deepEqual(buildProxyContext(withCertOnly).tls, {
    certificatePath: '/opt/certs/example.crt',
    keyPath: DEFAULT_TLS.keyPath,
  });

  const withKeyOnly: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: '192.0.2.1', ssh_user: 'root' }],
    guests: [],
    proxyTlsKey: '/opt/certs/example.key',
  };
  assert.deepEqual(buildProxyContext(withKeyOnly).tls, {
    certificatePath: DEFAULT_TLS.certificatePath,
    keyPath: '/opt/certs/example.key',
  });
});

// issue #35: certResolver is the Traefik driver's own setting, inert for
// every other driver -- same "always present, defaults independently"
// precedent as tls above.

test('buildProxyContext: certResolver defaults to DEFAULT_CERT_RESOLVER when proxyCertResolver is unset', () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: '192.0.2.1', ssh_user: 'root' }],
    guests: [],
  };
  assert.equal(buildProxyContext(inv).certResolver, DEFAULT_CERT_RESOLVER);
  assert.equal(DEFAULT_CERT_RESOLVER, 'cloudflare');
});

test('buildProxyContext: certResolver uses the configured proxyCertResolver when set', () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: '192.0.2.1', ssh_user: 'root' }],
    guests: [],
    proxyCertResolver: 'my-resolver',
  };
  assert.equal(buildProxyContext(inv).certResolver, 'my-resolver');
});

// Sanity check that the exported ProxyRoute type shape lines up with what
// buildRoutes actually returns (a compile-time check as much as a runtime
// one).
test('buildRoutes: return type matches ProxyRoute[]', () => {
  const routes: ProxyRoute[] = buildRoutes(fixtureInventory());
  assert.ok(Array.isArray(routes));
});

test('buildRouteForEntry: derives only the named entry, so another entry\'s missing authentik ip or bad exempt path never makes it fail', () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: '192.0.2.1', ssh_user: 'root', proxy: true }],
    guests: [
      { name: 'gated', type: 'lxc', vmid: 101, host: 'pve1', ip: '192.0.2.11', subdomains: ['gated'], authGroup: 'bellhop-users', unauthenticatedPaths: ['/api*'] },
      { name: 'web-lxc', type: 'lxc', vmid: 102, host: 'pve1', ip: '192.0.2.12', port: 8080, subdomains: ['web'] },
    ],
  };
  assert.throws(() => buildRoutes(inv));
  assert.deepEqual(buildRouteForEntry(inv, { type: 'guest', name: 'web-lxc' }), {
    owner: { type: 'guest', name: 'web-lxc' },
    hostnames: ['web.example.com'],
    backend: { ip: '192.0.2.12', port: 8080, insecureTls: false },
    auth: { mode: 'ungated' },
  });
});

test('buildRouteForEntry: undefined for an entry with no route or no such entry', () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: '192.0.2.1', ssh_user: 'root', proxy: true }],
    guests: [
      { name: 'internal-lxc', type: 'lxc', vmid: 101, host: 'pve1', ip: '192.0.2.11' },
      { name: 'manual-lxc', type: 'lxc', vmid: 102, host: 'pve1', subdomains: ['manual'], proxyManual: true },
    ],
  };
  assert.equal(buildRouteForEntry(inv, { type: 'guest', name: 'internal-lxc' }), undefined);
  assert.equal(buildRouteForEntry(inv, { type: 'guest', name: 'manual-lxc' }), undefined);
  assert.equal(buildRouteForEntry(inv, { type: 'host', name: 'web-lxc' }), undefined);
});
