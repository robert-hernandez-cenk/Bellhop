import { Router, type Response } from 'express';
import type { Inventory } from '../../lib/inventory.ts';
import { requireResourceAccess } from '../access.ts';
import { gatewayStatus, gatewayServers, gatewayCities, gatewayGroups, connectGateway, type GatewayResult } from '../../operations/vpn-gateway.ts';

// Thin HTTP adapter over src/operations/vpn-gateway.ts -- the shared
// implementation the MCP server's gateway tools also call (issue #7,
// FR-003). This file's only job is translating a GatewayResult into an
// HTTP status/body pair; the gateway-resolution and fetch-proxying logic
// itself lives in the shared module.
function respond(res: Response, result: GatewayResult): void {
  const status = result.ok ? 200 : result.kind === 'not-found' ? 404 : 502;
  res.status(status).json(result.body);
}

export function networkingRoutes(inventory: Inventory, inventoryPath: string, fetchImpl: typeof fetch = fetch): Router {
  const router = Router();
  const requireGatewayAccess = requireResourceAccess(inventoryPath, inventory, (req) => ({
    type: 'guest',
    name: req.params.name as string,
  }));

  router.get('/gateways/:name/status', requireGatewayAccess, async (req, res) => {
    respond(res, await gatewayStatus(inventory, req.params.name as string, fetchImpl));
  });

  router.get('/gateways/:name/servers', requireGatewayAccess, async (req, res) => {
    respond(res, await gatewayServers(inventory, req.params.name as string, fetchImpl));
  });

  router.get('/gateways/:name/cities', requireGatewayAccess, async (req, res) => {
    const country = typeof req.query.country === 'string' ? req.query.country : '';
    respond(res, await gatewayCities(inventory, req.params.name as string, country, fetchImpl));
  });

  router.get('/gateways/:name/groups', requireGatewayAccess, async (req, res) => {
    respond(res, await gatewayGroups(inventory, req.params.name as string, fetchImpl));
  });

  router.post('/gateways/:name/connect', requireGatewayAccess, async (req, res) => {
    respond(
      res,
      await connectGateway(
        inventory,
        req.params.name as string,
        { country: req.body?.country, city: req.body?.city, group: req.body?.group },
        fetchImpl
      )
    );
  });

  return router;
}
