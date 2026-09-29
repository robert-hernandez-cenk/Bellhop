import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadInventory, saveInventory, effectiveAuth } from '../../../src/lib/inventory.ts';
import { buildDemoInventory } from '../../../scripts/demo/demo-inventory.ts';

function tempDbPath(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'bellhop-demo-inventory-')), 'bellhop.db');
}

test('buildDemoInventory saves and loads back through the real inventory schema', () => {
  const inv = buildDemoInventory();
  const dbPath = tempDbPath();
  // saveInventory/loadInventory both run validateInventory (loadInventory
  // does so on every read) -- a thrown error here means the demo inventory
  // itself is invalid, which should fail this test rather than surface only
  // once someone runs `npm run demo`.
  assert.doesNotThrow(() => saveInventory(dbPath, inv));
  const reloaded = loadInventory(dbPath);
  assert.ok(reloaded.hosts.length >= 2);
});

test('buildDemoInventory covers at least two Proxmox hosts', () => {
  const inv = buildDemoInventory();
  assert.ok(inv.hosts.length >= 2, `expected at least 2 hosts, got ${inv.hosts.length}`);
});

test('buildDemoInventory covers at least eight guests across both lxc and vm types', () => {
  const inv = buildDemoInventory();
  assert.ok(inv.guests.length >= 8, `expected at least 8 guests, got ${inv.guests.length}`);
  const types = new Set(inv.guests.map((g) => g.type));
  assert.ok(types.has('lxc'), 'expected at least one lxc guest');
  assert.ok(types.has('vm'), 'expected at least one vm guest');
});

test('buildDemoInventory has several guests with subdomains, some with more than one', () => {
  const inv = buildDemoInventory();
  const withSubdomains = inv.guests.filter((g) => (g.subdomains?.length ?? 0) > 0);
  assert.ok(withSubdomains.length >= 3, `expected several guests with subdomains, got ${withSubdomains.length}`);
  const withMultiple = inv.guests.filter((g) => (g.subdomains?.length ?? 0) > 1);
  assert.ok(withMultiple.length >= 1, 'expected at least one guest with more than one subdomain');
  for (const guest of withSubdomains) {
    assert.ok(guest.port !== undefined, `guest '${guest.name}' has subdomains but no port`);
  }
});

test('buildDemoInventory gates guests at two or more different authGroup rungs', () => {
  const inv = buildDemoInventory();
  const rungs = new Set(inv.guests.filter((g) => g.authGroup).map((g) => g.authGroup));
  assert.ok(rungs.size >= 2, `expected at least 2 distinct authGroup rungs, got ${[...rungs].join(', ')}`);
});

test('buildDemoInventory has exactly one guest in OIDC mode with redirect URIs', () => {
  const inv = buildDemoInventory();
  const oidcGuests = inv.guests.filter((g) => effectiveAuth(g) === 'oidc');
  assert.equal(oidcGuests.length, 1, `expected exactly one OIDC guest, got ${oidcGuests.length}`);
  const [oidcGuest] = oidcGuests;
  assert.ok(oidcGuest.authGroup, 'the OIDC guest must have authGroup set');
  assert.ok((oidcGuest.oidcRedirectUris?.length ?? 0) > 0, 'the OIDC guest must have oidcRedirectUris set');
});

test('buildDemoInventory has several guests with an app slug set', () => {
  const inv = buildDemoInventory();
  const withApp = inv.guests.filter((g) => g.app);
  assert.ok(withApp.length >= 3, `expected several guests with 'app' set, got ${withApp.length}`);
});

test('buildDemoInventory has exactly one proxy:true and one authentik:true guest', () => {
  const inv = buildDemoInventory();
  const proxyEntries = [...inv.hosts.filter((h) => h.proxy), ...inv.guests.filter((g) => g.proxy)];
  assert.equal(proxyEntries.length, 1, `expected exactly one proxy:true entry, got ${proxyEntries.length}`);
  const authentikEntries = [...inv.hosts.filter((h) => h.authentik), ...inv.guests.filter((g) => g.authentik)];
  assert.equal(authentikEntries.length, 1, `expected exactly one authentik:true entry, got ${authentikEntries.length}`);
});

test('buildDemoInventory has at least one guest with unauthenticatedPaths', () => {
  const inv = buildDemoInventory();
  const withPaths = inv.guests.filter((g) => (g.unauthenticatedPaths?.length ?? 0) > 0);
  assert.ok(withPaths.length >= 1, 'expected at least one guest with unauthenticatedPaths set');
});

test('buildDemoInventory hosts cover midScheme ranges, bridges, and storages (vztmpl/rootdir|images/nfs)', () => {
  const inv = buildDemoInventory();
  for (const host of inv.hosts) {
    assert.ok(host.midScheme, `host '${host.name}' is missing a midScheme`);
    assert.ok((host.bridges?.length ?? 0) > 0, `host '${host.name}' is missing bridges`);
    assert.ok((host.storages?.length ?? 0) > 0, `host '${host.name}' is missing storages`);
  }
  const allContentTypes = new Set(inv.hosts.flatMap((h) => h.storages ?? []).flatMap((s) => s.content));
  assert.ok(allContentTypes.has('vztmpl'), 'expected some storage with vztmpl content');
  assert.ok(allContentTypes.has('rootdir') || allContentTypes.has('images'), 'expected some storage with rootdir or images content');
  const nfsStorages = (inv.hosts.flatMap((h) => h.storages ?? [])).filter((s) => s.type === 'nfs');
  assert.ok(nfsStorages.length >= 1, 'expected at least one nfs storage');
});

test('buildDemoInventory returns a fresh, independent object on every call', () => {
  const first = buildDemoInventory();
  const second = buildDemoInventory();
  assert.notEqual(first, second);
  assert.notEqual(first.hosts, second.hosts);
  assert.notEqual(first.guests, second.guests);

  // Mutate the first result deeply and confirm the second is untouched.
  first.domain = 'mutated.example';
  first.hosts.push({ name: 'mutated-host', ssh_target: '192.0.2.99', ssh_user: 'root' });
  first.guests[0].name = 'mutated-guest';
  if (first.guests[0].subdomains) {
    first.guests[0].subdomains.push('mutated.example.com');
  }

  const third = buildDemoInventory();
  assert.notEqual(third.domain, 'mutated.example');
  assert.notEqual(third.hosts.length, first.hosts.length);
  assert.notEqual(third.guests[0].name, 'mutated-guest');
  assert.notEqual(second.domain, 'mutated.example');
  assert.notEqual(second.guests[0].name, 'mutated-guest');
});

test('buildDemoInventory settings match the brief: domain and the three settings values', () => {
  const inv = buildDemoInventory();
  assert.equal(inv.domain, 'example.com');
  assert.equal(inv.backupStorage, 'nas-backup');
  assert.equal(inv.dnsServer, '198.51.100.53');
  assert.equal(inv.nfsServer, '198.51.100.50');
});

test('buildDemoInventory hosts use pve1/pve2, root ssh_user, and 192.0.2.0/24 ssh_target', () => {
  const inv = buildDemoInventory();
  const names = inv.hosts.map((h) => h.name).sort();
  assert.deepEqual(names, ['pve1', 'pve2']);
  for (const host of inv.hosts) {
    assert.equal(host.ssh_user, 'root');
    assert.match(host.ssh_target, /^192\.0\.2\.\d{1,3}$/, `host '${host.name}' ssh_target not in 192.0.2.0/24`);
  }
});
