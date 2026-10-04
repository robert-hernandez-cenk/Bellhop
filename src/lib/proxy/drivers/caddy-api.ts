import type { DriverDeps, ProxyPlan, ReverseProxyDriver } from '../driver.ts';
import type { ProxyContext, ProxyRoute } from '../routes.ts';
import { formatCaddyPreview, formatConflictError, planCaddyConfig, type CaddyConfigPlan } from '../caddy-json.ts';
import { readCaddyConfig, writeCaddyConfig } from '../caddy-admin.ts';
import { caddyAcmeDns01ViaCloudflare } from './caddy.ts';

// The payload plan() hands apply(): the reconciled configuration plus the
// Etag it was computed from, so apply() writes exactly what was previewed
// and refuses if Caddy changed in between (FR-003/FR-005).
interface CaddyApiPayload {
  plan: CaddyConfigPlan;
  etag: string;
}

// Caddy configured through its admin API instead of a Caddyfile (issue
// #26). Like Nginx Proxy Manager (issue #31) it writes no file at all
// (defaultConfigPath: null), and reconciles Bellhop-tagged routes and the
// active proxyCaddyTls mode's TLS objects (issue #51 -- planCaddyConfig
// reads the mode from ctx.caddyTls) against Caddy's live JSON
// configuration, leaving every untagged object alone
// (src/lib/proxy/caddy-json.ts). Served behavior
// matches the file-based 'caddy' driver route for route -- the parity test
// in test/lib/proxy/caddy-json.test.ts pins it against Caddy's own adapter.
export const caddyApiDriver: ReverseProxyDriver = {
  id: 'caddy-api',
  label: 'Caddy (admin API)',
  // Same as the file-based driver: Caddy enforces forward-auth itself, and
  // caddyAcmeDns01ViaCloudflare (shared with drivers/caddy.ts, so neither
  // copy can drift from the other) reports true only in the 'cloudflare'
  // caddyTls mode (unset defaults to it) -- the other three modes never
  // touch Cloudflare's DNS, so prune-acme-challenges has nothing to clean up
  // after them.
  capabilities: { authModes: ['forward', 'oidc'], acmeDns01ViaCloudflare: caddyAcmeDns01ViaCloudflare },
  // No config file: driverDeps() resolves configPath to null, and the
  // Settings page hides Proxy config path for it.
  defaultConfigPath: null,
  // The same document root the file-based driver suggests -- the status
  // page site itself stays hand-authored and untagged.
  statusPage: { suggestedPath: '/usr/share/caddy/index.html' },
  // issue #51: the Settings page shows the Caddy TLS dropdown for it.
  usesCaddyTls: true,

  async plan(routes: ProxyRoute[], ctx: ProxyContext, deps: DriverDeps): Promise<ProxyPlan> {
    const live = await readCaddyConfig(deps, { checkService: true });
    const plan = planCaddyConfig(live.config, routes, ctx, deps.proxyHost);
    const payload: CaddyApiPayload = { plan, etag: live.etag };
    return { preview: formatCaddyPreview(plan), payload };
  },

  async apply(proxyPlan: ProxyPlan, deps: DriverDeps): Promise<void> {
    const { plan, etag } = proxyPlan.payload as CaddyApiPayload;
    if (plan.config !== null) {
      await writeCaddyConfig(deps, plan.config, etag);
    }
    // Conflicting routes were left out of the written configuration; the
    // rest is live now, but the sync as a whole still failed (FR-007).
    if (plan.conflicts.length > 0) {
      throw new Error(formatConflictError(plan.conflicts, deps.proxyHost));
    }
  },

  // Read-only: no Caddyfile-mode check, and never touches routes, so the
  // status page works even when the inventory itself is invalid (FR-013).
  async snapshot(deps: DriverDeps): Promise<string> {
    const live = await readCaddyConfig(deps, { checkService: false });
    return JSON.stringify(live.config, null, 2);
  },
};
