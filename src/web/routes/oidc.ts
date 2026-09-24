import { Router } from 'express';
import type { Inventory } from '../../lib/inventory.ts';
import type { AuthentikClient } from '../../lib/authentik-client.ts';
import type { JobRunner } from '../jobs/job-runner.ts';
import { requireAdminGroup } from '../auth.ts';
import { runOidcCredentials, OidcCredentialsError } from '../../commands/networking/oidc-credentials.ts';

// jobRunner is unused until a later unit (issue #1's adopt-oidc-client
// preview/apply routes) -- accepted now per R-2 so this file's export
// signature does not need to change again when that unit lands.
export function oidcRoutes(
  inventory: Inventory,
  _inventoryPath: string,
  authentik: AuthentikClient,
  _jobRunner: JobRunner
): Router {
  const router = Router();
  router.use(requireAdminGroup);

  router.get('/:entry/credentials', async (req, res) => {
    // Never cached by a browser or intermediary -- this response carries a
    // client secret (FR-021).
    res.set('Cache-Control', 'no-store');
    try {
      const credentials = await runOidcCredentials(req.params.entry, { authentik, inventory });
      res.json(credentials);
    } catch (err) {
      if (err instanceof OidcCredentialsError) {
        res.status(err.code === 'unknown-entry' ? 404 : 409).json({ error: err.message });
        return;
      }
      // Checked after the entry/ownership errors above, which are cheaper
      // and more specific than an Authentik round trip -- matches
      // requireUserDirectory's own gate (src/web/auth.ts), just inline
      // here since 503 only applies to this one route, not the whole
      // router (an unknown entry should 404 even when Authentik is
      // unconfigured, not 503).
      if (!authentik.isConfigured()) {
        res.status(503).json({ error: err instanceof Error ? err.message : String(err) });
        return;
      }
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
