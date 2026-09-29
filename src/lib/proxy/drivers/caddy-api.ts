import type { DriverDeps, ProxyPlan, ReverseProxyDriver } from '../driver.ts';
import type { ProxyContext, ProxyRoute } from '../routes.ts';
import { formatCaddyPreview, formatConflictError, planCaddyConfig, type CaddyConfigPlan } from '../caddy-json.ts';
import { readCaddyConfig, writeCaddyConfig } from '../caddy-admin.ts';

// The payload plan() hands apply(): the reconciled configuration plus the
// Etag it was computed from, so apply() writes exactly what was previewed
// and refuses if Caddy changed in between (FR-003/FR-005).
interface CaddyApiPayload {
  plan: CaddyConfigPlan;
  etag: string;
}

// Caddy configured through its admin API instead of a Caddyfile (issue
// #26). The first driver not built on fileDriver: it writes no file at all
// (usesConfigFile: false), and reconciles Bellhop-tagged routes and one
// TLS policy against Caddy's live JSON configuration, leaving every
// untagged object alone (src/lib/proxy/caddy-json.ts). Served behavior
// matches the file-based 'caddy' driver route for route -- the parity test
// in test/lib/proxy/caddy-json.test.ts pins it against Caddy's own adapter.
export const caddyApiDriver: ReverseProxyDriver = {
  id: 'caddy-api',
  label: 'Caddy (admin API)',
  // Same as the file-based driver: Caddy enforces forward-auth itself and
  // issues its own certificates through Cloudflare DNS-01, so stale
  // _acme-challenge records keep being pruned after Dashboard edits.
  capabilities: { authModes: ['forward', 'oidc'], acmeDns01ViaCloudflare: true },
  defaultConfigPath: null,
  usesConfigFile: false,
  // The same document root the file-based driver suggests -- the status
  // page site itself stays hand-authored and untagged.
  statusPage: { suggestedPath: '/usr/share/caddy/index.html' },

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
