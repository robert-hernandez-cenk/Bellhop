import { z } from 'zod';
import type { GuestEntry } from '../lib/inventory.ts';
import {
  saveInventory,
  parseSubdomains,
  parsePort,
  parseAuthGroup,
  parseUnauthenticatedPaths,
  validateInventory,
} from '../lib/inventory.ts';
import { probeInsecureBackendTls } from '../lib/tls-probe.ts';
import { syncCaddyLive } from '../web/caddy-sync.ts';
import type { OffLadderEntry } from '../commands/networking/sync-authentik.ts';
import type { OperationDeps } from './types.ts';

// The Dashboard's inline guest edit, extracted from the PATCH handler in
// src/web/routes/dashboard.ts so the MCP server's edit_guest tool runs the
// same parse -> validate -> probe -> save -> push-live sequence (#16). The
// caller-identity checks (who may lower an auth tier or add a path
// exemption) stay in the route: the MCP server always runs as the local
// operator, who is admin.

export class GuestEditValidationError extends Error {}

export type EditGuestResult =
  | {
      guest: GuestEntry;
      caddySynced: true;
      authentikConflicts?: string[];
      authentikOffLadder?: OffLadderEntry[];
      authentikMissingRungs?: string[];
    }
  | { guest: GuestEntry; caddySynced: false; caddyError: string };

// The web form sends ';'-joined strings; MCP clients may send arrays and
// numbers. Normalize to what the parse* helpers accept.
const asDelimited = (v: unknown): unknown => (Array.isArray(v) ? v.join(';') : v);

export function applyGuestEdits(current: GuestEntry, body: Record<string, unknown>): GuestEntry {
  const updated = { ...current };
  if ('subdomains' in body) updated.subdomains = parseSubdomains(asDelimited(body.subdomains));
  if ('port' in body) updated.port = parsePort(typeof body.port === 'number' ? String(body.port) : body.port);
  if ('caddyManual' in body) updated.caddyManual = !!body.caddyManual;
  if ('insecureBackendTls' in body) updated.insecureBackendTls = !!body.insecureBackendTls;
  if ('authGroup' in body) updated.authGroup = parseAuthGroup(body.authGroup);
  if ('unauthenticatedPaths' in body) updated.unauthenticatedPaths = parseUnauthenticatedPaths(asDelimited(body.unauthenticatedPaths));
  return updated;
}

// Validated the same way any other inventory write is (subdomains requires
// ip unless caddyManual is set, no two entries sharing a subdomain) before
// it's ever written to disk. A successful write always also pushes the
// change live (Caddyfile + status page) via syncCaddyLive -- reported back
// separately (caddySynced/caddyError) rather than failing the whole
// request, since the inventory write itself already succeeded and
// shouldn't be reported as rejected just because the live push failed.
export async function commitGuestEdit(
  deps: OperationDeps,
  name: string,
  updated: GuestEntry,
  touchedRouting: boolean
): Promise<EditGuestResult> {
  const { inventory } = deps;
  const idx = inventory.guests.findIndex((g) => g.name === name);
  if (idx === -1) throw new Error(`Unknown guest: ${name}`);
  const guests = inventory.guests.map((g, i) => (i === idx ? updated : g));

  const errors = validateInventory({ ...inventory, guests });
  if (errors.length > 0) throw new GuestEditValidationError(errors.join('\n'));

  // Only when this edit actually touched subdomains or port (an
  // insecureBackendTls/caddyManual/authGroup-only edit never
  // re-probes), and the resulting entry has a concrete ip+port+
  // subdomains combo to test, and isn't caddyManual (which never gets
  // a generated Caddy block at all, so insecureBackendTls on it is
  // inert). A conclusive result overwrites updated.insecureBackendTls
  // even if this same request also submitted a value for it --
  // mutating `updated` here is visible through `guests` above since
  // they share the same object reference.
  if (
    touchedRouting &&
    updated.port !== undefined &&
    updated.ip &&
    updated.subdomains &&
    updated.subdomains.length > 0 &&
    !updated.caddyManual
  ) {
    const probe = await probeInsecureBackendTls(deps.ssh, inventory, updated.host, updated.ip, updated.port);
    if (probe !== 'inconclusive') {
      updated.insecureBackendTls = probe === 'insecure';
    }
  }

  saveInventory(deps.inventoryPath, { ...inventory, guests });
  inventory.guests = guests;

  try {
    const { authentikConflicts, authentikOffLadder, authentikMissingRungs } = await syncCaddyLive({
      ssh: deps.ssh,
      inventory,
      authentik: deps.authentik,
      cloudflare: deps.cloudflare,
    });
    // Conflicts are computed inventory-wide, but this response belongs to
    // one guest -- surfacing another entry's conflict here would render a
    // banner on the edited row that is not about it. The full list still
    // goes to logWarn in syncCaddyLive.
    // Compared against the slug directly: syncCaddyLive's conflict list
    // holds bare slugs (issue #156). Rebuilding `<slug>.<domain>` here
    // would match nothing and silently stop rendering the banner.
    const ownConflict = updated.subdomains?.[0];
    const ownConflicts = ownConflict ? authentikConflicts.filter((c) => c === ownConflict) : [];
    // Scoped to this guest for the same reason ownConflicts is: another
    // entry's misconfiguration must not render a banner on this row.
    const ownOffLadder = ownConflict ? authentikOffLadder.filter((o) => o.slug === ownConflict) : [];
    return {
      guest: updated,
      caddySynced: true,
      // Omitted when empty so the ordinary response shape is unchanged
      // for every edit that produces no conflict.
      ...(ownConflicts.length > 0 ? { authentikConflicts: ownConflicts } : {}),
      // Same conditional-spread convention as authentikConflicts above.
      ...(ownOffLadder.length > 0 ? { authentikOffLadder: ownOffLadder } : {}),
      // NOT scoped -- a missing rung is about AUTHENTIK_GROUP_LADDER
      // itself, not about any one entry. Same conditional-spread
      // convention as authentikConflicts above.
      ...(authentikMissingRungs.length > 0 ? { authentikMissingRungs } : {}),
    };
  } catch (err) {
    return { guest: updated, caddySynced: false, caddyError: err instanceof Error ? err.message : String(err) };
  }
}

export const EDIT_GUEST_SHAPE = {
  name: z.string().describe('Guest name'),
  subdomains: z.union([z.string(), z.array(z.string())]).optional().describe("Subdomains (array or ';'-separated); empty clears"),
  port: z.union([z.number().int(), z.string()]).optional().describe('Backend port; empty string clears'),
  caddyManual: z.boolean().optional().describe('Caddy block is hand-authored outside the managed section'),
  insecureBackendTls: z.boolean().optional().describe('Backend serves untrusted/self-signed TLS'),
  authGroup: z.string().nullable().optional().describe('Authentik group ladder rung; null or empty clears the gate'),
  unauthenticatedPaths: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe("Caddy path globs exempt from forward-auth (array or ';'-separated)"),
};

export async function runEditGuest(input: { name: string } & Record<string, unknown>, deps: OperationDeps): Promise<EditGuestResult> {
  const { name, ...fields } = input;
  const current = deps.inventory.guests.find((g) => g.name === name);
  if (!current) throw new Error(`Unknown guest: ${name}`);
  const updated = applyGuestEdits(current, fields);
  return commitGuestEdit(deps, name, updated, 'subdomains' in fields || 'port' in fields);
}
