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
  certificateCovers,
  chooseCertificate,
  createNpmDriver,
  isOwned,
  nginxProxyManagerDriver,
  planNpmSync,
} from '../../../../src/lib/proxy/drivers/nginx-proxy-manager.ts';
import { render as renderNginx } from '../../../../src/lib/proxy/drivers/nginx.ts';
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
  const ctx = buildProxyContext(inventory, nginxProxyManagerDriver);
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
  const ctx = buildProxyContext(inventory, nginxProxyManagerDriver);
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
  assert.deepEqual(nginxProxyManagerDriver.capabilities.authModes, ['forward', 'oidc']);
  assert.equal(nginxProxyManagerDriver.defaultConfigPath, null);
  assert.equal(nginxProxyManagerDriver.statusPage, null);
  assert.deepEqual(nginxProxyManagerDriver.capabilities.tlsSources, ['acme-http']);
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
  assert.ok(
    result.preview
      .split('\n')
      .includes(
        "  ! conflict www.example.com: already claimed by proxy host #9 (not created by Bellhop), entry 'app' -- delete or change it in Nginx Proxy Manager, or mark the entry proxyManual"
      ),
    result.preview
  );
  assert.doesNotMatch(result.preview, /^ {2}- delete/m);
  await assert.rejects(
    () => driver.apply(result, deps),
    new Error(
      "1 route(s) skipped because a proxy host not created by Bellhop already claims their hostnames: app.example.com (entry 'app', #9) -- delete or change those proxy hosts in Nginx Proxy Manager, or mark the entries proxyManual"
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
  const plan = planNpmSync([mixed], buildProxyContext(inventory, nginxProxyManagerDriver), await client.listProxyHosts(), [WILDCARD]);
  assert.deepEqual(plan.routes.map((r) => r.action), ['unchanged']);
  assert.deepEqual(plan.deletes, []);

  // And a new mixed-case route is created with lower-cased names.
  const fresh = planNpmSync([mixed], buildProxyContext(inventory, nginxProxyManagerDriver), [], [WILDCARD]);
  const create = fresh.routes[0];
  assert.deepEqual(create.action === 'create' && create.desired.domain_names, ['app.example.com', 'www.example.com']);
});

// =============================================================================
// User Story 2 (T014): never touch a proxy host Bellhop did not create
// =============================================================================

const CONFLICT_HINT =
  'delete or change it in Nginx Proxy Manager, or mark the entry proxyManual';

