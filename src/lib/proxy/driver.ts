import type { SSHClient } from '../ssh-client.ts';
import type { Inventory } from '../inventory.ts';
import type { ProxyContext, ProxyRoute } from './routes.ts';
import { NO_PROXY_DRIVER_ID, type ProxyDriverId, type TlsSource } from './ids.ts';
// settings-hint.ts only imports a *type* from inventory.ts, and inventory.ts
// only imports PROXY_DRIVER_IDS (a value) from ./ids.ts -- neither of those
// reaches back into this file, so importing settingFix here as an ordinary
// value import creates no cycle.
import { settingFix } from '../settings-hint.ts';

export type ProxyAuthMode = 'forward' | 'oidc';

export interface DriverCapabilities {
  authModes: ProxyAuthMode[];
  // Which TLS sources this driver can render (issue #72), and the one used
  // when the tlsSource setting is unset -- defaultTlsSource must be in
  // tlsSources. effectiveTlsSource/checkTlsSource (./tls.ts) read these.
  tlsSources: TlsSource[];
  defaultTlsSource: TlsSource;
}

export interface DriverDeps {
  ssh: SSHClient;
  inventory: Inventory;
  // Name of the `proxy: true` entry, resolved by driverDeps() in
  // src/lib/proxy/index.ts.
  proxyHost: string;
  // inventory.proxyConfigPath ?? driver.defaultConfigPath, resolved by
  // driverDeps() -- null when the active driver's own defaultConfigPath is
  // null (issue #31: a REST-managed driver with no config file at all, e.g.
  // Nginx Proxy Manager), regardless of whether proxyConfigPath is set --
  // a driver with no file has nowhere for that setting to point. A
  // file-configured driver (fileDriver, src/lib/proxy/file-driver.ts) never
  // sees null here in practice, since its own defaultConfigPath is always a
  // real path; it resolves this through its own helper that throws a
  // programming-error message if it ever does.
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
  // null = the driver uses no configuration file -- the 'none' driver, and
  // (issue #31) a REST-managed driver like Nginx Proxy Manager. For either,
  // driverDeps() returns configPath: null rather than throwing (see
  // DriverDeps.configPath above); it is only a file-configured driver
  // (fileDriver, src/lib/proxy/file-driver.ts) declaring defaultConfigPath:
  // null that would be a programming error, since fileDriver always needs a
  // real path -- not a reachable state for any driver that ships today.
  defaultConfigPath: string | null;
  // null = no status page served (only the 'none' driver today) --
  // render-status-page checks managesProxy() first, then this, then
  // statusPagePath.
  statusPage: { suggestedPath: string } | null;
  // true = this driver reads the proxyCertResolver setting (issue #35,
  // Traefik only, which names its certificate resolver per route under
  // tlsSource 'acme-dns'/'acme-http'). The Settings page shows that field
  // only for a driver that sets this. Absent = false. Whether the
  // proxyTlsCertificate/proxyTlsKey fields apply is no longer a driver hint
  // but the effective tlsSource (issue #72): they are read under 'files'.
  usesCertResolver?: boolean;
  // true = this driver reads the proxyApiUrl setting (issue #35, Traefik
  // only) to validate a rendered file against the proxy's own read-only
  // API after writing it. The Settings page shows that field only for a
  // driver that sets this. Absent = false (most drivers validate locally
  // on the proxy host instead, e.g. `caddy validate`/`nginx -t`).
  usesApiUrl?: boolean;
  // true = this driver reads the npmApiUrl/npmApiEmail/npmApiPassword
  // settings (issue #73, Nginx Proxy Manager only) to reach its REST API
  // and sign in to it. The Settings page shows those three fields on the
  // Proxy tab only for a driver that sets this. Absent = false.
  usesNpmApi?: boolean;
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
