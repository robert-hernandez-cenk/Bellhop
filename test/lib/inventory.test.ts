import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { authentikConfig } from '../../src/lib/authentik-config.ts';
import {
  loadInventory,
  saveInventory,
  validateInventory,
  parsePort,
  parseAuthGroup,
  parseUnauthenticatedPaths,
  parseAuthMode,
  parseOidcRedirectUris,
  effectiveAuth,
  oidcConfigErrors,
  sortInventoryForFile,
  refreshInventory,
  HostEntrySchema,
  GuestEntrySchema,
  ExternalSiteSchema,
  SettingsSchema,
  SETTINGS_KEYS,
  findCaddyEntry,
  type Inventory,
} from '../../src/lib/inventory.ts';

const FIXTURE_INVENTORY: Inventory = {
  domain: 'example.com',
  hosts: [
    { name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' } },
    { name: 'pve2', ssh_target: 'pve2.local', ssh_user: 'root', midScheme: { vmidBase: 5000, ipPrefix: '192.168.2.', gateway: '192.168.3.1' } },
  ],
  guests: [
    { name: 'media', type: 'lxc', vmid: 105, host: 'pve1', ip: '192.168.1.50', port: 8080, subdomains: ['media'] },
    { name: 'windows-test', type: 'vm', vmid: 201, host: 'pve2' },
    { name: 'proxy', type: 'lxc', vmid: 110, host: 'pve1', ip: '192.168.1.10', caddy: true },
  ],
};

function tempInventoryDb(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'bellhop-test-'));
  const dest = path.join(dir, 'bellhop.db');
  saveInventory(dest, FIXTURE_INVENTORY);
  return dest;
}

test('loadInventory parses a valid fixture', () => {
  const inv = loadInventory(tempInventoryDb());
  assert.equal(inv.domain, 'example.com');
  assert.equal(inv.hosts.length, 2);
  assert.equal(inv.guests.length, 3);
  assert.deepEqual(inv.hosts[0].midScheme, { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' });
});

test('loadInventory rejects a host with an empty ssh_user', () => {
  const dest = tempInventoryDb();
  const db = new Database(dest);
  db.prepare("UPDATE hosts SET ssh_user = '' WHERE name = 'pve1'").run();
  db.close();
  assert.throws(() => loadInventory(dest), /ssh_user/);
});

test('loadInventory rejects a host whose midScheme.ipPrefix is a 2-octet prefix', () => {
  const dest = tempInventoryDb();
  const db = new Database(dest);
  db.prepare("UPDATE hosts SET mid_scheme_json = ? WHERE name = 'pve1'").run(
    JSON.stringify({ vmidBase: 4000, ipPrefix: '192.168.', gateway: '192.168.3.1' })
  );
  db.close();
  assert.throws(() => loadInventory(dest), /ipPrefix/);
});

test('validateInventory flags more than one caddy:true entry', () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [
      { name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', caddy: true },
    ],
    guests: [
      { name: 'proxy', type: 'lxc', vmid: 110, host: 'pve1', ip: '192.168.1.10', caddy: true },
    ],
  };
  const errors = validateInventory(inv);
  assert.ok(errors.some((e) => e.includes("multiple entries flagged 'caddy: true'")));
});

test('validateInventory flags more than one authentik:true entry', () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [
      { name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', authentik: true },
    ],
    guests: [
      { name: 'auth-lxc', type: 'lxc', vmid: 111, host: 'pve1', ip: '192.168.1.11', authentik: true },
    ],
  };
  const errors = validateInventory(inv);
  assert.ok(errors.some((e) => e.includes("multiple entries flagged 'authentik: true'")));
});

test('validateInventory flags an authGroup entry when no entry has authentik: true', () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
    guests: [
      { name: 'sonarr', type: 'lxc', vmid: 120, host: 'pve1', ip: '192.168.1.20', subdomains: ['sonarr'], authGroup: 'bellhop-users' },
    ],
  };
  const errors = validateInventory(inv);
  assert.ok(errors.some((e) => e.includes("'sonarr' has an 'authGroup' set but no entry has 'authentik: true'")));
});

test('validateInventory flags an authGroup entry when the authentik:true entry has no ip', () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
    guests: [
      { name: 'auth-lxc', type: 'lxc', vmid: 111, host: 'pve1', authentik: true },
      { name: 'sonarr', type: 'lxc', vmid: 120, host: 'pve1', ip: '192.168.1.20', subdomains: ['sonarr'], authGroup: 'bellhop-users' },
    ],
  };
  const errors = validateInventory(inv);
  assert.ok(
    errors.some((e) => e.includes("has an 'authGroup' set but the 'authentik: true' entry has no 'ip' set"))
  );
});

test('validateInventory allows authGroup when an authentik:true entry exists', () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
    guests: [
      { name: 'auth-lxc', type: 'lxc', vmid: 111, host: 'pve1', ip: '192.168.1.11', authentik: true },
      { name: 'sonarr', type: 'lxc', vmid: 120, host: 'pve1', ip: '192.168.1.20', subdomains: ['sonarr'], authGroup: 'bellhop-users' },
    ],
  };
  assert.deepEqual(validateInventory(inv), []);
});

test('saveInventory/loadInventory round-trip vpnGateway and vpn fields', () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
    guests: [
      { name: 'nordvpn-gateway-lxc', type: 'lxc', vmid: 4015, host: 'pve1', ip: '192.168.1.15', vpnGateway: 'nordvpn' },
      { name: 'media', type: 'lxc', vmid: 105, host: 'pve1', vpn: 'nordvpn-gateway-lxc' },
    ],
  };
  const dir = mkdtempSync(path.join(tmpdir(), 'bellhop-test-'));
  const dest = path.join(dir, 'bellhop.db');
  saveInventory(dest, inv);
  const loaded = loadInventory(dest);
  const gateway = loaded.guests.find((g) => g.name === 'nordvpn-gateway-lxc');
  const media = loaded.guests.find((g) => g.name === 'media');
  assert.equal(gateway?.vpnGateway, 'nordvpn');
  assert.equal(media?.vpn, 'nordvpn-gateway-lxc');
});

// issue #11: appSource round-trips through saveInventory/loadInventory the
// same way `app` does -- set only by the web/MCP install-app apply path
// (never by anything in src/lib/inventory.ts itself), but must survive a
// plain save/load cycle like every other guest field.
test('saveInventory/loadInventory round-trips appSource on a guest', () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
    guests: [
      { name: 'myapp-lxc', type: 'lxc', vmid: 4020, host: 'pve1', app: 'myapp', appSource: 'custom' },
      { name: 'plex-lxc', type: 'lxc', vmid: 4021, host: 'pve1', app: 'plex' },
    ],
  };
  const dir = mkdtempSync(path.join(tmpdir(), 'bellhop-test-'));
  const dest = path.join(dir, 'bellhop.db');
  saveInventory(dest, inv);
  const loaded = loadInventory(dest);
  const custom = loaded.guests.find((g) => g.name === 'myapp-lxc');
  const upstream = loaded.guests.find((g) => g.name === 'plex-lxc');
  assert.equal(custom?.appSource, 'custom');
  assert.equal(upstream?.appSource, undefined, 'a guest with no appSource must round-trip as undefined, not null/custom');
});

test('saveInventory/loadInventory round-trips insecureBackendTls: false (not just true/unset) for hosts, guests, and external_sites', () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', insecureBackendTls: false }],
    guests: [{ name: 'media', type: 'lxc', vmid: 105, host: 'pve1', insecureBackendTls: false }],
    externalSites: [{ name: 'nas', ip: '192.168.1.5', subdomains: ['nas'], insecureBackendTls: false }],
  };
  const dir = mkdtempSync(path.join(tmpdir(), 'bellhop-test-'));
  const dest = path.join(dir, 'bellhop.db');
  saveInventory(dest, inv);
  const loaded = loadInventory(dest);
  assert.equal(loaded.hosts[0].insecureBackendTls, false);
  assert.equal(loaded.guests[0].insecureBackendTls, false);
  assert.equal(loaded.externalSites?.[0].insecureBackendTls, false);
});

