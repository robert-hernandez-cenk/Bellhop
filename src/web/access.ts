import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { Inventory, HostEntry, GuestEntry } from '../lib/inventory.ts';
import { loadPermissionRules, isAllowed as isAllowedByRules } from '../lib/permissions.ts';
import type { ResourceRef } from '../lib/permissions.ts';
import { isAdminUser } from './auth.ts';

export type { ResourceRef } from '../lib/permissions.ts';

export function isAdmin(groups: string[]): boolean {
  return isAdminUser(groups);
}

// Admin bypass first, then the per-resource rules -- see isAllowed in
// src/lib/permissions.ts for how multiple groups' rules combine.
export function isResourceAllowed(inventoryPath: string, groups: string[], ref: ResourceRef): boolean {
  if (isAdmin(groups)) return true;
  const rules = loadPermissionRules(inventoryPath);
  return isAllowedByRules(rules, groups, ref);
}

export function filterInventoryForUser(
  inventoryPath: string,
  groups: string[],
  inventory: Inventory
): { hosts: HostEntry[]; guests: GuestEntry[] } {
  if (isAdmin(groups)) return { hosts: inventory.hosts, guests: inventory.guests };
  const rules = loadPermissionRules(inventoryPath);
  return {
    hosts: inventory.hosts.filter((h) => isAllowedByRules(rules, groups, { type: 'host', name: h.name })),
    guests: inventory.guests.filter((g) => isAllowedByRules(rules, groups, { type: 'guest', name: g.name })),
  };
}

// Express middleware factory: resolveRef pulls the target resource (host or
// guest name) out of the request, e.g. `(req) => req.body.guest ? { type:
// 'guest', name: req.body.guest } : undefined`. Returning undefined (no
// target on this request, e.g. a field left blank) skips the check and lets
// the route's own validation reject it instead -- this middleware only ever
// says no to a *resolved* target the caller can't access.
export function requireResourceAccess(
  inventoryPath: string,
  resolveRef: (req: Request) => ResourceRef | undefined
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ref = resolveRef(req);
    if (!ref) {
      next();
      return;
    }
    const groups = req.user?.groups ?? [];
    if (!isResourceAllowed(inventoryPath, groups, ref)) {
      res.status(403).json({ error: `forbidden: no access to ${ref.type} '${ref.name}'` });
      return;
    }
    next();
  };
}
