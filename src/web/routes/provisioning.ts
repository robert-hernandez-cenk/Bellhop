import { Router } from 'express';
import type { Request, Response } from 'express';
import type { SSHClient } from '../../lib/ssh-client.ts';
import type { Inventory } from '../../lib/inventory.ts';
export { parseSubdomains } from '../../lib/inventory.ts';
import type { JobRunner } from '../jobs/job-runner.ts';
import { PROVISIONING_COMMANDS } from '../commands-meta.ts';
import { getScriptCatalog } from '../../lib/script-catalog.ts';
import type { GoBuilder } from '../../lib/go-build.ts';
import type { AuthentikClient } from '../../lib/authentik-client.ts';
import type { CloudflareClient } from '../../lib/cloudflare-client.ts';
import { isResourceAllowed } from '../access.ts';
import { resolveTriggeredBy } from '../impersonation.ts';
import { checkAppUrl } from '../../operations/app-check.ts';
export { checkAppUrl, parseAppDefaults, parsePromptHints, type AppDefaults } from '../../operations/app-check.ts';
import type { Operation, OperationDeps } from '../../operations/types.ts';
import { PROVISIONING_OPERATIONS } from '../../operations/provisioning.ts';
import { parseOperationInput, previewAndEnqueue } from '../../operations/core.ts';

export function provisioningRoutes(
  inventory: Inventory,
  ssh: SSHClient,
  jobRunner: JobRunner,
  inventoryPath: string,
  authentik: AuthentikClient,
  cloudflare: CloudflareClient,
  testDeps: { goBuilder?: GoBuilder; fetchImpl?: typeof fetch; tlsProbeSleepFn?: (ms: number) => Promise<void> }
): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(PROVISIONING_COMMANDS);
  });

  router.get('/install-app/check-app', async (req, res) => {
    const app = String(req.query.value ?? '');
    if (!app) {
      res.json({ exists: false, url: '' });
      return;
    }
    // issue #11: resolves through the configured custom script repository
    // (see resolveAppSource in src/lib/app-source.ts) when one is set,
    // falling back to today's plain VE->VED check when it isn't.
    res.json(await checkAppUrl(app, testDeps.fetchImpl, inventory));
  });

  // The community-scripts slug catalog behind the App field's autocomplete.
  // Global requireAuth is the only gate -- no requireResourceAccess, since a
  // script catalog is neither a host nor a guest, matching check-app and
  // GET /provisioning above.
  router.get('/install-app/apps', async (_req, res) => {
    res.json(await getScriptCatalog(inventoryPath, testDeps.fetchImpl ?? fetch));
  });

  const deps = (): OperationDeps => ({ ssh, inventory, inventoryPath, authentik, cloudflare, ...testDeps });

  // Permission check runs on the raw body before schema parsing, preserving
  // the pre-#16 ordering (a blocked caller gets 403, never a parse error).
  function forbidden(req: Request, res: Response, op: Operation): boolean {
    const targetName = op.target(req.body ?? {});
    const groups = req.user?.groups ?? [];
    if (targetName && op.targetType && !isResourceAllowed(inventoryPath, groups, { type: op.targetType, name: targetName })) {
      res.status(403).json({ error: `forbidden: no access to ${op.targetType} '${targetName}'` });
      return true;
    }
    return false;
  }

  router.post('/:id/preview', async (req, res) => {
    const op = Object.hasOwn(PROVISIONING_OPERATIONS, req.params.id) ? PROVISIONING_OPERATIONS[req.params.id] : undefined;
    if (!op) {
      res.status(404).json({ error: `Unknown provisioning command: ${req.params.id}` });
      return;
    }
    if (forbidden(req, res, op)) return;
    try {
      const preview = await op.preview(parseOperationInput(op, req.body), deps());
      res.json({ preview });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/:id/apply', async (req, res) => {
    const op = Object.hasOwn(PROVISIONING_OPERATIONS, req.params.id) ? PROVISIONING_OPERATIONS[req.params.id] : undefined;
    if (!op) {
      res.status(404).json({ error: `Unknown provisioning command: ${req.params.id}` });
      return;
    }
    if (forbidden(req, res, op)) return;
    try {
      const { jobId } = await previewAndEnqueue(op, req.body, deps(), jobRunner, resolveTriggeredBy(req));
      res.json({ jobId });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