test('validateInventory allows two guests to share the same vpnGateway value (multiple gateways per provider)', () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
    guests: [
      { name: 'nordvpn-us-gw-lxc', type: 'lxc', vmid: 4015, host: 'pve1', vpnGateway: 'nordvpn' },
      { name: 'nordvpn-eu-gw-lxc', type: 'lxc', vmid: 4017, host: 'pve1', vpnGateway: 'nordvpn' },
    ],
  };
  assert.deepEqual(validateInventory(inv), []);
});

test('validateInventory allows one nordvpn gateway and one pia gateway to coexist', () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
    guests: [
      { name: 'gw-nord', type: 'lxc', vmid: 4015, host: 'pve1', vpnGateway: 'nordvpn' },
      { name: 'gw-pia', type: 'lxc', vmid: 4016, host: 'pve1', vpnGateway: 'pia' },
    ],
  };
  assert.deepEqual(validateInventory(inv), []);
});

test('validateInventory flags a guest whose host does not exist', () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
    guests: [{ name: 'orphan', type: 'lxc', vmid: 100, host: 'pve-missing' }],
  };
  const errors = validateInventory(inv);
  assert.ok(errors.some((e) => e.includes("guest 'orphan' has host 'pve-missing'")));
});

test('validateInventory flags two hosts sharing the same midScheme.vmidBase', () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [
      { name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' } },
      { name: 'pve2', ssh_target: 'pve2.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.2.', gateway: '192.168.3.1' } },
    ],
    guests: [],
  };
  const errors = validateInventory(inv);
  assert.ok(errors.some((e) => e.includes('share the same midScheme.vmidBase')));
});

test('validateInventory flags two hosts sharing the same midScheme.ipPrefix', () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [
      { name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' } },
      { name: 'pve2', ssh_target: 'pve2.local', ssh_user: 'root', midScheme: { vmidBase: 5000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' } },
    ],
    guests: [],
  };
  const errors = validateInventory(inv);
  assert.ok(errors.some((e) => e.includes('share the same midScheme.ipPrefix')));
});

test('validateInventory allows two hosts with distinct midScheme vmidBase/ipPrefix', () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [
      { name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' } },
      { name: 'pve2', ssh_target: 'pve2.local', ssh_user: 'root', midScheme: { vmidBase: 5000, ipPrefix: '192.168.2.', gateway: '192.168.3.1' } },
    ],
    guests: [],
  };
  assert.deepEqual(validateInventory(inv), []);
});

test('validateInventory flags a subdomain with no ip', () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', subdomains: ['pve1'] }],
    guests: [],
  };
  const errors = validateInventory(inv);
  assert.ok(errors.some((e) => e.includes("entry 'pve1' has 'subdomains' set but no 'ip'")));
});

test('validateInventory does not require ip when caddyManual is set', () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', subdomains: ['pve1'], caddyManual: true }],
    guests: [],
  };
  const errors = validateInventory(inv);
  assert.deepEqual(errors, []);
});

test('validateInventory still requires ip when caddyManual is not set', () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', subdomains: ['pve1'] }],
    guests: [],
  };
  const errors = validateInventory(inv);
  assert.ok(errors.some((e) => e.includes("entry 'pve1' has 'subdomains' set but no 'ip'")));
});

test('validateInventory flags the same subdomain claimed by two entries', () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
    guests: [
      { name: 'media', type: 'lxc', vmid: 105, host: 'pve1', ip: '192.168.1.50', subdomains: ['photos'] },
      { name: 'other', type: 'lxc', vmid: 106, host: 'pve1', ip: '192.168.1.60', subdomains: ['Photos'] },
    ],
  };
  const errors = validateInventory(inv);
  assert.ok(errors.some((e) => e.includes("subdomain 'photos' is claimed by multiple entries: media, other")));
});

test('validateInventory includes externalSites in the duplicate-subdomain check', () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
    guests: [{ name: 'media', type: 'lxc', vmid: 105, host: 'pve1', ip: '192.168.1.50', subdomains: ['nas'] }],
    externalSites: [{ name: 'nas-external', ip: '192.168.1.250', subdomains: ['nas'] }],
  };
  const errors = validateInventory(inv);
  assert.ok(errors.some((e) => e.includes("subdomain 'nas' is claimed by multiple entries: media, nas-external")));
});

test('parsePort accepts a valid whole-number string, and returns undefined for empty input', () => {
  assert.equal(parsePort('8080'), 8080);
  assert.equal(parsePort(''), undefined);
  assert.equal(parsePort('   '), undefined);
  assert.equal(parsePort(undefined), undefined);
});

test('parsePort throws on a non-empty but invalid port', () => {
  assert.throws(() => parsePort('not-a-number'), /Invalid port 'not-a-number'/);
  assert.throws(() => parsePort('0'), /Invalid port '0'/);
  assert.throws(() => parsePort('-5'), /Invalid port '-5'/);
  assert.throws(() => parsePort('70000'), /Invalid port '70000'/);
  assert.throws(() => parsePort('8080.5'), /Invalid port '8080\.5'/);
});

test('parseUnauthenticatedPaths accepts a valid semicolon-separated list, dedupes, and trims', () => {
  assert.deepEqual(parseUnauthenticatedPaths('/api/* ; /api/*; /system/*'), ['/api/*', '/system/*']);
  assert.equal(parseUnauthenticatedPaths(''), undefined);
  assert.equal(parseUnauthenticatedPaths('   '), undefined);
  assert.equal(parseUnauthenticatedPaths(undefined), undefined);
});

test('parseUnauthenticatedPaths throws on a pattern missing a leading slash', () => {
  assert.throws(() => parseUnauthenticatedPaths('api/*'), /Invalid unauthenticated path 'api\/\*' \(must start with '\/'\)/);
  assert.throws(() => parseUnauthenticatedPaths('/api/*; system'), /Invalid unauthenticated path 'system'/);
});

