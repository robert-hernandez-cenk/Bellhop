import { openDb } from './sqlite.ts';
import type { GuestCreator } from './inventory.ts';

export type PermissionMode = 'allow-list' | 'block-list';
export type ResourceType = 'host' | 'guest';

export interface ResourceRef {
  type: ResourceType;
  name: string;
}

export interface GroupPermission {
  mode: PermissionMode;
  resources: ResourceRef[];
}

// Independent of and never touched by inventory.ts's loadInventory/
// saveInventory -- lives in the same bellhop.db file, but as its own
// tables outside saveInventory's DELETE FROM .../re-insert list, so a
// permission rule survives a sync-inventory --apply run untouched.
const PERMISSIONS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS permission_groups (
    group_name TEXT PRIMARY KEY,
    mode TEXT NOT NULL CHECK (mode IN ('allow-list', 'block-list'))
  );
  CREATE TABLE IF NOT EXISTS permission_rules (
    group_name TEXT NOT NULL REFERENCES permission_groups(group_name) ON DELETE CASCADE,
    resource_type TEXT NOT NULL CHECK (resource_type IN ('host', 'guest')),
    resource_name TEXT NOT NULL,
    PRIMARY KEY (group_name, resource_type, resource_name)
  );
`;

function openPermissionsDb(path: string) {
  return openDb(path, PERMISSIONS_SCHEMA);
}

interface PermissionGroupRow {
  group_name: string;
  mode: PermissionMode;
}

interface PermissionRuleRow {
  group_name: string;
  resource_type: ResourceType;
  resource_name: string;
}

// Loads every group that has an explicit rule configured. A group with no
// row here is unrestricted -- see isAllowed's default-open behavior below.
export function loadPermissionRules(path: string): Map<string, GroupPermission> {
  const db = openPermissionsDb(path);
  try {
    const groupRows = db.prepare('SELECT group_name, mode FROM permission_groups').all() as PermissionGroupRow[];
    const ruleRows = db
      .prepare('SELECT group_name, resource_type, resource_name FROM permission_rules')
      .all() as PermissionRuleRow[];
    const result = new Map<string, GroupPermission>();
    for (const row of groupRows) {
      result.set(row.group_name, { mode: row.mode, resources: [] });
    }
    for (const row of ruleRows) {
      const perm = result.get(row.group_name);
      if (perm) perm.resources.push({ type: row.resource_type, name: row.resource_name });
    }
    return result;
  } finally {
    db.close();
  }
}

// Replaces a single group's mode + resource list in one transaction --
// never touches any other group's rows.
export function savePermissionGroup(path: string, groupName: string, permission: GroupPermission): void {
  const db = openPermissionsDb(path);
  try {
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM permission_rules WHERE group_name = ?').run(groupName);
      db.prepare('DELETE FROM permission_groups WHERE group_name = ?').run(groupName);
      db.prepare('INSERT INTO permission_groups (group_name, mode) VALUES (?, ?)').run(groupName, permission.mode);
      const insertRule = db.prepare(
        'INSERT INTO permission_rules (group_name, resource_type, resource_name) VALUES (?, ?, ?)'
      );
      for (const resource of permission.resources) {
        insertRule.run(groupName, resource.type, resource.name);
      }
    });
    tx();
  } finally {
    db.close();
  }
}

// Clears a group's rule entirely -- it goes back to unrestricted, the same
// state every group starts in. permission_rules rows cascade-delete via
// ON DELETE CASCADE (foreign_keys is on for this connection).
export function clearPermissionGroup(path: string, groupName: string): void {
  const db = openPermissionsDb(path);
  try {
    db.prepare('DELETE FROM permission_groups WHERE group_name = ?').run(groupName);
  } finally {
    db.close();
  }
}

// The caller fields isGuestCreator reads -- a structural subset of
// src/web/auth.ts's AuthUser, so a request's req.user fits directly.
export interface CreatorCaller {
  username: string;
  uid?: string;
  impersonating?: string;
}

// Whether `caller` is the person recorded as a guest's creator (issue #58).
// Never true while the caller is impersonating a group: impersonation shows
// exactly that group's view, so the admin's own creator access must not
// leak into it. When both sides carry the identity provider's stable uid,
// the uid decides (a renamed user keeps access; a new user reusing an old
// name gets none); otherwise the username does. An empty caller username
// never matches.
export function isGuestCreator(creator: GuestCreator | undefined, caller: CreatorCaller): boolean {
  if (caller.impersonating) return false;
  if (!creator) return false;
  if (creator.uid && caller.uid) return creator.uid === caller.uid;
  return caller.username !== '' && creator.username === caller.username;
}

// Pure, synchronous effective-access computation -- no DB/network calls.
// A caller's access is the intersection across every group they belong to:
// a group with no row in `rules` allows everything; an allow-list group
// allows only what's listed; a block-list group allows everything except
// what's listed. One restrictive group can only narrow access, never widen
// it via another, more permissive group. Callers needing admin bypass
// (bellhop-admins / authentik Admins) must check that themselves
// before calling this -- see src/web/access.ts's isAdmin.
//
// Creator lift (issue #58): `opts.isCreator` (see isGuestCreator) makes an
// allow-list group treat a *guest* ref as listed, so a guest's creator can
// reach it without an admin adding it to their group. It never applies to
// a host ref, and never to a block-list group: an explicit block wins, so
// an admin can still take a guest away from the person who made it.
// Omitting `opts` behaves exactly as before.
export function isAllowed(
  rules: Map<string, GroupPermission>,
  groups: string[],
  ref: ResourceRef,
  opts: { isCreator?: boolean } = {}
): boolean {
  const creatorLift = ref.type === 'guest' && opts.isCreator === true;
  for (const groupName of groups) {
    const perm = rules.get(groupName);
    if (!perm) continue;
    const listed = perm.resources.some((r) => r.type === ref.type && r.name === ref.name);
    const allowedByThisGroup = perm.mode === 'allow-list' ? listed || creatorLift : !listed;
    if (!allowedByThisGroup) return false;
  }
  return true;
}
