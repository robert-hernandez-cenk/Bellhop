import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { Inventory, HostEntry, GuestEntry, GuestCreator } from '../lib/inventory.ts';
import { loadPermissionRules, isAllowed as isAllowedByRules, isGuestCreator } from '../lib/permissions.ts';
import type { CreatorCaller, ResourceRef } from '../lib/permissions.ts';
import { isAdminUser } from './auth.ts';

export type { ResourceRef } from '../lib/permissions.ts';

// Who is asking -- a structural subset of AuthUser (src/web/auth.ts), so
// req.user fits directly. `groups` drives the group rules; username/uid/
// impersonating drive the creator lift (issue #58, isGuestCreator). Use
// req.user (the overlaid identity), never req.realUser, so an active
// impersonation sets `impersonating` and switches the creator lift off.
export interface AccessCaller extends CreatorCaller {
  groups: string[];
}

// Stand-in for a request with no req.user (unreachable behind requireAuth):
// no groups, and an empty username that can never match a creator.
export const ANONYMOUS_CALLER: AccessCaller = { groups: [], username: '' };

export function isAdmin(groups: string[]): boolean {
  return isAdminUser(groups);
}

function isCreatorOf(inventory: Pick<Inventory, 'guests'>, caller: AccessCaller, ref: ResourceRef): boolean {
  if (ref.type !== 'guest') return false;
  return isGuestCreator(inventory.guests.find((g) => g.name === ref.name)?.creator, caller);
}

// Guest name -> recorded creator, for checks that only have a name to go on
// (job visibility, src/web/routes/jobs.ts's isJobVisible). Built once per
// request from the in-memory inventory.
//
// A guest whose name is also a host name is left out (#58 final review): a
// job's target is an untyped name and the guest-creating commands target a
// *host*, so including it would let someone create a guest named like a host
// they can't access and then see and control every job on that host. Its
// creator still reaches the guest itself through isResourceAllowed/
// filterInventoryForUser, which have a typed ref; only the name-keyed job
// lift is withheld. Not a validateInventory rule, since that could make an
// already-saved inventory unloadable.
export function guestCreators(inventory: Pick<Inventory, 'guests' | 'hosts'>): Map<string, GuestCreator> {
  const hostNames = new Set(inventory.hosts.map((h) => h.name));
  const result = new Map<string, GuestCreator>();
  for (const guest of inventory.guests) {
    if (guest.creator && !hostNames.has(guest.name)) result.set(guest.name, guest.creator);
  }
  return result;
}

// Admin bypass first, then the per-resource rules -- see isAllowed in
// src/lib/permissions.ts for how multiple groups' rules combine and how a
// guest's creator is let through allow-list groups.
export function isResourceAllowed(
  inventoryPath: string,
  inventory: Pick<Inventory, 'guests'>,
  caller: AccessCaller,
  ref: ResourceRef
): boolean {
  if (isAdmin(caller.groups)) return true;
  const rules = loadPermissionRules(inventoryPath);
  return isAllowedByRules(rules, caller.groups, ref, { isCreator: isCreatorOf(inventory, caller, ref) });
}

export function filterInventoryForUser(
  inventoryPath: string,
  caller: AccessCaller,
  inventory: Inventory
): { hosts: HostEntry[]; guests: GuestEntry[] } {
  if (isAdmin(caller.groups)) return { hosts: inventory.hosts, guests: inventory.guests };
  const rules = loadPermissionRules(inventoryPath);
  return {
    hosts: inventory.hosts.filter((h) => isAllowedByRules(rules, caller.groups, { type: 'host', name: h.name })),
    guests: inventory.guests.filter((g) =>
      isAllowedByRules(rules, caller.groups, { type: 'guest', name: g.name }, { isCreator: isGuestCreator(g.creator, caller) })
    ),
  };
}

// Express middleware factory: resolveRef pulls the target resource (host or
// guest name) out of the request, e.g. `(req) => req.body.guest ? { type:
// 'guest', name: req.body.guest } : undefined`. Returning undefined (no
// target on this request, e.g. a field left blank) skips the check and lets
// the route's own validation reject it instead -- this middleware only ever
// says no to a *resolved* target the caller can't access. `inventory` is the
// route's shared, per-request-refreshed object, read for a guest's creator.
export function requireResourceAccess(
  inventoryPath: string,
  inventory: Pick<Inventory, 'guests'>,
  resolveRef: (req: Request) => ResourceRef | undefined
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ref = resolveRef(req);
    if (!ref) {
      next();
      return;
    }
    if (!isResourceAllowed(inventoryPath, inventory, req.user ?? ANONYMOUS_CALLER, ref)) {
      res.status(403).json({ error: `forbidden: no access to ${ref.type} '${ref.name}'` });
      return;
    }
    next();
  };
}