test('saveInventory replaces guests and hosts, without touching domain', () => {
  const dest = tempInventoryDb();
  const inv = loadInventory(dest);
  const updated: Inventory = { ...inv, guests: [{ name: 'new-guest', type: 'lxc', vmid: 999, host: 'pve1' }] };
  saveInventory(dest, updated);

  const reloaded = loadInventory(dest);
  assert.equal(reloaded.guests.length, 1);
  assert.equal(reloaded.guests[0].name, 'new-guest');
  assert.equal(reloaded.domain, 'example.com');
  assert.deepEqual(reloaded.hosts.find((h) => h.name === 'pve1')?.midScheme, { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' }, 'host data survives a save');
});

test('saveInventory sorts guests by host, then type, then ip', () => {
  const dest = tempInventoryDb();
  const inv = loadInventory(dest);
  saveInventory(dest, inv);

  const reloaded = loadInventory(dest);
  // fixture guests: media (pve1/lxc/.50), windows-test (pve2/vm/no ip),
  // proxy (pve1/lxc/.10) -- expect grouped by host, then ip ascending
  // within the pve1/lxc group
  assert.deepEqual(
    reloaded.guests.map((g) => g.name),
    ['proxy', 'media', 'windows-test']
  );
});

test('saveInventory is idempotent when the inventory content is unchanged', () => {
  const dest = tempInventoryDb();
  const inv = loadInventory(dest);
  saveInventory(dest, inv);
  const firstReload = loadInventory(dest);

  saveInventory(dest, firstReload);
  const secondReload = loadInventory(dest);

  assert.deepEqual(secondReload, firstReload);
});

test('saveInventory writes bridges onto a host without disturbing its other fields', () => {
  const dest = tempInventoryDb();
  const inv = loadInventory(dest);
  const pve1 = inv.hosts.find((h) => h.name === 'pve1')!;
  const updated: Inventory = {
    ...inv,
    hosts: inv.hosts.map((h) =>
      h.name === 'pve1' ? { ...h, bridges: [{ name: 'vmbr0', alias: 'Home LAN', active: true }] } : h
    ),
  };
  saveInventory(dest, updated);

  const reloaded = loadInventory(dest);
  const reloadedPve1 = reloaded.hosts.find((h) => h.name === 'pve1')!;
  assert.equal(reloadedPve1.ssh_target, pve1.ssh_target, 'other fields on the same host must be untouched');
  assert.deepEqual(reloadedPve1.bridges, [{ name: 'vmbr0', alias: 'Home LAN', active: true }]);
  const reloadedPve2 = reloaded.hosts.find((h) => h.name === 'pve2')!;
  assert.equal(reloadedPve2.bridges, undefined, 'a host with no bridges given should be left alone');
});

test('saveInventory writes nfsMounts onto a host without disturbing its other fields', () => {
  const dest = tempInventoryDb();
  const inv = loadInventory(dest);
  const updated: Inventory = {
    ...inv,
    hosts: inv.hosts.map((h) =>
      h.name === 'pve1'
        ? {
            ...h,
            nfsMounts: [
              { name: 'nas-media', export: '/volume1/Media', mountPoint: '/mnt/pve/nas-media', active: true },
            ],
          }
        : h
    ),
  };
  saveInventory(dest, updated);

  const reloaded = loadInventory(dest);
  const reloadedPve1 = reloaded.hosts.find((h) => h.name === 'pve1')!;
  assert.deepEqual(reloadedPve1.nfsMounts, [
    { name: 'nas-media', export: '/volume1/Media', mountPoint: '/mnt/pve/nas-media', active: true },
  ]);
  const reloadedPve2 = reloaded.hosts.find((h) => h.name === 'pve2')!;
  assert.equal(reloadedPve2.nfsMounts, undefined, 'a host with no nfsMounts given should be left alone');
});

test('saveInventory/loadInventory round-trips caddyManual on a host and a guest', () => {
  const dest = tempInventoryDb();
  const inv = loadInventory(dest);
  const updated: Inventory = {
    ...inv,
    hosts: inv.hosts.map((h) => (h.name === 'pve1' ? { ...h, caddyManual: true } : h)),
    guests: inv.guests.map((g) => (g.name === 'proxy' ? { ...g, caddyManual: true } : g)),
  };
  saveInventory(dest, updated);

  const reloaded = loadInventory(dest);
  assert.equal(reloaded.hosts.find((h) => h.name === 'pve1')?.caddyManual, true);
  assert.equal(
    reloaded.hosts.find((h) => h.name === 'pve2')?.caddyManual,
    undefined,
    'a host with no caddyManual given must stay undefined, not false'
  );
  assert.equal(reloaded.guests.find((g) => g.name === 'proxy')?.caddyManual, true);
});

test('saveInventory/loadInventory round-trips authGroup and authentik on a host and a guest', () => {
  const dest = tempInventoryDb();
  const inv = loadInventory(dest);
  const updated: Inventory = {
    ...inv,
    hosts: inv.hosts.map((h) => (h.name === 'pve1' ? { ...h, authentik: true, ip: '192.168.1.5' } : h)),
    guests: inv.guests.map((g) => (g.name === 'proxy' ? { ...g, authGroup: 'bellhop-users' } : g)),
  };
  saveInventory(dest, updated);

  const reloaded = loadInventory(dest);
  assert.equal(reloaded.hosts.find((h) => h.name === 'pve1')?.authentik, true);
  assert.equal(
    reloaded.hosts.find((h) => h.name === 'pve2')?.authentik,
    undefined,
    'a host with no authentik given must stay undefined, not false'
  );
  assert.equal(reloaded.guests.find((g) => g.name === 'proxy')?.authGroup, 'bellhop-users');
});

// Upgrade path (issue #8): a guest stored under a pre-rename default rung
// name ('homelab-users') must still round-trip unchanged with no
// AUTHENTIK_GROUP_LADDER override -- the rename never rewrites, migrates,
// or otherwise touches an already-stored authGroup value (FR-004), and the
// inventory must still load successfully even though that name is no
// longer on the active default ladder (FR-005).
test('saveInventory/loadInventory round-trips a pre-rename authGroup unchanged with no ladder override', () => {
  const dest = tempInventoryDb();
  const inv = loadInventory(dest);
  const updated: Inventory = {
    ...inv,
    hosts: inv.hosts.map((h) => (h.name === 'pve1' ? { ...h, authentik: true, ip: '192.168.1.5' } : h)),
    guests: inv.guests.map((g) => (g.name === 'proxy' ? { ...g, authGroup: 'homelab-users' } : g)),
  };
  saveInventory(dest, updated);

  const reloaded = loadInventory(dest);
  assert.equal(reloaded.guests.find((g) => g.name === 'proxy')?.authGroup, 'homelab-users');
});

test('saveInventory/loadInventory round-trips unauthenticatedPaths on a host, a guest, and an external site', () => {
  const dest = tempInventoryDb();
  const inv = loadInventory(dest);
  const updated: Inventory = {
    ...inv,
    hosts: inv.hosts.map((h) => (h.name === 'pve1' ? { ...h, unauthenticatedPaths: ['/health'] } : h)),
    guests: inv.guests.map((g) => (g.name === 'proxy' ? { ...g, unauthenticatedPaths: ['/api/*', '/system/*'] } : g)),
    externalSites: [{ name: 'nas', ip: '192.168.1.250', subdomains: ['nas'], unauthenticatedPaths: ['/webapi/*'] }],
  };
  saveInventory(dest, updated);

  const reloaded = loadInventory(dest);
  assert.deepEqual(reloaded.hosts.find((h) => h.name === 'pve1')?.unauthenticatedPaths, ['/health']);
  assert.equal(
    reloaded.hosts.find((h) => h.name === 'pve2')?.unauthenticatedPaths,
    undefined,
    'a host with no unauthenticatedPaths given must stay undefined, not []'
  );
  assert.deepEqual(reloaded.guests.find((g) => g.name === 'proxy')?.unauthenticatedPaths, ['/api/*', '/system/*']);
  assert.deepEqual(reloaded.externalSites?.find((s) => s.name === 'nas')?.unauthenticatedPaths, ['/webapi/*']);
});

test('loadInventory rejects a hand-inserted unauthenticated path missing a leading slash', () => {
  const dest = tempInventoryDb();
  const db = new Database(dest);
  db.prepare("UPDATE hosts SET unauthenticated_paths_json = '[\"api/*\"]' WHERE name = 'pve1'").run();
  db.close();
  assert.throws(() => loadInventory(dest), /must start with/);
});

test('opening a pre-existing database without the unauthenticated_paths_json column migrates it in place', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bellhop-test-'));
  const dest = path.join(dir, 'bellhop.db');
  const legacyDb = new Database(dest);
  legacyDb.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE hosts (
      name TEXT PRIMARY KEY, ssh_target TEXT NOT NULL, ssh_user TEXT NOT NULL,
      role TEXT, caddy INTEGER NOT NULL DEFAULT 0,
      ip TEXT, port INTEGER, insecure_backend_tls INTEGER,
      bridges_json TEXT, storages_json TEXT, nfs_mounts_json TEXT
    );
    CREATE TABLE guests (
      name TEXT PRIMARY KEY, type TEXT NOT NULL, vmid INTEGER NOT NULL,
      host TEXT NOT NULL REFERENCES hosts(name),
      ip TEXT, port INTEGER, insecure_backend_tls INTEGER,
      caddy INTEGER NOT NULL DEFAULT 0, unprivileged INTEGER, app TEXT,
      UNIQUE (host, vmid)
    );
    CREATE TABLE external_sites (name TEXT PRIMARY KEY, ip TEXT NOT NULL, port INTEGER, insecure_backend_tls INTEGER);
    CREATE TABLE subdomains (subdomain TEXT PRIMARY KEY, owner_type TEXT NOT NULL, owner_name TEXT NOT NULL);
    CREATE TABLE caddy_owner (id INTEGER PRIMARY KEY CHECK (id = 1), owner_type TEXT NOT NULL, owner_name TEXT NOT NULL);
  `);
  legacyDb.prepare("INSERT INTO meta (key, value) VALUES ('domain', 'example.com')").run();
  legacyDb.prepare("INSERT INTO hosts (name, ssh_target, ssh_user) VALUES ('pve1', 'pve1.local', 'root')").run();
  legacyDb.prepare("INSERT INTO guests (name, type, vmid, host) VALUES ('proxy', 'lxc', 110, 'pve1')").run();
  legacyDb.close();

  const inv = loadInventory(dest);
  assert.equal(inv.hosts[0].unauthenticatedPaths, undefined, 'a pre-migration row has no unauthenticated_paths_json value');
  assert.equal(inv.guests[0].unauthenticatedPaths, undefined, 'a pre-migration guest row has no unauthenticated_paths_json value');

  const updated: Inventory = {
    ...inv,
    hosts: inv.hosts.map((h) => ({ ...h, unauthenticatedPaths: ['/api/*'] })),
    guests: inv.guests.map((g) => ({ ...g, unauthenticatedPaths: ['/system/*'] })),
    externalSites: [{ name: 'nas', ip: '192.168.1.250', subdomains: ['nas'], unauthenticatedPaths: ['/webapi/*'] }],
  };
  saveInventory(dest, updated);
  const reloaded = loadInventory(dest);
  assert.deepEqual(reloaded.hosts[0].unauthenticatedPaths, ['/api/*'], 'the migrated hosts column must actually be writable/readable');
  assert.deepEqual(
    reloaded.guests[0].unauthenticatedPaths,
    ['/system/*'],
    'the migrated guests column must actually be writable/readable'
  );
  assert.deepEqual(
    reloaded.externalSites?.[0].unauthenticatedPaths,
    ['/webapi/*'],
    'the migrated external_sites column must actually be writable/readable'
  );
});

test('opening a pre-existing database without the auth_group/authentik columns migrates them in place', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bellhop-test-'));
  const dest = path.join(dir, 'bellhop.db');
  const legacyDb = new Database(dest);
  legacyDb.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE hosts (
      name TEXT PRIMARY KEY, ssh_target TEXT NOT NULL, ssh_user TEXT NOT NULL,
      role TEXT, caddy INTEGER NOT NULL DEFAULT 0,
      ip TEXT, port INTEGER, insecure_backend_tls INTEGER,
      bridges_json TEXT, storages_json TEXT, nfs_mounts_json TEXT
    );
    CREATE TABLE guests (
      name TEXT PRIMARY KEY, type TEXT NOT NULL, vmid INTEGER NOT NULL,
      host TEXT NOT NULL REFERENCES hosts(name),
      ip TEXT, port INTEGER, insecure_backend_tls INTEGER,
      caddy INTEGER NOT NULL DEFAULT 0, unprivileged INTEGER, app TEXT,
      UNIQUE (host, vmid)
    );
    CREATE TABLE external_sites (name TEXT PRIMARY KEY, ip TEXT NOT NULL, port INTEGER, insecure_backend_tls INTEGER);
    CREATE TABLE subdomains (subdomain TEXT PRIMARY KEY, owner_type TEXT NOT NULL, owner_name TEXT NOT NULL);
    CREATE TABLE caddy_owner (id INTEGER PRIMARY KEY CHECK (id = 1), owner_type TEXT NOT NULL, owner_name TEXT NOT NULL);
  `);
  legacyDb.prepare("INSERT INTO meta (key, value) VALUES ('domain', 'example.com')").run();
  legacyDb.prepare("INSERT INTO hosts (name, ssh_target, ssh_user) VALUES ('pve1', 'pve1.local', 'root')").run();
  legacyDb.close();

  const inv = loadInventory(dest);
  assert.equal(inv.hosts[0].authGroup, undefined, 'a pre-migration row has no auth_group value');
  assert.equal(inv.hosts[0].authentik, undefined, 'a pre-migration row has no authentik value');

  const updated: Inventory = { ...inv, hosts: inv.hosts.map((h) => ({ ...h, authentik: true })) };
  saveInventory(dest, updated);
  const reloaded = loadInventory(dest);
  assert.equal(reloaded.hosts[0].authentik, true, 'the migrated column must actually be writable/readable');
});

