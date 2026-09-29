import type { Inventory } from '../lib/inventory.ts';

// Shared implementation behind both the web UI's /api/networking/gateways/*
// routes (src/web/routes/networking.ts) and the MCP server's gateway tools
// (issue #7, FR-003) -- moved out of the web route so both front ends call
// the exact same code rather than the MCP tools re-implementing it. Not an
// Operation: four of these five actions are reads, and connect is
// deliberately immediate with no preview/job (research R1).

type GatewayResolution = { ip: string } | { error: string };

// Every action's result: `ok: true` carries the gateway's own JSON body
// unchanged; `ok: false` distinguishes a local "not-found" (unknown
// gateway, or one with no ip -- never reaches the network) from an
// "upstream" failure (the fetch itself threw, or the gateway answered
// non-2xx). `error` is the message a caller should show; `body` is always
// present so a web route can respond with it unchanged (research R2).
export type GatewayResult =
  | { ok: true; body: unknown }
  | { ok: false; kind: 'not-found' | 'upstream'; error: string; body: unknown };

// /status reads local agent state and is polled every 10s (GatewayCard.tsx),
// so a short timeout is fine -- missing one poll is invisible. /servers,
// /cities, and /groups instead trigger a *live* upstream call from inside
// the gateway container out to the VPN provider's own API, and are each a
// one-shot page-load fetch with no retry -- a cold first connection from the
// web service process to a gateway it hasn't talked to recently was observed
// live taking up to ~5s on its own (issue #145), so they get a longer budget.
export const STATUS_TIMEOUT_MS = 5_000;
export const LIST_TIMEOUT_MS = 15_000;

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
// (gateway unreachable) and a non-2xx response from the gateway itself into
// the same GatewayResult shape, so callers below don't each need their own
// try/catch.
async function callGateway(fetchImpl: typeof fetch, gatewayIp: string, name: string, path: string, init?: RequestInit): Promise<GatewayResult> {
  let response: Response;
  try {
    response = await fetchImpl(`http://${gatewayIp}:8080${path}`, init);
  } catch (err) {
    const error = `Failed to reach gateway at ${gatewayIp}:8080 -- ${err instanceof Error ? err.message : String(err)}`;
    return { ok: false, kind: 'upstream', error, body: { error } };
  }
  if (response.ok) {
    return { ok: true, body: await response.json().catch(() => ({})) };
  }
  const body = await response.json().catch(() => ({}));
  const bodyError = body && typeof body === 'object' && 'error' in body ? (body as { error: unknown }).error : undefined;
  const error = typeof bodyError === 'string' && bodyError.length > 0 ? bodyError : `VPN gateway ${name} returned HTTP ${response.status}`;
  return { ok: false, kind: 'upstream', error, body };
}

function notFound(error: string): GatewayResult {
  return { ok: false, kind: 'not-found', error, body: { error } };
}

export async function gatewayStatus(inventory: Inventory, name: string, fetchImpl: typeof fetch): Promise<GatewayResult> {
  const resolved = resolveGateway(inventory, name);
  if ('error' in resolved) return notFound(resolved.error);
  return callGateway(fetchImpl, resolved.ip, name, '/status', { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
}

export async function gatewayServers(inventory: Inventory, name: string, fetchImpl: typeof fetch): Promise<GatewayResult> {
  const resolved = resolveGateway(inventory, name);
  if ('error' in resolved) return notFound(resolved.error);
  return callGateway(fetchImpl, resolved.ip, name, '/servers', { signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
}

export async function gatewayCities(inventory: Inventory, name: string, country: string, fetchImpl: typeof fetch): Promise<GatewayResult> {
  const resolved = resolveGateway(inventory, name);
  if ('error' in resolved) return notFound(resolved.error);
  return callGateway(fetchImpl, resolved.ip, name, `/cities?country=${encodeURIComponent(country)}`, {
    signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
  });
}

export async function gatewayGroups(inventory: Inventory, name: string, fetchImpl: typeof fetch): Promise<GatewayResult> {
  const resolved = resolveGateway(inventory, name);
  if ('error' in resolved) return notFound(resolved.error);
  return callGateway(fetchImpl, resolved.ip, name, '/groups', { signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
}

export async function connectGateway(
  inventory: Inventory,
  name: string,
  selection: { country?: string; city?: string; group?: string },
  fetchImpl: typeof fetch
): Promise<GatewayResult> {
  const resolved = resolveGateway(inventory, name);
  if ('error' in resolved) return notFound(resolved.error);
  // No timeout (research R4): connect runs `wg-quick down/up` plus a
  // public-IP lookup on the gateway, which can legitimately take a while --
  // aborting it partway through could tear down a switch that was actually
  // succeeding, so this is the one call that gets no AbortSignal.
  return callGateway(fetchImpl, resolved.ip, name, '/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      country: selection.country ?? '',
      city: selection.city ?? '',
      group: selection.group ?? '',
    }),
  });
}
