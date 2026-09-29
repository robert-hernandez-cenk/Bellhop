import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProxyRoute } from '../../../src/lib/proxy/routes.ts';
import type { ReverseProxyDriver, ProxyPlan, DriverDeps } from '../../../src/lib/proxy/driver.ts';
import { checkCapabilities, managesProxy } from '../../../src/lib/proxy/driver.ts';
import type { ProxyDriverId } from '../../../src/lib/proxy/ids.ts';
import { caddyDriver } from '../../../src/lib/proxy/drivers/caddy.ts';
import { noneDriver } from '../../../src/lib/proxy/drivers/none.ts';

function route(name: string, auth: ProxyRoute['auth']): ProxyRoute {
  return {
    owner: { type: 'guest', name },
    hostnames: [`${name}.example.com`],
    backend: { ip: '192.0.2.10', port: 80, insecureTls: false },
    auth,
  };
}

// A minimal fake driver satisfying ReverseProxyDriver -- plan/apply/snapshot
// are never called by checkCapabilities, so they're stubs. `id` is cast
// through ProxyDriverId since PROXY_DRIVER_IDS only lists 'caddy'/'none'
// (src/lib/proxy/ids.ts) and these tests need drivers with other,
// test-only ids to exercise both capability-mismatch directions. `label`/
// `statusPage` are unused by checkCapabilities but required by
// ReverseProxyDriver.
function fakeDriver(id: string, authModes: ('forward' | 'oidc')[]): ReverseProxyDriver {
  return {
    id: id as ProxyDriverId,
    label: 'Fake',
    capabilities: { authModes, acmeDns01ViaCloudflare: false },
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

test('checkCapabilities: no errors when every route is ungated or its mode is supported', () => {
  const driver = fakeDriver('both', ['forward', 'oidc']);
  const routes = [
    route('ungated-app', { mode: 'ungated' }),
    route('forward-app', { mode: 'forward', exemptPaths: [], rawExemptPaths: [] }),
    route('oidc-app', { mode: 'oidc' }),
  ];
  assert.deepEqual(checkCapabilities(routes, driver), []);
});

test('checkCapabilities: one error per forward-gated route on an oidc-only driver, exact message', () => {
  const driver = fakeDriver('oidc-only', ['oidc']);
  const routes = [
    route('ungated-app', { mode: 'ungated' }),
    route('forward-app', { mode: 'forward', exemptPaths: [], rawExemptPaths: [] }),
  ];
  const errors = checkCapabilities(routes, driver);
  assert.equal(errors.length, 1);
  assert.deepEqual(errors[0].owner, { type: 'guest', name: 'forward-app' });
  assert.equal(errors[0].mode, 'forward');
  assert.equal(
    errors[0].message,
    "Entry 'forward-app' uses forward-auth gating, but the 'oidc-only' proxy driver cannot enforce it -- set its authMode to oidc or clear authGroup"
  );
});

test('checkCapabilities: mirror message for an OIDC route on a forward-only driver', () => {
  const driver = fakeDriver('forward-only', ['forward']);
  const routes = [route('oidc-app', { mode: 'oidc' })];
  const errors = checkCapabilities(routes, driver);
  assert.equal(errors.length, 1);
  assert.deepEqual(errors[0].owner, { type: 'guest', name: 'oidc-app' });
  assert.equal(errors[0].mode, 'oidc');
  assert.equal(
    errors[0].message,
    "Entry 'oidc-app' uses OIDC gating, but the 'forward-only' proxy driver cannot enforce it -- set its authMode to forward or clear authGroup"
  );
});

test('checkCapabilities: never suggests the other auth mode when the driver cannot enforce that one either', () => {
  const driver = fakeDriver('ungated-only', []);
  const errors = checkCapabilities(
    [route('forward-app', { mode: 'forward', exemptPaths: [], rawExemptPaths: [] }), route('oidc-app', { mode: 'oidc' })],
    driver
  );
  assert.deepEqual(
    errors.map((e) => e.message),
    [
      "Entry 'forward-app' uses forward-auth gating, but the 'ungated-only' proxy driver cannot enforce it -- clear authGroup or choose a proxyDriver that supports it",
      "Entry 'oidc-app' uses OIDC gating, but the 'ungated-only' proxy driver cannot enforce it -- clear authGroup or choose a proxyDriver that supports it",
    ]
  );
});

test('checkCapabilities: one error per offending route, in route order', () => {
  const driver = fakeDriver('oidc-only', ['oidc']);
  const routes = [
    route('forward-app-1', { mode: 'forward', exemptPaths: [], rawExemptPaths: [] }),
    route('ungated-app', { mode: 'ungated' }),
    route('forward-app-2', { mode: 'forward', exemptPaths: [], rawExemptPaths: [] }),
  ];
  const errors = checkCapabilities(routes, driver);
  assert.deepEqual(
    errors.map((e) => e.owner.name),
    ['forward-app-1', 'forward-app-2']
  );
});

// A compile-time check that DriverDeps matches the contract's shape.
test('DriverDeps shape matches the contract', () => {
  const deps: DriverDeps = {
    ssh: {
      exec: async () => ({ stdout: '', stderr: '', code: 0 }),
      execInteractive: async () => ({ stdout: '', stderr: '', code: 0 }),
      putFile: async () => {},
    },
    inventory: { domain: 'example.com', hosts: [], guests: [] },
    proxyHost: 'pve1',
    configPath: '/etc/caddy/Caddyfile',
  };
  assert.equal(deps.proxyHost, 'pve1');
});

// --- managesProxy (issue #33) -----------------------------------------------

test('managesProxy: true for caddyDriver, false only for noneDriver', () => {
  assert.equal(managesProxy(caddyDriver), true);
  assert.equal(managesProxy(noneDriver), false);
});

// --- checkCapabilities under noneDriver (issue #33) -------------------------
//
// noneDriver declares authModes: ['forward', 'oidc'] (the same as Caddy), so
// it never itself produces a capability mismatch -- callers short-circuit
// around it via managesProxy() before a route is ever derived.

test('checkCapabilities: [] for both forward and oidc routes under noneDriver', () => {
  const routes = [
    route('forward-app', { mode: 'forward', exemptPaths: [], rawExemptPaths: [] }),
    route('oidc-app', { mode: 'oidc' }),
  ];
  assert.deepEqual(checkCapabilities(routes, noneDriver), []);
});
