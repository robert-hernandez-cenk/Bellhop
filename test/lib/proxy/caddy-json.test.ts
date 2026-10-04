// Issue #26: the admin-API Caddy driver's JSON renderer and reconcile
// planner. The parity tests compare the rendered routes against
// test/fixtures/caddy/characterization-adapted.json -- Caddy v2.10.2's own
// `caddy adapt` of the file-based Caddy driver's characterization block --
// so both Caddy drivers provably serve the same thing (spec FR-008/SC-001,
// research R1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Inventory } from '../../../src/lib/inventory.ts';
import { buildRoutes, buildProxyContext } from '../../../src/lib/proxy/routes.ts';
import type { ProxyRoute } from '../../../src/lib/proxy/routes.ts';
import type { CaddyTlsMode } from '../../../src/lib/proxy/ids.ts';
import type {
  CaddyConfigObject,
  CaddyConnectionPolicy,
  CaddyRoute,
  CaddyTlsPolicy,
} from '../../../src/lib/proxy/caddy-json.ts';
import {
  BELLHOP_CERT_TAG,
  BELLHOP_TLS_CONNECTION_ID,
  BELLHOP_TLS_DEFAULT_ID,
  BELLHOP_TLS_FILES_ID,
  BELLHOP_TLS_POLICY_ID,
  NO_CHANGES_MESSAGE,
  canonicalJson,
  formatCaddyPreview,
  formatConflictError,
  planCaddyConfig,
  renderRoute,
  renderTlsObjects,
  routeId,
} from '../../../src/lib/proxy/caddy-json.ts';

const FIXTURES = new URL('../../fixtures/caddy/', import.meta.url);
const adapted = JSON.parse(readFileSync(new URL('characterization-adapted.json', FIXTURES), 'utf8'));
const adaptedRoutes: Array<Record<string, unknown>> = adapted.apps.http.servers.srv0.routes;
const adaptedPolicy = adapted.apps.tls.automation.policies[0];
const handAuthored = JSON.parse(readFileSync(new URL('convert-adapted.json', FIXTURES), 'utf8'));

// The same inventory as test/lib/proxy/drivers/caddy.test.ts's
// characterization fixture -- the input the adapter fixture was captured
// from. Kept identical so the two drivers are compared on the same routes.
const inventory: Inventory = {
  domain: 'example.com',
  hosts: [
    { name: 'pve1', ssh_target: '192.0.2.1', ssh_user: 'root', proxy: true },
    {
      name: 'pve2',
      ssh_target: '192.0.2.2',
      ssh_user: 'root',
      ip: '198.51.100.10',
      port: 8006,
      subdomains: ['proxmox', 'pve-admin'],
      insecureBackendTls: true,
    },
  ],
  guests: [
    { name: 'media', type: 'lxc', vmid: 105, host: 'pve1', ip: '192.0.2.50', port: 8096, subdomains: ['media'] },
    { name: 'web-lxc', type: 'lxc', vmid: 106, host: 'pve1', ip: '192.0.2.51', subdomains: ['web'] },
    { name: 'app-lxc', type: 'lxc', vmid: 120, host: 'pve1', ip: '192.0.2.20', subdomains: ['app'], authGroup: 'bellhop-users' },
    {
      name: 'api-lxc',
      type: 'lxc',
      vmid: 121,
      host: 'pve1',
      ip: '192.0.2.21',
      subdomains: ['api'],
      authGroup: 'bellhop-users',
      unauthenticatedPaths: ['/health', '/api/*'],
    },
    {
      name: 'sso-app-lxc',
      type: 'lxc',
      vmid: 122,
      host: 'pve1',
      ip: '192.0.2.22',
      subdomains: ['dash'],
      authGroup: 'bellhop-users',
      authMode: 'oidc',
      oidcRedirectUris: ['https://dash.example.com/oauth/callback'],
    },
    { name: 'manual-lxc', type: 'lxc', vmid: 123, host: 'pve1', ip: '192.0.2.23', subdomains: ['manual'], proxyManual: true },
    { name: 'internal-lxc', type: 'lxc', vmid: 124, host: 'pve1', ip: '192.0.2.24' },
    { name: 'auth-lxc', type: 'lxc', vmid: 130, host: 'pve1', ip: '192.0.2.9', authentik: true },
  ],
  externalSites: [{ name: 'nas', ip: '198.51.100.20', port: 5001, subdomains: ['nas'] }],
};