test('opening a pre-existing database without the caddy_manual/ssh_port/ssh_identity_file columns migrates them in place', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bellhop-test-'));
  const dest = path.join(dir, 'bellhop.db');
  const legacyDb = new Database(dest);
  legacyDb.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE hosts (
      name TEXT PRIMARY KEY, ssh_target TEXT NOT NULL, ssh_user TEXT NOT NULL,
      role TEXT, caddy INTEGER NOT NULL DEFAULT 0,
      ip TEXT, port INTEGER, insecure_backend_tls INTEGER,
      bridges_json TEXT, storages_json TEXT, nfs_mounts_json TEXT
    );
    CREATE TABLE guests (
      name TEXT PRIMARY KEY, type TEXT NOT NULL, vmid INTEGER NOT NULL,
      host TEXT NOT NULL REFERENCES hosts(name),
      ip TEXT, port INTEGER, insecure_backend_tls INTEGER,
      caddy INTEGER NOT NULL DEFAULT 0, unprivileged INTEGER, app TEXT,
      UNIQUE (host, vmid)
    );
    CREATE TABLE external_sites (name TEXT PRIMARY KEY, ip TEXT NOT NULL, port INTEGER, insecure_backend_tls INTEGER);
    CREATE TABLE subdomains (subdomain TEXT PRIMARY KEY, owner_type TEXT NOT NULL, owner_name TEXT NOT NULL);
    CREATE TABLE caddy_owner (id INTEGER PRIMARY KEY CHECK (id = 1), owner_type TEXT NOT NULL, owner_name TEXT NOT NULL);
  `);
  legacyDb.prepare("INSERT INTO meta (key, value) VALUES ('domain', 'example.com')").run();
  legacyDb.prepare("INSERT INTO hosts (name, ssh_target, ssh_user) VALUES ('pve1', 'pve1.local', 'root')").run();
  legacyDb.close();

  const inv = loadInventory(dest);
  assert.equal(inv.hosts[0].caddyManual, undefined, 'a pre-migration row has no caddy_manual value');
  assert.equal(inv.hosts[0].ssh_port, undefined, 'a pre-migration row has no ssh_port value');
  assert.equal(inv.hosts[0].ssh_identity_file, undefined, 'a pre-migration row has no ssh_identity_file value');

  const updated: Inventory = {
    ...inv,
    hosts: inv.hosts.map((h) => ({ ...h, caddyManual: true, ssh_port: 2222, ssh_identity_file: '~/.ssh/pve_key' })),
  };
  saveInventory(dest, updated);
  const reloaded = loadInventory(dest);
  assert.equal(reloaded.hosts[0].caddyManual, true, 'the migrated caddy_manual column must actually be writable/readable');
  assert.equal(reloaded.hosts[0].ssh_port, 2222, 'the migrated ssh_port column must actually be writable/readable');
  assert.equal(
    reloaded.hosts[0].ssh_identity_file,
    '~/.ssh/pve_key',
    'the migrated ssh_identity_file column must actually be writable/readable'
  );
});

test('opening a pre-existing database without the app_source column migrates it in place', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bellhop-test-'));
  const dest = path.join(dir, 'bellhop.db');
  const legacyDb = new Database(dest);
  legacyDb.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE hosts (
      name TEXT PRIMARY KEY, ssh_target TEXT NOT NULL, ssh_user TEXT NOT NULL,
      caddy INTEGER NOT NULL DEFAULT 0,
      ip TEXT, port INTEGER, insecure_backend_tls INTEGER,
      bridges_json TEXT, storages_json TEXT, nfs_mounts_json TEXT
    );
    CREATE TABLE guests (
      name TEXT PRIMARY KEY, type TEXT NOT NULL, vmid INTEGER NOT NULL,
      host TEXT NOT NULL REFERENCES hosts(name),
      ip TEXT, port INTEGER, insecure_backend_tls INTEGER,
      caddy INTEGER NOT NULL DEFAULT 0, unprivileged INTEGER, app TEXT,
      UNIQUE (host, vmid)
    );
    CREATE TABLE external_sites (name TEXT PRIMARY KEY, ip TEXT NOT NULL, port INTEGER, insecure_backend_tls INTEGER);
    CREATE TABLE subdomains (subdomain TEXT PRIMARY KEY, owner_type TEXT NOT NULL, owner_name TEXT NOT NULL);
    CREATE TABLE caddy_owner (id INTEGER PRIMARY KEY CHECK (id = 1), owner_type TEXT NOT NULL, owner_name TEXT NOT NULL);
  `);
  legacyDb.prepare("INSERT INTO meta (key, value) VALUES ('domain', 'example.com')").run();
  legacyDb.prepare("INSERT INTO hosts (name, ssh_target, ssh_user) VALUES ('pve1', 'pve1.local', 'root')").run();
  legacyDb
    .prepare("INSERT INTO guests (name, type, vmid, host, app) VALUES ('myapp-lxc', 'lxc', 4020, 'pve1', 'myapp')")
    .run();
  legacyDb.close();

  const inv = loadInventory(dest);
  assert.equal(inv.guests[0].appSource, undefined, 'a pre-migration row has no app_source value');

  const updated: Inventory = {
    ...inv,
    guests: inv.guests.map((g) => ({ ...g, appSource: 'custom' as const })),
  };
  saveInventory(dest, updated);
  const reloaded = loadInventory(dest);
  assert.equal(reloaded.guests[0].appSource, 'custom', 'the migrated app_source column must actually be writable/readable');
});

