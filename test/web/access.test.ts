import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isAdmin, isResourceAllowed, filterInventoryForUser, requireResourceAccess } from '../../src/web/access.ts';
import { savePermissionGroup } from '../../src/lib/permissions.ts';
import type { Inventory } from '../../src/lib/inventory.ts';

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
  assert.equal(isResourceAllowed(dbPath, ['bellhop-admins'], { type: 'guest', name: 'stash-lxc' }), true);
});

test('isResourceAllowed: admin bypass wins even when caller also belongs to a restrictive group', () => {
  const dbPath = tempDbPath();
  savePermissionGroup(dbPath, 'family', { mode: 'block-list', resources: [{ type: 'guest', name: 'stash-lxc' }] });
  assert.equal(isResourceAllowed(dbPath, ['bellhop-admins', 'family'], { type: 'guest', name: 'stash-lxc' }), true);
});

test("isResourceAllowed: a non-admin group's block-list rule is enforced", () => {
  const dbPath = tempDbPath();
  savePermissionGroup(dbPath, 'family', { mode: 'block-list', resources: [{ type: 'guest', name: 'stash-lxc' }] });
  assert.equal(isResourceAllowed(dbPath, ['family'], { type: 'guest', name: 'stash-lxc' }), false);
  assert.equal(isResourceAllowed(dbPath, ['family'], { type: 'guest', name: 'plex-lxc' }), true);
});

test('filterInventoryForUser: admin sees every host and guest unfiltered', () => {
  const dbPath = tempDbPath();
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
    guests: [{ name: 'stash-lxc', type: 'lxc', vmid: 4001, host: 'pve1' }],
  };
  const result = filterInventoryForUser(dbPath, ['bellhop-admins'], inventory);
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
  const result = filterInventoryForUser(dbPath, ['family'], inventory);
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
    requireResourceAccess(dbPath, (req) => (req.body?.guest ? { type: 'guest', name: req.body.guest } : undefined)),
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
