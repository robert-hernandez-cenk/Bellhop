import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Inventory } from '../../../src/lib/inventory.ts';
import type { ProxyPlan, ReverseProxyDriver } from '../../../src/lib/proxy/driver.ts';
import type { ProxyDriverId } from '../../../src/lib/proxy/ids.ts';
import { getDriver, driverDeps, registerDriverForTests } from '../../../src/lib/proxy/index.ts';
import { caddyDriver } from '../../../src/lib/proxy/drivers/caddy.ts';
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
// only lists 'caddy' this round (src/lib/proxy/ids.ts), and this test needs
// a second, test-only id to exercise the registry without touching the real
// driver list.
function fakeDriver(id: string): ReverseProxyDriver {
  return {
    id: id as ProxyDriverId,
    capabilities: { authModes: ['forward', 'oidc'], acmeDns01ViaCloudflare: false },
    defaultConfigPath: '/etc/fake/fake.conf',
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
  const inv = baseInventory({ proxyDriver: 'nginx' as Inventory['proxyDriver'] });
  assert.throws(
    () => getDriver(inv),
    /^Error: Unknown proxyDriver 'nginx' -- run: bellhop set-config proxyDriver caddy --apply$/
  );
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
    capabilities: { authModes: ['forward', 'oidc'], acmeDns01ViaCloudflare: false },
    defaultConfigPath: '/etc/test-only/test.conf',
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
      // Cast, commented: PROXY_DRIVER_IDS only lists 'caddy' this round
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