test('sortInventoryForFile groups guests by host name, then type, then name', () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [],
    guests: [
      { name: 'z-guest', type: 'lxc', vmid: 1, host: 'zzz-host' },
      { name: 'b-vm', type: 'vm', vmid: 2, host: 'aaa-host' },
      { name: 'a-lxc', type: 'lxc', vmid: 3, host: 'aaa-host' },
    ],
  };
  const sorted = sortInventoryForFile(inv);
  assert.deepEqual(
    sorted.guests.map((g) => g.name),
    ['a-lxc', 'b-vm', 'z-guest']
  );
});

test('sortInventoryForFile sorts guests by ip numerically within the same host/type, ip-less last', () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [],
    guests: [
      { name: 'has-ip-high', type: 'lxc', vmid: 1, host: 'pve1', ip: '192.168.1.10' },
      { name: 'no-ip-b', type: 'lxc', vmid: 2, host: 'pve1' },
      { name: 'has-ip-low', type: 'lxc', vmid: 3, host: 'pve1', ip: '192.168.1.2' },
      { name: 'no-ip-a', type: 'lxc', vmid: 4, host: 'pve1' },
    ],
  };
  const sorted = sortInventoryForFile(inv);
  assert.deepEqual(
    sorted.guests.map((g) => g.name),
    // numeric ip compare (.2 sorts before .10, not lexicographic), then
    // ip-less entries last, tie-broken by name
    ['has-ip-low', 'has-ip-high', 'no-ip-a', 'no-ip-b']
  );
});

test('sortInventoryForFile sorts hosts alphabetically by name', () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [
      { name: 'zzz-host', ssh_target: 'z.local', ssh_user: 'root' },
      { name: 'aaa-host', ssh_target: 'a.local', ssh_user: 'root' },
    ],
    guests: [],
  };
  const sorted = sortInventoryForFile(inv);
  assert.deepEqual(
    sorted.hosts.map((h) => h.name),
    ['aaa-host', 'zzz-host']
  );
});

test("sortInventoryForFile sorts a host's bridges, storages (and each storage's content), and nfsMounts alphabetically", () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [
      {
        name: 'pve1',
        ssh_target: 'pve1.local',
        ssh_user: 'root',
        bridges: [
          { name: 'vmbr1', alias: 'LAN' },
          { name: 'vmbr0', alias: 'LAN' },
        ],
        storages: [
          { name: 'zpool', type: 'zfspool', content: ['images', 'rootdir'], active: true },
          { name: 'local-lvm', type: 'lvmthin', content: ['rootdir', 'images'], active: true },
        ],
        nfsMounts: [
          { name: 'media', export: '/volume1/media-b', mountPoint: '/mnt/pve/media-b', active: true },
          { name: 'media', export: '/volume1/media-a', mountPoint: '/mnt/pve/media-a', active: true },
        ],
      },
    ],
    guests: [],
  };
  const sorted = sortInventoryForFile(inv);
  const host = sorted.hosts[0];
  assert.deepEqual(host.bridges?.map((b) => b.name), ['vmbr0', 'vmbr1']);
  assert.deepEqual(host.storages?.map((s) => s.name), ['local-lvm', 'zpool']);
  assert.deepEqual(host.storages?.map((s) => s.content), [
    ['images', 'rootdir'],
    ['images', 'rootdir'],
  ]);
  assert.deepEqual(
    host.nfsMounts?.map((m) => m.mountPoint),
    ['/mnt/pve/media-a', '/mnt/pve/media-b']
  );
});

test('sortInventoryForFile leaves a host with no bridges/storages/nfsMounts as undefined, not []', () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
    guests: [],
  };
  const sorted = sortInventoryForFile(inv);
  assert.equal(sorted.hosts[0].bridges, undefined);
  assert.equal(sorted.hosts[0].storages, undefined);
  assert.equal(sorted.hosts[0].nfsMounts, undefined);
});

test('refreshInventory copies fresh domain/hosts/guests onto the existing object in place', () => {
  const dest = tempInventoryDb();
  const inv = loadInventory(dest);
  const originalRef = inv;
  assert.equal(inv.domain, 'example.com');
  assert.equal(inv.guests.length, 3);

  const updated: Inventory = {
    domain: 'changed.example.com',
    hosts: FIXTURE_INVENTORY.hosts,
    guests: [{ name: 'media', type: 'lxc', vmid: 105, host: 'pve1', app: 'plex' }],
  };
  saveInventory(dest, updated);

  refreshInventory(inv, dest);

  assert.equal(inv, originalRef, 'refreshInventory must mutate the existing object, not replace the reference');
  assert.equal(inv.domain, 'changed.example.com');
  assert.equal(inv.guests.length, 1);
  assert.equal(inv.guests[0].app, 'plex');
});

test('refreshInventory clears a settings key that was removed on disk (issue #124 regression)', () => {
  const dest = tempInventoryDb();
  saveInventory(dest, { ...FIXTURE_INVENTORY, nfsServer: '10.0.0.5' });
  const inv = loadInventory(dest);
  assert.equal(inv.nfsServer, '10.0.0.5');
  // Snapshot before the reload so the "unrelated fields survive" assertion
  // below compares against what was actually loaded (already sorted by
  // sortInventoryForFile), not the fixture's pre-sort declaration order.
  const domainBefore = inv.domain;
  const hostsBefore = structuredClone(inv.hosts);
  const guestsBefore = structuredClone(inv.guests);

  // Clear the setting on disk (absent from the saved inventory, same as
  // the Settings page's Clear button / PATCH .../settings with null).
  saveInventory(dest, FIXTURE_INVENTORY);

  refreshInventory(inv, dest);

  assert.equal(inv.nfsServer, undefined);
  assert.ok(!('nfsServer' in inv), 'nfsServer must be removed as an own key, not merely undefined');
  // The settings-key delete pass must be scoped to just that key -- assert
  // domain/hosts/guests survive the same reload untouched, so a future
  // change that widens the delete (or drops the merge back onto the
  // existing object) doesn't get past this regression test unnoticed.
  assert.equal(inv.domain, domainBefore);
  assert.deepEqual(inv.hosts, hostsBefore);
  assert.deepEqual(inv.guests, guestsBefore);
});

