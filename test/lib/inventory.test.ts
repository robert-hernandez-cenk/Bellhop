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
  parseOidcMobileRedirectUris,
  effectiveAuth,
  oidcConfigErrors,
  sortInventoryForFile,
  refreshInventory,
  withFreshSettings,
  HostEntrySchema,
  GuestEntrySchema,
  GuestCreatorSchema,
  ExternalSiteSchema,
  UnauthenticatedPathSchema,
  SettingsSchema,
  SETTINGS_KEYS,
  findProxyEntry,
  type Inventory,
} from '../../src/lib/inventory.ts';
import { parsePathPattern } from '../../src/lib/proxy/routes.ts';

const FIXTURE_INVENTORY: Inventory = {
  domain: 'example.com',
  hosts: [
    { name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' } },
    { name: 'pve2', ssh_target: 'pve2.local', ssh_user: 'root', midScheme: { vmidBase: 5000, ipPrefix: '192.168.2.', gateway: '192.168.3.1' } },
  ],
  guests: [
    { name: 'media', type: 'lxc', vmid: 105, host: 'pve1', ip: '192.168.1.50', port: 8080, subdomains: ['media'] },
    { name: 'windows-test', type: 'vm', vmid: 201, host: 'pve2' },
    { name: 'proxy', type: 'lxc', vmid: 110, host: 'pve1', ip: '192.168.1.10', proxy: true },
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
  assert.equal(findProxyEntry(inv)?.name, 'proxy', 'proxy: true round-trips through the proxy column');
});

test('saveInventory records the proxy host in proxy_owner', () => {
  const dest = tempInventoryDb();
  const db = new Database(dest, { readonly: true });
  const row = db.prepare('SELECT owner_type, owner_name FROM proxy_owner').get();
  const cols = (db.prepare('PRAGMA table_info(guests)').all() as { name: string }[]).map((c) => c.name);
  db.close();
  assert.deepEqual({ ...(row as object) }, { owner_type: 'guest', owner_name: 'proxy' });
  assert.ok(cols.includes('proxy') && cols.includes('proxy_manual'));
  assert.ok(!cols.includes('caddy') && !cols.includes('caddy_manual'));
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

test('validateInventory flags more than one proxy: true entry', () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [
      { name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', proxy: true },
    ],
    guests: [
      { name: 'proxy', type: 'lxc', vmid: 110, host: 'pve1', ip: '192.168.1.10', proxy: true },
    ],
  };
  const errors = validateInventory(inv);
  assert.ok(errors.some((e) => e.includes("multiple entries flagged 'proxy: true'")));
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

// issue #58 (unit U1): creator records the web-UI actor that created a
// guest, set only by create-lxc/create-vm/install-app's apply step or
// backfill-guest-creators -- but, same as appSource above, must survive a
// plain save/load cycle like every other guest field.
test('saveInventory/loadInventory round-trips a guest creator with uid and username', () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
    guests: [{ name: 'web-lxc', type: 'lxc', vmid: 4020, host: 'pve1', creator: { uid: 'uid-test-user', username: 'test-user' } }],
  };
  const dir = mkdtempSync(path.join(tmpdir(), 'bellhop-test-'));
  const dest = path.join(dir, 'bellhop.db');
  saveInventory(dest, inv);
  const loaded = loadInventory(dest);
  const guest = loaded.guests.find((g) => g.name === 'web-lxc');
  assert.deepEqual(guest?.creator, { uid: 'uid-test-user', username: 'test-user' });
});

test('saveInventory/loadInventory round-trips a guest creator with username only, omitting the uid key entirely', () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
    guests: [{ name: 'demo-vm', type: 'vm', vmid: 4021, host: 'pve1', creator: { username: 'other-user' } }],
  };
  const dir = mkdtempSync(path.join(tmpdir(), 'bellhop-test-'));
  const dest = path.join(dir, 'bellhop.db');
  saveInventory(dest, inv);
  const loaded = loadInventory(dest);
  const guest = loaded.guests.find((g) => g.name === 'demo-vm');
  assert.equal(guest?.creator?.username, 'other-user');
  assert.ok(guest?.creator && !('uid' in guest.creator), 'a creator with no uid must round-trip without a uid key at all, not creator.uid === undefined');
});

test('a guest saved without a creator loads with no creator key at all', () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
    guests: [{ name: 'media', type: 'lxc', vmid: 4022, host: 'pve1' }],
  };
  const dir = mkdtempSync(path.join(tmpdir(), 'bellhop-test-'));
  const dest = path.join(dir, 'bellhop.db');
  saveInventory(dest, inv);
  const loaded = loadInventory(dest);
  const guest = loaded.guests.find((g) => g.name === 'media');
  assert.ok(guest && !('creator' in guest), 'a guest with no creator must round-trip without a creator key at all, not creator === undefined');
});

test('GuestCreatorSchema rejects an empty username, with or without a uid', () => {
  assert.equal(GuestCreatorSchema.safeParse({ username: '' }).success, false);
  assert.equal(GuestCreatorSchema.safeParse({ uid: '', username: 'x' }).success, false);
  assert.equal(GuestCreatorSchema.safeParse({ username: 'test-user' }).success, true);
  assert.equal(GuestCreatorSchema.safeParse({ uid: 'uid-test-user', username: 'test-user' }).success, true);
  assert.equal(GuestCreatorSchema.safeParse({ username: 'test-user', since: '' }).success, false);
});

// Final review (#58), finding 2: `since` records when the creator was
// recorded, so the job lift never reaches a reused name's older jobs.
test('saveInventory/loadInventory round-trips a creator `since`, and omits the key when absent', () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
    guests: [
      {
        name: 'web-lxc',
        type: 'lxc',
        vmid: 4020,
        host: 'pve1',
        creator: { uid: 'uid-test-user', username: 'test-user', since: '2026-01-02T03:04:05.000Z' },
      },
      { name: 'demo-vm', type: 'vm', vmid: 4021, host: 'pve1', creator: { username: 'other-user' } },
    ],
  };
  const dest = path.join(mkdtempSync(path.join(tmpdir(), 'bellhop-test-')), 'bellhop.db');
  saveInventory(dest, inv);
  const loaded = loadInventory(dest);
  assert.deepEqual(loaded.guests.find((g) => g.name === 'web-lxc')?.creator, {
    uid: 'uid-test-user',
    username: 'test-user',
    since: '2026-01-02T03:04:05.000Z',
  });
  const noSince = loaded.guests.find((g) => g.name === 'demo-vm')?.creator;
  assert.ok(noSince && !('since' in noSince), 'a creator with no since must round-trip without a since key at all');
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

test('validateInventory does not require ip when proxyManual is set', () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', subdomains: ['pve1'], proxyManual: true }],
    guests: [],
  };
  const errors = validateInventory(inv);
  assert.deepEqual(errors, []);
});

