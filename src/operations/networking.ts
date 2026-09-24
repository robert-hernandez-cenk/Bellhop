import { z } from 'zod';
import { stringify } from 'yaml';
import { refreshInventory, SETTINGS_KEYS } from '../lib/inventory.ts';
import { withCapturedConsole } from '../web/console-capture.ts';
import { runSyncAuthentik, formatSyncAuthentik } from '../commands/networking/sync-authentik.ts';
import { runAdoptOidcClient, formatAdoptOidcClient } from '../commands/networking/adopt-oidc-client.ts';
import { runRenderStatusPage } from '../commands/networking/render-status-page.ts';
import { runSetConfig } from '../commands/maintenance/set-config.ts';
import type { Operation } from './types.ts';
import { flag, reqStr } from './fields.ts';

// Operations that existed only as CLI commands before #16. They have no web
// routes; the MCP server is their only non-CLI caller. Like the web UI's
// syncCaddyLive, render-status-page uses the command's own default Caddyfile
// path rather than the CLI's CADDYFILE_PATH override.
export const NETWORKING_OPERATIONS: Record<string, Operation> = {
  'sync-authentik': {
    id: 'sync-authentik',
    category: 'maintenance',
    description: "Reconcile Authentik Providers/Applications/policy bindings with inventory entries' authGroup.",
    shape: {},
    target: () => undefined,
    fleetWide: true,
    preview: async (_i, deps) => formatSyncAuthentik(await runSyncAuthentik({ apply: false }, deps)),
    apply: async (_i, deps) => {
      console.log(formatSyncAuthentik(await runSyncAuthentik({ apply: true }, deps)));
    },
  },
  // Issue #1 (U9): adopt a hand-made Authentik OpenID client at an
  // OIDC-gated entry's slug as Bellhop-managed, without rotating its
  // client_id/client_secret. `entry` names a host, guest, or external site
  // -- the same lookup oidc-credentials/sync-authentik use. fleetWide
  // (rather than targetType: 'guest') because the named entry could be a
  // host or an external site too, neither of which isResourceAllowed can
  // scope a per-resource check against; the web route also gates this
  // entire router behind requireAdminGroup regardless.
  'adopt-oidc-client': {
    id: 'adopt-oidc-client',
    category: 'maintenance',
    description:
      "Adopt a hand-made Authentik OpenID client at an OIDC-gated entry's slug as Bellhop-managed, without rotating its client ID or secret.",
    shape: {
      entry: reqStr('Host, guest, or external-site name'),
    },
    target: (i) => i.entry || undefined,
    fleetWide: true,
    preview: async (i, deps) => formatAdoptOidcClient(await runAdoptOidcClient({ entry: i.entry, apply: false }, deps)),
    apply: async (i, deps) => {
      console.log(formatAdoptOidcClient(await runAdoptOidcClient({ entry: i.entry, apply: true }, deps)));
    },
  },
  'render-status-page': {
    id: 'render-status-page',
    category: 'maintenance',
    description: 'Regenerate the LAN-only status page on the Caddy host (requires the statusPagePath setting).',
    shape: {},
    target: () => undefined,
    fleetWide: true,
    preview: async (_i, deps) => {
      const { text, result } = await withCapturedConsole(() =>
        runRenderStatusPage({ apply: false }, deps, stringify(deps.inventory))
      );
      return [text, result.html].filter(Boolean).join('\n');
    },
    apply: async (_i, deps) => {
      const result = await runRenderStatusPage({ apply: true }, deps, stringify(deps.inventory));
      console.log(`Wrote status page to ${result.caddyHost}`);
    },
  },
  'set-config': {
    id: 'set-config',
    category: 'maintenance',
    description: `Set or clear one inventory-wide setting (${SETTINGS_KEYS.join(', ')}).`,
    shape: {
      key: z.enum(SETTINGS_KEYS as [string, ...string[]]).describe('Setting name'),
      // Deliberately not optStr: an empty string reaches SettingsSchema and is
      // rejected, same as the CLI. Clearing is unset: true.
      value: z.string().optional().describe('New value (omit when unset is true)'),
      unset: flag('Clear the setting instead of setting it'),
    },
    target: () => undefined,
    fleetWide: true,
    preview: async (i, deps) => {
      const { text } = await withCapturedConsole(async () => runSetConfig({ ...(i as any), apply: false }, deps));
      return text;
    },
    apply: async (i, deps) => {
      const result = runSetConfig({ ...(i as any), apply: true }, deps);
      // runSetConfig only writes disk; keep the shared in-memory copy current.
      refreshInventory(deps.inventory, deps.inventoryPath);
      console.log(result.value === undefined ? `Cleared ${result.key}` : `Set ${result.key} to ${result.value}`);
    },
  },
};