const ORIGINAL_OUTPOST_PORT = process.env.AUTHENTIK_OUTPOST_PORT;
function withPinnedOutpostPort<T>(fn: () => T): T {
  process.env.AUTHENTIK_OUTPOST_PORT = '9000';
  try {
    return fn();
  } finally {
    if (ORIGINAL_OUTPOST_PORT === undefined) delete process.env.AUTHENTIK_OUTPOST_PORT;
    else process.env.AUTHENTIK_OUTPOST_PORT = ORIGINAL_OUTPOST_PORT;
  }
}

function routesAndCtx() {
  return withPinnedOutpostPort(() => ({ routes: buildRoutes(inventory), ctx: buildProxyContext(inventory) }));
}

function withoutId(obj: Record<string, unknown>): Record<string, unknown> {
  const { ['@id']: _id, ...rest } = obj;
  return rest;
}

function adaptedRouteFor(hostnames: string[]): Record<string, unknown> {
  const found = adaptedRoutes.find(
    (r) => canonicalJson((r.match as Array<{ host: string[] }>)[0].host) === canonicalJson(hostnames)
  );
  assert.ok(found, `adapter fixture has a route for ${hostnames.join(', ')}`);
  return found;
}

// The planned configuration's srv0 routes / TLS policies, failing the test
// rather than reading through an undefined.
function srv0(config: CaddyConfigObject | null): { listen?: string[]; routes: CaddyRoute[] } {
  const server = config?.apps?.http?.servers?.srv0;
  assert.ok(server?.routes, 'planned config has srv0 routes');
  return { listen: server.listen, routes: server.routes };
}

function policiesOf(config: CaddyConfigObject | null): CaddyTlsPolicy[] {
  const policies = config?.apps?.tls?.automation?.policies;
  assert.ok(policies, 'planned config has TLS policies');
  return policies;
}

function route(hostnames: string[]): ProxyRoute {
  const found = routesAndCtx().routes.find((r) => r.hostnames[0] === hostnames[0]);
  assert.ok(found);
  return found;
}

test('every rendered route matches the one Caddy adapts from the file-based driver (parity, FR-008)', () => {
  const { routes, ctx } = routesAndCtx();
  assert.equal(routes.length, adaptedRoutes.length);
  for (const r of routes) {
    const rendered = renderRoute(r, ctx);
    assert.equal(rendered['@id'], routeId(r));
    assert.deepEqual(JSON.parse(canonicalJson(withoutId(rendered))), JSON.parse(canonicalJson(adaptedRouteFor(r.hostnames))));
  }
});

test('the TLS policy matches the adapter-merged policy for the same hostnames (parity, FR-008)', () => {
  const { routes, ctx } = routesAndCtx();
  const policy = renderTlsObjects(routes.flatMap((r) => r.hostnames), ctx).policy;
  assert.ok(policy);
  assert.equal(policy['@id'], BELLHOP_TLS_POLICY_ID);
  assert.deepEqual([...(policy.subjects as string[])].sort(), [...adaptedPolicy.subjects].sort());
  assert.deepEqual(JSON.parse(canonicalJson(policy.issuers)), JSON.parse(canonicalJson(adaptedPolicy.issuers)));
});

test('route ids use the canonical hostname', () => {
  assert.equal(routeId(route(['proxmox.example.com'])), 'bellhop-route-proxmox.example.com');
});

