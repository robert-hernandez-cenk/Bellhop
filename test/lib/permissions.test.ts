import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  loadPermissionRules,
  savePermissionGroup,
  clearPermissionGroup,
  isAllowed,
  isGuestCreator,
  type GroupPermission,
} from '../../src/lib/permissions.ts';

function tempDbPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'bellhop-permissions-test-'));
  return path.join(dir, 'bellhop.db');
}

test('loadPermissionRules returns an empty map when no group has ever been configured', () => {
  const rules = loadPermissionRules(tempDbPath());
  assert.equal(rules.size, 0);
});

test('savePermissionGroup persists mode and resources, loadPermissionRules reads them back', () => {
  const dbPath = tempDbPath();
  const permission: GroupPermission = {
    mode: 'block-list',
    resources: [{ type: 'guest', name: 'stash-lxc' }],
  };
  savePermissionGroup(dbPath, 'family', permission);

  const rules = loadPermissionRules(dbPath);
  assert.deepEqual(rules.get('family'), permission);
});

test("savePermissionGroup replaces a group's previous rule entirely rather than merging", () => {
  const dbPath = tempDbPath();
  savePermissionGroup(dbPath, 'family', { mode: 'block-list', resources: [{ type: 'guest', name: 'stash-lxc' }] });
  savePermissionGroup(dbPath, 'family', { mode: 'allow-list', resources: [{ type: 'host', name: 'pve1' }] });

  const rules = loadPermissionRules(dbPath);
  assert.deepEqual(rules.get('family'), { mode: 'allow-list', resources: [{ type: 'host', name: 'pve1' }] });
});

test("savePermissionGroup does not affect a different group's rule", () => {
  const dbPath = tempDbPath();
  savePermissionGroup(dbPath, 'family', { mode: 'block-list', resources: [{ type: 'guest', name: 'stash-lxc' }] });
  savePermissionGroup(dbPath, 'guests', { mode: 'allow-list', resources: [] });

  const rules = loadPermissionRules(dbPath);
  assert.deepEqual(rules.get('family'), { mode: 'block-list', resources: [{ type: 'guest', name: 'stash-lxc' }] });
  assert.deepEqual(rules.get('guests'), { mode: 'allow-list', resources: [] });
});

test("clearPermissionGroup removes the group's rule entirely", () => {
  const dbPath = tempDbPath();
  savePermissionGroup(dbPath, 'family', { mode: 'block-list', resources: [{ type: 'guest', name: 'stash-lxc' }] });
  clearPermissionGroup(dbPath, 'family');

  const rules = loadPermissionRules(dbPath);
  assert.equal(rules.has('family'), false);
});

test('clearPermissionGroup on a group with no rule is a harmless no-op', () => {
  const dbPath = tempDbPath();
  clearPermissionGroup(dbPath, 'never-configured');
  assert.equal(loadPermissionRules(dbPath).size, 0);
});

test('isAllowed: a group with no rule allows everything', () => {
  const rules = new Map<string, GroupPermission>();
  assert.equal(isAllowed(rules, ['family'], { type: 'guest', name: 'stash-lxc' }), true);
});

test('isAllowed: allow-list mode only allows listed resources', () => {
  const rules = new Map<string, GroupPermission>([
    ['family', { mode: 'allow-list', resources: [{ type: 'guest', name: 'plex-lxc' }] }],
  ]);
  assert.equal(isAllowed(rules, ['family'], { type: 'guest', name: 'plex-lxc' }), true);
  assert.equal(isAllowed(rules, ['family'], { type: 'guest', name: 'stash-lxc' }), false);
});

test('isAllowed: block-list mode allows everything except listed resources', () => {
  const rules = new Map<string, GroupPermission>([
    ['family', { mode: 'block-list', resources: [{ type: 'guest', name: 'stash-lxc' }] }],
  ]);
  assert.equal(isAllowed(rules, ['family'], { type: 'guest', name: 'stash-lxc' }), false);
  assert.equal(isAllowed(rules, ['family'], { type: 'guest', name: 'plex-lxc' }), true);
});

test('isAllowed: resource type matters -- a rule for a guest does not match a host of the same name', () => {
  const rules = new Map<string, GroupPermission>([
    ['family', { mode: 'block-list', resources: [{ type: 'guest', name: 'pve1' }] }],
  ]);
  assert.equal(isAllowed(rules, ['family'], { type: 'host', name: 'pve1' }), true);
});

test('isAllowed: multiple groups intersect -- the most restrictive group wins', () => {
  const rules = new Map<string, GroupPermission>([
    ['family', { mode: 'block-list', resources: [{ type: 'guest', name: 'stash-lxc' }] }],
    ['open', { mode: 'block-list', resources: [] }],
  ]);
  assert.equal(isAllowed(rules, ['family', 'open'], { type: 'guest', name: 'stash-lxc' }), false);
  assert.equal(isAllowed(rules, ['family', 'open'], { type: 'guest', name: 'plex-lxc' }), true);
});

