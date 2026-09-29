import type { ReverseProxyDriver } from '../driver.ts';
import { NO_PROXY_SYNC_MESSAGE, NO_PROXY_STATUS_PAGE_ERROR } from '../driver.ts';
import { NO_PROXY_DRIVER_ID } from '../ids.ts';

// The 'none' driver (issue #33): a real, registered ReverseProxyDriver whose
// id means "Bellhop manages no reverse proxy for this deployment," not
// "no proxy exists in front of it" -- an operator may still run one by
// hand, entirely outside this toolkit's managed markers. Every caller
// (sync-proxy, render-status-page, syncProxyLive, migrate-guest) detects it
// through managesProxy() in src/lib/proxy/driver.ts rather than comparing
// driver.id === 'none' directly, so this file itself
// has no special-casing to keep in sync with theirs -- it only has to
// implement the interface honestly: nothing to write, nothing to read.
export const noneDriver: ReverseProxyDriver = {
  id: NO_PROXY_DRIVER_ID,
  label: 'No proxy',
  // Same authModes as Caddy: capability enforcement (checkCapabilities) is
  // about whether the *active proxy* can enforce a route's auth mode, and
  // 'none' never reaches that check at all -- callers short-circuit around
  // it via managesProxy() before buildRoutes()/checkCapabilities() ever run
  // (research.md R2). Declaring both modes here means this driver never
  // itself produces a spurious capability mismatch if some future caller
  // ever did call checkCapabilities against it directly.
  capabilities: { authModes: ['forward', 'oidc'], acmeDns01ViaCloudflare: false },
  defaultConfigPath: null,
  statusPage: null,

  async plan() {
    return { preview: NO_PROXY_SYNC_MESSAGE, payload: null };
  },

  async apply() {
    // No-op: there is nothing to write, and therefore nothing to SSH to.
  },

  async snapshot(): Promise<string> {
    throw new Error(NO_PROXY_STATUS_PAGE_ERROR);
  },
};
