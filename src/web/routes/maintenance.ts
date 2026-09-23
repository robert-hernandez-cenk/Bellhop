import { Router } from 'express';
import type { Request, Response } from 'express';
import type { SSHClient } from '../../lib/ssh-client.ts';
import type { Inventory } from '../../lib/inventory.ts';
import type { JobRunner } from '../jobs/job-runner.ts';
import { MAINTENANCE_ACTIONS } from '../commands-meta.ts';
import { runAuditNfsMounts, formatAuditNfsMounts } from '../../commands/maintenance/audit-nfs-mounts.ts';
import { requireAdminGroup } from '../auth.ts';
import { isAdmin, isResourceAllowed, requireResourceAccess } from '../access.ts';
import { resolveTriggeredBy } from '../impersonation.ts';
import type { AuthentikClient } from '../../lib/authentik-client.ts';
import type { CloudflareClient } from '../../lib/cloudflare-client.ts';
import type { Operation, OperationDeps } from '../../operations/types.ts';
import { MAINTENANCE_OPERATIONS, toTargetSelector } from '../../operations/maintenance.ts';
import { parseOperationInput, previewAndEnqueue, enqueueWithoutPreview } from '../../operations/core.ts';

export function maintenanceRoutes(
  inventory: Inventory,
  ssh: SSHClient,
  jobRunner: JobRunner,
  inventoryPath: string,
  authentik: AuthentikClient,
  cloudflare: CloudflareClient
): Router {
  const router = Router();

  const deps = (): OperationDeps => ({ ssh, inventory, inventoryPath, authentik, cloudflare });

  router.get('/', (_req, res) => {
    res.json(MAINTENANCE_ACTIONS);
  });

  router.post('/audit-nfs-mounts/run', requireAdminGroup, async (req, res) => {
    try {
      const result = await runAuditNfsMounts(req.body ?? {}, { ssh, inventory });
      res.json({ report: formatAuditNfsMounts(result) });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/update-all/run', requireAdminGroup, (req, res) => {
    try {
      const op = MAINTENANCE_OPERATIONS['update-all'];
      // Validate the selector up front (#16) so an invalid one is a 400 here
      // rather than an enqueued job that only fails once it runs.
      toTargetSelector(parseOperationInput(op, req.body.selector));
      const jobId = enqueueWithoutPreview(op, req.body.selector, deps(), jobRunner, resolveTriggeredBy(req));
      res.json({ jobId });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post(
    '/guest-power',
    requireResourceAccess(inventoryPath, (req) => {
      const guest = req.body?.guest;
      return typeof guest === 'string' && guest ? { type: 'guest', name: guest } : undefined;
    }),
    (req, res) => {
      try {
        const jobId = enqueueWithoutPreview(MAINTENANCE_OPERATIONS['guest-power'], req.body, deps(), jobRunner, resolveTriggeredBy(req));
        res.json({ jobId });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }
  );

  router.post(
    '/set-guest-vpn',
    requireResourceAccess(inventoryPath, (req) => {
      const guest = req.body?.guest;
      return typeof guest === 'string' && guest ? { type: 'guest', name: guest } : undefined;
    }),
    (req, res) => {
      try {
        const jobId = enqueueWithoutPreview(MAINTENANCE_OPERATIONS['set-guest-vpn'], req.body, deps(), jobRunner, resolveTriggeredBy(req));
        res.json({ jobId });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }
  );

  router.post('/sync-ssh-keys/preview', requireAdminGroup, async (req, res) => {
    const op = MAINTENANCE_OPERATIONS['sync-ssh-keys'];
    try {
      res.json({ preview: await op.preview(parseOperationInput(op, { host: req.body.host || undefined }), deps()) });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/sync-ssh-keys/apply', requireAdminGroup, (req, res) => {
    try {
      const jobId = enqueueWithoutPreview(
        MAINTENANCE_OPERATIONS['sync-ssh-keys'],
        { host: req.body.host || undefined },
        deps(),
        jobRunner,
        resolveTriggeredBy(req)
      );
      res.json({ jobId });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/push-ssh-key/apply', requireAdminGroup, (req, res) => {
    try {
      const jobId = enqueueWithoutPreview(
        MAINTENANCE_OPERATIONS['push-ssh-key'],
        { key: req.body.key, guests: req.body.guests },
        deps(),
        jobRunner,
        resolveTriggeredBy(req)
      );
      res.json({ jobId });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Only these three ids have ever been reachable through the generic
  // routes; every other maintenance operation keeps its dedicated route.
  const GENERIC_IDS = ['sync-inventory', 'update-app', 'sync-caddy'];

  function authorize(req: Request, res: Response): Operation | undefined {
    const op = GENERIC_IDS.includes(req.params.id as string) ? MAINTENANCE_OPERATIONS[req.params.id as string] : undefined;
    if (!op) {
      res.status(404).json({ error: `Unknown maintenance action: ${req.params.id}` });
      return undefined;
    }
    const groups = req.user?.groups ?? [];
    if (op.fleetWide && !isAdmin(groups)) {
      res.status(403).json({ error: 'forbidden' });
      return undefined;
    }
    if (op.targetType) {
      const targetName = op.target(req.body ?? {});
      if (targetName && !isResourceAllowed(inventoryPath, groups, { type: op.targetType, name: targetName })) {
        res.status(403).json({ error: `forbidden: no access to ${op.targetType} '${targetName}'` });
        return undefined;
      }
    }
    return op;
  }

  router.post('/:id/preview', async (req, res) => {
    const op = authorize(req, res);
    if (!op) return;
    try {
      res.json({ preview: await op.preview(parseOperationInput(op, req.body), deps()) });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/:id/apply', async (req, res) => {
    const op = authorize(req, res);
    if (!op) return;
    try {
      const { jobId } = await previewAndEnqueue(op, req.body, deps(), jobRunner, resolveTriggeredBy(req));
      res.json({ jobId });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
