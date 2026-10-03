import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isAdmin, isResourceAllowed, filterInventoryForUser, requireResourceAccess, guestCreators } from '../../src/web/access.ts';
import { savePermissionGroup } from '../../src/lib/permissions.ts';
import type { Inventory } from '../../src/lib/inventory.ts';

const emptyInventory: Inventory = { domain: 'example.com', hosts: [], guests: [] };

function tempDbPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'bellhop-access-test-'));
  return path.join(dir, 'bellhop.db');
}

test("isAdmin recognizes both the app admin group and Authentik's built-in admin group", () => {
  assert.equal(isAdmin(['bellhop-admins']), true);
  assert.equal(isAdmin(['authentik Admins']), true);
  assert.equal(isAdmin(['someone-else']), false);
  assert.equal(isAdmin([]), false);
});

test('isResourceAllowed: admin bypasses any configured rule', () => {
  const dbPath = tempDbPath();
  savePermissionGroup(dbPath, 'bellhop-admins', { mode: 'allow-list', resources: [] });
  assert.equal(isResourceAllowed(dbPath, emptyInventory, { username: 'test', groups: ['bellhop-admins'] }, { type: 'guest', name: 'stash-lxc' }), true);
});

test('isResourceAllowed: admin bypass wins even when caller also belongs to a restrictive group', () => {
  const dbPath = tempDbPath();
  savePermissionGroup(dbPath, 'family', { mode: 'block-list', resources: [{ type: 'guest', name: 'stash-lxc' }] });
  assert.equal(isResourceAllowed(dbPath, emptyInventory, { username: 'test', groups: ['bellhop-admins', 'family'] }, { type: 'guest', name: 'stash-lxc' }), true);
});

test("isResourceAllowed: a non-admin group's block-list rule is enforced", () => {
  const dbPath = tempDbPath();
  savePermissionGroup(dbPath, 'family', { mode: 'block-list', resources: [{ type: 'guest', name: 'stash-lxc' }] });
  assert.equal(isResourceAllowed(dbPath, emptyInventory, { username: 'test', groups: ['family'] }, { type: 'guest', name: 'stash-lxc' }), false);
  assert.equal(isResourceAllowed(dbPath, emptyInventory, { username: 'test', groups: ['family'] }, { type: 'guest', name: 'plex-lxc' }), true);
});

test('filterInventoryForUser: admin sees every host and guest unfiltered', () => {
  const dbPath = tempDbPath();
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
    guests: [{ name: 'stash-lxc', type: 'lxc', vmid: 4001, host: 'pve1' }],
  };
  const result = filterInventoryForUser(dbPath, { username: 'test', groups: ['bellhop-admins'] }, inventory);
  assert.equal(result.hosts.length, 1);
  assert.equal(result.guests.length, 1);
});

test('filterInventoryForUser: a restricted group only sees resources its rule allows', () => {
  const dbPath = tempDbPath();
  savePermissionGroup(dbPath, 'family', { mode: 'block-list', resources: [{ type: 'guest', name: 'stash-lxc' }] });
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
    guests: [
      { name: 'stash-lxc', type: 'lxc', vmid: 4001, host: 'pve1' },
      { name: 'plex-lxc', type: 'lxc', vmid: 4002, host: 'pve1' },
    ],
  };
  const result = filterInventoryForUser(dbPath, { username: 'test', groups: ['family'] }, inventory);
  assert.equal(result.hosts.length, 1);
  assert.deepEqual(result.guests.map((g) => g.name), ['plex-lxc']);
});

function testMiddlewareApp(dbPath: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const groupsHeader = req.headers['x-groups'];
    req.user = { username: 'test', groups: typeof groupsHeader === 'string' ? groupsHeader.split('|') : [] };
    next();
  });
  app.post(
    '/act',
    requireResourceAccess(dbPath, emptyInventory, (req) => (req.body?.guest ? { type: 'guest', name: req.body.guest } : undefined)),
    (_req, res) => res.json({ ok: true })
  );
  return app;
}

test('requireResourceAccess allows the request through when the target is accessible', async () => {
  const dbPath = tempDbPath();
  const app = testMiddlewareApp(dbPath);
  const res = await request(app).post('/act').set('x-groups', 'family').send({ guest: 'plex-lxc' });
  assert.equal(res.status, 200);
});

test('requireResourceAccess rejects with 403 when the target is blocked', async () => {
  const dbPath = tempDbPath();
  savePermissionGroup(dbPath, 'family', { mode: 'block-list', resources: [{ type: 'guest', name: 'stash-lxc' }] });
  const app = testMiddlewareApp(dbPath);
  const res = await request(app).post('/act').set('x-groups', 'family').send({ guest: 'stash-lxc' });
  assert.equal(res.status, 403);
  assert.match(res.body.error, /stash-lxc/);
});

test('requireResourceAccess skips the check when resolveRef returns undefined', async () => {
  const dbPath = tempDbPath();
  const app = testMiddlewareApp(dbPath);
  const res = await request(app).post('/act').send({});
  assert.equal(res.status, 200);
});