test('forward-gated routes carry the outpost check, passthrough and exempt paths; oidc and ungated carry none (US3)', () => {
  const { ctx } = routesAndCtx();
  const text = (hostnames: string[]) => JSON.stringify(renderRoute(route(hostnames), ctx));
  assert.match(text(['app.example.com']), /outpost\.goauthentik\.io\/auth\/caddy/);
  assert.doesNotMatch(text(['app.example.com']), /"not":\[\{"path"/);
  assert.match(text(['api.example.com']), /"not":\[\{"path":\["\/health","\/api\/\*"\]\}\]/);
  assert.doesNotMatch(text(['dash.example.com']), /outpost/);
  assert.doesNotMatch(text(['media.example.com']), /outpost/);
});

test('an empty Caddy gets srv0 on :443 holding every route, plus the TLS policy', () => {
  const { routes, ctx } = routesAndCtx();
  const plan = planCaddyConfig(null, routes, ctx, 'pve1');
  const server = srv0(plan.config);
  assert.deepEqual(server.listen, [':443']);
  assert.deepEqual(
    server.routes.map((r) => r['@id']),
    routes.map((r) => routeId(r))
  );
  assert.equal(policiesOf(plan.config)[0]['@id'], BELLHOP_TLS_POLICY_ID);
  assert.equal(plan.changes.filter((c) => c.kind === 'add' && c.object === 'route').length, 7);
  assert.deepEqual(plan.conflicts, []);
});

test('an unchanged configuration plans no write (SC-003)', () => {
  const { routes, ctx } = routesAndCtx();
  const first = planCaddyConfig(null, routes, ctx, 'pve1');
  // Round-trip through JSON like Caddy's own GET /config/ does.
  const live = JSON.parse(JSON.stringify(first.config));
  const second = planCaddyConfig(live, routes, ctx, 'pve1');
  assert.equal(second.config, null);
  assert.deepEqual(second.changes, []);
  assert.equal(formatCaddyPreview(second), NO_CHANGES_MESSAGE);
});

test('a changed route is replaced, a dropped one removed, and the rest untouched', () => {
  const { routes, ctx } = routesAndCtx();
  const live = JSON.parse(JSON.stringify(planCaddyConfig(null, routes, ctx, 'pve1').config));
  const changed = routes
    .filter((r) => r.hostnames[0] !== 'nas.example.com')
    .map((r) => (r.hostnames[0] === 'media.example.com' ? { ...r, backend: { ...r.backend, port: 9000 } } : r));
  const plan = planCaddyConfig(live, changed, ctx, 'pve1');
  assert.deepEqual(
    plan.changes.filter((c) => c.object === 'route').map((c) => `${c.kind} ${c.hostnames[0]}`),
    ['replace media.example.com', 'remove nas.example.com']
  );
  assert.ok(plan.changes.some((c) => c.object === 'tls-policy' && c.kind === 'replace'));
});

test('hand-authored routes stay, in order, after Bellhop routes (US2, SC-002)', () => {
  const { routes, ctx } = routesAndCtx();
  const live = JSON.parse(JSON.stringify(handAuthored));
  live.apps.http.servers.srv0.routes.push({ match: [{ host: ['*.example.com'] }], handle: [{ handler: 'static_response' }] });
  const before = live.apps.http.servers.srv0.routes.map((r: unknown) => canonicalJson(r));
  const plan = planCaddyConfig(live, routes, ctx, 'pve1');
  const after = srv0(plan.config).routes;
  assert.equal(after.length, 7 + before.length);
  assert.deepEqual(after.slice(7).map((r) => canonicalJson(r)), before);
  // A wildcard host is not a conflict: the prepended exact-host routes win.
  assert.deepEqual(plan.conflicts, []);
});

test('a hand-authored route claiming an inventory hostname is a conflict and that route is left out (FR-007)', () => {
  const { routes, ctx } = routesAndCtx();
  const live = JSON.parse(JSON.stringify(handAuthored));
  live.apps.http.servers.srv0.routes.push({ match: [{ host: ['WEB.example.com'] }], handle: [{ handler: 'static_response' }] });
  const plan = planCaddyConfig(live, routes, ctx, 'pve1');
  assert.deepEqual(plan.conflicts, [
    { hostname: 'web.example.com', owner: { type: 'guest', name: 'web-lxc' }, claimedBy: 'route', server: 'srv0' },
  ]);
  const ids = srv0(plan.config).routes.map((r) => r['@id']);
  assert.ok(!ids.includes('bellhop-route-web.example.com'));
  assert.ok(!policiesOf(plan.config)[0].subjects?.includes('web.example.com'));
  assert.match(formatCaddyPreview(plan), /^! conflict web\.example\.com \(entry 'web-lxc'\): claimed by a hand-authored route in server 'srv0'$/m);
  assert.equal(
    formatConflictError(plan.conflicts, 'pve1'),
    "Hostname 'web.example.com' for entry 'web-lxc' is already claimed by a hand-authored route in server 'srv0' in Caddy's configuration on 'pve1'; it was left out. Remove or change that object, or mark the entry proxyManual."
  );
});

test('a hand-authored TLS policy listing an inventory hostname is a conflict (FR-007)', () => {
  const { routes, ctx } = routesAndCtx();
  const live = JSON.parse(JSON.stringify(handAuthored));
  live.apps.tls = { automation: { policies: [{ subjects: ['media.example.com'] }] } };
  const plan = planCaddyConfig(live, routes, ctx, 'pve1');
  assert.deepEqual(plan.conflicts, [
    { hostname: 'media.example.com', owner: { type: 'guest', name: 'media' }, claimedBy: 'tls-policy' },
  ]);
  // Bellhop's policy goes first; the operator's stays after it.
  assert.equal(policiesOf(plan.config)[0]['@id'], BELLHOP_TLS_POLICY_ID);
  assert.deepEqual(policiesOf(plan.config)[1], { subjects: ['media.example.com'] });
});

test('removing every route removes the TLS policy too, never leaving an empty-subjects policy', () => {
  const { routes, ctx } = routesAndCtx();
  const live = JSON.parse(JSON.stringify(planCaddyConfig(handAuthored, routes, ctx, 'pve1').config));
  const plan = planCaddyConfig(live, [], ctx, 'pve1');
  assert.ok(plan.config);
  assert.equal(plan.config.apps?.tls, undefined);
  assert.deepEqual(srv0(plan.config).routes, handAuthored.apps.http.servers.srv0.routes);
});

test('no routes and no Bellhop objects plans nothing, even with no HTTPS server', () => {
  const { ctx } = routesAndCtx();
  const plan = planCaddyConfig({ apps: { http: { servers: { plain: { listen: [':80'] } } } } }, [], ctx, 'pve1');
  assert.equal(plan.config, null);
});

test('zero or several servers on port 443 is an error naming them', () => {
  const { routes, ctx } = routesAndCtx();
  assert.throws(
    () => planCaddyConfig({ apps: { http: { servers: { plain: { listen: [':80'] } } } } }, routes, ctx, 'pve1'),
    /^Error: Caddy's configuration on 'pve1' has 0 servers listening on port 443 \(none\); the caddy-api driver needs exactly one to hold its routes\.$/
  );
  const two = { apps: { http: { servers: { a: { listen: [':443'] }, b: { listen: ['0.0.0.0:443'] } } } } };
  assert.throws(() => planCaddyConfig(two, routes, ctx, 'pve1'), /has 2 servers listening on port 443 \(a, b\)/);
});

test('Bellhop routes moved behind hand-authored ones are moved back to the front', () => {
  const { routes, ctx } = routesAndCtx();
  const live = JSON.parse(JSON.stringify(planCaddyConfig(handAuthored, routes, ctx, 'pve1').config));
  const srvRoutes = live.apps.http.servers.srv0.routes;
  srvRoutes.push(srvRoutes.shift());
  const plan = planCaddyConfig(live, routes, ctx, 'pve1');
  assert.deepEqual(plan.changes, [{ kind: 'reorder', object: 'route', hostnames: [] }]);
  assert.equal(srv0(plan.config).routes[0]['@id'], 'bellhop-route-proxmox.example.com');
});

test('the preview lists each change and ends with the Bellhop objects as written', () => {
  const { routes, ctx } = routesAndCtx();
  const plan = planCaddyConfig(null, routes, ctx, 'pve1');
  const preview = formatCaddyPreview(plan);
  assert.match(preview, /^\+ route proxmox\.example\.com, pve-admin\.example\.com -> 198\.51\.100\.10:8006 \(insecure backend TLS\)$/m);
  assert.match(preview, /^\+ route api\.example\.com -> 192\.0\.2\.21:80 \(forward-auth, 2 exempt paths\)$/m);
  assert.match(preview, /^\+ route dash\.example\.com -> 192\.0\.2\.22:80 \(OIDC\)$/m);
  assert.match(preview, /^\+ tls policy: 8 hostnames$/m);
  const objects = JSON.parse(preview.split('Bellhop objects after this change:\n')[1]);
  assert.deepEqual(objects, [...srv0(plan.config).routes, policiesOf(plan.config)[0]]);
});

// --- issue #51: TLS modes ---------------------------------------------------
// Each proxyCaddyTls mode's Bellhop TLS objects are pinned against Caddy's
// own adapter output for the same characterization block with that mode's
// clause (test/fixtures/caddy/tls-*-adapted.json), the same way the routes
// are pinned above (contracts/rendering-and-settings.md "Caddy JSON").

const MODES: CaddyTlsMode[] = ['cloudflare', 'letsencrypt', 'internal', 'files'];
const FIXTURE_FOR: Record<CaddyTlsMode, string> = {
  cloudflare: 'characterization-adapted.json',
  letsencrypt: 'tls-letsencrypt-adapted.json',
  internal: 'tls-internal-adapted.json',
  files: 'tls-files-adapted.json',
};

function modeInventory(mode: CaddyTlsMode): Inventory {
  return { ...inventory, proxyCaddyTls: mode };
}

function modeRoutesAndCtx(mode: CaddyTlsMode) {
  const inv = modeInventory(mode);
  return withPinnedOutpostPort(() => ({ routes: buildRoutes(inv), ctx: buildProxyContext(inv) }));
}

// The TLS-relevant parts of a configuration -- apps.tls and the HTTPS
// server's tls_connection_policies -- with Bellhop's @ids dropped, its
// certificate tag swapped back to the adapter's cert0, and the hostname
// lists sorted (the adapter orders sites its own way; Caddy treats both as
// sets).
function tlsParts(config: unknown): unknown {
  const c = config as { apps?: { tls?: unknown; http?: { servers?: Record<string, { tls_connection_policies?: unknown }> } } };
  return normalizeTls({
    tls: c.apps?.tls,
    connectionPolicies: c.apps?.http?.servers?.srv0?.tls_connection_policies,
  });
}

function normalizeTls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeTls);
  if (value === 'bellhop-cert') return 'cert0';
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === '@id' || v === undefined) continue;
      out[k] = (k === 'subjects' || k === 'sni') && Array.isArray(v) ? [...v].sort() : normalizeTls(v);
    }
    return out;
  }
  return value;
}

