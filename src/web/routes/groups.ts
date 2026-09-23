import { Router } from 'express';
import type { AuthentikClient } from '../../lib/authentik-client.ts';
import { requireAdminGroup, requireUserDirectory } from '../auth.ts';

export function groupsRoutes(authentik: AuthentikClient): Router {
  const router = Router();
  router.use(requireAdminGroup);
  router.use(requireUserDirectory(authentik));

  router.get('/', async (_req, res) => {
    try {
      res.json(await authentik.listGroups());
    } catch (err) {
      res.status(503).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/', async (req, res) => {
    const { name } = req.body ?? {};
    if (typeof name !== 'string' || name.length === 0) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    try {
      res.status(201).json(await authentik.createGroup(name));
    } catch (err) {
      res.status(503).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.patch('/:id', async (req, res) => {
    try {
      const { name, userIds } = req.body ?? {};
      const group = await authentik.updateGroup(req.params.id, {
        name: typeof name === 'string' ? name : undefined,
        userIds: Array.isArray(userIds) ? userIds : undefined,
      });
      res.json(group);
    } catch (err) {
      res.status(503).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      await authentik.deleteGroup(req.params.id);
      res.status(204).end();
    } catch (err) {
      res.status(503).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
