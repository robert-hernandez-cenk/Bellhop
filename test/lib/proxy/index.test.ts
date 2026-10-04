import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Inventory } from '../../../src/lib/inventory.ts';
import type { ProxyPlan, ReverseProxyDriver } from '../../../src/lib/proxy/driver.ts';
import { NO_PROXY_SYNC_MESSAGE, NO_PROXY_STATUS_PAGE_ERROR, managesProxy } from '../../../src/lib/proxy/driver.ts';
import type { ProxyDriverId } from '../../../src/lib/proxy/ids.ts';
import { PROXY_DRIVER_IDS, getDriver, driverDeps, registerDriverForTests, DEFAULT_PROXY_DRIVER_ID, listDrivers } from '../../../src/lib/proxy/index.ts';
import { caddyDriver } from '../../../src/lib/proxy/drivers/caddy.ts';
import { caddyApiDriver } from '../../../src/lib/proxy/drivers/caddy-api.ts';
import { nginxDriver } from '../../../src/lib/proxy/drivers/nginx.ts';
import { noneDriver } from '../../../src/lib/proxy/drivers/none.ts';
import { nginxProxyManagerDriver } from '../../../src/lib/proxy/drivers/nginx-proxy-manager.ts';
import { haproxyDriver } from '../../../src/lib/proxy/drivers/haproxy.ts';
import { traefikDriver } from '../../../src/lib/proxy/drivers/traefik.ts';
import { fileDriver } from '../../../src/lib/proxy/file-driver.ts';
import { buildRoutes, buildProxyContext, type ProxyContext, type ProxyRoute } from '../../../src/lib/proxy/routes.ts';
import { runSyncProxy } from '../../../src/commands/networking/sync-proxy.ts';
import { runRenderStatusPage } from '../../../src/commands/networking/render-status-page.ts';
import { FakeSSHClient, defaultResponder } from '../../support/fake-ssh-client.ts';

function baseInventory(overrides: Partial<Inventory> = {}): Inventory {
  return {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: '192.0.2.1', ssh_user: 'root', proxy: true }],
    guests: [],
    ...overrides,
  };
}

// A minimal fake driver, same shape/convention as test/lib/proxy/driver.test.ts's
// own fakeDriver -- id is cast through ProxyDriverId since PROXY_DRIVER_IDS
// only lists the shipped ids (src/lib/proxy/ids.ts), and this test needs
// a second, test-only id to exercise the registry without touching the real
// driver list. `label`/`statusPage` are required by ReverseProxyDriver but
// unused by these tests.
function fakeDriver(id: string): ReverseProxyDriver {
  return {
    id: id as ProxyDriverId,
    label: 'Fake',
    capabilities: { authModes: ['forward', 'oidc'], acmeDns01ViaCloudflare: () => false },
    defaultConfigPath: '/etc/fake/fake.conf',
    statusPage: null,
    async plan(): Promise<ProxyPlan> {
      return { preview: '', payload: undefined };
    },
    async apply(): Promise<void> {},
    async snapshot(): Promise<string> {
      return '';
    },
  };
}

// --- getDriver ------------------------------------------------------------

test('getDriver returns caddyDriver when proxyDriver is unset', () => {
  const inv = baseInventory();
  assert.equal(getDriver(inv), caddyDriver);
});

test('getDriver returns caddyDriver when proxyDriver is explicitly "caddy"', () => {
  const inv = baseInventory({ proxyDriver: 'caddy' });
  assert.equal(getDriver(inv), caddyDriver);
});

test('getDriver throws a named error for an id no registered driver has, with the set-config fix', () => {
  // Only reachable if the database was edited by hand -- InventorySchema's
  // own zod enum would otherwise reject this value on load. Bypassed here
  // by casting past the ProxyDriverId type, the same way the contract
  // describes this error as only reachable that way.
  const inv = baseInventory({ proxyDriver: 'unknown-provider' as Inventory['proxyDriver'] });
  assert.throws(
    () => getDriver(inv),
    /^Error: Unknown proxyDriver 'unknown-provider' -- run: bellhop set-config proxyDriver caddy --apply$/
  );
});