test('isAdmin follows a configured admin group name', () => {
  const original = process.env.AUTHENTIK_ADMIN_GROUP;
  process.env.AUTHENTIK_ADMIN_GROUP = 'my-admins';
  try {
    assert.equal(isAdmin(['my-admins']), true);
    assert.equal(isAdmin(['bellhop-admins']), false);
    // The built-in group is configured separately and still applies.
    assert.equal(isAdmin(['authentik Admins']), true);
  } finally {
    if (original === undefined) delete process.env.AUTHENTIK_ADMIN_GROUP;
    else process.env.AUTHENTIK_ADMIN_GROUP = original;
  }
});

// issue #58: creator access. app-users is an allow-list group naming only
// host pve1; web-lxc was created by test-user.
const creatorInventory: Inventory = {
  domain: 'example.com',
  hosts: [
    { name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' },
    { name: 'pve2', ssh_target: 'pve2.local', ssh_user: 'root' },
  ],
  guests: [
    { name: 'web-lxc', type: 'lxc', vmid: 4001, host: 'pve1', creator: { uid: 'uid-test-user', username: 'test-user' } },
    { name: 'media', type: 'lxc', vmid: 4002, host: 'pve1' },
  ],
};

function creatorDbPath(): string {
  const dbPath = tempDbPath();
  savePermissionGroup(dbPath, 'app-users', { mode: 'allow-list', resources: [{ type: 'host', name: 'pve1' }] });
  return dbPath;
}

test('filterInventoryForUser: includes a guest the caller created despite an allow-list that does not list it', () => {
  const dbPath = creatorDbPath();
  const result = filterInventoryForUser(dbPath, { username: 'test-user', uid: 'uid-test-user', groups: ['app-users'] }, creatorInventory);
  assert.deepEqual(result.guests.map((g) => g.name), ['web-lxc']);
  assert.deepEqual(result.hosts.map((h) => h.name), ['pve1']);
});

test('filterInventoryForUser: excludes the created guest for another user in the same group', () => {
  const dbPath = creatorDbPath();
  const result = filterInventoryForUser(dbPath, { username: 'other-user', groups: ['app-users'] }, creatorInventory);
  assert.deepEqual(result.guests.map((g) => g.name), []);
});

test('filterInventoryForUser: excludes the created guest while the creator is impersonating', () => {
  const dbPath = creatorDbPath();
  const result = filterInventoryForUser(
    dbPath,
    { username: 'test-user', uid: 'uid-test-user', groups: ['app-users'], impersonating: 'app-users' },
    creatorInventory
  );
  assert.deepEqual(result.guests.map((g) => g.name), []);
});

test('isResourceAllowed: allows the creator and refuses another user; never lifts a host ref', () => {
  const dbPath = creatorDbPath();
  const creator = { username: 'test-user', uid: 'uid-test-user', groups: ['app-users'] };
  assert.equal(isResourceAllowed(dbPath, creatorInventory, creator, { type: 'guest', name: 'web-lxc' }), true);
  assert.equal(isResourceAllowed(dbPath, creatorInventory, { username: 'other-user', groups: ['app-users'] }, { type: 'guest', name: 'web-lxc' }), false);
  assert.equal(isResourceAllowed(dbPath, creatorInventory, creator, { type: 'host', name: 'pve2' }), false);
});

test('isResourceAllowed: admin bypass is unchanged for a guest with a creator', () => {
  const dbPath = creatorDbPath();
  assert.equal(
    isResourceAllowed(dbPath, creatorInventory, { username: 'admin', groups: ['bellhop-admins', 'app-users'] }, { type: 'guest', name: 'web-lxc' }),
    true
  );
});

function creatorMiddlewareApp(dbPath: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const username = req.headers['x-user'];
    req.user = { username: typeof username === 'string' ? username : '', groups: ['app-users'] };
    next();
  });
  app.post(
    '/act',
    requireResourceAccess(dbPath, creatorInventory, (req) => ({ type: 'guest', name: req.body.guest })),
    (_req, res) => res.json({ ok: true })
  );
  return app;
}

test('requireResourceAccess allows the creator and 403s another user in the same allow-list group', async () => {
  const app = creatorMiddlewareApp(creatorDbPath());
  const ok = await request(app).post('/act').set('x-user', 'test-user').send({ guest: 'web-lxc' });
  assert.equal(ok.status, 200);
  const denied = await request(app).post('/act').set('x-user', 'other-user').send({ guest: 'web-lxc' });
  assert.equal(denied.status, 403);
});

// Final review (#58), finding 1: a job target is an untyped name, so a guest
// whose name equals a host name must never feed the job-visibility creator
// lift -- guestCreators leaves it out entirely.
test('guestCreators maps guest name to creator, excluding guests with no creator and any guest named like a host', () => {
  const inventory: Inventory = {
    ...creatorInventory,
    guests: [
      ...creatorInventory.guests,
      { name: 'pve2', type: 'lxc', vmid: 4003, host: 'pve1', creator: { uid: 'uid-test-user', username: 'test-user' } },
    ],
  };
  const creators = guestCreators(inventory);
  assert.deepEqual([...creators.keys()], ['web-lxc']);
  assert.deepEqual(creators.get('web-lxc'), { uid: 'uid-test-user', username: 'test-user' });
  assert.equal(creators.has('pve2'), false);
});