test('refreshInventory leaves the existing object untouched when the reload fails', () => {
  const dest = tempInventoryDb();
  const inv = loadInventory(dest);
  const originalDomain = inv.domain;
  const originalGuestCount = inv.guests.length;

  // An empty/never-written DB path has no `domain` row, so loadInventory's
  // own InventorySchema validation (domain: z.string().min(1)) throws --
  // openInventoryDb auto-creates an empty DB file for a path that doesn't
  // exist yet rather than erroring, so this reliably exercises the
  // reload-failure branch without needing to hand-corrupt a file.
  const emptyDbPath = path.join(mkdtempSync(path.join(tmpdir(), 'bellhop-test-')), 'empty.db');

  const errors: string[] = [];
  const originalError = console.error;
  console.error = (msg: string) => errors.push(msg);
  try {
    refreshInventory(inv, emptyDbPath);
  } finally {
    console.error = originalError;
  }
  assert.ok(errors.some((l) => l.includes('Failed to reload inventory')));
  assert.equal(inv.domain, originalDomain);
  assert.equal(inv.guests.length, originalGuestCount);
});

test('saveInventory/loadInventory round-trip ssh_port and ssh_identity_file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'inv-sshconn-'));
  const dbPath = path.join(dir, 'bellhop.db');
  saveInventory(dbPath, {
    domain: 'example.com',
    hosts: [
      { name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', ssh_port: 2222, ssh_identity_file: '~/.ssh/pve_key' },
      { name: 'pve2', ssh_target: 'pve2.local', ssh_user: 'root' },
    ],
    guests: [],
  });

  const loaded = loadInventory(dbPath);
  assert.equal(loaded.hosts[0].ssh_port, 2222);
  assert.equal(loaded.hosts[0].ssh_identity_file, '~/.ssh/pve_key');
  // A host with neither set must reload with both undefined, not 0 or ''.
  assert.equal(loaded.hosts[1].ssh_port, undefined);
  assert.equal(loaded.hosts[1].ssh_identity_file, undefined);
});

test('HostEntrySchema rejects an out-of-range or non-integer ssh_port', () => {
  const base = { name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' };
  assert.ok(!HostEntrySchema.safeParse({ ...base, ssh_port: 0 }).success);
  assert.ok(!HostEntrySchema.safeParse({ ...base, ssh_port: 65536 }).success);
  assert.ok(!HostEntrySchema.safeParse({ ...base, ssh_port: 22.5 }).success);
  assert.ok(HostEntrySchema.safeParse({ ...base, ssh_port: 22 }).success);
});

test('HostEntrySchema rejects an empty ssh_identity_file', () => {
  const base = { name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' };
  assert.ok(!HostEntrySchema.safeParse({ ...base, ssh_identity_file: '' }).success);
  assert.ok(HostEntrySchema.safeParse({ ...base, ssh_identity_file: 'pve_key' }).success);
});

test('saveInventory/loadInventory round-trip every settings scalar', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bellhop-test-'));
  const dest = path.join(dir, 'bellhop.db');
  saveInventory(dest, {
    ...FIXTURE_INVENTORY,
    nfsServer: '10.0.0.5',
    backupStorage: 'backups',
    dnsServer: '10.0.0.53',
    statusPagePath: '/var/www/status.html',
  });
  const loaded = loadInventory(dest);
  assert.equal(loaded.nfsServer, '10.0.0.5');
  assert.equal(loaded.backupStorage, 'backups');
  assert.equal(loaded.dnsServer, '10.0.0.53');
  assert.equal(loaded.statusPagePath, '/var/www/status.html');
  assert.equal(loaded.domain, 'example.com');
});

test('saveInventory deletes a settings row when the field is undefined', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bellhop-test-'));
  const dest = path.join(dir, 'bellhop.db');
  saveInventory(dest, { ...FIXTURE_INVENTORY, dnsServer: '10.0.0.53' });
  saveInventory(dest, { ...FIXTURE_INVENTORY });
  assert.equal(loadInventory(dest).dnsServer, undefined);
  const db = new Database(dest, { readonly: true });
  const row = db.prepare("SELECT value FROM meta WHERE key = 'dnsServer'").get();
  db.close();
  assert.equal(row, undefined);
});

test('loadInventory omits settings that were never set', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bellhop-test-'));
  const dest = path.join(dir, 'bellhop.db');
  saveInventory(dest, FIXTURE_INVENTORY);
  const loaded = loadInventory(dest);
  assert.equal(loaded.nfsServer, undefined);
  assert.equal(loaded.statusPagePath, undefined);
});

test('SettingsSchema rejects a relative statusPagePath', () => {
  const result = SettingsSchema.safeParse({ statusPagePath: 'usr/share/caddy/index.html' });
  assert.equal(result.success, false);
});

test('SettingsSchema rejects an empty string value', () => {
  const result = SettingsSchema.safeParse({ nfsServer: '' });
  assert.equal(result.success, false);
});

test('SETTINGS_KEYS lists exactly the six settings keys', () => {
  assert.deepEqual([...SETTINGS_KEYS].sort(), [
    'backupStorage',
    'customScriptsBranch',
    'customScriptsRepo',
    'dnsServer',
    'nfsServer',
    'statusPagePath',
  ]);
});

test('findCaddyEntry returns the entry flagged caddy: true', () => {
  assert.equal(findCaddyEntry(FIXTURE_INVENTORY)?.name, 'proxy');
});

test('findCaddyEntry returns undefined when no entry is flagged', () => {
  assert.equal(
    findCaddyEntry({ ...FIXTURE_INVENTORY, guests: FIXTURE_INVENTORY.guests.filter((g) => !g.caddy) }),
    undefined
  );
});

test('loadInventory migrates a legacy requires_auth column to authGroup at the ladder top rung', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'inventory-migrate-'));
  const dbPath = path.join(dir, 'bellhop.db');
  saveInventory(dbPath, {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', authentik: true, ip: '192.168.1.5' }],
    guests: [{ name: 'sonarr', type: 'lxc', vmid: 120, host: 'pve1', ip: '192.168.1.20', subdomains: ['sonarr'] }],
    externalSites: [{ name: 'nas', ip: '192.168.1.30', subdomains: ['nas'] }],
  });

  // Re-create the pre-#158 shape by hand: the column plus a gated row, on
  // all three tables sync-authentik gates -- not just guests.
  const raw = new Database(dbPath);
  for (const table of ['hosts', 'guests', 'external_sites']) {
    raw.exec(`ALTER TABLE ${table} ADD COLUMN requires_auth INTEGER`);
  }
  raw.prepare("UPDATE hosts SET requires_auth = 1 WHERE name = 'pve1'").run();
  raw.prepare("UPDATE guests SET requires_auth = 1 WHERE name = 'sonarr'").run();
  raw.prepare("UPDATE external_sites SET requires_auth = 1 WHERE name = 'nas'").run();
  raw.close();

  const ladder = authentikConfig().groupLadder;
  const topRung = ladder[ladder.length - 1];

  const migrated = loadInventory(dbPath);
  assert.equal(migrated.hosts[0].authGroup, topRung);
  assert.equal(migrated.guests[0].authGroup, topRung);
  assert.equal(migrated.externalSites?.[0].authGroup, topRung);

  // The column is gone from every migrated table, so the migration cannot
  // run a second time.
  const after = new Database(dbPath);
  for (const table of ['hosts', 'guests', 'external_sites']) {
    const cols = after.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    assert.equal(cols.some((c) => c.name === 'requires_auth'), false, `${table} still has requires_auth`);
  }
  after.close();

  // A second load is a plain no-op read.
  assert.equal(loadInventory(dbPath).guests[0].authGroup, topRung);
});

