import type { Inventory } from '../inventory.ts';
import { findProxyEntry } from '../inventory.ts';
import type { SSHClient } from '../ssh-client.ts';
import type { DriverDeps, ReverseProxyDriver } from './driver.ts';
import { settingFix } from '../settings-hint.ts';
import { caddyDriver } from './drivers/caddy.ts';
import { noneDriver } from './drivers/none.ts';
import { PROXY_DRIVER_IDS, type ProxyDriverId } from './ids.ts';

// Re-exported rather than redefined -- ids.ts is the dependency-free source,
// so both src/lib/inventory.ts's proxyDriver enum and any
// caller importing from here see the exact same list/type.
export { PROXY_DRIVER_IDS, type ProxyDriverId };

// inventory.proxyDriver ?? DEFAULT_PROXY_DRIVER_ID when unset -- exported so
// getDriver below and any caller needing the same fallback (e.g. a future
// Settings-page default) share the one literal.
export const DEFAULT_PROXY_DRIVER_ID: ProxyDriverId = 'caddy';

// Keyed by plain string (not ProxyDriverId) so registerDriverForTests can
// register a driver under an id PROXY_DRIVER_IDS doesn't list -- getDriver
// itself only ever looks up ids that either come from PROXY_DRIVER_IDS-typed
// inventory data or were added through that same test-only hook. Order
// matters: this is registration order, and listDrivers() below returns it
// verbatim (Caddy first, then None) for the Settings dropdown.
const DRIVERS = new Map<string, ReverseProxyDriver>([
  [caddyDriver.id, caddyDriver],
  [noneDriver.id, noneDriver],
]);

// Every registered driver, in registration order (data-model.md
// "ProxyDriverInfo (API view)") -- the Settings page's GET/PATCH
// /api/settings response is built from this.
export function listDrivers(): ReverseProxyDriver[] {
  return [...DRIVERS.values()];
}

// inventory.proxyDriver ?? DEFAULT_PROXY_DRIVER_ID -- an unset setting
// behaves exactly as if every inventory had always named the default. The
// thrown case (an id no registered driver has) is only reachable if
// bellhop.db was edited by hand: InventorySchema's own zod enum already
// rejects any other value at load time.
export function getDriver(inventory: Inventory): ReverseProxyDriver {
  const id = inventory.proxyDriver ?? DEFAULT_PROXY_DRIVER_ID;
  const driver = DRIVERS.get(id);
  if (!driver) {
    throw new Error(`Unknown proxyDriver '${id}' -- run: bellhop set-config proxyDriver ${DEFAULT_PROXY_DRIVER_ID} --apply`);
  }
  return driver;
}

// Resolves the DriverDeps contracts/driver-interface.md's plan()/apply()/
// snapshot() all take: proxyHost from the entry flagged proxy: true,
// configPath from the proxyConfigPath setting when set, else the
// active driver's own defaultConfigPath. Only ever called for a driver that
// managesProxy() -- a managed driver with defaultConfigPath: null and no
// proxyConfigPath override is a programming error (data-model.md
// "driverDeps()"), not a state 'none' can reach, since callers short-circuit
// around 'none' before this runs.
export function driverDeps(inventory: Inventory, ssh: SSHClient, driver: ReverseProxyDriver): DriverDeps {
  const proxyHost = findProxyEntry(inventory)?.name;
  if (!proxyHost) {
    throw new Error("No inventory entry has 'proxy: true'");
  }
  const configPath = inventory.proxyConfigPath ?? driver.defaultConfigPath;
  if (configPath === null) {
    throw new Error(`The '${driver.id}' proxy driver has no default config path -- ${settingFix('proxyConfigPath', '</absolute/path>')}`);
  }
  return {
    ssh,
    inventory,
    proxyHost,
    configPath,
  };
}

// Test-only: registers a driver under an additional id (which need not be
// one of PROXY_DRIVER_IDS -- see fakeDriver in test/lib/proxy/driver.test.ts
// and test/lib/proxy/index.test.ts for the id-casting convention that
// enables this) and returns a function that removes it again. No production
// code path calls this; it exists so a test can exercise getDriver/a
// capability check against a driver other than the real caddyDriver
// (e.g. test/web/proxy-sync.test.ts's acmeDns01ViaCloudflare: false case)
// without mutating the real, shipped driver list.
export function registerDriverForTests(driver: ReverseProxyDriver): () => void {
  DRIVERS.set(driver.id, driver);
  return () => {
    DRIVERS.delete(driver.id);
  };
}