test('US2: an unmarked host for an unrelated hostname is never updated or deleted, across a create, a drift update and a delete', async () => {
  const handmade = npmHost({ id: 9, domain_names: ['handmade.example.com'], forward_port: 1234, advanced_config: '# my own config' });
  const client = new FakeNpmClient({ certificates: [WILDCARD], hosts: [handmade] });

  // Create both routes, then drift one and drop the other.
  await setup(inv(TWO_ROUTES), client).sync();
  const result = await setup(inv([{ ...TWO_ROUTES[0], port: 8081 }]), client).sync();

  assert.match(result.preview, /^ {2}~ update {2}app\.example\.com/m);
  assert.match(result.preview, /^ {2}- delete {2}wiki\.example\.com/m);
  assert.doesNotMatch(result.preview, /handmade|#9/);
  assert.ok(client.writes().every((w) => w.id !== 9), 'no write ever names host #9');
  assert.deepEqual(client.hosts.get(9), handmade);
});

test("US2: an unmarked host claiming a route's non-canonical hostname -> \"! conflict\" naming it and #id; apply creates the other route, never writes that host, then throws", async () => {
  const handmade = npmHost({ id: 9, domain_names: ['www.example.com'], advanced_config: '# my own config' });
  const client = new FakeNpmClient({ certificates: [WILDCARD], hosts: [handmade] });
  const { plan, driver, deps } = setup(inv(TWO_ROUTES), client);

  const result = await plan();
  assert.equal(
    result.preview,
    [
      'Nginx Proxy Manager at http://192.0.2.30:81',
      `  ! conflict www.example.com: already claimed by proxy host #9 (not created by Bellhop), entry 'app' -- ${CONFLICT_HINT}`,
      '  + create  wiki.example.com -> http://192.0.2.11:3000  [certificate: #3 Wildcard example.com]',
      '1 change(s), 1 conflict(s)',
    ].join('\n')
  );

  await assert.rejects(
    () => driver.apply(result, deps),
    new Error(
      "1 route(s) skipped because a proxy host not created by Bellhop already claims their hostnames: app.example.com (entry 'app', #9) -- delete or change those proxy hosts in Nginx Proxy Manager, or mark the entries proxyManual"
    )
  );
  // The non-conflicting route was still applied, before the throw.
  assert.deepEqual(client.writes().map((w) => w.method), ['createProxyHost']);
  assert.deepEqual(client.writes()[0].body!.domain_names, ['wiki.example.com']);
  assert.deepEqual(client.hosts.get(9), handmade);
});

test('US2: several conflicts are all named in the final error, with every claiming host id', async () => {
  const client = new FakeNpmClient({
    certificates: [WILDCARD],
    hosts: [
      npmHost({ id: 9, domain_names: ['app.example.com'] }),
      npmHost({ id: 10, domain_names: ['www.example.com'] }),
      npmHost({ id: 11, domain_names: ['wiki.example.com'] }),
    ],
  });
  const { plan, driver, deps } = setup(inv(TWO_ROUTES), client);
  const result = await plan();
  assert.match(result.preview, /^ {2}! conflict app\.example\.com, www\.example\.com: already claimed by proxy host #9, #10 \(not created by Bellhop\), entry 'app' -- /m);
  assert.match(result.preview, /^ {2}! conflict wiki\.example\.com: already claimed by proxy host #11 \(not created by Bellhop\), entry 'wiki' -- /m);
  assert.match(result.preview, /^0 change\(s\), 2 conflict\(s\)$/m);
  await assert.rejects(
    () => driver.apply(result, deps),
    /^Error: 2 route\(s\) skipped because a proxy host not created by Bellhop already claims their hostnames: app\.example\.com \(entry 'app', #9, #10\), wiki\.example\.com \(entry 'wiki', #11\) -- /
  );
  assert.deepEqual(client.writes(), []);
});

test('US2: an owned host whose marker line was removed is treated as unmarked -- a conflict for its route, and never deleted', async () => {
  const client = new FakeNpmClient({ certificates: [WILDCARD] });
  await setup(inv([TWO_ROUTES[1]]), client).sync();
  // The operator deletes the marker line: the host is theirs now.
  const host = client.hosts.get(1)!;
  host.advanced_config = host.advanced_config.split('\n').slice(1).join('\n');
  assert.equal(isOwned(host), false);
  const released = structuredClone(host);
  client.clearCalls();

  // Its route still exists -> conflict, not an update.
  const same = setup(inv([TWO_ROUTES[1]]), client);
  const result = await same.plan();
  assert.match(result.preview, /^ {2}! conflict wiki\.example\.com: already claimed by proxy host #1 \(not created by Bellhop\), entry 'wiki' -- /m);
  await assert.rejects(() => same.driver.apply(result, same.deps), /1 route\(s\) skipped/);

  // No route for it at all -> left alone, not a delete.
  const none = await setup(inv([]), client).sync();
  assert.equal(none.preview, ['Nginx Proxy Manager at http://192.0.2.30:81', 'No changes'].join('\n'));
  assert.deepEqual(client.writes(), []);
  assert.deepEqual(client.hosts.get(1), released);
});

test('US2: the marker only counts as the first line of advanced_config', () => {
  const later = npmHost({ id: 1, domain_names: ['app.example.com'], advanced_config: `# mine\n${NPM_OWNERSHIP_MARKER}` });
  const indented = npmHost({ id: 2, domain_names: ['app.example.com'], advanced_config: ` ${NPM_OWNERSHIP_MARKER}` });
  const first = npmHost({ id: 3, domain_names: ['app.example.com'], advanced_config: `${NPM_OWNERSHIP_MARKER}\r\n    client_max_body_size 0;` });
  assert.equal(isOwned(later), false);
  assert.equal(isOwned(indented), false);
  assert.equal(isOwned(first), true);
});

test("US2: matching is case-insensitive -- an unmarked \"WWW.Example.COM\" conflicts, and an owned \"APP.EXAMPLE.COM\" host is the route's own", async () => {
  const conflicted = new FakeNpmClient({ certificates: [WILDCARD], hosts: [npmHost({ id: 9, domain_names: ['WWW.Example.COM'] })] });
  const conflict = await setup(inv([TWO_ROUTES[0]]), conflicted).plan();
  assert.match(conflict.preview, /^ {2}! conflict www\.example\.com: already claimed by proxy host #9 \(not created by Bellhop\), entry 'app' -- /m);

  const client = new FakeNpmClient({ certificates: [WILDCARD] });
  await setup(inv([TWO_ROUTES[0]]), client).sync();
  client.hosts.get(1)!.domain_names = ['APP.EXAMPLE.COM', 'WWW.EXAMPLE.COM'];
  const result = await setup(inv([TWO_ROUTES[0]]), client).plan();
  assert.equal(result.preview, ['Nginx Proxy Manager at http://192.0.2.30:81', '  = ok      app.example.com (#1)', 'No changes'].join('\n'));
});

// =============================================================================
// Carried-over fix M1: update order when an alias moves between two owned hosts
// =============================================================================

test('M1: an alias moving from owned host A to owned host B -> the update releasing it runs (and is previewed) before the one claiming it', async () => {
  const client = new FakeNpmClient({ certificates: [WILDCARD] });
  await setup(
    inv([
      { name: 'a', ip: '192.0.2.10', port: 80, subdomains: ['a', 'b'] },
      { name: 'c', ip: '192.0.2.11', port: 80, subdomains: ['c'] },
    ]),
    client
  ).sync();
  assert.deepEqual(client.hosts.get(1)!.domain_names, ['a.example.com', 'b.example.com']);
  assert.deepEqual(client.hosts.get(2)!.domain_names, ['c.example.com']);
  client.clearCalls();

  // Route order puts the claimant (c, now [c, b]) first.
  const { plan, driver, deps } = setup(
    inv([
      { name: 'c', ip: '192.0.2.11', port: 80, subdomains: ['c', 'b'] },
      { name: 'a', ip: '192.0.2.10', port: 80, subdomains: ['a'] },
    ]),
    client
  );
  const result = await plan();
  assert.equal(
    result.preview,
    [
      'Nginx Proxy Manager at http://192.0.2.30:81',
      '  ~ update  a.example.com (#1): domain_names',
      '  ~ update  c.example.com (#2): domain_names',
      '2 change(s), 0 conflict(s)',
    ].join('\n')
  );
  await driver.apply(result, deps);
  assert.deepEqual(
    client.writes().map((w) => [w.method, w.id]),
    [
      ['updateProxyHost', 1],
      ['updateProxyHost', 2],
    ]
  );
  assert.deepEqual(client.hosts.get(1)!.domain_names, ['a.example.com']);
  assert.deepEqual(client.hosts.get(2)!.domain_names, ['c.example.com', 'b.example.com']);
});

test('M1: a three-host chain (A releases a name B claims, B releases a name C claims) is written and previewed A, B, C for every route order', async () => {
  const before: GuestSpec[] = [
    { name: 'a', ip: '192.0.2.10', port: 80, subdomains: ['a', 'b'] },
    { name: 'c', ip: '192.0.2.11', port: 80, subdomains: ['c', 'd'] },
    { name: 'e', ip: '192.0.2.12', port: 80, subdomains: ['e'] },
  ];
  const after: GuestSpec[] = [
    { name: 'a', ip: '192.0.2.10', port: 80, subdomains: ['a'] },
    { name: 'c', ip: '192.0.2.11', port: 80, subdomains: ['c', 'b'] },
    { name: 'e', ip: '192.0.2.12', port: 80, subdomains: ['e', 'd'] },
  ];
  const orders = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ];
  for (const order of orders) {
    const client = new FakeNpmClient({ certificates: [WILDCARD] });
    await setup(inv(before), client).sync();
    client.clearCalls();

    const { plan, driver, deps } = setup(inv(order.map((i) => after[i])), client);
    const result = await plan();
    assert.equal(
      result.preview,
      [
        'Nginx Proxy Manager at http://192.0.2.30:81',
        '  ~ update  a.example.com (#1): domain_names',
        '  ~ update  c.example.com (#2): domain_names',
        '  ~ update  e.example.com (#3): domain_names',
        '3 change(s), 0 conflict(s)',
      ].join('\n'),
      `route order ${order.join(',')}`
    );
    await driver.apply(result, deps);
    assert.deepEqual(client.writes().map((w) => w.id), [1, 2, 3], `route order ${order.join(',')}`);
    assert.deepEqual(client.hosts.get(3)!.domain_names, ['e.example.com', 'd.example.com']);
  }
});

test('M1: updates with no name moving between them keep route order', () => {
  const inventory = inv(TWO_ROUTES);
  const routes = buildRoutes(inventory);
  const ctx = buildProxyContext(inventory, nginxProxyManagerDriver);
  const empty = planNpmSync(routes, ctx, [], [WILDCARD]);
  // Both hosts exist with a drifted port, ids in reverse of route order.
  const hosts = empty.routes.map((r, i) => {
    assert.equal(r.action, 'create');
    if (r.action !== 'create') throw new Error('unreachable');
    const { certificate: _certificate, ...body } = r.desired;
    return npmHost({ ...body, id: 20 - i, certificate_id: 3, forward_port: 1 });
  });
  const plan = planNpmSync(routes, ctx, hosts, [WILDCARD]);
  assert.deepEqual(
    plan.routes.map((r) => (r.action === 'update' ? r.hostId : r.action)),
    [20, 19]
  );
});

test("M1: a genuine cycle (two hosts swapping aliases) keeps route order in both preview and apply, and fails loudly on NPM's rejection", async () => {
  const client = new FakeNpmClient({ certificates: [WILDCARD] });
  await setup(
    inv([
      { name: 'a', ip: '192.0.2.10', port: 80, subdomains: ['a', 'b'] },
      { name: 'c', ip: '192.0.2.11', port: 80, subdomains: ['c', 'd'] },
    ]),
    client
  ).sync();
  client.clearCalls();

  const { plan, driver, deps } = setup(
    inv([
      { name: 'a', ip: '192.0.2.10', port: 80, subdomains: ['a', 'd'] },
      { name: 'c', ip: '192.0.2.11', port: 80, subdomains: ['c', 'b'] },
    ]),
    client
  );
  const result = await plan();
  assert.match(result.preview, /~ update {2}a\.example\.com \(#1\)[^\n]*\n {2}~ update {2}c\.example\.com \(#2\)/);
  await assert.rejects(() => driver.apply(result, deps), /d\.example\.com is already in use/);
  assert.deepEqual(client.writes().map((w) => w.id), [1]);
});

// =============================================================================
// User Story 3 (T016): Authentik forward-auth in advanced_config
// =============================================================================

const ORIGINAL_OUTPOST_PORT = process.env.AUTHENTIK_OUTPOST_PORT;

// buildProxyContext reads the outpost port from AUTHENTIK_OUTPOST_PORT;
// pinned (and restored) so the developer's own shell can't change the output.
async function withPinnedOutpostPort(fn: () => Promise<void>): Promise<void> {
  process.env.AUTHENTIK_OUTPOST_PORT = '9000';
  try {
    await fn();
  } finally {
    if (ORIGINAL_OUTPOST_PORT === undefined) delete process.env.AUTHENTIK_OUTPOST_PORT;
    else process.env.AUTHENTIK_OUTPOST_PORT = ORIGINAL_OUTPOST_PORT;
  }
}

// An authentik:true entry at 192.0.2.20 (so ctx.outpost is 192.0.2.20:9000)
// plus one forward-gated guest 'app' at 192.0.2.30:8080.
function gatedInv(appOverrides: Record<string, unknown> = {}): Inventory {
  return {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: '192.0.2.1', ssh_user: 'root', proxy: true }],
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
        ...appOverrides,
      },
    ],
  };
}

async function advancedConfigFor(inventory: Inventory): Promise<string> {
  const client = new FakeNpmClient({ certificates: [WILDCARD] });
  await setup(inventory, client).sync();
  const [create] = client.calls.filter((c) => c.method === 'createProxyHost');
  return create.body!.advanced_config;
}

// The body of the location opened by `head`, up to its closing `    }`.
function locationBody(config: string, head: string): string {
  const lines = config.split('\n');
  const start = lines.indexOf(`    ${head} {`);
  assert.ok(start >= 0, `no "${head}" location`);
  const end = lines.indexOf('    }', start);
  return lines.slice(start + 1, end).join('\n');
}

test('US3: a forward-gated route with /api/* and /health exempt carries the whole Authentik recipe, all on $http_host', async () => {
  await withPinnedOutpostPort(async () => {
    const config = await advancedConfigFor(gatedInv({ unauthenticatedPaths: ['/api/*', '/health'] }));
    assert.equal(config.split('\n')[0], NPM_OWNERSHIP_MARKER);

    const root = locationBody(config, 'location /');
    assert.match(root, /^ {8}auth_request \/outpost\.goauthentik\.io\/auth\/nginx;$/m);
    assert.match(root, /^ {8}error_page 401 = @goauthentik_proxy_signin;$/m);
    for (const header of ['username', 'groups', 'email', 'name', 'uid']) {
      assert.match(root, new RegExp(`^ {8}proxy_set_header X-authentik-${header} \\$bellhop_authentik_${header};$`, 'm'));
    }

    // One unchecked location per exempt path.
    for (const head of ['location ^~ "/api/"', 'location = "/health"']) {
      const body = locationBody(config, head);
      assert.match(body, /proxy_pass http:\/\/192\.0\.2\.30:8080;/);
      assert.doesNotMatch(body, /auth_request/);
    }

    // The outpost passthrough targets ctx.outpost, and the sign-in redirect.
    const outpost = locationBody(config, 'location /outpost.goauthentik.io');
    assert.match(outpost, /^ {8}proxy_pass http:\/\/192\.0\.2\.20:9000\/outpost\.goauthentik\.io;$/m);
    assert.match(outpost, /proxy_set_header X-Original-URL \$scheme:\/\/\$http_host\$request_uri;/);
    const signin = locationBody(config, 'location @goauthentik_proxy_signin');
    assert.match(signin, /return 302 \/outpost\.goauthentik\.io\/start\?rd=\$scheme:\/\/\$http_host\$request_uri;/);

    assert.match(config, /proxy_set_header Host \$http_host;/);
    assert.doesNotMatch(config, /\$bellhop_http_host|\$bellhop_connection_upgrade|\$host\b/);
  });
});

test("US3: advanced_config is the nginx driver's own server body with only the two variables swapped (one renderer, FR-016)", async () => {
  await withPinnedOutpostPort(async () => {
    const inventory = gatedInv({ unauthenticatedPaths: ['/api/*', '/health'] });
    const nginxFile = renderNginx(buildRoutes(inventory), buildProxyContext(inventory, nginxProxyManagerDriver), '/etc/nginx/conf.d/bellhop.conf')[0].content;
    const lines = nginxFile.split('\n');
    // The nginx driver separates its TLS lines from the body with one blank line.
    const tlsEnd = lines.findIndex((l) => l.startsWith('    ssl_certificate_key '));
    assert.equal(lines[tlsEnd + 1], '');
    const start = tlsEnd + 2;
    const end = lines.lastIndexOf('}');
    const nginxBody = lines
      .slice(start, end)
      .join('\n')
      .replaceAll('$bellhop_http_host', '$http_host')
      .replaceAll('$bellhop_connection_upgrade', '$http_connection');

    const config = await advancedConfigFor(inventory);
    assert.equal(config, `${NPM_OWNERSHIP_MARKER}\n${nginxBody}`);
  });
});

test('US3: a /* exemption leaves no auth_request line at all, but keeps the outpost and sign-in locations', async () => {
  await withPinnedOutpostPort(async () => {
    const config = await advancedConfigFor(gatedInv({ unauthenticatedPaths: ['/*'] }));
    assert.doesNotMatch(config, /^\s*auth_request\s/m);
    assert.doesNotMatch(config, /location \^~ "\/"/);
    assert.match(config, /^ {4}location \/outpost\.goauthentik\.io \{$/m);
    assert.match(config, /^ {4}location @goauthentik_proxy_signin \{$/m);
  });
});

test('US3: an exempt path inside /outpost.goauthentik.io/ is skipped, and location / keeps its check', async () => {
  await withPinnedOutpostPort(async () => {
    const config = await advancedConfigFor(
      gatedInv({ unauthenticatedPaths: ['/outpost.goauthentik.io/*', '/outpost.goauthentik.io/start', '/health'] })
    );
    assert.doesNotMatch(config, /location (=|\^~) "\/outpost/);
    assert.match(config, /^ {4}location = "\/health" \{$/m);
    assert.match(locationBody(config, 'location /'), /auth_request \/outpost\.goauthentik\.io\/auth\/nginx;/);
  });
});

test('US3: an OIDC-mode route and an ungated route carry no forward-auth configuration', async () => {
  await withPinnedOutpostPort(async () => {
    for (const overrides of [{ authMode: 'oidc', oidcRedirectUris: ['https://app.example.com/cb'] }, { authGroup: undefined }]) {
      const config = await advancedConfigFor(gatedInv(overrides));
      assert.doesNotMatch(config, /auth_request|goauthentik|X-authentik-|proxy_buffers/);
      assert.match(config, /^ {4}location \/ \{$/m);
    }
  });
});

test('US3: removing the gate is previewed and applied as an advanced_config update on the same host', async () => {
  await withPinnedOutpostPort(async () => {
    const client = new FakeNpmClient({ certificates: [WILDCARD] });
    await setup(gatedInv({ unauthenticatedPaths: ['/api/*'] }), client).sync();
    client.clearCalls();

    const { plan, driver, deps } = setup(gatedInv({ authGroup: undefined, unauthenticatedPaths: ['/api/*'] }), client);
    const result = await plan();
    assert.equal(
      result.preview,
      ['Nginx Proxy Manager at http://192.0.2.30:81', '  ~ update  app.example.com (#1): advanced_config', '1 change(s), 0 conflict(s)'].join('\n')
    );
    await driver.apply(result, deps);
    assert.doesNotMatch(client.hosts.get(1)!.advanced_config, /auth_request|goauthentik/);
  });
});

// =============================================================================
// User Story 4 (T018): certificates (research R8)
// =============================================================================

const NOW = new Date('2026-09-29T00:00:00Z');

function cert(id: number, domainNames: string[], expiresOn = '2099-01-01 00:00:00'): NpmCertificate {
  return { id, provider: 'letsencrypt', nice_name: `cert ${id}`, domain_names: domainNames, expires_on: expiresOn };
}

function chosenId(choice: ReturnType<typeof chooseCertificate>): number | 'request' {
  return choice.kind === 'existing' ? choice.id : 'request';
}

test('certificateCovers: an exact name, or a wildcard covering exactly one label', () => {
  assert.equal(certificateCovers(cert(1, ['app.example.com']), 'app.example.com'), true);
  assert.equal(certificateCovers(cert(1, ['app.example.com']), 'www.example.com'), false);
  const wildcard = cert(2, ['*.example.com']);
  assert.equal(certificateCovers(wildcard, 'app.example.com'), true);
  assert.equal(certificateCovers(wildcard, 'a.b.example.com'), false);
  assert.equal(certificateCovers(wildcard, 'example.com'), false);
  assert.equal(certificateCovers(wildcard, 'app.example.org'), false);
  assert.equal(certificateCovers(wildcard, 'appexample.com'), false);
});

test('certificateCovers: case-insensitive on both sides', () => {
  assert.equal(certificateCovers(cert(1, ['*.Example.COM']), 'APP.example.com'), true);
  assert.equal(certificateCovers(cert(1, ['App.Example.com']), 'app.EXAMPLE.com'), true);
});

test("chooseCertificate: a certificate covering only some of the route's hostnames is not used", () => {
  const names = ['app.example.com', 'www.example.com'];
  assert.deepEqual(chooseCertificate(names, [cert(1, ['app.example.com'])], undefined, NOW), { kind: 'request', domainNames: names });
  assert.deepEqual(chooseCertificate(names, [cert(1, ['app.example.com']), cert(2, ['app.example.com', '*.example.com'])], undefined, NOW), {
    kind: 'existing',
    id: 2,
    name: 'cert 2',
  });
});

test('chooseCertificate: an expired (UTC) or unparseable expires_on is never used', () => {
  const names = ['app.example.com'];
  const request = { kind: 'request', domainNames: names };
  assert.deepEqual(chooseCertificate(names, [cert(1, names, '2026-09-28 23:59:59')], undefined, NOW), request);
  assert.deepEqual(chooseCertificate(names, [cert(1, names, '2026-09-29 00:00:00')], undefined, NOW), request, 'expiring right now is expired');
  for (const bad of ['2099-01-01T00:00:00Z', '2099-01-01', '', 'never']) {
    assert.deepEqual(chooseCertificate(names, [cert(1, names, bad)], undefined, NOW), request, `expires_on ${JSON.stringify(bad)}`);
  }
  // Read as UTC: one second after NOW is still valid wherever this test runs.
  assert.equal(chosenId(chooseCertificate(names, [cert(1, names, '2026-09-29 00:00:01')], undefined, NOW)), 1);
});

test('chooseCertificate: the current certificate is kept while it qualifies; otherwise latest expires_on, then lowest id', () => {
  const names = ['app.example.com'];
  const certs = [cert(3, ['*.example.com'], '2099-01-01 00:00:00'), cert(8, names, '2100-01-01 00:00:00'), cert(5, names, '2100-01-01 00:00:00')];
  assert.equal(chosenId(chooseCertificate(names, certs, 3, NOW)), 3, 'current kept');
  assert.equal(chosenId(chooseCertificate(names, certs, undefined, NOW)), 5, 'latest expiry, lowest id');
  assert.equal(chosenId(chooseCertificate(names, certs, 0, NOW)), 5, 'no certificate yet');

  const currentExpired = [cert(3, names, '2020-01-01 00:00:00'), cert(4, names, '2099-01-01 00:00:00')];
  assert.equal(chosenId(chooseCertificate(names, currentExpired, 3, NOW)), 4, 'expired current replaced');
  const currentNarrow = [cert(3, ['app.example.com']), cert(4, ['*.example.com'])];
  assert.equal(chosenId(chooseCertificate(['app.example.com', 'www.example.com'], currentNarrow, 3, NOW)), 4, 'no-longer-covering current replaced');
});

test('planNpmSync takes "now": the same certificate list plans differently before and after its expiry', () => {
  const inventory = inv([TWO_ROUTES[1]]);
  const routes = buildRoutes(inventory);
  const ctx = buildProxyContext(inventory, nginxProxyManagerDriver);
  const short = cert(6, ['wiki.example.com'], '2027-01-01 00:00:00');
  const before = planNpmSync(routes, ctx, [], [short], new Date('2026-12-31T23:59:59Z')).routes[0];
  const after = planNpmSync(routes, ctx, [], [short], new Date('2027-01-01T00:00:01Z')).routes[0];
  assert.deepEqual(before.action === 'create' && before.desired.certificate, { kind: 'existing', id: 6, name: 'cert 6' });
  assert.deepEqual(after.action === 'create' && after.desired.certificate, { kind: 'request', domainNames: ['wiki.example.com'] });
});

test('US4: each route needing a certificate requests one right before its own create, and uses the returned id', async () => {
  const client = new FakeNpmClient();
  const { sync } = setup(inv(TWO_ROUTES), client);
  const result = await sync();
  assert.match(result.preview, /\+ create {2}wiki\.example\.com -> http:\/\/192\.0\.2\.11:3000 {2}\[certificate: request Let's Encrypt for wiki\.example\.com\]$/m);
  const writes = client.writes();
  assert.deepEqual(writes.map((w) => w.method), ['requestCertificate', 'createProxyHost', 'requestCertificate', 'createProxyHost']);
  assert.deepEqual(writes[0].domainNames, ['app.example.com', 'www.example.com']);
  assert.equal(writes[1].body!.certificate_id, 1);
  assert.deepEqual(writes[2].domainNames, ['wiki.example.com']);
  assert.equal(writes[3].body!.certificate_id, 2);
});

test('US4: an owned host whose certificate expired -> "~ update ... certificate_id  [certificate: request ...]", requested right before the update', async () => {
  const client = new FakeNpmClient({ certificates: [{ ...WILDCARD }] });
  await setup(inv([TWO_ROUTES[0]]), client).sync();
  client.certificates[0].expires_on = '2020-01-01 00:00:00';
  client.clearCalls();

  const { plan, driver, deps } = setup(inv([TWO_ROUTES[0]]), client);
  const result = await plan();
  assert.equal(
    result.preview,
    [
      'Nginx Proxy Manager at http://192.0.2.30:81',
      "  ~ update  app.example.com (#1): certificate_id  [certificate: request Let's Encrypt for app.example.com, www.example.com]",
      '1 change(s), 0 conflict(s)',
    ].join('\n')
  );
  await driver.apply(result, deps);
  const writes = client.writes();
  assert.deepEqual(
    writes.map((w) => [w.method, w.id]),
    [
      ['requestCertificate', undefined],
      ['updateProxyHost', 1],
    ]
  );
  assert.equal(writes[1].body!.certificate_id, 4);
  assert.equal(client.hosts.get(1)!.certificate_id, 4);
});

test("US4: a failed certificate request throws naming the route with NPM's own error, and leaves no proxy host for it", async () => {
  const client = new FakeNpmClient();
  client.certificateFailure = 'Some challenges have failed.';
  const { sync } = setup(inv([TWO_ROUTES[0]]), client);
  await assert.rejects(
    sync,
    new Error(
      "Could not get a Let's Encrypt certificate for app.example.com: Nginx Proxy Manager API 500 POST /api/nginx/certificates: Internal Error -- Some challenges have failed."
    )
  );
  assert.equal(client.calls.filter((c) => c.method === 'createProxyHost').length, 0);
  assert.equal(client.hosts.size, 0);
});

test('US4: a failed certificate request for an update leaves the existing host exactly as it was', async () => {
  const client = new FakeNpmClient({ certificates: [{ ...WILDCARD }] });
  await setup(inv([TWO_ROUTES[0]]), client).sync();
  const before = structuredClone(client.hosts.get(1));
  client.certificates[0].expires_on = '2020-01-01 00:00:00';
  client.certificateFailure = 'Some challenges have failed.';
  client.clearCalls();

  await assert.rejects(setup(inv([TWO_ROUTES[0]]), client).sync(), /^Error: Could not get a Let's Encrypt certificate for app\.example\.com: /);
  assert.equal(client.calls.filter((c) => c.method === 'updateProxyHost').length, 0);
  assert.deepEqual(client.hosts.get(1), before);
});

// =============================================================================
// User Story 5 (T020): snapshot() -- contract format, never any PEM
// =============================================================================

test('NPM snapshot: header + owned hosts only, sorted by id, certificate labels ("none" / "#id name" / bare "#id"), forward-auth and online detection, advanced_config indented with blank lines preserved', async () => {
  // Deliberately out of id order, and an unowned host interleaved, to prove
  // both the ownership filter (contract: "N proxy host(s) managed by
  // Bellhop") and the id sort in one pass.
  const unowned = npmHost({ id: 9, domain_names: ['handmade.example.com'], advanced_config: '# my own config' });
  const gated = npmHost({
    id: 12,
    domain_names: ['media.example.com'],
    forward_host: '192.0.2.12',
    forward_port: 8096,
    certificate_id: 3,
    advanced_config: [
      NPM_OWNERSHIP_MARKER,
      '    client_max_body_size 0;',
      '',
      '    location / {',
      '        auth_request /outpost.goauthentik.io/auth/nginx;',
      '    }',
    ].join('\n'),
  });
  const noCert = npmHost({
    id: 5,
    domain_names: ['plain.example.com'],
    forward_host: '192.0.2.5',
    forward_port: 80,
    certificate_id: 0,
    advanced_config: [NPM_OWNERSHIP_MARKER, '    location / {', '        proxy_pass http://192.0.2.5:80;', '    }'].join('\n'),
  });
  // certificate_id 99 names no certificate in the list at all (e.g. one
  // deleted out from under a proxy host) -- the bare "#99" form, no name.
  const orphanCert = npmHost({
    id: 14,
    domain_names: ['wiki.example.com'],
    forward_host: '192.0.2.14',
    forward_port: 3000,
    certificate_id: 99,
    advanced_config: [NPM_OWNERSHIP_MARKER, '    location / {', '        proxy_pass http://192.0.2.14:3000;', '    }'].join('\n'),
    meta: { nginx_online: false, nginx_err: 'boom' },
  });

  const client = new FakeNpmClient({ certificates: [WILDCARD], hosts: [orphanCert, unowned, gated, noCert] });
  const driver = createNpmDriver({ clientFor: () => client });
  const deps: DriverDeps = { ssh: new FakeSSHClient(defaultResponder), inventory: inv([]), proxyHost: 'pve1', configPath: null };

  const result = await driver.snapshot(deps);
  const header = 'Nginx Proxy Manager at http://192.0.2.30:81 -- 3 proxy host(s) managed by Bellhop';
  // indent() shifts the *whole* stored advanced_config (marker at column 0,
  // its body already indented 4 spaces by renderServerBody in the real
  // driver) another 4 spaces uniformly -- so the marker lands at column 4
  // and a body line originally at column 4 lands at column 8, per the
  // contract's "<advanced_config, indented 4 spaces>".
  const block5 = [
    '#5 plain.example.com -> http://192.0.2.5:80',
    '    certificate: none   forward-auth: no   online: yes',
    `    ${NPM_OWNERSHIP_MARKER}`,
    '        location / {',
    '            proxy_pass http://192.0.2.5:80;',
    '        }',
  ].join('\n');
  const block12 = [
    '#12 media.example.com -> http://192.0.2.12:8096',
    '    certificate: #3 Wildcard example.com   forward-auth: yes   online: yes',
    `    ${NPM_OWNERSHIP_MARKER}`,
    '        client_max_body_size 0;',
    '',
    '        location / {',
    '            auth_request /outpost.goauthentik.io/auth/nginx;',
    '        }',
  ].join('\n');
  const block14 = [
    '#14 wiki.example.com -> http://192.0.2.14:3000',
    '    certificate: #99   forward-auth: no   online: no',
    `    ${NPM_OWNERSHIP_MARKER}`,
    '        location / {',
    '            proxy_pass http://192.0.2.14:3000;',
    '        }',
  ].join('\n');
  assert.equal(result, [header, block5, block12, block14].join('\n\n'));

  // Belt-and-suspenders: the fake's NpmCertificate type has no `meta` field
  // to smuggle a PEM/private key through in the first place -- npm-client.ts's
  // schema drops it entirely (test/lib/npm-client.test.ts's "drops meta
  // entirely (never surfaces the private key)" case is what actually pins
  // that guarantee at the parse boundary). This just confirms
  // formatNpmSnapshot itself only ever reads a certificate's id/nice_name and
  // a host's own listed fields -- never a wholesale dump of either object --
  // by checking the exact string above never contains anything PEM-shaped.
  assert.doesNotMatch(result, /BEGIN CERTIFICATE|PRIVATE KEY/);
});

test('NPM snapshot: no owned hosts at all -> just the header, "0 proxy host(s)"', async () => {
  const client = new FakeNpmClient({
    certificates: [WILDCARD],
    hosts: [npmHost({ id: 9, domain_names: ['handmade.example.com'], advanced_config: '# my own config' })],
  });
  const driver = createNpmDriver({ clientFor: () => client });
  const deps: DriverDeps = { ssh: new FakeSSHClient(defaultResponder), inventory: inv([]), proxyHost: 'pve1', configPath: null };
  const result = await driver.snapshot(deps);
  assert.equal(result, 'Nginx Proxy Manager at http://192.0.2.30:81 -- 0 proxy host(s) managed by Bellhop');
});

// =============================================================================
// Final review F1: an owned host nginx left offline is rewritten
// =============================================================================

test('F1: an owned host matching every desired field but offline -> "~ update ... : nginx_online", applied, read back online', async () => {
  const client = new FakeNpmClient({ certificates: [WILDCARD] });
  await setup(inv([TWO_ROUTES[1]]), client).sync();
  const host = client.hosts.get(1)!;
  host.meta = { nginx_online: false, nginx_err: 'nginx: [emerg] host not found in upstream' };
  client.clearCalls();

  const { plan, driver, deps } = setup(inv([TWO_ROUTES[1]]), client);
  const result = await plan();
  assert.equal(
    result.preview,
    [
      'Nginx Proxy Manager at http://192.0.2.30:81',
      '  ~ update  wiki.example.com (#1): nginx_online',
      '1 change(s), 0 conflict(s)',
    ].join('\n')
  );
  await driver.apply(result, deps);
  assert.deepEqual(client.writes().map((w) => [w.method, w.id]), [['updateProxyHost', 1]]);
  assert.equal(client.hosts.get(1)!.meta.nginx_online, true);
});

test('F1: the same host with nginx_online true or undefined stays "= ok"', async () => {
  for (const meta of [{ nginx_online: true, nginx_err: null }, {}]) {
    const client = new FakeNpmClient({ certificates: [WILDCARD] });
    await setup(inv([TWO_ROUTES[1]]), client).sync();
    client.hosts.get(1)!.meta = meta;
    const result = await setup(inv([TWO_ROUTES[1]]), client).plan();
    assert.equal(
      result.preview,
      ['Nginx Proxy Manager at http://192.0.2.30:81', '  = ok      wiki.example.com (#1)', 'No changes'].join('\n'),
      JSON.stringify(meta)
    );
  }
});

// =============================================================================
// Final review F2: redirection hosts and 404 hosts claim hostnames too
// =============================================================================

test('F2: a redirection host holding a route name -> conflict naming "redirection host #N"; never written; apply error says so', async () => {
  const client = new FakeNpmClient({
    certificates: [WILDCARD],
    redirectionHosts: [{ id: 1, domain_names: ['www.example.com'] }],
  });
  const { plan, driver, deps } = setup(inv(TWO_ROUTES), client);
  const result = await plan();
  assert.equal(
    result.preview,
    [
      'Nginx Proxy Manager at http://192.0.2.30:81',
      `  ! conflict www.example.com: already claimed by redirection host #1 (not created by Bellhop), entry 'app' -- ${CONFLICT_HINT}`,
      '  + create  wiki.example.com -> http://192.0.2.11:3000  [certificate: #3 Wildcard example.com]',
      '1 change(s), 1 conflict(s)',
    ].join('\n')
  );
  await assert.rejects(
    () => driver.apply(result, deps),
    new Error(
      "1 route(s) skipped because a host not created by Bellhop already claims their hostnames: app.example.com (entry 'app', redirection host #1) -- delete or change those hosts in Nginx Proxy Manager, or mark the entries proxyManual"
    )
  );
  assert.deepEqual(client.writes().map((w) => w.method), ['createProxyHost']);
  assert.deepEqual(client.redirectionHosts, [{ id: 1, domain_names: ['www.example.com'] }]);
});

test('F2: a 404 host holding a canonical name -> conflict naming "404 host #N", matched case-insensitively', async () => {
  const client = new FakeNpmClient({ certificates: [WILDCARD], deadHosts: [{ id: 4, domain_names: ['Wiki.Example.com'] }] });
  const result = await setup(inv([TWO_ROUTES[1]]), client).plan();
  assert.match(
    result.preview,
    /^ {2}! conflict wiki\.example\.com: already claimed by 404 host #4 \(not created by Bellhop\), entry 'wiki' -- /m
  );
});

test('F2: claimants of several kinds are grouped by kind, proxy hosts first; ids are per kind', async () => {
  const client = new FakeNpmClient({
    certificates: [WILDCARD],
    hosts: [npmHost({ id: 1, domain_names: ['app.example.com'] })],
    redirectionHosts: [{ id: 1, domain_names: ['www.example.com'] }],
    deadHosts: [{ id: 2, domain_names: ['www.example.com'] }],
  });
  const { plan, driver, deps } = setup(inv([TWO_ROUTES[0]]), client);
  const result = await plan();
  assert.match(
    result.preview,
    /^ {2}! conflict app\.example\.com, www\.example\.com: already claimed by proxy host #1, redirection host #1, 404 host #2 \(not created by Bellhop\), entry 'app' -- /m
  );
  await assert.rejects(
    () => driver.apply(result, deps),
    new Error(
      "1 route(s) skipped because a host not created by Bellhop already claims their hostnames: app.example.com (entry 'app', proxy host #1, redirection host #1, 404 host #2) -- delete or change those hosts in Nginx Proxy Manager, or mark the entries proxyManual"
    )
  );
  assert.deepEqual(client.writes(), []);
});

test('F2: planNpmSync takes redirection and 404 hosts as an optional last argument', () => {
  const inventory = inv([TWO_ROUTES[1]]);
  const routes = buildRoutes(inventory);
  const ctx = buildProxyContext(inventory, nginxProxyManagerDriver);
  const plan = planNpmSync(routes, ctx, [], [WILDCARD], NOW, { redirectionHosts: [], deadHosts: [{ id: 7, domain_names: ['wiki.example.com'] }] });
  assert.deepEqual(plan.routes[0].action === 'conflict' && plan.routes[0].claimants, [{ kind: 'dead', id: 7 }]);
});

// =============================================================================
// Final review F4: a certificate with no expiry is never selected
// =============================================================================

test('F4: chooseCertificate never selects a certificate whose expires_on is null', () => {
  const names = ['app.example.com'];
  const noExpiry: NpmCertificate = { ...cert(1, names), expires_on: null };
  assert.deepEqual(chooseCertificate(names, [noExpiry], 1, NOW), { kind: 'request', domainNames: names });
  assert.equal(chosenId(chooseCertificate(names, [noExpiry, cert(2, names)], 1, NOW)), 2);
});

// -- The read-only check (issue #87) ----------------------------------------

import { RealNpmClient } from '../../../../src/lib/npm-client.ts';

const NPM_PASSWORD = 'correct-horse-battery';

// A fetch standing in for NPM: records every request and answers by path.
function fakeNpmFetch(answer: (method: string, path: string) => { status: number; body: unknown } | Error) {
  const requests: string[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const method = init?.method ?? 'GET';
    requests.push(`${method} ${path}`);
    const reply = answer(method, path);
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { requests, impl };
}

function npmCheckDriver(fetchImpl: typeof fetch) {
  return createNpmDriver({ clientFor: () => new RealNpmClient('http://192.0.2.30:81', 'admin@example.com', NPM_PASSWORD, fetchImpl) });
}

const deps = (): DriverDeps => ({ ssh: new FakeSSHClient(defaultResponder), inventory: inv([]), proxyHost: 'pve1', configPath: null });

test('check: signs in and lists proxy hosts, nothing else', async () => {
  const { requests, impl } = fakeNpmFetch((method, path) =>
    path === '/api/tokens' ? { status: 200, body: { token: 't0ken', expires: '2099-01-01T00:00:00.000Z' } } : { status: 200, body: [] }
  );
  const summary = await npmCheckDriver(impl).check!(deps());
  assert.deepEqual(requests, ['POST /api/tokens', 'GET /api/nginx/proxy-hosts']);
  assert.match(summary, /http:\/\/192\.0\.2\.30:81/);
});

test('check: a refused sign-in names the email and password settings and never the password', async () => {
  const { impl } = fakeNpmFetch(() => ({ status: 400, body: { error: { code: 400, message: 'Invalid email or password' } } }));
  await assert.rejects(
    () => npmCheckDriver(impl).check!(deps()),
    (err: Error) => {
      assert.match(err.message, /rejected the login for admin@example\.com/);
      assert.match(err.message, /npmApiEmail and npmApiPassword/);
      assert.ok(!err.message.includes(NPM_PASSWORD));
      return true;
    }
  );
});

test('check: an unreachable URL names the URL', async () => {
  const { impl } = fakeNpmFetch(() => new Error('connect ECONNREFUSED 192.0.2.30:81'));
  await assert.rejects(() => npmCheckDriver(impl).check!(deps()), /Could not reach Nginx Proxy Manager at http:\/\/192\.0\.2\.30:81/);
});

test('check: the registered driver reports an unconfigured client the usual way', async () => {
  await assert.rejects(() => nginxProxyManagerDriver.check!(deps()), /npmApiEmail|NPM_API/);
});