test('loadInventory migration leaves auth_group null and still drops requires_auth when AUTHENTIK_GROUP_LADDER parses to an empty list', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'inventory-migrate-empty-ladder-'));
  const dbPath = path.join(dir, 'bellhop.db');
  saveInventory(dbPath, {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', authentik: true, ip: '192.168.1.5' }],
    guests: [{ name: 'sonarr', type: 'lxc', vmid: 120, host: 'pve1', ip: '192.168.1.20', subdomains: ['sonarr'] }],
  });

  const raw = new Database(dbPath);
  raw.exec('ALTER TABLE guests ADD COLUMN requires_auth INTEGER');
  raw.prepare("UPDATE guests SET requires_auth = 1 WHERE name = 'sonarr'").run();
  raw.close();

  // authentikConfig() falls back to the built-in default ladder when
  // AUTHENTIK_GROUP_LADDER is empty or unset, so a string of only
  // separators is what's needed to actually get an empty parsed ladder.
  const previous = process.env.AUTHENTIK_GROUP_LADDER;
  process.env.AUTHENTIK_GROUP_LADDER = ',,,';
  try {
    assert.deepEqual(authentikConfig().groupLadder, []);

    const migrated = loadInventory(dbPath);
    assert.equal(migrated.guests[0].authGroup, undefined, 'no rung exists to write, so auth_group stays null');

    // requires_auth must still be dropped even though nothing was written,
    // so this remains self-idempotent and a later ladder fix can't re-run it.
    const after = new Database(dbPath);
    const cols = after.prepare('PRAGMA table_info(guests)').all() as { name: string }[];
    after.close();
    assert.equal(cols.some((c) => c.name === 'requires_auth'), false);
  } finally {
    if (previous === undefined) delete process.env.AUTHENTIK_GROUP_LADDER;
    else process.env.AUTHENTIK_GROUP_LADDER = previous;
  }
});

test('saveInventory round-trips authGroup', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'inventory-authgroup-'));
  const dbPath = path.join(dir, 'bellhop.db');
  saveInventory(dbPath, {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', authentik: true, ip: '192.168.1.5' }],
    guests: [
      { name: 'sonarr', type: 'lxc', vmid: 120, host: 'pve1', ip: '192.168.1.20', subdomains: ['sonarr'], authGroup: 'bellhop-users' },
      { name: 'plex', type: 'lxc', vmid: 121, host: 'pve1', ip: '192.168.1.21', subdomains: ['plex'] },
    ],
  });
  const loaded = loadInventory(dbPath);
  assert.equal(loaded.guests.find((g) => g.name === 'sonarr')!.authGroup, 'bellhop-users');
  assert.equal(loaded.guests.find((g) => g.name === 'plex')!.authGroup, undefined);
});

test('parseAuthGroup treats null and empty string as ungated and trims a name', () => {
  assert.equal(parseAuthGroup(null), undefined);
  assert.equal(parseAuthGroup(''), undefined);
  assert.equal(parseAuthGroup('   '), undefined);
  assert.equal(parseAuthGroup('  bellhop-users  '), 'bellhop-users');
  assert.throws(() => parseAuthGroup(42), /authGroup/);
});