test('getDriver returns nginxDriver when proxyDriver is "nginx" (issue #30)', () => {
  const inv = baseInventory({ proxyDriver: 'nginx' });
  assert.equal(getDriver(inv), nginxDriver);
});

test('getDriver returns noneDriver when proxyDriver is "none"', () => {
  const inv = baseInventory({ proxyDriver: 'none' });
  assert.equal(getDriver(inv), noneDriver);
});

// --- driver ids / registry metadata (issue #33) ----------------------------

test('PROXY_DRIVER_IDS equals [caddy, nginx, nginx-proxy-manager, haproxy, traefik, none, caddy-api]', () => {
  assert.deepEqual(PROXY_DRIVER_IDS, ['caddy', 'nginx', 'nginx-proxy-manager', 'haproxy', 'traefik', 'none', 'caddy-api']);
});

test('DEFAULT_PROXY_DRIVER_ID is caddy', () => {
  assert.equal(DEFAULT_PROXY_DRIVER_ID, 'caddy');
});

test('listDrivers returns Caddy, Caddy (admin API), nginx, Nginx Proxy Manager, HAProxy, Traefik, then None, in registration order', () => {
  assert.deepEqual(listDrivers(), [caddyDriver, caddyApiDriver, nginxDriver, nginxProxyManagerDriver, haproxyDriver, traefikDriver, noneDriver]);
});

test('getDriver returns traefikDriver when proxyDriver is "traefik" (issue #35)', () => {
  const inv = baseInventory({ proxyDriver: 'traefik' });
  assert.equal(getDriver(inv), traefikDriver);
  assert.equal(managesProxy(traefikDriver), true);
});

test('driverDeps resolves configPath to the Traefik driver default when proxyConfigPath is unset (issue #35)', () => {
  const inv = baseInventory({ proxyDriver: 'traefik' });
  const deps = driverDeps(inv, new FakeSSHClient(defaultResponder), traefikDriver);
  assert.equal(deps.configPath, '/etc/traefik/dynamic/bellhop.yml');
});

test('Traefik driver metadata: label, capabilities, default config path, status page, and cert-resolver/api-url hints', () => {
  assert.equal(traefikDriver.id, 'traefik');
  assert.equal(traefikDriver.label, 'Traefik');
  // acmeDns01ViaCloudflare is now a function (issue #51), so it's compared
  // by its return value for a sample inventory rather than by deepEqual on
  // the whole capabilities object (which would compare function identity).
  assert.deepEqual(traefikDriver.capabilities.authModes, ['forward', 'oidc']);
  assert.equal(traefikDriver.capabilities.acmeDns01ViaCloudflare(baseInventory()), true);
  assert.equal(traefikDriver.defaultConfigPath, '/etc/traefik/dynamic/bellhop.yml');
  assert.equal(traefikDriver.statusPage, null);
  assert.equal(traefikDriver.usesCertResolver, true);
  assert.equal(traefikDriver.usesApiUrl, true);
  assert.equal(traefikDriver.usesSharedCertificate, undefined);
});

test('getDriver returns haproxyDriver when proxyDriver is "haproxy" (issue #32)', () => {
  const inv = baseInventory({ proxyDriver: 'haproxy' });
  assert.equal(getDriver(inv), haproxyDriver);
  assert.equal(managesProxy(haproxyDriver), true);
});

test('driverDeps resolves configPath to the HAProxy driver default when proxyConfigPath is unset (issue #32)', () => {
  const inv = baseInventory({ proxyDriver: 'haproxy' });
  const deps = driverDeps(inv, new FakeSSHClient(defaultResponder), haproxyDriver);
  assert.equal(deps.configPath, '/etc/haproxy/bellhop.cfg');
});

test('getDriver returns nginxProxyManagerDriver when proxyDriver is "nginx-proxy-manager" (issue #31)', () => {
  const inv = baseInventory({ proxyDriver: 'nginx-proxy-manager' });
  assert.equal(getDriver(inv), nginxProxyManagerDriver);
  assert.equal(managesProxy(nginxProxyManagerDriver), true);
});