for (const mode of MODES) {
  test(`${mode}: the Bellhop TLS objects equal what Caddy adapts from the same Caddyfile (parity)`, () => {
    const { routes, ctx } = modeRoutesAndCtx(mode);
    const plan = planCaddyConfig(null, routes, ctx, 'pve1');
    const fixture = JSON.parse(readFileSync(new URL(FIXTURE_FOR[mode], FIXTURES), 'utf8'));
    assert.equal(canonicalJson(tlsParts(plan.config)), canonicalJson(tlsParts(fixture)));
    // Routes never vary by mode (research R1).
    const cloudflare = modeRoutesAndCtx('cloudflare');
    assert.equal(
      canonicalJson(srv0(plan.config).routes),
      canonicalJson(srv0(planCaddyConfig(null, cloudflare.routes, cloudflare.ctx, 'pve1').config).routes)
    );
  });
}

test('letsencrypt writes no tls app at all', () => {
  const { routes, ctx } = modeRoutesAndCtx('letsencrypt');
  const plan = planCaddyConfig(null, routes, ctx, 'pve1');
  assert.equal(plan.config?.apps?.tls, undefined);
  assert.equal(plan.config?.apps?.http?.servers?.srv0?.tls_connection_policies, undefined);
});

test('files: the Bellhop objects carry their ids and the bellhop-cert tag', () => {
  const { routes, ctx } = modeRoutesAndCtx('files');
  const plan = planCaddyConfig(null, routes, ctx, 'pve1');
  const loadFiles = plan.config?.apps?.tls?.certificates?.load_files;
  assert.deepEqual(loadFiles?.map((f) => [f['@id'], f.tags]), [[BELLHOP_TLS_FILES_ID, [BELLHOP_CERT_TAG]]]);
  assert.deepEqual(
    srv0Policies(plan.config).map((p) => p['@id']),
    [BELLHOP_TLS_CONNECTION_ID, BELLHOP_TLS_DEFAULT_ID]
  );
});

