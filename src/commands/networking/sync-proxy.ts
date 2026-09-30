import type { SSHClient } from '../../lib/ssh-client.ts';
import type { Inventory } from '../../lib/inventory.ts';
import { buildRoutes, buildProxyContext } from '../../lib/proxy/routes.ts';
import { getDriver, driverDeps } from '../../lib/proxy/index.ts';
import { checkCapabilities, managesProxy, NO_PROXY_SYNC_MESSAGE } from '../../lib/proxy/driver.ts';
import type { DriverDeps } from '../../lib/proxy/driver.ts';

export interface SyncProxyOptions {
  apply?: boolean;
}

export interface SyncProxyResult {
  // Name of the `proxy: true` entry the configuration was written to, or
  // null when the active driver manages no proxy at all (issue #33,
  // proxyDriver: 'none') -- there is nothing to write and therefore no
  // proxy host to name.
  proxyHost: string | null;
  // Id of the active driver (the `proxyDriver` setting, default 'caddy').
  driver: string;
  // What the driver would write -- identical to what apply sends.
  preview: string;
  // Whether a configuration was actually written -- false for a dry run,
  // and always false when proxyHost is null (nothing to write).
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

  // Issue #33 (US2): under proxyDriver: 'none' there is nothing to write, so
  // this returns before driverDeps() (which throws when no entry has
  // 'proxy: true'), buildRoutes() (which throws when a forward-gated route
  // has no authentik ip), and checkCapabilities() ever run -- none of those
  // failures are meaningful when Bellhop manages no proxy at all. applied is
  // always false here, even with --apply: nothing is ever written.
  if (!managesProxy(driver)) {
    return { proxyHost: null, driver: driver.id, preview: NO_PROXY_SYNC_MESSAGE, applied: false };
  }

  const resolvedDeps: DriverDeps = driverDeps(deps.inventory, deps.ssh, driver);

  // Only a driver that can forward-auth needs an outpost to address. For one
  // that can't (HAProxy, issue #32), buildRoutes's missing-authentik error
  // would pre-empt the capability refusal below and tell the operator to add
  // an outpost the driver could never use.
  const routes = buildRoutes(deps.inventory, {
    requireOutpost: driver.capabilities.authModes.includes('forward'),
  });

  // Capability enforcement (issue #10, FR-011): refuse before previewing or
  // writing anything -- for both a dry run and --apply -- when any route
  // needs an auth mode the active driver cannot enforce. Every offending
  // entry's message is joined into one thrown Error.
  const capabilityErrors = checkCapabilities(routes, driver);
  if (capabilityErrors.length > 0) {
    throw new Error(capabilityErrors.map((e) => e.message).join('\n'));
  }

  const ctx = buildProxyContext(deps.inventory);
  const plan = await driver.plan(routes, ctx, resolvedDeps);

  if (opts.apply) {
    await driver.apply(plan, resolvedDeps);
  }

  return { proxyHost: resolvedDeps.proxyHost, driver: driver.id, preview: plan.preview, applied: opts.apply === true };
}
