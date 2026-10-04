import { Router } from 'express';
import type { Inventory } from '../../lib/inventory.ts';
import { loadAppUpdateResults } from '../../lib/app-update-store.ts';
import { ANONYMOUS_CALLER, isResourceAllowed } from '../access.ts';

// GET /api/app-updates (contracts/http-api.md, FR-026): any authenticated
// user may call this, but a row is only ever returned when its guest is
// still an eligible lxc+app guest in the *current* inventory (research R7
// -- covers a guest removed or repurposed since the last check) and
// isResourceAllowed holds for it, the same per-resource rules
// dashboardRoutes applies to /inventory and /guests/status. Admin bypass
// and impersonation overlay both live inside isResourceAllowed/req.user, so
// this route has no identity logic of its own to get wrong.
export function appUpdatesRoutes(inventory: Inventory, inventoryPath: string): Router {
  const router = Router();

  router.get('/', (req, res) => {
    const eligibleGuests = new Set(
      inventory.guests.filter((g) => g.type === 'lxc' && g.app).map((g) => g.name)
    );
    const caller = req.user ?? ANONYMOUS_CALLER;
    const results = loadAppUpdateResults(inventoryPath).filter(
      (result) =>
        eligibleGuests.has(result.guest) &&
        isResourceAllowed(inventoryPath, inventory, caller, { type: 'guest', name: result.guest })
    );
    res.json({ results });
  });

  return router;
}