function srv0Policies(config: CaddyConfigObject | null): CaddyConnectionPolicy[] {
  const policies = config?.apps?.http?.servers?.srv0?.tls_connection_policies;
  assert.ok(policies, 'planned config has srv0 connection policies');
  return policies;
}

function liveConfig(mode: CaddyTlsMode, base: unknown = null): CaddyConfigObject {
  const { routes, ctx } = modeRoutesAndCtx(mode);
  return JSON.parse(JSON.stringify(planCaddyConfig(base as CaddyConfigObject | null, routes, ctx, 'pve1').config));
}

test('switching cloudflare -> files removes bellhop-tls and adds the files objects', () => {
  const { routes, ctx } = modeRoutesAndCtx('files');
  const plan = planCaddyConfig(liveConfig('cloudflare'), routes, ctx, 'pve1');
  assert.equal(plan.config?.apps?.tls?.automation, undefined);
  assert.deepEqual(plan.config?.apps?.tls?.certificates?.load_files?.map((f) => f['@id']), [BELLHOP_TLS_FILES_ID]);
  assert.deepEqual(
    srv0Policies(plan.config).map((p) => p['@id']),
    [BELLHOP_TLS_CONNECTION_ID, BELLHOP_TLS_DEFAULT_ID]
  );
  assert.deepEqual(
    plan.changes.filter((c) => c.object !== 'route').map((c) => `${c.kind} ${c.object}`),
    ['remove tls-policy', 'add tls-files', 'add tls-connection']
  );
});

