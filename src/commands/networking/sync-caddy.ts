import type { SSHClient } from '../../lib/ssh-client.ts';
import type { Inventory } from '../../lib/inventory.ts';
import { buildRoutes, buildProxyContext } from '../../lib/proxy/routes.ts';
import { getDriver, driverDeps } from '../../lib/proxy/index.ts';
import type { DriverDeps } from '../../lib/proxy/driver.ts';

export interface SyncCaddyOptions {
  apply?: boolean;
  // Until T021 (a later batch) this still exists and the CLI still passes
  // CADDYFILE_PATH -- honored here for one batch by overriding the resolved
  // DriverDeps.configPath, same as it used to override the hardcoded
  // '/etc/caddy/Caddyfile' default.
  caddyfilePath?: string;
}

// Orchestration only (issue #10, T013): resolve the active driver and its
// deps, derive the proxy-neutral routes/context, then hand both to the
// driver's own plan()/apply(). buildCaddyBlock/buildRemoteScript (the old
// Caddy-specific rendering/remote-script logic) are gone -- that logic now
// lives in src/lib/proxy/drivers/caddy.ts (render) and
// src/lib/proxy/file-driver.ts (buildFileDriverScript), shared by every
// file-configured driver rather than duplicated here.
export async function runSyncCaddy(
  opts: SyncCaddyOptions,
  deps: { ssh: SSHClient; inventory: Inventory }
): Promise<{ caddyHost: string; block: string; applied: boolean }> {
  const driver = getDriver(deps.inventory);
  const resolvedDeps: DriverDeps = driverDeps(deps.inventory, deps.ssh, driver);
  if (opts.caddyfilePath) {
    resolvedDeps.configPath = opts.caddyfilePath;
  }

  const routes = buildRoutes(deps.inventory);
  const ctx = buildProxyContext(deps.inventory);
  const plan = await driver.plan(routes, ctx, resolvedDeps);

  if (opts.apply) {
    await driver.apply(plan, resolvedDeps);
    return { caddyHost: resolvedDeps.proxyHost, block: plan.preview, applied: true };
  }

  return { caddyHost: resolvedDeps.proxyHost, block: plan.preview, applied: false };
}
