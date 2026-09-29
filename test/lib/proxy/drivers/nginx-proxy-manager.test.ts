// Nginx Proxy Manager driver (issue #31), User Story 1: reconcile inventory
// routes with NPM proxy hosts. Pinned against
// specs/014-nginx-proxy-manager-driver/contracts/driver-and-client.md
// (preview lines, apply order, error text) and research.md R9 (the desired
// proxy host body). Uses an in-memory FakeNpmClient -- no HTTP at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Inventory } from '../../../../src/lib/inventory.ts';
import type { NpmCertificate } from '../../../../src/lib/npm-client.ts';
import { buildRoutes, buildProxyContext } from '../../../../src/lib/proxy/routes.ts';
import type { DriverDeps } from '../../../../src/lib/proxy/driver.ts';
import {
  NPM_OWNERSHIP_MARKER,
  createNpmDriver,
  isOwned,
  nginxProxyManagerDriver,
  planNpmSync,
} from '../../../../src/lib/proxy/drivers/nginx-proxy-manager.ts';
import { FakeNpmClient, npmHost } from '../../../support/fake-npm-client.ts';
import { FakeSSHClient, defaultResponder } from '../../../support/fake-ssh-client.ts';

const WILDCARD: NpmCertificate = {
  id: 3,
  provider: 'other',
  nice_name: 'Wildcard example.com',
  domain_names: ['*.example.com'],
  expires_on: '2099-01-01 00:00:00',
};

type GuestSpec = { name: string; ip: string; port?: number; subdomains: string[]; insecureBackendTls?: boolean };

function inv(guests: GuestSpec[]): Inventory {
  return {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: '192.0.2.1', ssh_user: 'root', proxy: true }],
    guests: guests.map((g, i) => ({ type: 'lxc' as const, vmid: 100 + i, host: 'pve1', ...g })),
  };
}

const TWO_ROUTES: GuestSpec[] = [
  { name: 'app', ip: '192.0.2.10', port: 8080, subdomains: ['app', 'www'] },
  { name: 'wiki', ip: '192.0.2.11', port: 3000, subdomains: ['wiki'] },
];

function setup(inventory: Inventory, client: FakeNpmClient) {
  const driver = createNpmDriver({ clientFor: () => client });
  const deps: DriverDeps = { ssh: new FakeSSHClient(defaultResponder), inventory, proxyHost: 'pve1', configPath: null };
  const routes = buildRoutes(inventory);
  const ctx = buildProxyContext(inventory);
  return {
    driver,
    deps,
    plan: () => driver.plan(routes, ctx, deps),
    sync: async () => {
      const plan = await driver.plan(routes, ctx, deps);
      await driver.apply(plan, deps);
      return plan;
    },
  };
}

// --- (a) empty NPM, two ungated routes, a covering wildcard certificate ------

test('NPM plan: empty NPM + two routes -> header, two "+ create" lines reusing the wildcard, change count', async () => {
  const client = new FakeNpmClient({ certificates: [WILDCARD] });
  const { plan } = setup(inv(TWO_ROUTES), client);
  const result = await plan();
  assert.equal(
    result.preview,
    [
      'Nginx Proxy Manager at http://192.0.2.30:81',
      '  + create  app.example.com, www.example.com -> http://192.0.2.10:8080  [certificate: #3 Wildcard example.com]',
      '  + create  wiki.example.com -> http://192.0.2.11:3000  [certificate: #3 Wildcard example.com]',
      '2 change(s), 0 conflict(s)',
    ].join('\n')
  );
  assert.deepEqual(client.writes(), [], 'plan() never writes');
});