test('validateInventory still requires ip when proxyManual is not set', () => {
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

test('parseUnauthenticatedPaths throws on a pattern missing a leading slash, naming the accepted forms', () => {
  assert.throws(
    () => parseUnauthenticatedPaths('api/*'),
    /Invalid unauthenticated path 'api\/\*' \(must be an exact path \(\/health\) or a prefix ending in \/\* \(\/api\/\*\)\)/
  );
  assert.throws(() => parseUnauthenticatedPaths('/api/*; system'), /Invalid unauthenticated path 'system'/);
});

// issue #30 review: the Authentik outpost's own namespace is always routed
// to the outpost (Caddy's `handle /outpost.goauthentik.io/*`, nginx's
// outpost location), so an exemption there could never take effect --
// rejected at edit time rather than silently dropped by a driver.
test('parseUnauthenticatedPaths rejects every form of a path in the outpost namespace, naming why', () => {
  for (const bad of [
    '/outpost.goauthentik.io',
    '/outpost.goauthentik.io/',
    '/outpost.goauthentik.io/*',
    '/outpost.goauthentik.io/auth/nginx',
    '/outpost.goauthentik.io/start/*',
  ]) {
    assert.throws(
      () => parseUnauthenticatedPaths(`/health; ${bad}`),
      (err: Error) =>
        err.message.includes(`'${bad}'`) && /belong.* to the Authentik outpost/.test(err.message) && /can't be exempted/.test(err.message),
      bad
    );
  }
});

test('parseUnauthenticatedPaths still accepts a path that merely starts with the outpost name', () => {
  assert.deepEqual(parseUnauthenticatedPaths('/outpost.goauthentik.iox; /outpost.goauthentik.io-docs/*'), [
    '/outpost.goauthentik.iox',
    '/outpost.goauthentik.io-docs/*',
  ]);
});

test('UnauthenticatedPathSchema still loads a saved outpost-namespace path (only the edit rule is stricter)', () => {
  assert.equal(UnauthenticatedPathSchema.safeParse('/outpost.goauthentik.io/*').success, true);
});

// issue #10, US4/T038: a path exemption is restricted to the two forms
// every reverse proxy can express -- an exact path, or a prefix ending in
// /*. Anything else (a '*' anywhere but as a trailing "/*") is rejected,
// from a guest edit (parseUnauthenticatedPaths, exercised here) exactly
// like it is from the schema (below) and from parsePathPattern
// (test/lib/proxy/routes.test.ts) -- all three must agree.
test('parseUnauthenticatedPaths accepts an exact path, a /* prefix, and the bare /* prefix', () => {
  assert.deepEqual(parseUnauthenticatedPaths('/health'), ['/health']);
  assert.deepEqual(parseUnauthenticatedPaths('/api/*'), ['/api/*']);
  assert.deepEqual(parseUnauthenticatedPaths('/*'), ['/*']);
});

test('parseUnauthenticatedPaths rejects a star anywhere but a trailing /*, naming both accepted forms', () => {
  for (const bad of ['/a*b', '*/x', '/api*', '/*/x', '/a/*/b']) {
    assert.throws(() => parseUnauthenticatedPaths(bad), (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      return (
        message.includes(`Invalid unauthenticated path '${bad}'`) &&
        message.includes('must be an exact path (/health) or a prefix ending in /* (/api/*)')
      );
    });
  }
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

test('saveInventory/loadInventory round-trips proxyManual on a host and a guest', () => {
  const dest = tempInventoryDb();
  const inv = loadInventory(dest);
  const updated: Inventory = {
    ...inv,
    hosts: inv.hosts.map((h) => (h.name === 'pve1' ? { ...h, proxyManual: true } : h)),
    guests: inv.guests.map((g) => (g.name === 'proxy' ? { ...g, proxyManual: true } : g)),
  };
  saveInventory(dest, updated);

  const reloaded = loadInventory(dest);
  assert.equal(reloaded.hosts.find((h) => h.name === 'pve1')?.proxyManual, true);
  assert.equal(
    reloaded.hosts.find((h) => h.name === 'pve2')?.proxyManual,
    undefined,
    'a host with no proxyManual given must stay undefined, not false'
  );
  assert.equal(reloaded.guests.find((g) => g.name === 'proxy')?.proxyManual, true);
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
  assert.throws(() => loadInventory(dest), /must be an exact path \(\/health\) or a prefix ending in \/\* \(\/api\/\*\)/);
});

// issue #10, US4/T038-T039: the schema-level rejection message and accepted
// forms must match parseUnauthenticatedPaths (above) and parsePathPattern
// (test/lib/proxy/routes.test.ts) exactly -- HostEntrySchema is exercised
// here as a stand-in for all three schemas, which share the one
// UnauthenticatedPathSchema definition.
test('HostEntrySchema accepts /health, /api/*, and the bare /* prefix for unauthenticatedPaths', () => {
  const base = { name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' };
  for (const good of ['/health', '/api/*', '/*']) {
    assert.doesNotThrow(() => HostEntrySchema.parse({ ...base, unauthenticatedPaths: [good] }));
  }
});

test('HostEntrySchema rejects a star anywhere but a trailing /* for unauthenticatedPaths, naming both accepted forms', () => {
  const base = { name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' };
  for (const bad of ['/a*b', '*/x', '/api*', '/*/x', '/a/*/b']) {
    assert.throws(
      () => HostEntrySchema.parse({ ...base, unauthenticatedPaths: [bad] }),
      /must be an exact path \(\/health\) or a prefix ending in \/\* \(\/api\/\*\)/
    );
  }
});

// GuestEntrySchema and ExternalSiteSchema share the exact same
// UnauthenticatedPathSchema -- one representative rejection from each is
// enough to prove they didn't drift into their own copy.
test('GuestEntrySchema and ExternalSiteSchema reject the same invalid unauthenticatedPaths forms as HostEntrySchema', () => {
  assert.throws(
    () =>
      GuestEntrySchema.parse({
        name: 'app', type: 'lxc', vmid: 100, host: 'pve1', unauthenticatedPaths: ['/a*b'],
      }),
    /must be an exact path \(\/health\) or a prefix ending in \/\* \(\/api\/\*\)/
  );
  assert.throws(
    () =>
      ExternalSiteSchema.parse({
        name: 'nas', ip: '192.168.1.250', subdomains: ['nas'], unauthenticatedPaths: ['/*/x'],
      }),
    /must be an exact path \(\/health\) or a prefix ending in \/\* \(\/api\/\*\)/
  );
});

// T039: the schema and parsePathPattern must agree on every accepted
// string -- this is the "agreement test" the task names, feeding a mix of
// accepted and rejected forms through both and asserting they land the
// same way.
test('UnauthenticatedPathSchema and parsePathPattern agree on every accepted and rejected form', () => {
  const candidates = ['/health', '/api/*', '/*', '/', '/a*b', '*/x', '/api*', '/*/x', '/a/*/b', 'api/*'];
  for (const candidate of candidates) {
    const schemaResult = UnauthenticatedPathSchema.safeParse(candidate);
    let parsePatternAccepted = true;
    try {
      parsePathPattern(candidate);
    } catch {
      parsePatternAccepted = false;
    }
    assert.equal(
      schemaResult.success,
      parsePatternAccepted,
      `schema and parsePathPattern disagree on '${candidate}'`
    );
  }
});

test('opening a pre-existing database without the unauthenticated_paths_json column migrates it in place', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bellhop-test-'));
  const dest = path.join(dir, 'bellhop.db');
  const legacyDb = new Database(dest);
  legacyDb.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE hosts (
      name TEXT PRIMARY KEY, ssh_target TEXT NOT NULL, ssh_user TEXT NOT NULL,
      role TEXT, proxy INTEGER NOT NULL DEFAULT 0,
      ip TEXT, port INTEGER, insecure_backend_tls INTEGER,
      bridges_json TEXT, storages_json TEXT, nfs_mounts_json TEXT
    );
    CREATE TABLE guests (
      name TEXT PRIMARY KEY, type TEXT NOT NULL, vmid INTEGER NOT NULL,
      host TEXT NOT NULL REFERENCES hosts(name),
      ip TEXT, port INTEGER, insecure_backend_tls INTEGER,
      proxy INTEGER NOT NULL DEFAULT 0, unprivileged INTEGER, app TEXT,
      UNIQUE (host, vmid)
    );
    CREATE TABLE external_sites (name TEXT PRIMARY KEY, ip TEXT NOT NULL, port INTEGER, insecure_backend_tls INTEGER);
    CREATE TABLE subdomains (subdomain TEXT PRIMARY KEY, owner_type TEXT NOT NULL, owner_name TEXT NOT NULL);
    CREATE TABLE proxy_owner (id INTEGER PRIMARY KEY CHECK (id = 1), owner_type TEXT NOT NULL, owner_name TEXT NOT NULL);
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
      role TEXT, proxy INTEGER NOT NULL DEFAULT 0,
      ip TEXT, port INTEGER, insecure_backend_tls INTEGER,
      bridges_json TEXT, storages_json TEXT, nfs_mounts_json TEXT
    );
    CREATE TABLE guests (
      name TEXT PRIMARY KEY, type TEXT NOT NULL, vmid INTEGER NOT NULL,
      host TEXT NOT NULL REFERENCES hosts(name),
      ip TEXT, port INTEGER, insecure_backend_tls INTEGER,
      proxy INTEGER NOT NULL DEFAULT 0, unprivileged INTEGER, app TEXT,
      UNIQUE (host, vmid)
    );
    CREATE TABLE external_sites (name TEXT PRIMARY KEY, ip TEXT NOT NULL, port INTEGER, insecure_backend_tls INTEGER);
    CREATE TABLE subdomains (subdomain TEXT PRIMARY KEY, owner_type TEXT NOT NULL, owner_name TEXT NOT NULL);
    CREATE TABLE proxy_owner (id INTEGER PRIMARY KEY CHECK (id = 1), owner_type TEXT NOT NULL, owner_name TEXT NOT NULL);
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

test('opening a pre-existing database without the proxy_manual/ssh_port/ssh_identity_file columns migrates them in place', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bellhop-test-'));
  const dest = path.join(dir, 'bellhop.db');
  const legacyDb = new Database(dest);
  legacyDb.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE hosts (
      name TEXT PRIMARY KEY, ssh_target TEXT NOT NULL, ssh_user TEXT NOT NULL,
      role TEXT, proxy INTEGER NOT NULL DEFAULT 0,
      ip TEXT, port INTEGER, insecure_backend_tls INTEGER,
      bridges_json TEXT, storages_json TEXT, nfs_mounts_json TEXT
    );
    CREATE TABLE guests (
      name TEXT PRIMARY KEY, type TEXT NOT NULL, vmid INTEGER NOT NULL,
      host TEXT NOT NULL REFERENCES hosts(name),
      ip TEXT, port INTEGER, insecure_backend_tls INTEGER,
      proxy INTEGER NOT NULL DEFAULT 0, unprivileged INTEGER, app TEXT,
      UNIQUE (host, vmid)
    );
    CREATE TABLE external_sites (name TEXT PRIMARY KEY, ip TEXT NOT NULL, port INTEGER, insecure_backend_tls INTEGER);
    CREATE TABLE subdomains (subdomain TEXT PRIMARY KEY, owner_type TEXT NOT NULL, owner_name TEXT NOT NULL);
    CREATE TABLE proxy_owner (id INTEGER PRIMARY KEY CHECK (id = 1), owner_type TEXT NOT NULL, owner_name TEXT NOT NULL);
  `);
  legacyDb.prepare("INSERT INTO meta (key, value) VALUES ('domain', 'example.com')").run();
  legacyDb.prepare("INSERT INTO hosts (name, ssh_target, ssh_user) VALUES ('pve1', 'pve1.local', 'root')").run();
  legacyDb.close();

  const inv = loadInventory(dest);
  assert.equal(inv.hosts[0].proxyManual, undefined, 'a pre-migration row has no proxy_manual value');
  assert.equal(inv.hosts[0].ssh_port, undefined, 'a pre-migration row has no ssh_port value');
  assert.equal(inv.hosts[0].ssh_identity_file, undefined, 'a pre-migration row has no ssh_identity_file value');

  const updated: Inventory = {
    ...inv,
    hosts: inv.hosts.map((h) => ({ ...h, proxyManual: true, ssh_port: 2222, ssh_identity_file: '~/.ssh/pve_key' })),
  };
  saveInventory(dest, updated);
  const reloaded = loadInventory(dest);
  assert.equal(reloaded.hosts[0].proxyManual, true, 'the migrated proxy_manual column must actually be writable/readable');
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
      proxy INTEGER NOT NULL DEFAULT 0,
      ip TEXT, port INTEGER, insecure_backend_tls INTEGER,
      bridges_json TEXT, storages_json TEXT, nfs_mounts_json TEXT
    );
    CREATE TABLE guests (
      name TEXT PRIMARY KEY, type TEXT NOT NULL, vmid INTEGER NOT NULL,
      host TEXT NOT NULL REFERENCES hosts(name),
      ip TEXT, port INTEGER, insecure_backend_tls INTEGER,
      proxy INTEGER NOT NULL DEFAULT 0, unprivileged INTEGER, app TEXT,
      UNIQUE (host, vmid)
    );
    CREATE TABLE external_sites (name TEXT PRIMARY KEY, ip TEXT NOT NULL, port INTEGER, insecure_backend_tls INTEGER);
    CREATE TABLE subdomains (subdomain TEXT PRIMARY KEY, owner_type TEXT NOT NULL, owner_name TEXT NOT NULL);
    CREATE TABLE proxy_owner (id INTEGER PRIMARY KEY CHECK (id = 1), owner_type TEXT NOT NULL, owner_name TEXT NOT NULL);
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

test('opening a pre-existing database without the created_by_uid/created_by_username columns migrates it in place', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bellhop-test-'));
  const dest = path.join(dir, 'bellhop.db');
  const legacyDb = new Database(dest);
  legacyDb.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE hosts (
      name TEXT PRIMARY KEY, ssh_target TEXT NOT NULL, ssh_user TEXT NOT NULL,
      proxy INTEGER NOT NULL DEFAULT 0,
      ip TEXT, port INTEGER, insecure_backend_tls INTEGER,
      bridges_json TEXT, storages_json TEXT, nfs_mounts_json TEXT
    );
    CREATE TABLE guests (
      name TEXT PRIMARY KEY, type TEXT NOT NULL, vmid INTEGER NOT NULL,
      host TEXT NOT NULL REFERENCES hosts(name),
      ip TEXT, port INTEGER, insecure_backend_tls INTEGER,
      proxy INTEGER NOT NULL DEFAULT 0, unprivileged INTEGER, app TEXT,
      UNIQUE (host, vmid)
    );
    CREATE TABLE external_sites (name TEXT PRIMARY KEY, ip TEXT NOT NULL, port INTEGER, insecure_backend_tls INTEGER);
    CREATE TABLE subdomains (subdomain TEXT PRIMARY KEY, owner_type TEXT NOT NULL, owner_name TEXT NOT NULL);
    CREATE TABLE proxy_owner (id INTEGER PRIMARY KEY CHECK (id = 1), owner_type TEXT NOT NULL, owner_name TEXT NOT NULL);
  `);
  legacyDb.prepare("INSERT INTO meta (key, value) VALUES ('domain', 'example.com')").run();
  legacyDb.prepare("INSERT INTO hosts (name, ssh_target, ssh_user) VALUES ('pve1', 'pve1.local', 'root')").run();
  legacyDb
    .prepare("INSERT INTO guests (name, type, vmid, host, app) VALUES ('web-lxc', 'lxc', 4020, 'pve1', 'myapp')")
    .run();
  legacyDb.close();

  const inv = loadInventory(dest);
  assert.equal(inv.guests[0].creator, undefined, 'a pre-migration row has no creator value');

  const updated: Inventory = {
    ...inv,
    guests: inv.guests.map((g) => ({
      ...g,
      creator: { uid: 'uid-test-user', username: 'test-user', since: '2026-01-02T03:04:05.000Z' },
    })),
  };
  saveInventory(dest, updated);
  const reloaded = loadInventory(dest);
  assert.deepEqual(
    reloaded.guests[0].creator,
    { uid: 'uid-test-user', username: 'test-user', since: '2026-01-02T03:04:05.000Z' },
    'the migrated created_by_uid/created_by_username/created_by_since columns must actually be writable/readable'
  );
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

test('SETTINGS_KEYS lists exactly the twenty-eight settings keys', () => {
  assert.deepEqual([...SETTINGS_KEYS].sort(), [
    'acmeDnsProvider',
    'authentikAdminGroup',
    'authentikApiUrl',
    'authentikAuthorizationFlowSlug',
    'authentikBuiltinAdminGroup',
    'authentikGroupLadder',
    'authentikInvalidationFlowSlug',
    'authentikOidcSigningKeyName',
    'authentikOutpostName',
    'authentikOutpostPort',
    'backupStorage',
    'customScriptsBranch',
    'customScriptsRepo',
    'dnsServer',
    'nfsServer',
    'npmApiEmail',
    'npmApiUrl',
    'proxyApiUrl',
    'proxyCertResolver',
    'proxyConfigPath',
    'proxyDriver',
    'proxyTlsCertificate',
    'proxyTlsKey',
    'pveCreatorRole',
    'pveUserRealm',
    'statusPagePath',
    'tlsSource',
    'webUiAuthMode',
  ]);
});

test('findProxyEntry returns the entry flagged proxy: true', () => {
  assert.equal(findProxyEntry(FIXTURE_INVENTORY)?.name, 'proxy');
});

test('findProxyEntry returns undefined when no entry is flagged', () => {
  assert.equal(
    findProxyEntry({ ...FIXTURE_INVENTORY, guests: FIXTURE_INVENTORY.guests.filter((g) => !g.proxy) }),
    undefined
  );
});

test('an entry carrying the old caddy/caddyManual keys does not become a proxy host (no alias)', () => {
  const host = HostEntrySchema.parse({ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', caddy: true, caddyManual: true });
  const guest = GuestEntrySchema.parse({ name: 'edge', type: 'lxc', vmid: 110, host: 'pve1', caddy: true, caddyManual: true });
  assert.equal(host.proxy, undefined);
  assert.equal(host.proxyManual, undefined);
  assert.equal(guest.proxy, undefined);
  assert.equal(guest.proxyManual, undefined);
  assert.ok(!('caddy' in host) && !('caddyManual' in guest), 'zod strips the old keys');
  assert.equal(findProxyEntry({ domain: 'example.com', hosts: [host], guests: [guest] }), undefined);
});

test('SettingsSchema accepts proxyDriver caddy and an absolute proxyConfigPath', () => {
  const result = SettingsSchema.safeParse({ proxyDriver: 'caddy', proxyConfigPath: '/etc/caddy/Caddyfile' });
  assert.equal(result.success, true);
});

test('SettingsSchema rejects an unknown proxyDriver and a relative proxyConfigPath', () => {
  assert.equal(SettingsSchema.safeParse({ proxyDriver: 'unknown-provider' }).success, false);
  assert.equal(SettingsSchema.safeParse({ proxyConfigPath: 'etc/caddy/Caddyfile' }).success, false);
});

// issue #33: 'none' is a real registered driver id, so PROXY_DRIVER_IDS
// (and therefore this schema's proxyDriver enum) accepts it the same way it
// accepts 'caddy' and 'nginx' -- an id no driver is registered under stays
// rejected.
test('SettingsSchema accepts proxyDriver "none" and still rejects an unknown id', () => {
  assert.equal(SettingsSchema.safeParse({ proxyDriver: 'none' }).success, true);
  assert.equal(SettingsSchema.safeParse({ proxyDriver: 'unknown-provider' }).success, false);
});

// issue #32: the enum is built from PROXY_DRIVER_IDS, so adding 'haproxy'
// there is all it takes for a saved inventory naming it to load.
test('SettingsSchema accepts proxyDriver "haproxy", and an inventory naming it round-trips through save/load', () => {
  assert.equal(SettingsSchema.safeParse({ proxyDriver: 'haproxy' }).success, true);
  const dir = mkdtempSync(path.join(tmpdir(), 'bellhop-test-'));
  const dest = path.join(dir, 'bellhop.db');
  saveInventory(dest, { ...FIXTURE_INVENTORY, proxyDriver: 'haproxy' });
  assert.equal(loadInventory(dest).proxyDriver, 'haproxy');
});

// issue #72: proxyCaddyTls (issue #51) is gone -- tlsSource replaced it.
// A database still holding a legacy proxyCaddyTls / proxyCertResolver 'none'
// meta row is converted once, on open, by migrateLegacyTlsSettings (User
// Story 4); the conversion table itself is pinned in
// test/lib/proxy/legacy-tls.test.ts, so these tests pin the database side:
// rows written/removed, the log line, and idempotence.

test('SettingsSchema has no proxyCaddyTls setting', () => {
  assert.equal('proxyCaddyTls' in SettingsSchema.shape, false);
  assert.equal((SETTINGS_KEYS as string[]).includes('proxyCaddyTls'), false);
});

// A fresh database with the given raw meta rows inserted behind the
// schema's back, the way a pre-#72 database holds them.
function legacyDb(rows: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'bellhop-test-'));
  const dest = path.join(dir, 'bellhop.db');
  saveInventory(dest, FIXTURE_INVENTORY);
  const writer = new Database(dest);
  for (const [k, v] of Object.entries(rows)) {
    writer.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);
  }
  writer.close();
  return dest;
}

function metaRow(dest: string, key: string): string | undefined {
  const db = new Database(dest, { readonly: true });
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  db.close();
  return row?.value;
}

// Runs fn with console.log captured; returns the captured lines.
function captureLog(fn: () => void): string[] {
  const lines: string[] = [];
  const original = console.log;
  console.log = (msg: string) => lines.push(msg);
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines;
}

const TLS_MIGRATION_LOG = /Migrated TLS settings to tlsSource (#72, one-time, irreversible): /;

test('opening a database converts each legacy proxyCaddyTls value for caddy, caddy-api and an unset driver (issue #72)', () => {
  const map = { cloudflare: 'acme-dns', letsencrypt: 'acme-http', internal: 'internal', files: 'files' } as const;
  for (const driver of ['caddy', 'caddy-api', undefined]) {
    for (const [legacy, tlsSource] of Object.entries(map)) {
      const dest = legacyDb({ ...(driver ? { proxyDriver: driver } : {}), proxyCaddyTls: legacy });
      let loaded!: Inventory;
      const lines = captureLog(() => {
        loaded = loadInventory(dest);
      });
      assert.equal(loaded.tlsSource, tlsSource, `${driver}/${legacy}`);
      assert.equal(metaRow(dest, 'proxyCaddyTls'), undefined);
      assert.equal(metaRow(dest, 'tlsSource'), tlsSource);
      assert.equal(lines.length, 1);
      assert.ok(
        lines[0].endsWith(
          `Migrated TLS settings to tlsSource (#72, one-time, irreversible): proxyCaddyTls '${legacy}' -> tlsSource '${tlsSource}'; removed proxyCaddyTls`
        ),
        lines[0]
      );
    }
  }
});

test('opening a database converts traefik proxyCertResolver none to tlsSource external and removes it', () => {
  const dest = legacyDb({ proxyDriver: 'traefik', proxyCertResolver: 'none' });
  let loaded!: Inventory;
  const lines = captureLog(() => {
    loaded = loadInventory(dest);
  });
  assert.equal(loaded.tlsSource, 'external');
  assert.equal(loaded.proxyCertResolver, undefined);
  assert.equal(metaRow(dest, 'proxyCertResolver'), undefined);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].endsWith(": proxyCertResolver 'none' -> tlsSource 'external'; removed proxyCertResolver"), lines[0]);
});

test('legacy rows under any other driver are removed without writing tlsSource; a named resolver is untouched', () => {
  const dest = legacyDb({ proxyDriver: 'nginx', proxyCaddyTls: 'internal', proxyCertResolver: 'none' });
  const lines = captureLog(() => {
    loadInventory(dest);
  });
  assert.equal(metaRow(dest, 'tlsSource'), undefined);
  assert.equal(metaRow(dest, 'proxyCaddyTls'), undefined);
  assert.equal(metaRow(dest, 'proxyCertResolver'), undefined);
  assert.equal(lines.length, 1);

  const named = legacyDb({ proxyDriver: 'traefik', proxyCertResolver: 'my-resolver' });
  const namedLines = captureLog(() => {
    loadInventory(named);
  });
  assert.equal(metaRow(named, 'proxyCertResolver'), 'my-resolver');
  assert.equal(namedLines.filter((l) => TLS_MIGRATION_LOG.test(l)).length, 0);
});

test('an existing tlsSource is never overwritten by the migration, though the legacy row is removed', () => {
  const dest = legacyDb({ proxyDriver: 'caddy', proxyCaddyTls: 'letsencrypt', tlsSource: 'internal' });
  captureLog(() => {
    assert.equal(loadInventory(dest).tlsSource, 'internal');
  });
  assert.equal(metaRow(dest, 'proxyCaddyTls'), undefined);
});

test('the TLS migration is one-time: a second open changes and logs nothing', () => {
  const dest = legacyDb({ proxyDriver: 'caddy', proxyCaddyTls: 'cloudflare' });
  captureLog(() => {
    loadInventory(dest);
  });
  const lines = captureLog(() => {
    assert.equal(loadInventory(dest).tlsSource, 'acme-dns');
  });
  assert.equal(lines.filter((l) => TLS_MIGRATION_LOG.test(l)).length, 0);
});

test('a database with no legacy TLS rows logs nothing and gains no tlsSource', () => {
  const dest = legacyDb({ proxyDriver: 'caddy' });
  const lines = captureLog(() => {
    assert.equal(loadInventory(dest).tlsSource, undefined);
  });
  assert.equal(lines.filter((l) => TLS_MIGRATION_LOG.test(l)).length, 0);
});

test('saveInventory also migrates legacy TLS rows on open, so a leftover row never lingers', () => {
  const dest = legacyDb({ proxyDriver: 'caddy', proxyCaddyTls: 'letsencrypt' });
  captureLog(() => {
    saveInventory(dest, { ...FIXTURE_INVENTORY, proxyDriver: 'caddy', tlsSource: 'acme-http' });
  });
  assert.equal(metaRow(dest, 'proxyCaddyTls'), undefined);
  assert.equal(metaRow(dest, 'tlsSource'), 'acme-http');
});

test('a prototype-member proxyCaddyTls row is removed without crashing or writing tlsSource', () => {
  const dest = legacyDb({ proxyDriver: 'caddy', proxyCaddyTls: 'constructor' });
  captureLog(() => {
    assert.equal(loadInventory(dest).tlsSource, undefined);
  });
  assert.equal(metaRow(dest, 'proxyCaddyTls'), undefined);
});

test('saveInventory/loadInventory round-trips proxyDriver and proxyConfigPath', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bellhop-test-'));
  const dest = path.join(dir, 'bellhop.db');
  saveInventory(dest, { ...FIXTURE_INVENTORY, proxyDriver: 'caddy', proxyConfigPath: '/etc/caddy/Caddyfile' });
  const loaded = loadInventory(dest);
  assert.equal(loaded.proxyDriver, 'caddy');
  assert.equal(loaded.proxyConfigPath, '/etc/caddy/Caddyfile');
});

test('SettingsSchema accepts proxyDriver nginx and absolute proxyTlsCertificate/proxyTlsKey', () => {
  const result = SettingsSchema.safeParse({
    proxyDriver: 'nginx',
    proxyTlsCertificate: '/etc/letsencrypt/live/example.com/fullchain.pem',
    proxyTlsKey: '/etc/letsencrypt/live/example.com/privkey.pem',
  });
  assert.equal(result.success, true);
});

test('SettingsSchema rejects a relative proxyTlsCertificate or proxyTlsKey', () => {
  assert.equal(SettingsSchema.safeParse({ proxyTlsCertificate: 'etc/ssl/fullchain.pem' }).success, false);
  assert.equal(SettingsSchema.safeParse({ proxyTlsKey: 'etc/ssl/privkey.pem' }).success, false);
});

test('saveInventory/loadInventory round-trips proxyTlsCertificate and proxyTlsKey, and clearing one removes it from meta', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bellhop-test-'));
  const dest = path.join(dir, 'bellhop.db');
  saveInventory(dest, {
    ...FIXTURE_INVENTORY,
    proxyTlsCertificate: '/etc/letsencrypt/live/example.com/fullchain.pem',
    proxyTlsKey: '/etc/letsencrypt/live/example.com/privkey.pem',
  });
  const loaded = loadInventory(dest);
  assert.equal(loaded.proxyTlsCertificate, '/etc/letsencrypt/live/example.com/fullchain.pem');
  assert.equal(loaded.proxyTlsKey, '/etc/letsencrypt/live/example.com/privkey.pem');

  saveInventory(dest, { ...loaded, proxyTlsCertificate: undefined });
  const reloaded = loadInventory(dest);
  assert.equal(reloaded.proxyTlsCertificate, undefined);
  assert.equal(reloaded.proxyTlsKey, '/etc/letsencrypt/live/example.com/privkey.pem');
  const db = new Database(dest, { readonly: true });
  const row = db.prepare("SELECT value FROM meta WHERE key = 'proxyTlsCertificate'").get();
  db.close();
  assert.equal(row, undefined);
});

// issue #35: proxyCertResolver/proxyApiUrl are the Traefik driver's two own
// settings (data-model.md), following the same optional/independent-default
// pattern as proxyTlsCertificate/proxyTlsKey above.

test('SettingsSchema accepts a proxyCertResolver made of letters, digits, - and _', () => {
  assert.equal(SettingsSchema.safeParse({ proxyCertResolver: 'cloudflare' }).success, true);
  assert.equal(SettingsSchema.safeParse({ proxyCertResolver: 'my-resolver_2' }).success, true);
});

test('SettingsSchema rejects a proxyCertResolver with characters other than letters, digits, - and _', () => {
  assert.equal(SettingsSchema.safeParse({ proxyCertResolver: 'my resolver' }).success, false);
  assert.equal(SettingsSchema.safeParse({ proxyCertResolver: 'resolver.name' }).success, false);
  assert.equal(SettingsSchema.safeParse({ proxyCertResolver: '' }).success, false);
});

test('SettingsSchema accepts an http:// or https:// proxyApiUrl', () => {
  assert.equal(SettingsSchema.safeParse({ proxyApiUrl: 'http://192.0.2.5:8080' }).success, true);
  assert.equal(SettingsSchema.safeParse({ proxyApiUrl: 'https://traefik.example.com' }).success, true);
});

test('SettingsSchema rejects a proxyApiUrl with a non-http(s) scheme, a malformed URL, or an embedded single quote', () => {
  assert.equal(SettingsSchema.safeParse({ proxyApiUrl: 'ftp://192.0.2.5' }).success, false);
  assert.equal(SettingsSchema.safeParse({ proxyApiUrl: 'not a url' }).success, false);
  assert.equal(SettingsSchema.safeParse({ proxyApiUrl: "http://192.0.2.5/it's" }).success, false);
});

test('saveInventory/loadInventory round-trips proxyCertResolver and proxyApiUrl, and clearing one removes it from meta', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bellhop-test-'));
  const dest = path.join(dir, 'bellhop.db');
  saveInventory(dest, {
    ...FIXTURE_INVENTORY,
    proxyCertResolver: 'cloudflare',
    proxyApiUrl: 'http://192.0.2.5:8080',
  });
  const loaded = loadInventory(dest);
  assert.equal(loaded.proxyCertResolver, 'cloudflare');
  assert.equal(loaded.proxyApiUrl, 'http://192.0.2.5:8080');

  saveInventory(dest, { ...loaded, proxyCertResolver: undefined });
  const reloaded = loadInventory(dest);
  assert.equal(reloaded.proxyCertResolver, undefined);
  assert.equal(reloaded.proxyApiUrl, 'http://192.0.2.5:8080');
  const db = new Database(dest, { readonly: true });
  const row = db.prepare("SELECT value FROM meta WHERE key = 'proxyCertResolver'").get();
  db.close();
  assert.equal(row, undefined);
});

// issue #53: pveUserRealm/pveCreatorRole are the Proxmox-creator-grant
// feature's two own settings (data-model.md), following the same
// optional/independent-default pattern as proxyCertResolver/proxyApiUrl
// above -- unset pveUserRealm means the grant is off, and unset
// pveCreatorRole means DEFAULT_CREATOR_ROLE ('PVEVMAdmin').

test('SettingsSchema accepts a pveUserRealm starting with a letter and made of letters, digits, ., - and _', () => {
  assert.equal(SettingsSchema.safeParse({ pveUserRealm: 'authentik' }).success, true);
  assert.equal(SettingsSchema.safeParse({ pveUserRealm: 'a.b-c_2' }).success, true);
});

test('SettingsSchema rejects a pveUserRealm starting with a non-letter or containing an invalid character', () => {
  const startsWithDigit = SettingsSchema.safeParse({ pveUserRealm: '1authentik' });
  assert.equal(startsWithDigit.success, false);
  assert.equal(
    startsWithDigit.error?.issues[0]?.message,
    'must start with a letter and contain only letters, digits, ., - and _'
  );
  assert.equal(SettingsSchema.safeParse({ pveUserRealm: 'auth entik' }).success, false);
  assert.equal(SettingsSchema.safeParse({ pveUserRealm: '' }).success, false);
});

test('SettingsSchema accepts a pveCreatorRole made of letters, digits, ., - and _', () => {
  assert.equal(SettingsSchema.safeParse({ pveCreatorRole: 'PVEVMAdmin' }).success, true);
  assert.equal(SettingsSchema.safeParse({ pveCreatorRole: 'my.role-2_x' }).success, true);
});

test('SettingsSchema rejects a pveCreatorRole with an invalid character', () => {
  const result = SettingsSchema.safeParse({ pveCreatorRole: 'my role' });
  assert.equal(result.success, false);
  assert.equal(result.error?.issues[0]?.message, 'must contain only letters, digits, ., - and _');
  assert.equal(SettingsSchema.safeParse({ pveCreatorRole: '' }).success, false);
});

test('saveInventory/loadInventory round-trips pveUserRealm and pveCreatorRole, and clearing one removes it from meta', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bellhop-test-'));
  const dest = path.join(dir, 'bellhop.db');
  saveInventory(dest, {
    ...FIXTURE_INVENTORY,
    pveUserRealm: 'authentik',
    pveCreatorRole: 'PVEVMAdmin',
  });
  const loaded = loadInventory(dest);
  assert.equal(loaded.pveUserRealm, 'authentik');
  assert.equal(loaded.pveCreatorRole, 'PVEVMAdmin');

  saveInventory(dest, { ...loaded, pveUserRealm: undefined });
  const reloaded = loadInventory(dest);
  assert.equal(reloaded.pveUserRealm, undefined);
  assert.equal(reloaded.pveCreatorRole, 'PVEVMAdmin');
  const db = new Database(dest, { readonly: true });
  const row = db.prepare("SELECT value FROM meta WHERE key = 'pveUserRealm'").get();
  db.close();
  assert.equal(row, undefined);
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

// Issue #64 (FR-020): the #158 migration reads the ladder from the database
// it is migrating -- the stored authentikGroupLadder setting -- with the
// AUTHENTIK_GROUP_LADDER variable still overriding it, and the built-in
// default when neither is set.
function legacyGatedGuestDb(prefix: string, ladder?: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  const dbPath = path.join(dir, 'bellhop.db');
  saveInventory(dbPath, {
    domain: 'example.com',
    authentikGroupLadder: ladder,
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', authentik: true, ip: '192.168.1.5' }],
    guests: [{ name: 'sonarr', type: 'lxc', vmid: 120, host: 'pve1', ip: '192.168.1.20', subdomains: ['sonarr'] }],
  });
  const raw = new Database(dbPath);
  raw.exec('ALTER TABLE guests ADD COLUMN requires_auth INTEGER');
  raw.prepare("UPDATE guests SET requires_auth = 1 WHERE name = 'sonarr'").run();
  raw.close();
  return dbPath;
}

function withLadderEnv<T>(value: string | undefined, fn: () => T): T {
  const previous = process.env.AUTHENTIK_GROUP_LADDER;
  if (value === undefined) delete process.env.AUTHENTIK_GROUP_LADDER;
  else process.env.AUTHENTIK_GROUP_LADDER = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.AUTHENTIK_GROUP_LADDER;
    else process.env.AUTHENTIK_GROUP_LADDER = previous;
  }
}

test('the requires_auth migration uses the stored authentikGroupLadder when no env var is set', () => {
  const dbPath = legacyGatedGuestDb('inventory-migrate-stored-ladder-', 'example-open,example-users,example-admins');
  const migrated = withLadderEnv(undefined, () => loadInventory(dbPath));
  assert.equal(migrated.guests[0].authGroup, 'example-admins');
});

test('the requires_auth migration lets AUTHENTIK_GROUP_LADDER override the stored ladder', () => {
  const dbPath = legacyGatedGuestDb('inventory-migrate-env-ladder-', 'example-open,example-admins');
  const migrated = withLadderEnv('env-open,env-top', () => loadInventory(dbPath));
  assert.equal(migrated.guests[0].authGroup, 'env-top');
});

test('the requires_auth migration falls back to the default ladder when neither is set', () => {
  const dbPath = legacyGatedGuestDb('inventory-migrate-default-ladder-');
  const migrated = withLadderEnv(undefined, () => loadInventory(dbPath));
  const defaultLadder = authentikConfig({}).groupLadder;
  assert.equal(migrated.guests[0].authGroup, defaultLadder[defaultLadder.length - 1]);
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
      role TEXT, proxy INTEGER NOT NULL DEFAULT 0,
      ip TEXT, port INTEGER, insecure_backend_tls INTEGER,
      bridges_json TEXT, storages_json TEXT, nfs_mounts_json TEXT
    );
    CREATE TABLE guests (
      name TEXT PRIMARY KEY, type TEXT NOT NULL, vmid INTEGER NOT NULL,
      host TEXT NOT NULL REFERENCES hosts(name),
      ip TEXT, port INTEGER, insecure_backend_tls INTEGER,
      proxy INTEGER NOT NULL DEFAULT 0, unprivileged INTEGER, app TEXT,
      UNIQUE (host, vmid)
    );
    CREATE TABLE external_sites (name TEXT PRIMARY KEY, ip TEXT NOT NULL, port INTEGER, insecure_backend_tls INTEGER);
    CREATE TABLE subdomains (subdomain TEXT PRIMARY KEY, owner_type TEXT NOT NULL, owner_name TEXT NOT NULL);
    CREATE TABLE proxy_owner (id INTEGER PRIMARY KEY CHECK (id = 1), owner_type TEXT NOT NULL, owner_name TEXT NOT NULL);
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

// --- OIDC mobile-app redirect URIs (issue #22, T002) ---

test('HostEntrySchema/GuestEntrySchema/ExternalSiteSchema accept a custom-scheme or https mobile redirect URI', () => {
  const hostBase = { name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' };
  assert.ok(
    HostEntrySchema.safeParse({ ...hostBase, oidcMobileRedirectUris: ['app.example:///oauth-callback'] }).success
  );
  assert.ok(
    HostEntrySchema.safeParse({
      ...hostBase,
      oidcMobileRedirectUris: ['https://books.example.com/auth/openid/mobile-redirect'],
    }).success
  );

  const guestBase = { name: 'sonarr', type: 'lxc' as const, vmid: 120, host: 'pve1' };
  assert.ok(
    GuestEntrySchema.safeParse({ ...guestBase, oidcMobileRedirectUris: ['app.example:///oauth-callback'] }).success
  );

  const siteBase = { name: 'nas', ip: '192.168.1.5', subdomains: ['nas'] };
  assert.ok(
    ExternalSiteSchema.safeParse({ ...siteBase, oidcMobileRedirectUris: ['app.example:///oauth-callback'] }).success
  );
});

test('HostEntrySchema rejects javascript:/data:/file:/vbscript: schemes (case-insensitive) for oidcMobileRedirectUris', () => {
  const hostBase = { name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' };
  for (const bad of ['javascript:x', 'JavaScript:x', 'data:text/plain,x', 'file:///etc/passwd', 'vbscript:x']) {
    assert.ok(
      !HostEntrySchema.safeParse({ ...hostBase, oidcMobileRedirectUris: [bad] }).success,
      `${bad} must be rejected`
    );
  }
});

test('HostEntrySchema rejects an oidcMobileRedirectUris value with a space or no scheme', () => {
  const hostBase = { name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' };
  assert.ok(
    !HostEntrySchema.safeParse({ ...hostBase, oidcMobileRedirectUris: ['app.example:///oauth callback'] }).success
  );
  assert.ok(!HostEntrySchema.safeParse({ ...hostBase, oidcMobileRedirectUris: ['not-a-uri'] }).success);
});

test('saveInventory/loadInventory round-trip oidcMobileRedirectUris on a host, a guest, and an external site', () => {
  const dest = tempInventoryDb();
  const inv = loadInventory(dest);
  const updated: Inventory = {
    ...inv,
    hosts: inv.hosts.map((h) =>
      h.name === 'pve1'
        ? {
            ...h,
            authGroup: 'bellhop-users',
            authMode: 'oidc' as const,
            oidcRedirectUris: ['https://pve1.example.com/callback'],
            oidcMobileRedirectUris: ['app.example:///oauth-callback'],
          }
        : h
    ),
    guests: inv.guests.map((g) =>
      g.name === 'proxy'
        ? {
            ...g,
            authGroup: 'bellhop-users',
            authMode: 'oidc' as const,
            oidcMobileRedirectUris: ['app.example:///oauth-callback', 'com.example.app:/callback'],
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
        oidcMobileRedirectUris: ['https://books.example.com/auth/openid/mobile-redirect'],
      },
    ],
  };
  saveInventory(dest, updated);

  const reloaded = loadInventory(dest);
  const pve1 = reloaded.hosts.find((h) => h.name === 'pve1')!;
  assert.deepEqual(pve1.oidcMobileRedirectUris, ['app.example:///oauth-callback']);

  const proxy = reloaded.guests.find((g) => g.name === 'proxy')!;
  assert.deepEqual(proxy.oidcMobileRedirectUris, ['app.example:///oauth-callback', 'com.example.app:/callback']);

  const nas = reloaded.externalSites?.find((s) => s.name === 'nas')!;
  assert.deepEqual(nas.oidcMobileRedirectUris, ['https://books.example.com/auth/openid/mobile-redirect']);

  const pve2 = reloaded.hosts.find((h) => h.name === 'pve2')!;
  assert.equal(
    pve2.oidcMobileRedirectUris,
    undefined,
    'a host with no oidcMobileRedirectUris given must stay undefined, not []'
  );
});

test('opening a database without the oidc_mobile_redirect_uris_json column loads with the field undefined', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bellhop-test-'));
  const dest = path.join(dir, 'bellhop.db');
  const legacyDb = new Database(dest);
  legacyDb.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE hosts (
      name TEXT PRIMARY KEY, ssh_target TEXT NOT NULL, ssh_user TEXT NOT NULL,
      proxy INTEGER NOT NULL DEFAULT 0,
      ip TEXT, port INTEGER, insecure_backend_tls INTEGER,
      bridges_json TEXT, storages_json TEXT, nfs_mounts_json TEXT,
      auth_mode TEXT, oidc_redirect_uris_json TEXT
    );
    CREATE TABLE guests (
      name TEXT PRIMARY KEY, type TEXT NOT NULL, vmid INTEGER NOT NULL,
      host TEXT NOT NULL REFERENCES hosts(name),
      ip TEXT, port INTEGER, insecure_backend_tls INTEGER,
      proxy INTEGER NOT NULL DEFAULT 0, unprivileged INTEGER, app TEXT,
      auth_mode TEXT, oidc_redirect_uris_json TEXT,
      UNIQUE (host, vmid)
    );
    CREATE TABLE external_sites (name TEXT PRIMARY KEY, ip TEXT NOT NULL, port INTEGER, insecure_backend_tls INTEGER, auth_mode TEXT, oidc_redirect_uris_json TEXT);
    CREATE TABLE subdomains (subdomain TEXT PRIMARY KEY, owner_type TEXT NOT NULL, owner_name TEXT NOT NULL);
    CREATE TABLE proxy_owner (id INTEGER PRIMARY KEY CHECK (id = 1), owner_type TEXT NOT NULL, owner_name TEXT NOT NULL);
  `);
  legacyDb.prepare("INSERT INTO meta (key, value) VALUES ('domain', 'example.com')").run();
  legacyDb.prepare("INSERT INTO hosts (name, ssh_target, ssh_user) VALUES ('pve1', 'pve1.local', 'root')").run();
  legacyDb.close();

  const inv = loadInventory(dest);
  assert.equal(
    inv.hosts[0].oidcMobileRedirectUris,
    undefined,
    'a database predating oidc_mobile_redirect_uris_json has no value for it'
  );
});

test('parseOidcMobileRedirectUris accepts a semicolon-joined string, dedupes, and keeps order', () => {
  assert.deepEqual(
    parseOidcMobileRedirectUris('app.example:///oauth-callback ; com.example.app:/callback; app.example:///oauth-callback'),
    ['app.example:///oauth-callback', 'com.example.app:/callback']
  );
});

test('parseOidcMobileRedirectUris accepts an array, dedupes, and keeps order', () => {
  assert.deepEqual(
    parseOidcMobileRedirectUris(['app.example:///oauth-callback', 'com.example.app:/callback', 'app.example:///oauth-callback']),
    ['app.example:///oauth-callback', 'com.example.app:/callback']
  );
});

test('parseOidcMobileRedirectUris returns undefined for empty input', () => {
  assert.equal(parseOidcMobileRedirectUris(''), undefined);
  assert.equal(parseOidcMobileRedirectUris('   '), undefined);
  assert.equal(parseOidcMobileRedirectUris(undefined), undefined);
  assert.equal(parseOidcMobileRedirectUris([]), undefined);
});

test('parseOidcMobileRedirectUris throws on a disallowed scheme, naming the URI and the reason', () => {
  assert.throws(() => parseOidcMobileRedirectUris('javascript:x'), /javascript:x/);
  assert.throws(() => parseOidcMobileRedirectUris('data:text/plain,x'), /data:text\/plain,x/);
  assert.throws(() => parseOidcMobileRedirectUris('file:///etc/passwd'), /file:\/\/\/etc\/passwd/);
  assert.throws(() => parseOidcMobileRedirectUris('vbscript:x'), /vbscript:x/);
  assert.throws(() => parseOidcMobileRedirectUris('not-a-uri'), /not-a-uri/);
});

test('oidcConfigErrors reports a URI present in both oidcRedirectUris and oidcMobileRedirectUris, naming it', () => {
  const errors = oidcConfigErrors({
    authGroup: 'bellhop-users',
    authMode: 'oidc',
    subdomains: ['sonarr'],
    oidcRedirectUris: ['https://sonarr.example.com/cb'],
    oidcMobileRedirectUris: ['https://sonarr.example.com/cb', 'app.example:///oauth-callback'],
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /oidcMobileRedirectUris/);
  assert.match(errors[0], /https:\/\/sonarr\.example\.com\/cb/);
});

test('oidcConfigErrors is fine when oidcMobileRedirectUris does not overlap oidcRedirectUris', () => {
  assert.deepEqual(
    oidcConfigErrors({
      authGroup: 'bellhop-users',
      authMode: 'oidc',
      subdomains: ['sonarr'],
      oidcRedirectUris: ['https://sonarr.example.com/cb'],
      oidcMobileRedirectUris: ['app.example:///oauth-callback'],
    }),
    []
  );
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

// #10, one-time on-open migration: caddy/caddy_manual/caddy_owner -> proxy
// naming. The DDL below is the pre-#10 SCHEMA (git show 641de27), with
// `caddy_owner` in place of today's `proxy_owner` and `caddy`/`caddy_manual`
// in place of `proxy`/`proxy_manual` -- structurally identical to today's
// SCHEMA otherwise, since ensureColumn adds every other column
// (auth_group/authentik/mid_scheme_json/app_source/vpn_gateway/vpn) the
// same way it does for today's fixtures above.
function withCapturedLog<T>(fn: () => T): { result: T; logs: string[] } {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);
  try {
    return { result: fn(), logs };
  } finally {
    console.log = originalLog;
  }
}

test('loadInventory migrates a legacy caddy/caddy_manual/caddy_owner database to proxy naming', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'inventory-caddy-migrate-'));
  const dbPath = path.join(dir, 'bellhop.db');
  const legacyDb = new Database(dbPath);
  legacyDb.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE hosts (
      name TEXT PRIMARY KEY,
      ssh_target TEXT NOT NULL,
      ssh_user TEXT NOT NULL,
      ssh_port INTEGER,
      ssh_identity_file TEXT,
      caddy INTEGER NOT NULL DEFAULT 0,
      caddy_manual INTEGER,
      ip TEXT, port INTEGER, insecure_backend_tls INTEGER,
      bridges_json TEXT,
      storages_json TEXT,
      nfs_mounts_json TEXT,
      unauthenticated_paths_json TEXT,
      auth_mode TEXT,
      oidc_redirect_uris_json TEXT
    );
    CREATE TABLE guests (
      name TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      vmid INTEGER NOT NULL,
      host TEXT NOT NULL REFERENCES hosts(name),
      ip TEXT, port INTEGER, insecure_backend_tls INTEGER,
      caddy INTEGER NOT NULL DEFAULT 0,
      caddy_manual INTEGER,
      unprivileged INTEGER, app TEXT,
      unauthenticated_paths_json TEXT,
      auth_mode TEXT,
      oidc_redirect_uris_json TEXT,
      UNIQUE (host, vmid)
    );
    CREATE TABLE external_sites (
      name TEXT PRIMARY KEY,
      ip TEXT NOT NULL, port INTEGER, insecure_backend_tls INTEGER,
      unauthenticated_paths_json TEXT,
      auth_mode TEXT,
      oidc_redirect_uris_json TEXT
    );
    CREATE TABLE subdomains (
      subdomain TEXT PRIMARY KEY,
      owner_type TEXT NOT NULL,
      owner_name TEXT NOT NULL
    );
    CREATE TABLE caddy_owner (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      owner_type TEXT NOT NULL, owner_name TEXT NOT NULL
    );
  `);
  legacyDb.prepare("INSERT INTO meta (key, value) VALUES ('domain', 'example.com')").run();
  legacyDb
    .prepare("INSERT INTO hosts (name, ssh_target, ssh_user, caddy) VALUES ('pve1', 'pve1.local', 'root', 1)")
    .run();
  legacyDb
    .prepare("INSERT INTO guests (name, type, vmid, host, caddy_manual) VALUES ('sonarr', 'lxc', 120, 'pve1', 1)")
    .run();
  legacyDb.prepare("INSERT INTO caddy_owner (id, owner_type, owner_name) VALUES (1, 'host', 'pve1')").run();
  legacyDb.close();

  const { result: inv, logs } = withCapturedLog(() => loadInventory(dbPath));

  assert.equal(inv.hosts[0].proxy, true, "the legacy host's caddy=1 round-trips as proxy: true");
  assert.equal(inv.guests[0].proxyManual, true, "the legacy guest's caddy_manual=1 round-trips as proxyManual: true");

  const migrationLogs = logs.filter((l) => l.includes('caddy to proxy naming (#10'));
  assert.equal(migrationLogs.length, 1, 'exactly one migration log line was written');

  const after = new Database(dbPath, { readonly: true });
  const hostCols = (after.prepare('PRAGMA table_info(hosts)').all() as { name: string }[]).map((c) => c.name);
  const guestCols = (after.prepare('PRAGMA table_info(guests)').all() as { name: string }[]).map((c) => c.name);
  const tables = (
    after.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
  ).map((t) => t.name);
  after.close();
  assert.ok(!hostCols.includes('caddy') && !hostCols.includes('caddy_manual'), 'hosts no longer has caddy/caddy_manual');
  assert.ok(!guestCols.includes('caddy') && !guestCols.includes('caddy_manual'), 'guests no longer has caddy/caddy_manual');
  assert.ok(hostCols.includes('proxy') && hostCols.includes('proxy_manual'), 'hosts gained proxy/proxy_manual');
  assert.ok(guestCols.includes('proxy') && guestCols.includes('proxy_manual'), 'guests gained proxy/proxy_manual');
  assert.ok(!tables.includes('caddy_owner'), 'caddy_owner is dropped, not renamed');
  assert.ok(tables.includes('proxy_owner'), 'proxy_owner already exists (created empty by SCHEMA)');

  // Reopening logs nothing and changes nothing further.
  const { result: reopened, logs: logsAgain } = withCapturedLog(() => loadInventory(dbPath));
  assert.equal(
    logsAgain.filter((l) => l.includes('caddy to proxy naming (#10')).length,
    0,
    'reopening a migrated database logs nothing'
  );
  assert.equal(reopened.hosts[0].proxy, true);
  assert.equal(reopened.guests[0].proxyManual, true);

  // saveInventory afterwards writes proxy_owner.
  saveInventory(dbPath, reopened);
  const afterSave = new Database(dbPath, { readonly: true });
  const proxyOwnerRow = afterSave.prepare('SELECT owner_type, owner_name FROM proxy_owner').get();
  afterSave.close();
  assert.deepEqual({ ...(proxyOwnerRow as object) }, { owner_type: 'host', owner_name: 'pve1' });
});

test('loadInventory never logs the caddy-to-proxy migration for a fresh database', () => {
  const dest = tempInventoryDb();
  const { logs } = withCapturedLog(() => loadInventory(dest));
  assert.equal(
    logs.filter((l) => l.includes('caddy to proxy naming')).length,
    0,
    'a fresh (already-proxy-named) database never logs the migration'
  );
});

test(
  'opening a pre-existing database with caddy but no caddy_manual column migrates caddy and still gets ' +
    'proxy_manual from ensureColumn',
  () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'inventory-caddy-migrate-nomanual-'));
    const dbPath = path.join(dir, 'bellhop.db');
    const legacyDb = new Database(dbPath);
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
    legacyDb
      .prepare("INSERT INTO hosts (name, ssh_target, ssh_user, caddy) VALUES ('pve1', 'pve1.local', 'root', 1)")
      .run();
    legacyDb.close();

    const inv = loadInventory(dbPath);
    assert.equal(inv.hosts[0].proxy, true, "the legacy host's caddy=1 still round-trips as proxy: true");
    assert.equal(
      inv.hosts[0].proxyManual,
      undefined,
      'a pre-migration row with no caddy_manual column at all has no proxyManual value yet'
    );

    const updated: Inventory = { ...inv, hosts: inv.hosts.map((h) => ({ ...h, proxyManual: true })) };
    saveInventory(dbPath, updated);
    const reloaded = loadInventory(dbPath);
    assert.equal(
      reloaded.hosts[0].proxyManual,
      true,
      'the ensureColumn-added proxy_manual column must actually be writable/readable'
    );
  }
);

