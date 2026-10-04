import { Router } from 'express';
import type { Inventory } from '../../lib/inventory.ts';
import { loadAppUpdateResults } from '../../lib/app-update-store.ts';
import { ANONYMOUS_CALLER, filterInventoryForUser } from '../access.ts';

// GET /api/app-updates (contracts/http-api.md, FR-026): any authenticated
// user may call this, but a row is only ever returned when its guest is
// still an eligible lxc+app guest in the *current* inventory, still running
// the same app the row was checked for (research R7 -- covers a guest
// removed or repurposed since the last check), and visible to the caller.
// Visibility comes from filterInventoryForUser, the same call /inventory
// uses in dashboard.ts -- one permission-rule load per request rather than
// one per row -- so admin bypass, impersonation overlay and creator access
// all behave exactly as they do there.
export function appUpdatesRoutes(inventory: Inventory, inventoryPath: string): Router {
  const router = Router();

  router.get('/', (req, res) => {
    const { guests } = filterInventoryForUser(inventoryPath, req.user ?? ANONYMOUS_CALLER, inventory);
    const visibleApps = new Map(guests.filter((g) => g.type === 'lxc' && g.app).map((g) => [g.name, g.app]));
    const results = loadAppUpdateResults(inventoryPath).filter((result) => visibleApps.get(result.guest) === result.app);
    res.json({ results });
  });

  return router;
}