test('switching files -> internal removes all three files objects, prunes their containers, adds the internal policy', () => {
  const { routes, ctx } = modeRoutesAndCtx('internal');
  const plan = planCaddyConfig(liveConfig('files'), routes, ctx, 'pve1');
  assert.equal(plan.config?.apps?.tls?.certificates, undefined);
  assert.equal(plan.config?.apps?.http?.servers?.srv0?.tls_connection_policies, undefined);
  const [policy] = policiesOf(plan.config);
  assert.equal(policy['@id'], BELLHOP_TLS_POLICY_ID);
  assert.deepEqual(policy.issuers, [{ module: 'internal' }]);
  assert.deepEqual(
    plan.changes.filter((c) => c.object !== 'route').map((c) => `${c.kind} ${c.object}`),
    ['add tls-policy', 'remove tls-files', 'remove tls-connection']
  );
});

test('untagged automation policies, load_files entries and connection policies are never altered', () => {
  const live = JSON.parse(JSON.stringify(handAuthored));
  const operatorPolicy = { subjects: ['other.example.com'], issuers: [{ module: 'internal' }] };
  const operatorFile = { certificate: '/etc/ssl/example/other.pem', key: '/etc/ssl/example/other.key', tags: ['cert0'] };
  const operatorConnection = { match: { sni: ['other.example.com'] }, certificate_selection: { any_tag: ['cert0'] } };
  live.apps.tls = { automation: { policies: [operatorPolicy] }, certificates: { load_files: [operatorFile] } };
  live.apps.http.servers.srv0.tls_connection_policies = [operatorConnection];

  const files = modeRoutesAndCtx('files');
  const asFiles = planCaddyConfig(live, files.routes, files.ctx, 'pve1');
  assert.deepEqual(asFiles.conflicts, []);
  assert.deepEqual(asFiles.config?.apps?.tls?.automation?.policies, [operatorPolicy]);
  assert.deepEqual(asFiles.config?.apps?.tls?.certificates?.load_files?.slice(1), [operatorFile]);
  const connection = srv0Policies(asFiles.config);
  assert.deepEqual(
    connection.map((p) => p['@id'] ?? 'operator'),
    [BELLHOP_TLS_CONNECTION_ID, 'operator', BELLHOP_TLS_DEFAULT_ID]
  );
  assert.deepEqual(connection[1], operatorConnection);

  const internal = modeRoutesAndCtx('internal');
  const asInternal = planCaddyConfig(JSON.parse(JSON.stringify(asFiles.config)), internal.routes, internal.ctx, 'pve1');
  assert.deepEqual(asInternal.config?.apps?.tls?.automation?.policies?.slice(1), [operatorPolicy]);
  assert.deepEqual(asInternal.config?.apps?.tls?.certificates?.load_files, [operatorFile]);
  assert.deepEqual(srv0Policies(asInternal.config), [operatorConnection]);
});

