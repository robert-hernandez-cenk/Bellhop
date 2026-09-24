import { Router } from 'express';
import type { Inventory } from '../../lib/inventory.ts';
import type { SSHClient } from '../../lib/ssh-client.ts';
import type { AuthentikClient } from '../../lib/authentik-client.ts';
import type { CloudflareClient } from '../../lib/cloudflare-client.ts';
import type { JobRunner } from '../jobs/job-runner.ts';
import type { OperationDeps } from '../../operations/types.ts';
import { NETWORKING_OPERATIONS } from '../../operations/networking.ts';
import { parseOperationInput, previewAndEnqueue } from '../../operations/core.ts';
import { requireAdminGroup } from '../auth.ts';
import { resolveTriggeredBy } from '../impersonation.ts';
import { runOidcCredentials, OidcCredentialsError } from '../../commands/networking/oidc-credentials.ts';

export function oidcRoutes(
  inventory: Inventory,
  inventoryPath: string,
  ssh: SSHClient,
  authentik: AuthentikClient,
  cloudflare: CloudflareClient,
  jobRunner: JobRunner
): Router {
  const router = Router();
  router.use(requireAdminGroup);

  const deps = (): OperationDeps => ({ ssh, inventory, inventoryPath, authentik, cloudflare });

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

  // Both routes go through the shared adopt-oidc-client Operation
  // (src/operations/networking.ts) the same way maintenance.ts's generic
  // :id/preview and :id/apply do -- a thrown error (unknown entry, not
  // OIDC-effective, no Application, already owned, not OAuth2-backed) is a
  // 400 here rather than the 404/409/502/503 split GET /credentials uses,
  // since contracts/interfaces.md gives adopt no such split (it is a
  // preview/apply pair like every other Operation, not a read like
  // GET /credentials).
  router.post('/:entry/adopt/preview', async (req, res) => {
    const op = NETWORKING_OPERATIONS['adopt-oidc-client'];
    try {
      const preview = await op.preview(parseOperationInput(op, { entry: req.params.entry }), deps());
      res.json({ preview });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/:entry/adopt/apply', async (req, res) => {
    const op = NETWORKING_OPERATIONS['adopt-oidc-client'];
    try {
      const { jobId } = await previewAndEnqueue(op, { entry: req.params.entry }, deps(), jobRunner, resolveTriggeredBy(req));
      res.json({ jobId });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