test('driverDeps returns configPath: null for the Nginx Proxy Manager driver, even when proxyConfigPath is set', () => {
  const inv = baseInventory({ proxyDriver: 'nginx-proxy-manager', proxyConfigPath: '/etc/nginx/conf.d/bellhop.conf' });
  const deps = driverDeps(inv, new FakeSSHClient(defaultResponder), nginxProxyManagerDriver);
  assert.equal(deps.configPath, null);
});

// issue #26: the admin-API driver writes no file either.
test('driverDeps returns configPath: null for the Caddy admin-API driver, even when proxyConfigPath is set', () => {
  const inv = baseInventory({ proxyDriver: 'caddy-api', proxyConfigPath: '/etc/caddy/Caddyfile' });
  assert.equal(getDriver(inv), caddyApiDriver);
  assert.equal(driverDeps(inv, new FakeSSHClient(defaultResponder), caddyApiDriver).configPath, null);
});

test('Caddy driver metadata: label, defaultConfigPath, statusPage', () => {
  assert.equal(caddyDriver.label, 'Caddy');
  assert.equal(caddyDriver.defaultConfigPath, '/etc/caddy/Caddyfile');
  assert.deepEqual(caddyDriver.statusPage, { suggestedPath: '/usr/share/caddy/index.html' });
});

// issue #30 x #33: nginx is a managed, file-configured driver with its own
// label and suggested status page, and the only one serving the shared
// proxyTlsCertificate/proxyTlsKey certificate.
test('nginx driver metadata: label, defaultConfigPath, statusPage, usesSharedCertificate, managesProxy', () => {
  assert.equal(nginxDriver.label, 'nginx');
  assert.equal(nginxDriver.defaultConfigPath, '/etc/nginx/conf.d/bellhop.conf');
  assert.deepEqual(nginxDriver.statusPage, { suggestedPath: '/var/www/html/index.html' });
  assert.equal(nginxDriver.usesSharedCertificate, true);
  assert.equal(managesProxy(nginxDriver), true);
  assert.match(nginxDriver.configPathNote ?? '', /replaces this whole file/);
  assert.equal(caddyDriver.usesSharedCertificate ?? false, false);
  assert.equal(noneDriver.usesSharedCertificate ?? false, false);
});

test('None driver metadata: label, defaultConfigPath, statusPage, capabilities', () => {
  assert.equal(noneDriver.id, 'none');
  assert.equal(noneDriver.label, 'No proxy');
  assert.equal(noneDriver.defaultConfigPath, null);
  assert.equal(noneDriver.statusPage, null);
  assert.deepEqual(noneDriver.capabilities.authModes, ['forward', 'oidc']);
  assert.equal(noneDriver.capabilities.acmeDns01ViaCloudflare(baseInventory()), false);
});

