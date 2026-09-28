import type { SSHClient } from '../ssh-client.ts';
import type { Inventory } from '../inventory.ts';
import type { ProxyContext, ProxyRoute } from './routes.ts';
import type { ProxyDriverId } from './ids.ts';

export type ProxyAuthMode = 'forward' | 'oidc';

export interface DriverCapabilities {
  authModes: ProxyAuthMode[];
  acmeDns01ViaCloudflare: boolean;
}

export interface DriverDeps {
  ssh: SSHClient;
  inventory: Inventory;
  // Name of the `proxy: true` entry, resolved by driverDeps() in
  // src/lib/proxy/index.ts.
  proxyHost: string;
  // inventory.proxyConfigPath ?? driver.defaultConfigPath, resolved by
  // driverDeps().
  configPath: string;
}

export interface ProxyPlan {
  preview: string;
  payload: unknown;
}

export interface ReverseProxyDriver {
  id: ProxyDriverId;
  capabilities: DriverCapabilities;
  defaultConfigPath: string;
  plan(routes: ProxyRoute[], ctx: ProxyContext, deps: DriverDeps): Promise<ProxyPlan>;
  apply(plan: ProxyPlan, deps: DriverDeps): Promise<void>; // throws on failure
  snapshot(deps: DriverDeps): Promise<string>; // throws on failure
}

export interface CapabilityError {
  owner: ProxyRoute['owner'];
  mode: ProxyAuthMode;
  message: string;
}

// One error per route whose auth mode the active driver cannot enforce --
// an 'ungated' route is never a candidate (there's nothing to enforce).
// sync-proxy joins every message into one thrown Error; commitGuestEdit
// returns the edited entry's own message as a 400. The fix it suggests is
// switching to the other auth mode only when this driver can enforce that
// one; otherwise it is clearing authGroup or picking another driver.
export function checkCapabilities(routes: ProxyRoute[], driver: ReverseProxyDriver): CapabilityError[] {
  const errors: CapabilityError[] = [];
  for (const route of routes) {
    const mode = route.auth.mode;
    if (mode === 'ungated') continue;
    if (driver.capabilities.authModes.includes(mode)) continue;
    const label = mode === 'forward' ? 'forward-auth' : 'OIDC';
    const otherMode: ProxyAuthMode = mode === 'forward' ? 'oidc' : 'forward';
    const fix = driver.capabilities.authModes.includes(otherMode)
      ? `set its authMode to ${otherMode} or clear authGroup`
      : 'clear authGroup or choose a proxyDriver that supports it';
    errors.push({
      owner: route.owner,
      mode,
      message: `Entry '${route.owner.name}' uses ${label} gating, but the '${driver.id}' proxy driver cannot enforce it -- ${fix}`,
    });
  }
  return errors;
}