test('bellhop-tls-default is omitted when the server already has an untagged catch-all', () => {
  const live = JSON.parse(JSON.stringify(handAuthored));
  live.apps.http.servers.srv0.tls_connection_policies = [{}];
  const { routes, ctx } = modeRoutesAndCtx('files');
  const plan = planCaddyConfig(live, routes, ctx, 'pve1');
  assert.deepEqual(
    srv0Policies(plan.config).map((p) => p['@id'] ?? 'operator'),
    [BELLHOP_TLS_CONNECTION_ID, 'operator']
  );
});

test('a matched untagged connection policy is not a catch-all, so bellhop-tls-default is still added', () => {
  const live = JSON.parse(JSON.stringify(handAuthored));
  live.apps.http.servers.srv0.tls_connection_policies = [{ match: { sni: ['www.example.com'] } }];
  const { routes, ctx } = modeRoutesAndCtx('files');
  const plan = planCaddyConfig(live, routes, ctx, 'pve1');
  assert.equal(srv0Policies(plan.config).at(-1)?.['@id'], BELLHOP_TLS_DEFAULT_ID);
});

for (const mode of MODES) {
  test(`${mode}: zero kept routes writes no TLS objects, and removes the ones a previous sync wrote`, () => {
    const { ctx } = modeRoutesAndCtx(mode);
    assert.equal(planCaddyConfig(null, [], ctx, 'pve1').config, null);
    for (const previous of MODES) {
      const plan = planCaddyConfig(liveConfig(previous, handAuthored), [], ctx, 'pve1');
      assert.ok(plan.config);
      assert.equal(plan.config.apps?.tls, undefined, `after ${previous}`);
      assert.equal(plan.config.apps?.http?.servers?.srv0?.tls_connection_policies, undefined, `after ${previous}`);
    }
  });

  test(`${mode}: an unchanged configuration plans no write`, () => {
    const { routes, ctx } = modeRoutesAndCtx(mode);
    const second = planCaddyConfig(liveConfig(mode, handAuthored), routes, ctx, 'pve1');
    assert.equal(second.config, null);
    assert.deepEqual(second.changes, []);
  });

  test(`${mode}: an untagged route naming an inventory hostname is always a conflict`, () => {
    const live = JSON.parse(JSON.stringify(handAuthored));
    live.apps.http.servers.srv0.routes.push({ match: [{ host: ['web.example.com'] }], handle: [{ handler: 'static_response' }] });
    const { routes, ctx } = modeRoutesAndCtx(mode);
    assert.deepEqual(
      planCaddyConfig(live, routes, ctx, 'pve1').conflicts.map((c) => `${c.hostname} ${c.claimedBy}`),
      ['web.example.com route']
    );
  });
}