// -- Final review M4: a long-running save never reverts a settings change ----

test('withFreshSettings takes every setting from the database and everything else from the given copy', () => {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'fresh-settings-')), 'bellhop.db');
  const stale: Inventory = {
    domain: 'example.com',
    nfsServer: '192.0.2.5',
    dnsServer: '192.0.2.53',
    hosts: [{ name: 'pve1', ssh_target: '192.0.2.10', ssh_user: 'root' }],
    guests: [],
  };
  saveInventory(dbPath, stale);
  // Another process changes and clears settings after `stale` was loaded.
  saveInventory(dbPath, { ...stale, nfsServer: '192.0.2.6', dnsServer: undefined, webUiAuthMode: 'authentik' });

  const edited: Inventory = { ...stale, guests: [{ name: 'app', type: 'lxc', vmid: 101, host: 'pve1' }] };
  const merged = withFreshSettings(dbPath, edited);
  assert.equal(merged.nfsServer, '192.0.2.6');
  assert.equal(merged.dnsServer, undefined);
  assert.equal(merged.webUiAuthMode, 'authentik');
  assert.deepEqual(merged.guests, edited.guests, 'non-settings fields come from the given copy');
  assert.equal(edited.nfsServer, '192.0.2.5', 'the given copy is not mutated');

  saveInventory(dbPath, merged);
  const saved = loadInventory(dbPath);
  assert.equal(saved.nfsServer, '192.0.2.6');
  assert.equal(saved.dnsServer, undefined);
  assert.equal(saved.guests.length, 1);
});