test('NPM apply: creates each host with the marker first, canonical-first names, and the fixed R9 settings', async () => {
  const client = new FakeNpmClient({ certificates: [WILDCARD] });
  const { sync } = setup(inv(TWO_ROUTES), client);
  await sync();

  const creates = client.calls.filter((c) => c.method === 'createProxyHost');
  assert.equal(creates.length, 2);
  const [app, wiki] = creates.map((c) => c.body!);
  assert.deepEqual(app.domain_names, ['app.example.com', 'www.example.com']);
  assert.deepEqual(wiki.domain_names, ['wiki.example.com']);
  for (const body of [app, wiki]) {
    assert.equal(body.advanced_config.split('\n')[0], NPM_OWNERSHIP_MARKER);
    assert.equal(body.forward_scheme, 'http');
    assert.equal(body.certificate_id, 3);
    assert.equal(body.ssl_forced, true);
    assert.equal(body.http2_support, true);
    assert.equal(body.allow_websocket_upgrade, true);
    assert.equal(body.enabled, true);
    assert.equal(body.block_exploits, false);
    assert.equal(body.caching_enabled, false);
    assert.equal(body.hsts_enabled, false);
    assert.equal(body.hsts_subdomains, false);
    assert.equal(body.trust_forwarded_proto, false);
    assert.equal(body.access_list_id, 0);
    assert.deepEqual(body.locations, []);
  }
  assert.equal(app.forward_host, '192.0.2.10');
  assert.equal(app.forward_port, 8080);
  // The NPM variable choice (research R5): nginx built-ins, never the nginx
  // driver's http{}-level map variables.
  assert.match(app.advanced_config, /proxy_set_header Host \$http_host;/);
  assert.match(app.advanced_config, /proxy_set_header Connection \$http_connection;/);
  assert.doesNotMatch(app.advanced_config, /\$bellhop_/);
  // Each write is read back (research R6).
  assert.equal(client.calls.filter((c) => c.method === 'getProxyHost').length, 2);
  assert.ok([...client.hosts.values()].every(isOwned));
});

// --- (b) idempotent ----------------------------------------------------------

test('NPM: re-planning against the applied result -> every route "= ok", "No changes", and apply writes nothing', async () => {
  const client = new FakeNpmClient({ certificates: [WILDCARD] });
  const { sync, plan, driver, deps } = setup(inv(TWO_ROUTES), client);
  await sync();
  client.clearCalls();

  const second = await plan();
  assert.equal(
    second.preview,
    [
      'Nginx Proxy Manager at http://192.0.2.30:81',
      '  = ok      app.example.com (#1)',
      '  = ok      wiki.example.com (#2)',
      'No changes',
    ].join('\n')
  );
  await driver.apply(second, deps);
  assert.deepEqual(client.writes(), []);
});

// --- (c) drift -> update on the same id -----------------------------------------

test('NPM: a port change -> "~ update ... (#id): forward_port, advanced_config", applied with updateProxyHost on that id', async () => {
  const client = new FakeNpmClient({ certificates: [WILDCARD] });
  await setup(inv(TWO_ROUTES), client).sync();
  client.clearCalls();

  const changed = TWO_ROUTES.map((g) => (g.name === 'wiki' ? { ...g, port: 3001 } : g));
  const { plan, driver, deps } = setup(inv(changed), client);
  const result = await plan();
  assert.equal(
    result.preview,
    [
      'Nginx Proxy Manager at http://192.0.2.30:81',
      '  = ok      app.example.com (#1)',
      '  ~ update  wiki.example.com (#2): forward_port, advanced_config',
      '1 change(s), 0 conflict(s)',
    ].join('\n')
  );
  await driver.apply(result, deps);
  const writes = client.writes();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, 'updateProxyHost');
  assert.equal(writes[0].id, 2);
  assert.equal(writes[0].body!.forward_port, 3001);
  assert.equal(client.hosts.get(2)!.forward_port, 3001);
});

// --- (d) delete, and deletes run first -----------------------------------------------

test('NPM: an owned host no route matches -> "- delete", and apply deletes before any update or create', async () => {
  const client = new FakeNpmClient({ certificates: [WILDCARD] });
  await setup(inv([...TWO_ROUTES, { name: 'old', ip: '192.0.2.12', subdomains: ['old'] }]), client).sync();
  client.clearCalls();

  // 'old' is gone, 'wiki' drifts, 'new' is added.
  const next: GuestSpec[] = [
    TWO_ROUTES[0],
    { ...TWO_ROUTES[1], port: 3001 },
    { name: 'new', ip: '192.0.2.13', port: 8000, subdomains: ['new'] },
  ];
  const { plan, driver, deps } = setup(inv(next), client);
  const result = await plan();
  assert.equal(
    result.preview,
    [
      'Nginx Proxy Manager at http://192.0.2.30:81',
      '  = ok      app.example.com (#1)',
      '  ~ update  wiki.example.com (#2): forward_port, advanced_config',
      '  + create  new.example.com -> http://192.0.2.13:8000  [certificate: #3 Wildcard example.com]',
      '  - delete  old.example.com (#3)',
      '3 change(s), 0 conflict(s)',
    ].join('\n')
  );
  await driver.apply(result, deps);
  assert.deepEqual(
    client.writes().map((w) => w.method),
    ['deleteProxyHost', 'updateProxyHost', 'createProxyHost']
  );
  assert.equal(client.writes()[0].id, 3);
  assert.equal(client.hosts.has(3), false);
});