test('untagged automation policies claim hostnames only in cloudflare and internal modes (research R4)', () => {
  const live = JSON.parse(JSON.stringify(handAuthored));
  live.apps.tls = { automation: { policies: [{ subjects: ['media.example.com'] }] } };
  const conflictsIn = (mode: CaddyTlsMode) => {
    const { routes, ctx } = modeRoutesAndCtx(mode);
    return planCaddyConfig(live, routes, ctx, 'pve1').conflicts.map((c) => `${c.hostname} ${c.claimedBy}`);
  };
  assert.deepEqual(conflictsIn('cloudflare'), ['media.example.com tls-policy']);
  assert.deepEqual(conflictsIn('internal'), ['media.example.com tls-policy']);
  assert.deepEqual(conflictsIn('letsencrypt'), []);
  assert.deepEqual(conflictsIn('files'), []);
});

test('the preview prints the tls certificate files and tls connection policy lines', () => {
  const files = modeRoutesAndCtx('files');
  const added = formatCaddyPreview(planCaddyConfig(null, files.routes, files.ctx, 'pve1'));
  assert.match(added, /^\+ tls certificate files: \/etc\/letsencrypt\/live\/example\.com\/fullchain\.pem$/m);
  assert.match(added, /^\+ tls connection policy: 8 hostnames$/m);
  assert.doesNotMatch(added, /tls policy/);

  const fewer = files.routes.filter((r) => r.hostnames[0] !== 'nas.example.com');
  const changed = formatCaddyPreview(planCaddyConfig(liveConfig('files'), fewer, files.ctx, 'pve1'));
  assert.match(changed, /^~ tls connection policy: 7 hostnames$/m);
  assert.doesNotMatch(changed, /tls certificate files/);

  const internal = modeRoutesAndCtx('internal');
  const removed = formatCaddyPreview(planCaddyConfig(liveConfig('files'), internal.routes, internal.ctx, 'pve1'));
  assert.match(removed, /^- tls certificate files$/m);
  assert.match(removed, /^- tls connection policy$/m);
  assert.match(removed, /^\+ tls policy: 8 hostnames$/m);
});

test('a changed certificate path replaces the load_files entry', () => {
  const inv: Inventory = { ...modeInventory('files'), proxyTlsCertificate: '/etc/ssl/example/cert.pem' };
  const { routes, ctx } = withPinnedOutpostPort(() => ({ routes: buildRoutes(inv), ctx: buildProxyContext(inv) }));
  const plan = planCaddyConfig(liveConfig('files'), routes, ctx, 'pve1');
  assert.deepEqual(
    plan.changes.map((c) => `${c.kind} ${c.object}`),
    ['replace tls-files']
  );
  assert.match(formatCaddyPreview(plan), /^~ tls certificate files: \/etc\/ssl\/example\/cert\.pem$/m);
});

test('the preview ends with every Bellhop object, TLS objects included, as written', () => {
  const { routes, ctx } = modeRoutesAndCtx('files');
  const plan = planCaddyConfig(null, routes, ctx, 'pve1');
  const objects = JSON.parse(formatCaddyPreview(plan).split('Bellhop objects after this change:\n')[1]);
  assert.deepEqual(objects, [
    ...srv0(plan.config).routes,
    ...(plan.config?.apps?.tls?.certificates?.load_files ?? []),
    ...srv0Policies(plan.config),
  ]);
});
