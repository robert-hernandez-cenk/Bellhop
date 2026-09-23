import { Router } from 'express';
import type { AuthentikClient } from '../../lib/authentik-client.ts';
import { authentikConfig } from '../../lib/authentik-config.ts';
import { isAdminUser } from '../auth.ts';

// The auth-tier ladder behind the Dashboard's Advanced modal dropdown.
// Deliberately NOT admin-gated: anyone with resource access to a guest may
// raise its tier (narrow its audience), so everyone who can open that modal
// needs the options. All it exposes is the configured rung names and whether
// each exists in Authentik -- both of which the dropdown renders anyway. No
// membership, no arbitrary group list.
//
// canLower is served rather than left to the client to derive, for the same
// reason GET /api/whoami serves isAdmin instead of the raw group names: the
// admin-group names have exactly one definition, on the server.
export function authGroupsRoutes(authentik: AuthentikClient): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const ladder = authentikConfig().groupLadder;
    // req.user.groups, i.e. the overlaid groups during an active
    // impersonation -- an admin impersonating a non-admin group sees the
    // restricted control, which is the point of that feature.
    const canLower = isAdminUser(req.user?.groups ?? []);
    if (!authentik.isConfigured()) {
      res.json({ configured: false, canLower, rungs: ladder.map((name) => ({ name, exists: null })) });
      return;
    }
    try {
      const groups = await authentik.listGroups();
      const names = new Set(groups.map((g) => g.name));
      res.json({ configured: true, canLower, rungs: ladder.map((name) => ({ name, exists: names.has(name) })) });
    } catch (err) {
      res.status(503).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
