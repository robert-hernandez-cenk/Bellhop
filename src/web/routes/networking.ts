import { Router } from 'express';
import type { Inventory } from '../../lib/inventory.ts';
import { requireResourceAccess } from '../access.ts';

type GatewayResolution = { ip: string } | { error: string };

// /status reads local agent state and is polled every 10s (GatewayCard.tsx),
// so a short timeout is fine -- missing one poll is invisible. /servers,
// /cities, and /groups instead trigger a *live* upstream call from inside
// the gateway container out to the VPN provider's own API, and are each a
// one-shot page-load fetch with no retry -- a cold first connection from the
// web service process to a gateway it hasn't talked to recently was observed
// live taking up to ~5s on its own (issue #145), so they get a longer budget.
const STATUS_TIMEOUT_MS = 5_000;
const LIST_TIMEOUT_MS = 15_000;

// Resolves a gateway guest's LAN IP from inventory by name -- only guests
// with vpnGateway set are valid gateway targets. Distinguishes "no such
// gateway" from "gateway exists but has no ip in inventory" so callers can
// surface a message that doesn't misdirect an operator toward a missing
// inventory entry that isn't actually missing.
function resolveGateway(inventory: Inventory, name: string): GatewayResolution {
  const guest = inventory.guests.find((g) => g.name === name && g.vpnGateway);
  if (!guest) {
    return { error: `Unknown VPN gateway: ${name}` };
  }
  if (!guest.ip) {
    return { error: `VPN gateway ${name} has no ip in inventory` };
  }
  return { ip: guest.ip };
}

// Forwards one request to the gateway's own Go management API (always
// LAN-only, unauthenticated) and normalizes both a network-level failure
// (gateway unreachable) and a non-2xx response from the gateway itself
// into the same { status: 502, body: { error } } shape, so route
// handlers below don't each need their own try/catch.
async function proxyToGateway(
  fetchImpl: typeof fetch,
  gatewayIp: string,
  path: string,
  init?: RequestInit
): Promise<{ status: number; body: unknown }> {
  let response: Response;
  try {
    response = await fetchImpl(`http://${gatewayIp}:8080${path}`, init);
  } catch (err) {
    return {
      status: 502,
      body: { error: `Failed to reach gateway at ${gatewayIp}:8080 -- ${err instanceof Error ? err.message : String(err)}` },
    };
  }
  const body = await response.json().catch(() => ({}));
  return { status: response.ok ? 200 : 502, body };
}

export function networkingRoutes(inventory: Inventory, inventoryPath: string, fetchImpl: typeof fetch = fetch): Router {
  const router = Router();
  const requireGatewayAccess = requireResourceAccess(inventoryPath, (req) => ({
    type: 'guest',
    name: req.params.name as string,
  }));

  router.get('/gateways/:name/status', requireGatewayAccess, async (req, res) => {
    const resolved = resolveGateway(inventory, req.params.name as string);
    if ('error' in resolved) {
      res.status(404).json({ error: resolved.error });
      return;
    }
    const { status, body } = await proxyToGateway(fetchImpl, resolved.ip, '/status', {
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
    res.status(status).json(body);
  });

  router.get('/gateways/:name/servers', requireGatewayAccess, async (req, res) => {
    const resolved = resolveGateway(inventory, req.params.name as string);
    if ('error' in resolved) {
      res.status(404).json({ error: resolved.error });
      return;
    }
    const { status, body } = await proxyToGateway(fetchImpl, resolved.ip, '/servers', {
      signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
    });
    res.status(status).json(body);
  });

  router.get('/gateways/:name/cities', requireGatewayAccess, async (req, res) => {
    const resolved = resolveGateway(inventory, req.params.name as string);
    if ('error' in resolved) {
      res.status(404).json({ error: resolved.error });
      return;
    }
    const country = typeof req.query.country === 'string' ? req.query.country : '';
    const { status, body } = await proxyToGateway(
      fetchImpl,
      resolved.ip,
      `/cities?country=${encodeURIComponent(country)}`,
      { signal: AbortSignal.timeout(LIST_TIMEOUT_MS) }
    );
    res.status(status).json(body);
  });

  router.get('/gateways/:name/groups', requireGatewayAccess, async (req, res) => {
    const resolved = resolveGateway(inventory, req.params.name as string);
    if ('error' in resolved) {
      res.status(404).json({ error: resolved.error });
      return;
    }
    const { status, body } = await proxyToGateway(fetchImpl, resolved.ip, '/groups', {
      signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
    });
    res.status(status).json(body);
  });

  router.post('/gateways/:name/connect', requireGatewayAccess, async (req, res) => {
    const resolved = resolveGateway(inventory, req.params.name as string);
    if ('error' in resolved) {
      res.status(404).json({ error: resolved.error });
      return;
    }
    const { status, body } = await proxyToGateway(fetchImpl, resolved.ip, '/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        country: req.body?.country ?? '',
        city: req.body?.city ?? '',
        group: req.body?.group ?? '',
      }),
    });
    res.status(status).json(body);
  });

  return router;
}
