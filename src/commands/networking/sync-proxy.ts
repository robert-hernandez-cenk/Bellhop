import type { SSHClient } from '../../lib/ssh-client.ts';
import type { Inventory } from '../../lib/inventory.ts';
import { buildRoutes, buildProxyContext } from '../../lib/proxy/routes.ts';
import { getDriver, driverDeps } from '../../lib/proxy/index.ts';
import type { DriverDeps } from '../../lib/proxy/driver.ts';

export interface SyncProxyOptions {
  apply?: boolean;
}

export interface SyncProxyResult {
  // Name of the `proxy: true` entry the configuration was written to.
  proxyHost: string;
  // Id of the active driver (the `proxyDriver` setting, default 'caddy').
  driver: string;
  // What the driver would write -- identical to what apply sends.
  preview: string;
  applied: boolean;
}

// Orchestration only (issue #10): resolve the active driver and its deps
// (configPath comes from the proxyConfigPath setting, else the driver's own
// default), derive the proxy-neutral routes/context, then hand both to the
// driver's own plan()/apply(). Rendering lives in the driver
// (src/lib/proxy/drivers/*), and the remote write/validate/reload script in
// src/lib/proxy/file-driver.ts, shared by every file-configured driver.
export async function runSyncProxy(
  opts: SyncProxyOptions,
  deps: { ssh: SSHClient; inventory: Inventory }
): Promise<SyncProxyResult> {
  const driver = getDriver(deps.inventory);
  const resolvedDeps: DriverDeps = driverDeps(deps.inventory, deps.ssh, driver);

  const routes = buildRoutes(deps.inventory);
  const ctx = buildProxyContext(deps.inventory);
  const plan = await driver.plan(routes, ctx, resolvedDeps);

  if (opts.apply) {
    await driver.apply(plan, resolvedDeps);
  }

  return { proxyHost: resolvedDeps.proxyHost, driver: driver.id, preview: plan.preview, applied: opts.apply === true };
}