test('isAllowed: an allow-list group membership cannot be widened by a second, unrestricted group', () => {
  const rules = new Map<string, GroupPermission>([
    ['narrow', { mode: 'allow-list', resources: [{ type: 'guest', name: 'plex-lxc' }] }],
  ]);
  // 'wide' has no rule at all (unrestricted), but 'narrow' still limits access.
  assert.equal(isAllowed(rules, ['narrow', 'wide'], { type: 'guest', name: 'stash-lxc' }), false);
});

test('isAllowed: a user in no configured groups is unrestricted', () => {
  const rules = new Map<string, GroupPermission>([['family', { mode: 'allow-list', resources: [] }]]);
  assert.equal(isAllowed(rules, [], { type: 'guest', name: 'stash-lxc' }), true);
});

// issue #58: creator access (data-model.md "Access decision").

test('isGuestCreator: false while the caller is impersonating, even for the real creator', () => {
  assert.equal(
    isGuestCreator({ uid: 'uid-test-user', username: 'test-user' }, { username: 'test-user', uid: 'uid-test-user', impersonating: 'app-users' }),
    false
  );
});

test('isGuestCreator: false when the guest has no recorded creator', () => {
  assert.equal(isGuestCreator(undefined, { username: 'test-user', uid: 'uid-test-user' }), false);
});

test('isGuestCreator: compares uid when both sides have one, ignoring username', () => {
  // Same username, different uid: a different person reusing a name.
  assert.equal(isGuestCreator({ uid: 'uid-test-user', username: 'test-user' }, { username: 'test-user', uid: 'uid-other-user' }), false);
  // Different username, same uid: the creator after a rename.
  assert.equal(isGuestCreator({ uid: 'uid-test-user', username: 'test-user' }, { username: 'renamed-user', uid: 'uid-test-user' }), true);
});

test('isGuestCreator: compares username when either side lacks a uid', () => {
  assert.equal(isGuestCreator({ username: 'test-user' }, { username: 'test-user', uid: 'uid-test-user' }), true);
  assert.equal(isGuestCreator({ uid: 'uid-test-user', username: 'test-user' }, { username: 'test-user' }), true);
  assert.equal(isGuestCreator({ username: 'test-user' }, { username: 'other-user' }), false);
  assert.equal(isGuestCreator({ uid: 'uid-test-user', username: 'test-user' }, { username: 'other-user' }), false);
});

test('isGuestCreator: an empty caller username never matches', () => {
  assert.equal(isGuestCreator({ username: 'test-user' }, { username: '' }), false);
});

test('isAllowed: an allow-list group lets the creator through to an unlisted guest', () => {
  const rules = new Map<string, GroupPermission>([['app-users', { mode: 'allow-list', resources: [{ type: 'host', name: 'pve1' }] }]]);
  assert.equal(isAllowed(rules, ['app-users'], { type: 'guest', name: 'web-lxc' }, { isCreator: true }), true);
  assert.equal(isAllowed(rules, ['app-users'], { type: 'guest', name: 'web-lxc' }, { isCreator: false }), false);
});

test('isAllowed: the creator lift never applies to a host ref', () => {
  const rules = new Map<string, GroupPermission>([['app-users', { mode: 'allow-list', resources: [{ type: 'host', name: 'pve1' }] }]]);
  assert.equal(isAllowed(rules, ['app-users'], { type: 'host', name: 'pve2' }, { isCreator: true }), false);
});

test('isAllowed: an explicit block-list entry denies the creator', () => {
  const rules = new Map<string, GroupPermission>([['blocked', { mode: 'block-list', resources: [{ type: 'guest', name: 'web-lxc' }] }]]);
  assert.equal(isAllowed(rules, ['blocked'], { type: 'guest', name: 'web-lxc' }, { isCreator: true }), false);
  assert.equal(isAllowed(rules, ['blocked'], { type: 'guest', name: 'demo-vm' }, { isCreator: true }), true);
});

test('isAllowed: allow-list unlisted plus a block-list listing the guest denies the creator (explicit block wins)', () => {
  const rules = new Map<string, GroupPermission>([
    ['app-users', { mode: 'allow-list', resources: [{ type: 'host', name: 'pve1' }] }],
    ['blocked', { mode: 'block-list', resources: [{ type: 'guest', name: 'web-lxc' }] }],
  ]);
  assert.equal(isAllowed(rules, ['app-users', 'blocked'], { type: 'guest', name: 'web-lxc' }, { isCreator: true }), false);
});

test('isAllowed: allow-list listing the guest allows regardless of isCreator; omitted opts behaves as before', () => {
  const rules = new Map<string, GroupPermission>([['app-users', { mode: 'allow-list', resources: [{ type: 'guest', name: 'web-lxc' }] }]]);
  assert.equal(isAllowed(rules, ['app-users'], { type: 'guest', name: 'web-lxc' }, { isCreator: false }), true);
  assert.equal(isAllowed(rules, ['app-users'], { type: 'guest', name: 'web-lxc' }), true);
  assert.equal(isAllowed(rules, ['app-users'], { type: 'guest', name: 'media' }), false);
});