test('NPM: an unowned host is never deleted, even when no route matches it', async () => {
  const client = new FakeNpmClient({
    certificates: [WILDCARD],
    hosts: [npmHost({ id: 9, domain_names: ['handmade.example.com'], advanced_config: '# my own config' })],
  });
  const { sync } = setup(inv(TWO_ROUTES), client);
  const result = await sync();
  assert.doesNotMatch(result.preview, /delete/);
  assert.ok(client.hosts.has(9));
});

// --- (e) nginx rejects the configuration --------------------------------------------

test('NPM apply: a write whose read-back has nginx_online false throws the contract message with nginx_err', async () => {
  const client = new FakeNpmClient({ certificates: [WILDCARD] });
  client.offlineError = 'nginx: [emerg] unknown directive "bogus" in /data/nginx/proxy_host/1.conf:61';
  const { sync } = setup(inv([TWO_ROUTES[0]]), client);
  await assert.rejects(
    sync,
    new Error(
      'Nginx Proxy Manager saved proxy host #1 (app.example.com) but nginx rejected its configuration: nginx: [emerg] unknown directive "bogus" in /data/nginx/proxy_host/1.conf:61 -- the site is offline until the next successful sync'
    )
  );
});

// --- (f) backend TLS ---------------------------------------------------------------

test('NPM: an insecureTls route and a port-443 route forward over https, with verification off and on respectively', async () => {
  const client = new FakeNpmClient({ certificates: [WILDCARD] });
  const { sync } = setup(
    inv([
      { name: 'nas', ip: '192.0.2.20', port: 5001, subdomains: ['nas'], insecureBackendTls: true },
      { name: 'secure', ip: '192.0.2.21', port: 443, subdomains: ['secure'] },
    ]),
    client
  );
  const result = await sync();
  assert.match(result.preview, /\+ create {2}nas\.example\.com -> https:\/\/192\.0\.2\.20:5001/);
  assert.match(result.preview, /\+ create {2}secure\.example\.com -> https:\/\/192\.0\.2\.21:443/);
  const [nas, secure] = client.calls.filter((c) => c.method === 'createProxyHost').map((c) => c.body!);
  assert.equal(nas.forward_scheme, 'https');
  assert.equal(secure.forward_scheme, 'https');
  assert.match(nas.advanced_config, /proxy_ssl_verify off;/);
  assert.match(secure.advanced_config, /proxy_ssl_verify on;/);
});

// --- certificates: request happy path ----------------------------------------------

