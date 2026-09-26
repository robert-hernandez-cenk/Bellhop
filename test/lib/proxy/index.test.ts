import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Inventory } from '../../../src/lib/inventory.ts';
import type { ProxyPlan, ReverseProxyDriver } from '../../../src/lib/proxy/driver.ts';
import type { ProxyDriverId } from '../../../src/lib/proxy/ids.ts';
import { getDriver, driverDeps, registerDriverForTests } from '../../../src/lib/proxy/index.ts';
import { caddyDriver } from '../../../src/lib/proxy/drivers/caddy.ts';
import { FakeSSHClient, defaultResponder } from '../../support/fake-ssh-client.ts';

function baseInventory(overrides: Partial<Inventory> = {}): Inventory {
  return {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: '192.0.2.1', ssh_user: 'root', caddy: true }],
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

test("driverDeps resolves proxyHost from the entry flagged caddy: true, and configPath from the driver default when proxyConfigPath is unset", () => {
  const inv = baseInventory();
  const ssh = new FakeSSHClient(defaultResponder);
  const deps = driverDeps(inv, ssh, caddyDriver);
  assert.equal(deps.proxyHost, 'pve1');
  assert.equal(deps.configPath, caddyDriver.defaultConfigPath);
  assert.equal(deps.ssh, ssh);
  assert.equal(deps.inventory, inv);
});

test('driverDeps resolves proxyHost from a guest flagged caddy: true', () => {
  const inv = baseInventory({
    hosts: [{ name: 'pve1', ssh_target: '192.0.2.1', ssh_user: 'root' }],
    guests: [{ name: 'proxy-lxc', type: 'lxc', vmid: 100, host: 'pve1', ip: '192.0.2.50', caddy: true }],
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

test("driverDeps throws \"No inventory entry has 'caddy: true'\" when no entry has it (renamed to 'proxy: true' in US2)", () => {
  const inv = baseInventory({
    hosts: [{ name: 'pve1', ssh_target: '192.0.2.1', ssh_user: 'root' }],
  });
  const ssh = new FakeSSHClient(defaultResponder);
  assert.throws(() => driverDeps(inv, ssh, caddyDriver), /^Error: No inventory entry has 'caddy: true'$/);
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