test('withFreshSettings returns the given copy unchanged when the database does not exist yet', () => {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'fresh-settings-')), 'missing.db');
  const inv: Inventory = { domain: 'example.com', nfsServer: '192.0.2.5', hosts: [], guests: [] };
  assert.deepEqual(withFreshSettings(dbPath, inv), inv);
});

// issue #72: tlsSource / acmeDnsProvider are enum-only settings on load and
// write; whether the active driver supports the chosen source is checked
// only when configuration is produced (src/lib/proxy/tls.ts).

test('SettingsSchema accepts each tlsSource and the cloudflare acmeDnsProvider, and rejects values outside the lists', () => {
  for (const source of ['acme-dns', 'acme-http', 'internal', 'files', 'external']) {
    assert.equal(SettingsSchema.safeParse({ tlsSource: source }).success, true, source);
  }
  assert.equal(SettingsSchema.safeParse({ acmeDnsProvider: 'cloudflare' }).success, true);
  assert.equal(SettingsSchema.safeParse({ tlsSource: 'letsencrypt' }).success, false);
  assert.equal(SettingsSchema.safeParse({ tlsSource: '' }).success, false);
  assert.equal(SettingsSchema.safeParse({ acmeDnsProvider: 'route53' }).success, false);
});

test('saveInventory/loadInventory round-trips tlsSource and acmeDnsProvider, and clearing removes them from meta', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bellhop-test-'));
  const dest = path.join(dir, 'bellhop.db');
  saveInventory(dest, { ...FIXTURE_INVENTORY, tlsSource: 'acme-dns', acmeDnsProvider: 'cloudflare' });
  const loaded = loadInventory(dest);
  assert.equal(loaded.tlsSource, 'acme-dns');
  assert.equal(loaded.acmeDnsProvider, 'cloudflare');

  saveInventory(dest, { ...loaded, tlsSource: undefined, acmeDnsProvider: undefined });
  const reloaded = loadInventory(dest);
  assert.equal(reloaded.tlsSource, undefined);
  assert.equal(reloaded.acmeDnsProvider, undefined);
  const db = new Database(dest, { readonly: true });
  const rows = db.prepare("SELECT key FROM meta WHERE key IN ('tlsSource', 'acmeDnsProvider')").all();
  db.close();
  assert.deepEqual(rows, []);
});

test('loadInventory rejects an out-of-list tlsSource or acmeDnsProvider written to meta', () => {
  for (const [key, value] of [['tlsSource', 'letsencrypt'], ['acmeDnsProvider', 'route53']]) {
    const dir = mkdtempSync(path.join(tmpdir(), 'bellhop-test-'));
    const dest = path.join(dir, 'bellhop.db');
    saveInventory(dest, FIXTURE_INVENTORY);
    const db = new Database(dest);
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
    db.close();
    assert.throws(() => loadInventory(dest), /./, key);
  }
});

// issue #72 (US2): an unsupported driver/TLS-source pairing is not a load or
// validation error -- it is only refused where configuration is produced
// (sync-proxy, convert-caddyfile), so switching drivers can't strand the
// database.
test('an inventory with nginx and tlsSource internal loads and validates clean', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bellhop-test-'));
  const dest = path.join(dir, 'bellhop.db');
  saveInventory(dest, { ...FIXTURE_INVENTORY, proxyDriver: 'nginx', tlsSource: 'internal' });
  const loaded = loadInventory(dest);
  assert.equal(loaded.proxyDriver, 'nginx');
  assert.equal(loaded.tlsSource, 'internal');
  assert.deepEqual(validateInventory(loaded), []);
});