test('NPM: with no covering certificate, the preview says a certificate will be requested, and apply requests it right before the create and uses its id', async () => {
  const client = new FakeNpmClient({
    certificates: [{ id: 4, provider: 'other', nice_name: 'Other domain', domain_names: ['*.example.org'], expires_on: '2099-01-01 00:00:00' }],
  });
  const { sync } = setup(inv([TWO_ROUTES[0]]), client);
  const result = await sync();
  assert.match(
    result.preview,
    /^ {2}\+ create {2}app\.example\.com, www\.example\.com -> http:\/\/192\.0\.2\.10:8080 {2}\[certificate: request Let's Encrypt for app\.example\.com, www\.example\.com\]$/m
  );
  const writes = client.writes();
  assert.deepEqual(writes.map((w) => w.method), ['requestCertificate', 'createProxyHost']);
  assert.deepEqual(writes[0].domainNames, ['app.example.com', 'www.example.com']);
  assert.equal(writes[1].body!.certificate_id, 5);
});

test('planNpmSync picks the qualifying certificate with the latest expires_on for a new host, but keeps an existing host on its current one', async () => {
  const inventory = inv([TWO_ROUTES[1]]);
  const routes = buildRoutes(inventory);
  const ctx = buildProxyContext(inventory);
  const newer: NpmCertificate = { ...WILDCARD, id: 8, nice_name: 'Newer wildcard', expires_on: '2100-01-01 00:00:00' };
  const now = new Date('2026-09-29T00:00:00Z');

  const empty = planNpmSync(routes, ctx, [], [WILDCARD, newer], now);
  const create = empty.routes[0];
  assert.equal(create.action, 'create');
  assert.deepEqual(create.action === 'create' && create.desired.certificate, { kind: 'existing', id: 8, name: 'Newer wildcard' });

  // A host already applied on certificate #3, which still qualifies.
  const client = new FakeNpmClient({ certificates: [WILDCARD] });
  await setup(inventory, client).sync();
  const again = planNpmSync(routes, ctx, await client.listProxyHosts(), [WILDCARD, newer], now);
  assert.equal(again.routes[0].action, 'unchanged');
});

// --- registration metadata -------------------------------------------------------------

test('nginxProxyManagerDriver metadata matches the contract', () => {
  assert.equal(nginxProxyManagerDriver.id, 'nginx-proxy-manager');
  assert.equal(nginxProxyManagerDriver.label, 'Nginx Proxy Manager');
  assert.deepEqual(nginxProxyManagerDriver.capabilities, { authModes: ['forward', 'oidc'], acmeDns01ViaCloudflare: false });
  assert.equal(nginxProxyManagerDriver.defaultConfigPath, null);
  assert.equal(nginxProxyManagerDriver.statusPage, null);
  assert.equal(nginxProxyManagerDriver.usesSharedCertificate, undefined);
  assert.equal(nginxProxyManagerDriver.configPathNote, undefined);
});

// --- Fix round 1 -------------------------------------------------------------

test("NPM: a conflicting route keeps its own live Bellhop host -- no delete, no writes to either host, then the conflict error", async () => {
  const client = new FakeNpmClient({ certificates: [WILDCARD] });
  // Live, owned host #1 for app.example.com.
  await setup(inv([{ name: 'app', ip: '192.0.2.10', port: 8080, subdomains: ['app'] }]), client).sync();
  // A hand-made host claims the alias the route is about to add.
  client.seedHost(npmHost({ id: 9, domain_names: ['www.example.com'], advanced_config: '# my own config' }));
  client.clearCalls();

  const { plan, driver, deps } = setup(inv([TWO_ROUTES[0]]), client);
  const result = await plan();
  assert.match(result.preview, /^ {2}! conflict www\.example\.com: already claimed by proxy host #9 \(not created by Bellhop\)/m);
  assert.doesNotMatch(result.preview, /^ {2}- delete/m);
  await assert.rejects(
    () => driver.apply(result, deps),
    new Error(
      '1 route(s) skipped because a proxy host not created by Bellhop already claims their hostnames: app.example.com (#9) -- delete or change those proxy hosts in Nginx Proxy Manager, or mark the entries proxyManual'
    )
  );
  assert.deepEqual(client.writes(), []);
  assert.ok(client.hosts.has(1));
  assert.ok(client.hosts.has(9));
});

test('planNpmSync: a mixed-case route hostname against an owned host holding the lower-cased names is "= ok" (idempotent)', async () => {
  const client = new FakeNpmClient({ certificates: [WILDCARD] });
  const inventory = inv([TWO_ROUTES[0]]);
  await setup(inventory, client).sync();
  assert.deepEqual(client.hosts.get(1)!.domain_names, ['app.example.com', 'www.example.com']);

  const [route] = buildRoutes(inventory);
  const mixed = { ...route, hostnames: ['App.Example.com', 'WWW.example.com'] };
  const plan = planNpmSync([mixed], buildProxyContext(inventory), await client.listProxyHosts(), [WILDCARD]);
  assert.deepEqual(plan.routes.map((r) => r.action), ['unchanged']);
  assert.deepEqual(plan.deletes, []);

  // And a new mixed-case route is created with lower-cased names.
  const fresh = planNpmSync([mixed], buildProxyContext(inventory), [], [WILDCARD]);
  const create = fresh.routes[0];
  assert.deepEqual(create.action === 'create' && create.desired.domain_names, ['app.example.com', 'www.example.com']);
});
