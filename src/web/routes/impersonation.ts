import { Router } from 'express';
import type { AuthentikClient } from '../../lib/authentik-client.ts';
import { isAdminUser, requireRealAdminGroup, requireUserDirectory } from '../auth.ts';
import type { ImpersonationStore } from '../impersonation.ts';

export function impersonationRoutes(authentik: AuthentikClient, store: ImpersonationStore): Router {
  const router = Router();
  router.use(requireRealAdminGroup);

  // Only POST is capability-gated. DELETE must stay reachable without the
  // API: an impersonation started while it was available lives in process
  // memory and would otherwise strand the admin in that view until a server
  // restart -- the same lockout hazard requireRealAdminGroup exists to
  // prevent.
  router.post('/', requireUserDirectory(authentik), async (req, res) => {
    const { group } = req.body ?? {};
    if (typeof group !== 'string' || group.length === 0) {
      res.status(400).json({ error: 'group is required' });
      return;
    }
    if (isAdminUser([group])) {
      res.status(400).json({ error: 'cannot impersonate an admin group' });
      return;
    }
    let groups;
    try {
      groups = await authentik.listGroups();
    } catch (err) {
      res.status(503).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (!groups.some((g) => g.name === group)) {
      res.status(400).json({ error: `Unknown Authentik group: ${group}` });
      return;
    }
    const realUser = req.realUser ?? req.user!;
    store.set(realUser.username, group);
    // 200 + a body, not 204: the frontend's apiPost always calls .json() on
    // success (unlike apiDelete). A prior version of this returned 204 and
    // broke the Sidebar's "Start" button with "Unexpected end of JSON input".
    res.status(200).json({ group });
  });

  router.delete('/', (req, res) => {
    const realUser = req.realUser ?? req.user!;
    store.delete(realUser.username);
    res.status(204).end();
  });

  return router;
}
