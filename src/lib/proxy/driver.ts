import type { SSHClient } from '../ssh-client.ts';
import type { Inventory } from '../inventory.ts';
import type { ProxyContext, ProxyRoute } from './routes.ts';
import { NO_PROXY_DRIVER_ID, type ProxyDriverId } from './ids.ts';
// settings-hint.ts only imports a *type* from inventory.ts, and inventory.ts
// only imports PROXY_DRIVER_IDS (a value) from ./ids.ts -- neither of those
// reaches back into this file, so importing settingFix here as an ordinary
// value import creates no cycle.
import { settingFix } from '../settings-hint.ts';

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
  // driverDeps() -- null only for a driver with usesConfigFile: false
  // (caddy-api, issue #26), which writes no file at all.
  configPath: string | null;
}

export interface ProxyPlan {
  preview: string;
  payload: unknown;
}

export interface ReverseProxyDriver {
  id: ProxyDriverId;
  // The Settings page's dropdown label (data-model.md "ReverseProxyDriver
  // (extended)") -- 'Caddy', 'No proxy', etc.
  label: string;
  capabilities: DriverCapabilities;
  // null = the driver uses no configuration file (only the 'none' driver
  // today). driverDeps() in src/lib/proxy/index.ts only ever calls this on
  // a driver that managesProxy(), so a managed, file-configured driver with
  // defaultConfigPath: null and no proxyConfigPath override is a
  // programming error, not a reachable runtime state for 'none'.
  defaultConfigPath: string | null;
  // null = no status page served (only the 'none' driver today) --
  // render-status-page checks managesProxy() first, then this, then
  // statusPagePath.
  statusPage: { suggestedPath: string } | null;
  // true = every site this driver renders is served with the one shared
  // certificate/key pair the proxyTlsCertificate/proxyTlsKey settings name
  // (ProxyContext.tls) -- nginx only (issue #30), since it cannot obtain
  // certificates itself. The Settings page shows those two fields only for
  // a driver that sets this. Absent = false (Caddy gets its own certificates
  // via DNS-01; 'none' writes nothing), so a driver that never reads those
  // settings needs no declaration.
  usesSharedCertificate?: boolean;
  // false = the driver writes no configuration file at all (caddy-api,
  // issue #26, reconciles Caddy's live configuration through its admin
  // API): driverDeps() resolves configPath to null rather than requiring
  // one, and the Settings page hides the Proxy config path field. Absent =
  // true, so a file-configured driver needs no declaration.
  usesConfigFile?: boolean;
  // One sentence the Settings page appends to the Proxy config path help
  // for this driver -- how it treats that file (the whole file vs. a
  // managed section of it). Absent = nothing appended.
  configPathNote?: string;
  plan(routes: ProxyRoute[], ctx: ProxyContext, deps: DriverDeps): Promise<ProxyPlan>;
  apply(plan: ProxyPlan, deps: DriverDeps): Promise<void>; // throws on failure
  snapshot(deps: DriverDeps): Promise<string>; // throws on failure
}

// The one signal for "Bellhop manages no reverse proxy" (issue #33): false
// only for the 'none' driver. It is an id comparison, not driver metadata --
// every caller reads this rather than comparing ids itself, so if a second
// such driver ever ships, this function is the one place to change.
// statusPage === null is a separate question (does a managed driver serve a
// status page?) and is never used to mean this.
export function managesProxy(driver: ReverseProxyDriver): boolean {
  return driver.id !== NO_PROXY_DRIVER_ID;
}

// The exact text contracts/commands-and-messages.md pins for every
// proxyDriver: 'none' caller (sync-proxy, syncProxyLive, migrate-guest, the
// CLI, and the sync-proxy web/MCP operation) -- one shared string so none
// of them can drift from each other.
export const NO_PROXY_SYNC_MESSAGE = "proxyDriver is 'none' -- Bellhop manages no reverse proxy, so there is nothing to write";

// Thrown by runRenderStatusPage (CLI and operation) before any SSH call when
// the active driver manages no proxy -- there is neither a managed proxy
// nor a document root to write the page to.
export const NO_PROXY_STATUS_PAGE_ERROR =
  "proxyDriver is 'none' -- there is no Bellhop-managed proxy to serve a status page -- " + settingFix('proxyDriver', 'caddy');

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