test('validateInventory rejects a gated entry when no entry is flagged authentik: true', () => {
  const errors = validateInventory({
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
    guests: [{ name: 'sonarr', type: 'lxc', vmid: 120, host: 'pve1', ip: '192.168.1.20', subdomains: ['sonarr'], authGroup: 'bellhop-users' }],
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /'sonarr' has an 'authGroup' set but no entry has 'authentik: true'/);
});

// --- Native OIDC gating (issue #1, unit U2): authMode / oidcRedirectUris ---

test('HostEntrySchema/GuestEntrySchema/ExternalSiteSchema accept only "forward" or "oidc" for authMode', () => {
  const hostBase = { name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' };
  assert.ok(HostEntrySchema.safeParse({ ...hostBase, authMode: 'forward' }).success);
  assert.ok(HostEntrySchema.safeParse({ ...hostBase, authMode: 'oidc' }).success);
  assert.ok(!HostEntrySchema.safeParse({ ...hostBase, authMode: 'basic' }).success);
  assert.ok(HostEntrySchema.safeParse(hostBase).success, 'authMode stays optional');

  const guestBase = { name: 'sonarr', type: 'lxc' as const, vmid: 120, host: 'pve1' };
  assert.ok(GuestEntrySchema.safeParse({ ...guestBase, authMode: 'forward' }).success);
  assert.ok(GuestEntrySchema.safeParse({ ...guestBase, authMode: 'oidc' }).success);
  assert.ok(!GuestEntrySchema.safeParse({ ...guestBase, authMode: 'basic' }).success);

  const siteBase = { name: 'nas', ip: '192.168.1.5', subdomains: ['nas'] };
  assert.ok(ExternalSiteSchema.safeParse({ ...siteBase, authMode: 'forward' }).success);
  assert.ok(ExternalSiteSchema.safeParse({ ...siteBase, authMode: 'oidc' }).success);
  assert.ok(!ExternalSiteSchema.safeParse({ ...siteBase, authMode: 'basic' }).success);
});

test('HostEntrySchema/GuestEntrySchema/ExternalSiteSchema accept only absolute http(s) oidcRedirectUris', () => {
  const hostBase = { name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' };
  assert.ok(HostEntrySchema.safeParse({ ...hostBase, oidcRedirectUris: ['https://pve1.example.com/callback'] }).success);
  assert.ok(HostEntrySchema.safeParse({ ...hostBase, oidcRedirectUris: ['http://pve1.example.com/callback'] }).success);
  assert.ok(!HostEntrySchema.safeParse({ ...hostBase, oidcRedirectUris: ['ftp://pve1.example.com/callback'] }).success);
  assert.ok(!HostEntrySchema.safeParse({ ...hostBase, oidcRedirectUris: ['/relative/callback'] }).success);
  assert.ok(!HostEntrySchema.safeParse({ ...hostBase, oidcRedirectUris: ['not-a-url'] }).success);

  const guestBase = { name: 'sonarr', type: 'lxc' as const, vmid: 120, host: 'pve1' };
  assert.ok(GuestEntrySchema.safeParse({ ...guestBase, oidcRedirectUris: ['https://sonarr.example.com/callback'] }).success);
  assert.ok(!GuestEntrySchema.safeParse({ ...guestBase, oidcRedirectUris: ['not-a-url'] }).success);

  const siteBase = { name: 'nas', ip: '192.168.1.5', subdomains: ['nas'] };
  assert.ok(ExternalSiteSchema.safeParse({ ...siteBase, oidcRedirectUris: ['https://nas.example.com/callback'] }).success);
  assert.ok(!ExternalSiteSchema.safeParse({ ...siteBase, oidcRedirectUris: ['not-a-url'] }).success);
});

test('saveInventory/loadInventory round-trip authMode and oidcRedirectUris on a host, a guest, and an external site', () => {
  const dest = tempInventoryDb();
  const inv = loadInventory(dest);
  const updated: Inventory = {
    ...inv,
    hosts: inv.hosts.map((h) =>
      h.name === 'pve1'
        ? { ...h, authGroup: 'bellhop-users', authMode: 'oidc' as const, oidcRedirectUris: ['https://pve1.example.com/callback'] }
        : h
    ),
    guests: inv.guests.map((g) =>
      g.name === 'proxy'
        ? {
            ...g,
            authGroup: 'bellhop-users',
            authMode: 'oidc' as const,
            oidcRedirectUris: ['https://proxy.example.com/callback', 'https://proxy.example.com/callback2'],
          }
        : g
    ),
    externalSites: [
      {
        name: 'nas',
        ip: '192.168.1.250',
        subdomains: ['nas'],
        authGroup: 'bellhop-users',
        authMode: 'oidc' as const,
        oidcRedirectUris: ['https://nas.example.com/callback'],
      },
    ],
  };
  saveInventory(dest, updated);

  const reloaded = loadInventory(dest);
  const pve1 = reloaded.hosts.find((h) => h.name === 'pve1')!;
  assert.equal(pve1.authMode, 'oidc');
  assert.deepEqual(pve1.oidcRedirectUris, ['https://pve1.example.com/callback']);

  const proxy = reloaded.guests.find((g) => g.name === 'proxy')!;
  assert.equal(proxy.authMode, 'oidc');
  assert.deepEqual(proxy.oidcRedirectUris, ['https://proxy.example.com/callback', 'https://proxy.example.com/callback2']);

  const nas = reloaded.externalSites?.find((s) => s.name === 'nas')!;
  assert.equal(nas.authMode, 'oidc');
  assert.deepEqual(nas.oidcRedirectUris, ['https://nas.example.com/callback']);

  const pve2 = reloaded.hosts.find((h) => h.name === 'pve2')!;
  assert.equal(pve2.authMode, undefined, 'a host with no authMode given must stay undefined, not "forward"');
  assert.equal(pve2.oidcRedirectUris, undefined, 'a host with no oidcRedirectUris given must stay undefined, not []');
});

test('opening a pre-existing database without the auth_mode/oidc_redirect_uris_json columns migrates them in place', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bellhop-test-'));
  const dest = path.join(dir, 'bellhop.db');
  const legacyDb = new Database(dest);
  legacyDb.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE hosts (
      name TEXT PRIMARY KEY, ssh_target TEXT NOT NULL, ssh_user TEXT NOT NULL,
      role TEXT, caddy INTEGER NOT NULL DEFAULT 0,
      ip TEXT, port INTEGER, insecure_backend_tls INTEGER,
      bridges_json TEXT, storages_json TEXT, nfs_mounts_json TEXT
    );
    CREATE TABLE guests (
      name TEXT PRIMARY KEY, type TEXT NOT NULL, vmid INTEGER NOT NULL,
      host TEXT NOT NULL REFERENCES hosts(name),
      ip TEXT, port INTEGER, insecure_backend_tls INTEGER,
      caddy INTEGER NOT NULL DEFAULT 0, unprivileged INTEGER, app TEXT,
      UNIQUE (host, vmid)
    );
    CREATE TABLE external_sites (name TEXT PRIMARY KEY, ip TEXT NOT NULL, port INTEGER, insecure_backend_tls INTEGER);
    CREATE TABLE subdomains (subdomain TEXT PRIMARY KEY, owner_type TEXT NOT NULL, owner_name TEXT NOT NULL);
    CREATE TABLE caddy_owner (id INTEGER PRIMARY KEY CHECK (id = 1), owner_type TEXT NOT NULL, owner_name TEXT NOT NULL);
  `);
  legacyDb.prepare("INSERT INTO meta (key, value) VALUES ('domain', 'example.com')").run();
  legacyDb.prepare("INSERT INTO hosts (name, ssh_target, ssh_user) VALUES ('pve1', 'pve1.local', 'root')").run();
  legacyDb.close();

  const inv = loadInventory(dest);
  assert.equal(inv.hosts[0].authMode, undefined, 'a pre-migration row has no auth_mode value');
  assert.equal(inv.hosts[0].oidcRedirectUris, undefined, 'a pre-migration row has no oidc_redirect_uris_json value');

  const updated: Inventory = {
    ...inv,
    hosts: inv.hosts.map((h) => ({
      ...h,
      authentik: true,
      ip: '192.168.1.5',
      authGroup: 'bellhop-users',
      authMode: 'oidc' as const,
      oidcRedirectUris: ['https://pve1.example.com/callback'],
    })),
  };
  saveInventory(dest, updated);
  const reloaded = loadInventory(dest);
  assert.equal(reloaded.hosts[0].authMode, 'oidc', 'the migrated auth_mode column must actually be writable/readable');
  assert.deepEqual(
    reloaded.hosts[0].oidcRedirectUris,
    ['https://pve1.example.com/callback'],
    'the migrated oidc_redirect_uris_json column must actually be writable/readable'
  );
});

test('effectiveAuth returns ungated with no authGroup', () => {
  assert.equal(effectiveAuth({}), 'ungated');
  assert.equal(effectiveAuth({ authMode: 'oidc' }), 'ungated');
});

test('effectiveAuth returns forward with authGroup and authMode unset or forward', () => {
  assert.equal(effectiveAuth({ authGroup: 'bellhop-users' }), 'forward');
  assert.equal(effectiveAuth({ authGroup: 'bellhop-users', authMode: 'forward' }), 'forward');
});

test('effectiveAuth returns oidc with authGroup and authMode: oidc', () => {
  assert.equal(effectiveAuth({ authGroup: 'bellhop-users', authMode: 'oidc' }), 'oidc');
});

test('parseAuthMode treats null, undefined, and empty string as unset', () => {
  assert.equal(parseAuthMode(null), undefined);
  assert.equal(parseAuthMode(undefined), undefined);
  assert.equal(parseAuthMode(''), undefined);
});

test('parseAuthMode accepts forward and oidc verbatim', () => {
  assert.equal(parseAuthMode('forward'), 'forward');
  assert.equal(parseAuthMode('oidc'), 'oidc');
});

test('parseAuthMode throws on an invalid value, naming the field', () => {
  assert.throws(() => parseAuthMode('basic'), /authMode/);
});

test('parseOidcRedirectUris accepts a semicolon-joined string, dedupes, and keeps order', () => {
  assert.deepEqual(
    parseOidcRedirectUris('https://a.example.com/cb ; https://b.example.com/cb; https://a.example.com/cb'),
    ['https://a.example.com/cb', 'https://b.example.com/cb']
  );
});

test('parseOidcRedirectUris accepts an array, dedupes, and keeps order', () => {
  assert.deepEqual(
    parseOidcRedirectUris(['https://a.example.com/cb', 'https://b.example.com/cb', 'https://a.example.com/cb']),
    ['https://a.example.com/cb', 'https://b.example.com/cb']
  );
});

test('parseOidcRedirectUris returns undefined for empty input', () => {
  assert.equal(parseOidcRedirectUris(''), undefined);
  assert.equal(parseOidcRedirectUris('   '), undefined);
  assert.equal(parseOidcRedirectUris(undefined), undefined);
  assert.equal(parseOidcRedirectUris([]), undefined);
});

test('parseOidcRedirectUris throws on a non-http(s) URL, naming the URL', () => {
  assert.throws(() => parseOidcRedirectUris('ftp://a.example.com/cb'), /ftp:\/\/a\.example\.com\/cb/);
  assert.throws(() => parseOidcRedirectUris('/relative/callback'), /\/relative\/callback/);
});

test('oidcConfigErrors requires at least one redirect URI when effectiveAuth is oidc and the entry has subdomains', () => {
  const errors = oidcConfigErrors({ authGroup: 'bellhop-users', authMode: 'oidc', subdomains: ['sonarr'] });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /oidcRedirectUris/);
});

test('oidcConfigErrors is fine when redirect URIs are present', () => {
  assert.deepEqual(
    oidcConfigErrors({
      authGroup: 'bellhop-users',
      authMode: 'oidc',
      subdomains: ['sonarr'],
      oidcRedirectUris: ['https://sonarr.example.com/cb'],
    }),
    []
  );
});

test('oidcConfigErrors is fine for a forward-effective entry with no redirect URIs', () => {
  assert.deepEqual(oidcConfigErrors({ authGroup: 'bellhop-users', subdomains: ['sonarr'] }), []);
});

test('oidcConfigErrors is fine for an oidc-effective entry with no subdomains', () => {
  assert.deepEqual(oidcConfigErrors({ authGroup: 'bellhop-users', authMode: 'oidc' }), []);
});

test('validateInventory allows an OIDC-gated entry with no authentik:true entry anywhere', () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
    guests: [
      {
        name: 'sonarr',
        type: 'lxc',
        vmid: 120,
        host: 'pve1',
        ip: '192.168.1.20',
        subdomains: ['sonarr'],
        authGroup: 'bellhop-users',
        authMode: 'oidc',
      },
    ],
  };
  assert.deepEqual(validateInventory(inv), []);
});

test('validateInventory still requires an authentik:true entry when a forward-gated entry coexists with an OIDC one', () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
    guests: [
      {
        name: 'sonarr',
        type: 'lxc',
        vmid: 120,
        host: 'pve1',
        ip: '192.168.1.20',
        subdomains: ['sonarr'],
        authGroup: 'bellhop-users',
        authMode: 'oidc',
      },
      {
        name: 'radarr',
        type: 'lxc',
        vmid: 121,
        host: 'pve1',
        ip: '192.168.1.21',
        subdomains: ['radarr'],
        authGroup: 'bellhop-users',
      },
    ],
  };
  const errors = validateInventory(inv);
  assert.ok(errors.some((e) => e.includes("'radarr' has an 'authGroup' set but no entry has 'authentik: true'")));
  assert.ok(!errors.some((e) => e.includes("'sonarr'")), 'the OIDC-gated entry must not appear in the forward-auth error');
});
