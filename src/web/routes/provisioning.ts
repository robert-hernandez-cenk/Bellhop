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
import { usedMidsByHost } from '../../lib/targets.ts';
import { resolveActor, resolveTriggeredBy } from '../impersonation.ts';
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
  // issue #11: the fourth argument surfaces the operator's configured
  // custom script repository (if any) as its own group -- see
  // getScriptCatalog/getCustomGroup in src/lib/script-catalog.ts.
  router.get('/install-app/apps', async (_req, res) => {
    res.json(await getScriptCatalog(inventoryPath, testDeps.fetchImpl ?? fetch, new Date(), inventory));
  });

  // issue #54: occupied MIDs per host the caller may see, from the
  // unfiltered inventory, so the form never suggests an MID held by a guest
  // hidden from the caller. Numbers only (contracts/used-mids.md); hosts the
  // caller can't see are left out. Not admin-gated, like the routes above.
  router.get('/used-mids', (req, res) => {
    const groups = req.user?.groups ?? [];
    const allowed = inventory.hosts
      .map((h) => h.name)
      .filter((name) => isResourceAllowed(inventoryPath, groups, { type: 'host', name }));
    res.json({ usedMids: usedMidsByHost(inventory, allowed) });
  });

  // canSeeGuest (#54): a VMID-in-use error names the conflicting guest only
  // when the caller's groups may see it. Groups are captured now, so the
  // job's later apply checks against the requester, not whoever is asking then.
  // actor (issue #53): the signed-in creator, for create-vm's Proxmox grant
  // -- set on preview and apply alike so the preview can name them.
  const deps = (req: Request): OperationDeps => {
    const groups = req.user?.groups ?? [];
    return {
      ssh,
      inventory,
      inventoryPath,
      authentik,
      cloudflare,
      canSeeGuest: (name) => isResourceAllowed(inventoryPath, groups, { type: 'guest', name }),
      actor: resolveActor(req),
      ...testDeps,
    };
  };

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
      const preview = await op.preview(parseOperationInput(op, req.body), deps(req));
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
      const { jobId } = await previewAndEnqueue(op, req.body, deps(req), jobRunner, resolveTriggeredBy(req));
      res.json({ jobId });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