test('None driver: plan() previews the fixed message, apply() is a no-op with no SSH calls, snapshot() rejects with the named error', async () => {
  const ssh = new FakeSSHClient(defaultResponder);
  const deps = { ssh, inventory: baseInventory(), proxyHost: 'pve1', configPath: '/etc/caddy/Caddyfile' };
  const plan = await noneDriver.plan(
    [],
    {
      externalPort: 443,
      tls: { certificatePath: '/etc/ssl/example.pem', keyPath: '/etc/ssl/example.key' },
      certResolver: 'cloudflare',
      caddyTls: 'cloudflare',
    },
    deps
  );
  assert.equal(plan.preview, NO_PROXY_SYNC_MESSAGE);

  await noneDriver.apply(plan, deps);
  assert.equal(ssh.history.length, 0, 'apply() must make no SSH calls');

  await assert.rejects(() => noneDriver.snapshot(deps), new RegExp(`^Error: ${NO_PROXY_STATUS_PAGE_ERROR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
});

// --- driverDeps -------------------------------------------------------------

test("driverDeps resolves proxyHost from the entry flagged proxy: true, and configPath from the driver default when proxyConfigPath is unset", () => {
  const inv = baseInventory();
  const ssh = new FakeSSHClient(defaultResponder);
  const deps = driverDeps(inv, ssh, caddyDriver);
  assert.equal(deps.proxyHost, 'pve1');
  assert.equal(deps.configPath, caddyDriver.defaultConfigPath);
  assert.equal(deps.ssh, ssh);
  assert.equal(deps.inventory, inv);
});

test('driverDeps resolves proxyHost from a guest flagged proxy: true', () => {
  const inv = baseInventory({
    hosts: [{ name: 'pve1', ssh_target: '192.0.2.1', ssh_user: 'root' }],
    guests: [{ name: 'proxy-lxc', type: 'lxc', vmid: 100, host: 'pve1', ip: '192.0.2.50', proxy: true }],
  });
  const ssh = new FakeSSHClient(defaultResponder);
  const deps = driverDeps(inv, ssh, caddyDriver);
  assert.equal(deps.proxyHost, 'proxy-lxc');
});

test('driverDeps reads configPath from proxyConfigPath when set, overriding the driver default', () => {
  const inv = baseInventory({ proxyConfigPath: '/etc/caddy/custom.Caddyfile' });
  const ssh = new FakeSSHClient(defaultResponder);
  const deps = driverDeps(inv, ssh, caddyDriver);
  assert.equal(deps.configPath, '/etc/caddy/custom.Caddyfile');
});

test("driverDeps throws \"No inventory entry has 'proxy: true'\" when no entry has it", () => {
  const inv = baseInventory({
    hosts: [{ name: 'pve1', ssh_target: '192.0.2.1', ssh_user: 'root' }],
  });
  const ssh = new FakeSSHClient(defaultResponder);
  assert.throws(() => driverDeps(inv, ssh, caddyDriver), /^Error: No inventory entry has 'proxy: true'$/);
});

test('driverDeps resolves configPath to the nginx driver default when proxyConfigPath is unset (issue #30)', () => {
  const inv = baseInventory({ proxyDriver: 'nginx' });
  const ssh = new FakeSSHClient(defaultResponder);
  const deps = driverDeps(inv, ssh, nginxDriver);
  assert.equal(deps.configPath, '/etc/nginx/conf.d/bellhop.conf');
});

// issue #31 (T003): a driver with no config file at all (defaultConfigPath:
// null, e.g. the upcoming Nginx Proxy Manager driver) gets configPath: null
// from driverDeps -- even when proxyConfigPath is set, since a driver with
// no file has nowhere for that setting to point.
test('driverDeps returns configPath: null for a driver with defaultConfigPath: null, even when proxyConfigPath is set', () => {
  const noFileDriver = fakeDriver('fake-no-config-file-driver');
  noFileDriver.defaultConfigPath = null;
  const inv = baseInventory({ proxyConfigPath: '/etc/caddy/Caddyfile' });
  const ssh = new FakeSSHClient(defaultResponder);
  const deps = driverDeps(inv, ssh, noFileDriver);
  assert.equal(deps.configPath, null);
  assert.equal(deps.proxyHost, 'pve1');
});

// --- registerDriverForTests (test-only hook) -------------------------------

test('registerDriverForTests adds a driver under an extra id that getDriver can then resolve', () => {
  const fake = fakeDriver('fake-driver-for-index-test');
  const unregister = registerDriverForTests(fake);
  try {
    const inv = baseInventory({ proxyDriver: fake.id });
    assert.equal(getDriver(inv), fake);
  } finally {
    unregister();
  }
});

test('registerDriverForTests: the returned unregister function removes the driver again', () => {
  const fake = fakeDriver('fake-driver-for-index-test-2');
  const unregister = registerDriverForTests(fake);
  unregister();
  const inv = baseInventory({ proxyDriver: fake.id });
  assert.throws(() => getDriver(inv), new RegExp(`Unknown proxyDriver '${fake.id}'`));
});

// --- Adding a driver needs nothing outside the driver and its
// registration (issue #10, US5) -------------------------------------------
//
// Demonstrates the seam this feature exists for: a contributor-written
// driver, built the same way the shipped caddyDriver is (fileDriver(...)
// from src/lib/proxy/file-driver.ts) and registered through the one
// test-only hook above, participates in sync-proxy and render-status-page
// without any change to either command. It captures the routes/configPath
// its own render() receives so the test can assert they are exactly what
// buildRoutes/buildProxyContext produce -- the same driver-agnostic values
// the Caddy driver itself is handed -- and asserts sync-proxy's preview and
// render-status-page's snapshot are exactly what this driver produced,
// never some fallback.
test('a test-only fileDriver receives the same routes/context the Caddy driver would, and sync-proxy/render-status-page return exactly what it produced', async () => {
  let receivedRoutes: ProxyRoute[] | undefined;
  let receivedCtx: ProxyContext | undefined;
  let receivedConfigPath: string | undefined;

  const testDriver = fileDriver({
    id: 'test-only-driver-t040' as ProxyDriverId,
    label: 'Test-only driver',
    capabilities: { authModes: ['forward', 'oidc'], acmeDns01ViaCloudflare: () => false },
    defaultConfigPath: '/etc/test-only/test.conf',
    // This test exercises runRenderStatusPage below, which throws for any
    // driver whose statusPage is null (issue #33), so this
    // file-configured, real-proxy-managing test driver needs a non-null
    // value, same as the Caddy driver's.
    statusPage: { suggestedPath: '/var/www/test-only/index.html' },
    render(routes, ctx, configPath) {
      receivedRoutes = routes;
      receivedCtx = ctx;
      receivedConfigPath = configPath;
      return [{ path: configPath, content: `TEST-DRIVER-RENDER:${JSON.stringify(routes)}`, mode: 'owned' }];
    },
    validateCommand: () => 'true',
    reloadCommand: 'true',
  });

  const unregister = registerDriverForTests(testDriver);
  try {
    const inv: Inventory = {
      domain: 'example.com',
      statusPagePath: '/var/www/status.html',
      hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', proxy: true }],
      guests: [{ name: 'media', type: 'lxc', vmid: 105, host: 'pve1', ip: '192.168.1.50', port: 8080, subdomains: ['media'] }],
      // Cast, commented: PROXY_DRIVER_IDS only lists the shipped ids
      // (src/lib/proxy/ids.ts); registerDriverForTests above is what makes
      // this test-only id resolvable at all -- same convention as
      // test/web/proxy-sync.test.ts's fakeDriverWithoutAcme.
      proxyDriver: testDriver.id as Inventory['proxyDriver'],
    };

    // What any driver -- Caddy included -- is handed: buildRoutes/
    // buildProxyContext are driver-agnostic, computed once by sync-proxy
    // before it ever calls into the active driver.
    const expectedRoutes = buildRoutes(inv);
    const expectedCtx = buildProxyContext(inv);

    const ssh = new FakeSSHClient(() => ({ stdout: 'live-test-driver-content', stderr: '', code: 0 }));
    const syncResult = await runSyncProxy({}, { ssh, inventory: inv });

    assert.deepEqual(receivedRoutes, expectedRoutes, 'the test driver must receive the same ProxyRoute[] the Caddy driver would');
    assert.deepEqual(receivedCtx, expectedCtx);
    assert.equal(receivedConfigPath, '/etc/test-only/test.conf');
    assert.equal(syncResult.driver, testDriver.id);
    assert.equal(
      syncResult.preview,
      `TEST-DRIVER-RENDER:${JSON.stringify(expectedRoutes)}`,
      "sync-proxy's dry-run preview must be exactly what this driver produced"
    );

    const statusResult = await runRenderStatusPage({}, { ssh, inventory: inv }, 'domain: example.com\n');
    assert.match(
      statusResult.html,
      /live-test-driver-content/,
      "render-status-page's configuration section must show exactly what this driver's snapshot() returned"
    );
    assert.ok(
      ssh.history.some((h) => h.command === "cat '/etc/test-only/test.conf'"),
      "snapshot() used this driver's own defaultConfigPath through the same file-driver plumbing Caddy uses"
    );
  } finally {
    unregister();
  }
});
