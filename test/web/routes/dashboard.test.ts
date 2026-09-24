import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { buildApp } from '../../../src/web/app.ts';
import { JobStore } from '../../../src/web/jobs/job-store.ts';
import { createJobLog } from '../../../src/web/jobs/job-log.ts';
import { JobRunner } from '../../../src/web/jobs/job-runner.ts';
import { FakeSSHClient } from '../../support/fake-ssh-client.ts';
import type { FakeSSHResponder } from '../../support/fake-ssh-client.ts';
import { FakeAuthentikClient } from '../../support/fake-authentik-client.ts';
import { UnconfiguredAuthentikClient } from '../../../src/lib/authentik-client.ts';
import type { AuthentikClient } from '../../../src/lib/authentik-client.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { saveInventory, type Inventory } from '../../../src/lib/inventory.ts';
import { authentikConfig } from '../../../src/lib/authentik-config.ts';
import { FakeCloudflareClient, txtRecord } from '../../support/fake-cloudflare-client.ts';
import type { CloudflareClient } from '../../../src/lib/cloudflare-client.ts';

function testApp(
  inventory: Inventory,
  respond: FakeSSHResponder = () => ({ stdout: '', stderr: '', code: 0 }),
  authentik: AuthentikClient = new FakeAuthentikClient(),
  cloudflare?: CloudflareClient
) {
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
  const ssh = new FakeSSHClient(respond);
  const jobRunner = new JobRunner(jobStore, jobLog, ssh);
  // A real file on disk -- PATCH /api/inventory/guests/:name writes through
  // saveInventory, which reads-then-rewrites this path.
  const inventoryPath = path.join(mkdtempSync(path.join(tmpdir(), 'inventory-')), 'bellhop.db');
  saveInventory(inventoryPath, inventory);
  return buildApp({ inventory, baseSsh: ssh, jobStore, jobLog, jobRunner, inventoryPath, authentik, cloudflare });
}

function asAdmin(req: request.Test): request.Test {
  return req.set('x-authentik-username', 'admin').set('x-authentik-groups', 'bellhop-admins');
}

test('GET /api/inventory returns hosts, guests, and domain from the loaded inventory', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' } }],
    guests: [{ name: 'plex-lxc', type: 'lxc', vmid: 4003, host: 'pve1' }],
  };
  const app = testApp(inventory);
  const res = await request(app).get('/api/inventory');
  assert.equal(res.status, 200);
  assert.equal(res.body.hosts.length, 1);
  assert.equal(res.body.guests[0].name, 'plex-lxc');
  assert.equal(res.body.domain, 'example.com');
});

test('PATCH /api/inventory/guests/:name updates subdomains, persists them, and syncs Caddy', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' }, caddy: true }],
    guests: [{ name: 'plex-lxc', type: 'lxc', vmid: 4003, host: 'pve1', ip: '192.168.1.3' }],
  };
  const app = testApp(inventory);
  const res = await request(app).patch('/api/inventory/guests/plex-lxc').send({ subdomains: 'plex ; plex ;movies' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.guest.subdomains, ['plex', 'movies']);
  assert.equal(res.body.caddySynced, true);

  const invRes = await request(app).get('/api/inventory');
  assert.deepEqual(invRes.body.guests[0].subdomains, ['plex', 'movies']);
});

test('PATCH /api/inventory/guests/:name prunes stale _acme-challenge records through the injected Cloudflare client', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' }, caddy: true }],
    guests: [{ name: 'plex-lxc', type: 'lxc', vmid: 4003, host: 'pve1', ip: '192.168.1.3' }],
  };
  const cloudflare = new FakeCloudflareClient({
    zones: { 'example.com': 'zone-1' },
    records: [txtRecord('old', '_acme-challenge.renamed.example.com', '2020-01-01T00:00:00.000000Z')],
  });
  const app = testApp(inventory, undefined, new FakeAuthentikClient(), cloudflare);
  const res = await request(app).patch('/api/inventory/guests/plex-lxc').send({ subdomains: 'plex' });
  assert.equal(res.status, 200);
  assert.equal(res.body.caddySynced, true);
  assert.deepEqual(cloudflare.records, []);
});

test('PATCH /api/inventory/guests/:name clears subdomains when given an empty string', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' }, caddy: true }],
    guests: [{ name: 'plex-lxc', type: 'lxc', vmid: 4003, host: 'pve1', ip: '192.168.1.3', subdomains: ['plex'] }],
  };
  const app = testApp(inventory);
  const res = await request(app).patch('/api/inventory/guests/plex-lxc').send({ subdomains: '' });
  assert.equal(res.status, 200);
  assert.equal(res.body.guest.subdomains, undefined);
  assert.equal(res.body.caddySynced, true);
});

test('PATCH /api/inventory/guests/:name still saves when there is no caddy: true entry, but reports the sync failure', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' } }],
    guests: [{ name: 'plex-lxc', type: 'lxc', vmid: 4003, host: 'pve1', ip: '192.168.1.3' }],
  };
  const app = testApp(inventory);
  const res = await request(app).patch('/api/inventory/guests/plex-lxc').send({ subdomains: 'plex' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.guest.subdomains, ['plex']);
  assert.equal(res.body.caddySynced, false);
  assert.match(res.body.caddyError, /No inventory entry has 'caddy: true'/);

  const invRes = await request(app).get('/api/inventory');
  assert.deepEqual(invRes.body.guests[0].subdomains, ['plex'], 'inventory write must still persist');
});

test('PATCH /api/inventory/guests/:name updates port independently, leaving subdomains untouched', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' }, caddy: true }],
    guests: [{ name: 'plex-lxc', type: 'lxc', vmid: 4003, host: 'pve1', ip: '192.168.1.3', subdomains: ['plex'] }],
  };
  const app = testApp(inventory);
  const res = await request(app).patch('/api/inventory/guests/plex-lxc').send({ port: '32400' });
  assert.equal(res.status, 200);
  assert.equal(res.body.guest.port, 32400);
  assert.deepEqual(res.body.guest.subdomains, ['plex'], 'a port-only PATCH must not touch subdomains');
  assert.equal(
    res.body.guest.insecureBackendTls,
    false,
    'this edit now gives the guest a concrete ip+port+subdomains combo, so the probe runs and conclusively finds trusted/no-TLS'
  );

  const invRes = await request(app).get('/api/inventory');
  assert.equal(invRes.body.guests[0].port, 32400);
});

test('PATCH /api/inventory/guests/:name updates caddyManual independently, leaving subdomains untouched', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' }, caddy: true }],
    guests: [{ name: 'caddy-lxc', type: 'lxc', vmid: 4002, host: 'pve1', ip: '192.168.1.2', subdomains: ['caddy'] }],
  };
  const app = testApp(inventory);
  const res = await request(app).patch('/api/inventory/guests/caddy-lxc').send({ caddyManual: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.guest.caddyManual, true);
  assert.deepEqual(res.body.guest.subdomains, ['caddy'], 'a caddyManual-only PATCH must not touch subdomains');

  const invRes = await request(app).get('/api/inventory');
  assert.equal(invRes.body.guests[0].caddyManual, true);
});

test('PATCH /api/inventory/guests/:name updates insecureBackendTls independently, leaving subdomains untouched', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' }, caddy: true }],
    guests: [{ name: 'bentopdf-lxc', type: 'lxc', vmid: 4005, host: 'pve1', ip: '192.168.1.5', subdomains: ['bentopdf'] }],
  };
  const calls: string[] = [];
  const app = testApp(inventory, (_t, _u, c) => {
    calls.push(c);
    return { stdout: '', stderr: '', code: 0 };
  });
  const res = await request(app).patch('/api/inventory/guests/bentopdf-lxc').send({ insecureBackendTls: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.guest.insecureBackendTls, true);
  assert.deepEqual(res.body.guest.subdomains, ['bentopdf'], 'an insecureBackendTls-only PATCH must not touch subdomains');
  assert.ok(!calls.some((c) => c.startsWith('curl ')), 'an insecureBackendTls-only edit must never trigger a probe');

  const invRes = await request(app).get('/api/inventory');
  assert.equal(invRes.body.guests[0].insecureBackendTls, true);
});

test('PATCH /api/inventory/guests/:name updates authGroup independently, leaving subdomains untouched', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [
      { name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' }, caddy: true },
    ],
    guests: [
      { name: 'auth-lxc', type: 'lxc', vmid: 4009, host: 'pve1', ip: '192.168.1.9', authentik: true },
      { name: 'sonarr', type: 'lxc', vmid: 4010, host: 'pve1', ip: '192.168.1.10', subdomains: ['sonarr'] },
    ],
  };
  const app = testApp(inventory);
  const res = await request(app).patch('/api/inventory/guests/sonarr').send({ authGroup: 'bellhop-users' });
  assert.equal(res.status, 200);
  assert.equal(res.body.guest.authGroup, 'bellhop-users');
  assert.deepEqual(res.body.guest.subdomains, ['sonarr'], 'an authGroup-only PATCH must not touch subdomains');
  assert.equal(res.body.caddySynced, true);

  const invRes = await request(app).get('/api/inventory');
  assert.equal(invRes.body.guests.find((g: any) => g.name === 'sonarr').authGroup, 'bellhop-users');
});

test('PATCH /api/inventory/guests/:name updates unauthenticatedPaths independently, leaving subdomains untouched', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' }, caddy: true }],
    guests: [
      { name: 'auth-lxc', type: 'lxc', vmid: 4009, host: 'pve1', ip: '192.168.1.9', authentik: true },
      { name: 'sonarr', type: 'lxc', vmid: 4010, host: 'pve1', ip: '192.168.1.10', subdomains: ['sonarr'], authGroup: 'bellhop-users' },
    ],
  };
  const app = testApp(inventory);
  // Adding an unauthenticatedPaths entry is gated on ladder reachability
  // (see the unauthenticatedPaths tests further down) -- run this one as
  // admin since it's only testing the field's parsing/independence from
  // subdomains, not the authorization rule itself.
  const res = await asAdmin(request(app).patch('/api/inventory/guests/sonarr')).send({ unauthenticatedPaths: '/api/* ; /api/*' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.guest.unauthenticatedPaths, ['/api/*']);
  assert.deepEqual(res.body.guest.subdomains, ['sonarr'], 'an unauthenticatedPaths-only PATCH must not touch subdomains');
  assert.equal(res.body.caddySynced, true);

  const invRes = await request(app).get('/api/inventory');
  assert.deepEqual(invRes.body.guests.find((g: any) => g.name === 'sonarr').unauthenticatedPaths, ['/api/*']);
});

test('PATCH /api/inventory/guests/:name rejects an unauthenticatedPaths pattern missing a leading slash', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' }, caddy: true }],
    guests: [
      { name: 'auth-lxc', type: 'lxc', vmid: 4009, host: 'pve1', ip: '192.168.1.9', authentik: true },
      { name: 'sonarr', type: 'lxc', vmid: 4010, host: 'pve1', ip: '192.168.1.10', subdomains: ['sonarr'], authGroup: 'bellhop-users' },
    ],
  };
  const app = testApp(inventory);
  const res = await request(app).patch('/api/inventory/guests/sonarr').send({ unauthenticatedPaths: 'api/*' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Invalid unauthenticated path 'api\/\*'/);

  const invRes = await request(app).get('/api/inventory');
  assert.equal(invRes.body.guests.find((g: any) => g.name === 'sonarr').unauthenticatedPaths, undefined, 'a rejected PATCH must not write anything');
});

test('PATCH /api/inventory/guests/:name clears unauthenticatedPaths when given an empty string', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' }, caddy: true }],
    guests: [
      { name: 'auth-lxc', type: 'lxc', vmid: 4009, host: 'pve1', ip: '192.168.1.9', authentik: true },
      { name: 'sonarr', type: 'lxc', vmid: 4010, host: 'pve1', ip: '192.168.1.10', subdomains: ['sonarr'], authGroup: 'bellhop-users', unauthenticatedPaths: ['/api/*'] },
    ],
  };
  const app = testApp(inventory);
  const res = await request(app).patch('/api/inventory/guests/sonarr').send({ unauthenticatedPaths: '' });
  assert.equal(res.status, 200);
  assert.equal(res.body.guest.unauthenticatedPaths, undefined);
});

test('PATCH /api/inventory/guests/:name updates port independently, leaving an existing unauthenticatedPaths untouched when the field is omitted entirely', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' }, caddy: true }],
    guests: [
      { name: 'auth-lxc', type: 'lxc', vmid: 4009, host: 'pve1', ip: '192.168.1.9', authentik: true },
      {
        name: 'sonarr',
        type: 'lxc',
        vmid: 4010,
        host: 'pve1',
        ip: '192.168.1.10',
        subdomains: ['sonarr'],
        authGroup: 'bellhop-users',
        unauthenticatedPaths: ['/api/*'],
      },
    ],
  };
  const app = testApp(inventory);
  const res = await request(app).patch('/api/inventory/guests/sonarr').send({ port: '8989' });
  assert.equal(res.status, 200);
  assert.equal(res.body.guest.port, 8989);
  assert.deepEqual(
    res.body.guest.unauthenticatedPaths,
    ['/api/*'],
    'a port-only PATCH that omits unauthenticatedPaths entirely must not touch it'
  );

  const invRes = await request(app).get('/api/inventory');
  assert.deepEqual(invRes.body.guests.find((g: any) => g.name === 'sonarr').unauthenticatedPaths, ['/api/*']);
});

test('PATCH /api/inventory/guests/:name probes and sets insecureBackendTls when an edit gives a guest both a port and subdomains', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' }, caddy: true }],
    guests: [{ name: 'authentik-lxc', type: 'lxc', vmid: 4009, host: 'pve1', ip: '192.168.1.9' }],
  };
  const calls: string[] = [];
  const app = testApp(inventory, (_t, _u, c) => {
    calls.push(c);
    if (c.startsWith('curl ')) return { stdout: '', stderr: '', code: 60 };
    return { stdout: '', stderr: '', code: 0 };
  });
  const res = await request(app).patch('/api/inventory/guests/authentik-lxc').send({ subdomains: 'auth', port: '9443' });
  assert.equal(res.status, 200);
  assert.equal(res.body.guest.insecureBackendTls, true);
  assert.ok(calls.includes('curl -s -o /dev/null --max-time 5 https://192.168.1.9:9443/'));
});

test('PATCH /api/inventory/guests/:name never probes a caddyManual guest even when port and subdomains are both set', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' }, caddy: true }],
    guests: [{ name: 'manual-lxc', type: 'lxc', vmid: 4011, host: 'pve1', ip: '192.168.1.11', caddyManual: true }],
  };
  const calls: string[] = [];
  const app = testApp(inventory, (_t, _u, c) => {
    calls.push(c);
    return { stdout: '', stderr: '', code: 60 };
  });
  const res = await request(app).patch('/api/inventory/guests/manual-lxc').send({ subdomains: 'manual', port: '8443' });
  assert.equal(res.status, 200);
  assert.equal(res.body.guest.insecureBackendTls, undefined);
  assert.ok(!calls.some((c) => c.startsWith('curl ')), 'a caddyManual guest must never be probed');
});

test('PATCH /api/inventory/guests/:name lets a conclusive probe override an insecureBackendTls value submitted in the same request', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' }, caddy: true }],
    guests: [{ name: 'jellyfin-lxc', type: 'lxc', vmid: 4004, host: 'pve1', ip: '192.168.1.4' }],
  };
  const app = testApp(inventory, () => ({ stdout: '', stderr: '', code: 0 }));
  const res = await request(app)
    .patch('/api/inventory/guests/jellyfin-lxc')
    .send({ subdomains: 'movies', port: '8096', insecureBackendTls: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.guest.insecureBackendTls, false, 'the probe (trusted/no-TLS) must win over the true value submitted in the same request');
});

test('PATCH /api/inventory/guests/:name allows subdomains with no ip when caddyManual is already set', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' }, caddy: true }],
    guests: [{ name: 'caddy-lxc', type: 'lxc', vmid: 4002, host: 'pve1', caddyManual: true }],
  };
  const app = testApp(inventory);
  const res = await request(app).patch('/api/inventory/guests/caddy-lxc').send({ subdomains: 'caddy' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.guest.subdomains, ['caddy']);
});

test('PATCH /api/inventory/guests/:name clears port when given an empty string', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' }, caddy: true }],
    guests: [{ name: 'plex-lxc', type: 'lxc', vmid: 4003, host: 'pve1', ip: '192.168.1.3', port: 32400 }],
  };
  const app = testApp(inventory);
  const res = await request(app).patch('/api/inventory/guests/plex-lxc').send({ port: '' });
  assert.equal(res.status, 200);
  assert.equal(res.body.guest.port, undefined);
});

test('PATCH /api/inventory/guests/:name rejects an invalid port without writing anything', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' }, caddy: true }],
    guests: [{ name: 'plex-lxc', type: 'lxc', vmid: 4003, host: 'pve1', ip: '192.168.1.3' }],
  };
  const app = testApp(inventory);
  const res = await request(app).patch('/api/inventory/guests/plex-lxc').send({ port: 'not-a-number' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Invalid port 'not-a-number'/);

  const invRes = await request(app).get('/api/inventory');
  assert.equal(invRes.body.guests[0].port, undefined, 'rejected write must not be persisted');
});

test('PATCH /api/inventory/guests/:name 404s for an unknown guest', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' } }],
    guests: [],
  };
  const app = testApp(inventory);
  const res = await request(app).patch('/api/inventory/guests/nope').send({ subdomains: 'x' });
  assert.equal(res.status, 404);
});

test('PATCH /api/inventory/guests/:name rejects a subdomain that collides with another entry', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' } }],
    guests: [
      { name: 'plex-lxc', type: 'lxc', vmid: 4003, host: 'pve1', ip: '192.168.1.3' },
      { name: 'jellyfin-lxc', type: 'lxc', vmid: 4004, host: 'pve1', ip: '192.168.1.4', subdomains: ['media'] },
    ],
  };
  const app = testApp(inventory);
  const res = await request(app).patch('/api/inventory/guests/plex-lxc').send({ subdomains: 'media' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /subdomain 'media' is claimed by multiple entries/);

  const invRes = await request(app).get('/api/inventory');
  const plex = invRes.body.guests.find((g: any) => g.name === 'plex-lxc');
  assert.equal(plex.subdomains, undefined, 'rejected write must not be persisted');
});

test('PATCH /api/inventory/guests/:name rejects subdomains on a guest with no ip', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' } }],
    guests: [{ name: 'no-ip-lxc', type: 'lxc', vmid: 4005, host: 'pve1' }],
  };
  const app = testApp(inventory);
  const res = await request(app).patch('/api/inventory/guests/no-ip-lxc').send({ subdomains: 'x' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /has 'subdomains' set but no 'ip'/);
});

test('GET /api/guests/status returns a running/stopped map keyed by guest name', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' } }],
    guests: [{ name: 'plex-lxc', type: 'lxc', vmid: 4003, host: 'pve1' }],
  };
  const app = testApp(inventory, (_target, _user, cmd) => {
    if (cmd.includes('/lxc')) return { stdout: JSON.stringify([{ vmid: 4003, status: 'running' }]), stderr: '', code: 0 };
    return { stdout: '[]', stderr: '', code: 0 };
  });

  const res = await request(app).get('/api/guests/status');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.statuses, { 'plex-lxc': 'running' });
  assert.deepEqual(res.body.failures, []);
});

test('GET /api/guests/status omits guests on a host whose query fails', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' } }],
    guests: [{ name: 'plex-lxc', type: 'lxc', vmid: 4003, host: 'pve1' }],
  };
  const app = testApp(inventory, () => {
    throw new Error('connection refused');
  });

  const res = await request(app).get('/api/guests/status');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.statuses, {});
  assert.deepEqual(res.body.failures, ['pve1']);
});

test('GET /api/guests/status omits a blocked host from failures for a restricted group, but not for an admin', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [
      { name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' } },
      { name: 'pve2', ssh_target: 'pve2.local', ssh_user: 'root', midScheme: { vmidBase: 5000, ipPrefix: '192.168.2.', gateway: '192.168.3.1' } },
    ],
    guests: [{ name: 'plex-lxc', type: 'lxc', vmid: 4003, host: 'pve1' }],
  };
  const app = testApp(inventory, () => {
    throw new Error('connection refused');
  });
  await asAdmin(request(app).put('/api/permissions/family')).send({
    mode: 'block-list',
    resources: [{ type: 'host', name: 'pve1' }],
  });

  const restricted = await request(app)
    .get('/api/guests/status')
    .set('x-authentik-username', 'kid')
    .set('x-authentik-groups', 'family');
  assert.equal(restricted.status, 200);
  assert.deepEqual(restricted.body.failures, ['pve2']);

  const admin = await asAdmin(request(app).get('/api/guests/status'));
  assert.equal(admin.status, 200);
  assert.deepEqual(admin.body.failures.sort(), ['pve1', 'pve2']);
});

test('GET /api/whoami returns the resolved auth user from trusted headers', async () => {
  const inventory: Inventory = { domain: 'example.com', hosts: [], guests: [] };
  const app = testApp(inventory);
  const res = await request(app)
    .get('/api/whoami')
    .set('x-authentik-username', 'alice')
    .set('x-authentik-groups', 'admins|homelab');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    username: 'alice',
    groups: ['admins', 'homelab'],
    localOperator: false,
    isAdmin: false,
    adminGroups: { app: 'bellhop-admins', authentikBuiltin: 'authentik Admins' },
    capabilities: { userDirectory: true },
  });
});

test('GET /api/whoami falls back to WEB_UI_DEV_USER when no trusted headers are sent', async () => {
  const inventory: Inventory = { domain: 'example.com', hosts: [], guests: [] };
  const app = testApp(inventory);
  const res = await request(app).get('/api/whoami');
  assert.equal(res.status, 200);
  // WEB_UI_DEV_USER=test-user is set for the whole `npm test` run (package.json).
  assert.deepEqual(res.body, {
    username: 'test-user',
    groups: [],
    localOperator: false,
    isAdmin: false,
    adminGroups: { app: 'bellhop-admins', authentikBuiltin: 'authentik Admins' },
    capabilities: { userDirectory: true },
  });
});

test('protected routes reject requests with no trusted headers and no WEB_UI_DEV_USER in strict authentik mode', async () => {
  const inventory: Inventory = { domain: 'example.com', hosts: [], guests: [] };
  const app = testApp(inventory);
  const originalDevUser = process.env.WEB_UI_DEV_USER;
  const originalAuthMode = process.env.WEB_UI_AUTH_MODE;
  delete process.env.WEB_UI_DEV_USER;
  process.env.WEB_UI_AUTH_MODE = 'authentik';
  try {
    const res = await request(app).get('/api/inventory');
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: 'unauthorized' });
  } finally {
    if (originalDevUser !== undefined) process.env.WEB_UI_DEV_USER = originalDevUser;
    if (originalAuthMode === undefined) delete process.env.WEB_UI_AUTH_MODE;
    else process.env.WEB_UI_AUTH_MODE = originalAuthMode;
  }
});

// Mirror image of the strict-mode test above: the 'auto' default (no
// WEB_UI_AUTH_MODE set) is what almost every adopter actually runs, and
// until now it only had unit-level coverage (auth.test.ts), not a
// route-level check that a request with no trusted headers and no
// WEB_UI_DEV_USER is actually served rather than rejected.
test('protected routes serve the local operator with no trusted headers and no WEB_UI_DEV_USER in the default auto mode', async () => {
  const inventory: Inventory = { domain: 'example.com', hosts: [], guests: [] };
  const app = testApp(inventory);
  const originalDevUser = process.env.WEB_UI_DEV_USER;
  const originalAuthMode = process.env.WEB_UI_AUTH_MODE;
  delete process.env.WEB_UI_DEV_USER;
  delete process.env.WEB_UI_AUTH_MODE;
  try {
    const res = await request(app).get('/api/inventory');
    assert.equal(res.status, 200);

    const whoami = await request(app).get('/api/whoami');
    assert.equal(whoami.status, 200);
    assert.equal(whoami.body.localOperator, true);
    assert.equal(whoami.body.isAdmin, true);
  } finally {
    if (originalDevUser !== undefined) process.env.WEB_UI_DEV_USER = originalDevUser;
    if (originalAuthMode === undefined) delete process.env.WEB_UI_AUTH_MODE;
    else process.env.WEB_UI_AUTH_MODE = originalAuthMode;
  }
});

test('GET /api/inventory filters hosts and guests for a restricted group', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [
      { name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' } },
      { name: 'pve2', ssh_target: 'pve2.local', ssh_user: 'root', midScheme: { vmidBase: 5000, ipPrefix: '192.168.2.', gateway: '192.168.3.1' } },
    ],
    guests: [
      { name: 'stash-lxc', type: 'lxc', vmid: 4001, host: 'pve1' },
      { name: 'plex-lxc', type: 'lxc', vmid: 4002, host: 'pve1' },
    ],
  };
  const app = testApp(inventory);
  await asAdmin(request(app).put('/api/permissions/family')).send({
    mode: 'block-list',
    resources: [
      { type: 'guest', name: 'stash-lxc' },
      { type: 'host', name: 'pve2' },
    ],
  });

  const res = await request(app)
    .get('/api/inventory')
    .set('x-authentik-username', 'kid')
    .set('x-authentik-groups', 'family');
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.body.guests.map((g: any) => g.name),
    ['plex-lxc']
  );
  assert.deepEqual(
    res.body.hosts.map((h: any) => h.name),
    ['pve1']
  );
});

test('GET /api/inventory returns every host/guest unfiltered when the caller is an admin', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' } }],
    guests: [{ name: 'stash-lxc', type: 'lxc', vmid: 4001, host: 'pve1' }],
  };
  const app = testApp(inventory);
  await asAdmin(request(app).put('/api/permissions/family')).send({
    mode: 'block-list',
    resources: [{ type: 'guest', name: 'stash-lxc' }],
  });

  const res = await asAdmin(request(app).get('/api/inventory'));
  assert.equal(res.status, 200);
  assert.equal(res.body.guests.length, 1);
});

test('PATCH /api/inventory/guests/:name returns 403 for a restricted group targeting a blocked guest', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' }, caddy: true }],
    guests: [{ name: 'stash-lxc', type: 'lxc', vmid: 4001, host: 'pve1', ip: '192.168.1.3' }],
  };
  const app = testApp(inventory);
  await asAdmin(request(app).put('/api/permissions/family')).send({
    mode: 'block-list',
    resources: [{ type: 'guest', name: 'stash-lxc' }],
  });

  const res = await request(app)
    .patch('/api/inventory/guests/stash-lxc')
    .set('x-authentik-username', 'kid')
    .set('x-authentik-groups', 'family')
    .send({ port: '8080' });
  assert.equal(res.status, 403);
});

test('PATCH /api/inventory/guests/:name still succeeds for a restricted group targeting an allowed guest', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' }, caddy: true }],
    guests: [{ name: 'plex-lxc', type: 'lxc', vmid: 4002, host: 'pve1', ip: '192.168.1.4' }],
  };
  const app = testApp(inventory);
  await asAdmin(request(app).put('/api/permissions/family')).send({
    mode: 'block-list',
    resources: [{ type: 'guest', name: 'stash-lxc' }],
  });

  const res = await request(app)
    .patch('/api/inventory/guests/plex-lxc')
    .set('x-authentik-username', 'kid')
    .set('x-authentik-groups', 'family')
    .send({ port: '8080' });
  assert.equal(res.status, 200);
});

const whoamiInventory: Inventory = { domain: 'example.com', hosts: [], guests: [] };

test('GET /api/whoami reports admin status, admin group names, and capabilities', async () => {
  // userDirectory reflects the actually-injected AuthentikClient's own
  // isConfigured() -- UnconfiguredAuthentikClient here, rather than deleting
  // AUTHENTIK_API_URL/AUTHENTIK_API_TOKEN from process.env (Task 5 moved
  // this off process.env entirely).
  const app = testApp(whoamiInventory, undefined, new UnconfiguredAuthentikClient());
  const res = await request(app)
    .get('/api/whoami')
    .set('x-authentik-username', 'someone')
    .set('x-authentik-groups', 'bellhop-admins');
  assert.equal(res.status, 200);
  assert.equal(res.body.username, 'someone');
  assert.equal(res.body.isAdmin, true);
  assert.equal(res.body.localOperator, false);
  assert.deepEqual(res.body.adminGroups, { app: 'bellhop-admins', authentikBuiltin: 'authentik Admins' });
  assert.deepEqual(res.body.capabilities, { userDirectory: false });
});

test('GET /api/whoami reports userDirectory: true when the injected AuthentikClient is configured', async () => {
  const app = testApp(whoamiInventory);
  const res = await request(app)
    .get('/api/whoami')
    .set('x-authentik-username', 'someone')
    .set('x-authentik-groups', 'bellhop-admins');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.capabilities, { userDirectory: true });
});

test('GET /api/whoami reports a non-admin as such', async () => {
  const app = testApp(whoamiInventory);
  const res = await request(app)
    .get('/api/whoami')
    .set('x-authentik-username', 'someone')
    .set('x-authentik-groups', 'homelab');
  assert.equal(res.body.isAdmin, false);
});

test('PATCH /api/inventory/guests/:name reports an Authentik slug conflict in the response', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [
      { name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', caddy: true },
    ],
    guests: [
      { name: 'auth-lxc', type: 'lxc', vmid: 4009, host: 'pve1', ip: '192.168.1.9', authentik: true },
      { name: 'sonarr', type: 'lxc', vmid: 4010, host: 'pve1', ip: '192.168.1.10', subdomains: ['sonarr'] },
    ],
  };
  const authentik = new FakeAuthentikClient({
    applications: [{ id: 'sonarr', pk: 'pk-sonarr', name: 'sonarr.example.com', slug: 'sonarr', providerId: '99' }],
  });
  const app = testApp(inventory, () => ({ stdout: '', stderr: '', code: 0 }), authentik);

  const res = await request(app).patch('/api/inventory/guests/sonarr').send({ authGroup: 'bellhop-users' });
  assert.equal(res.status, 200);
  assert.equal(res.body.caddySynced, true, 'the edit still succeeds -- a conflict never fails the request');
  assert.deepEqual(res.body.authentikConflicts, ['sonarr']);
});

test('PATCH /api/inventory/guests/:name omits authentikConflicts entirely when there are none', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', caddy: true }],
    guests: [{ name: 'sonarr', type: 'lxc', vmid: 4010, host: 'pve1', ip: '192.168.1.10', subdomains: ['sonarr'] }],
  };
  const app = testApp(inventory);
  const res = await request(app).patch('/api/inventory/guests/sonarr').send({ port: 8989 });
  assert.equal(res.status, 200);
  assert.equal(res.body.caddySynced, true);
  assert.equal('authentikConflicts' in res.body, false, 'the ordinary response shape is unchanged');
  assert.equal('authentikOffLadder' in res.body, false, 'the ordinary response shape is unchanged');
  assert.equal('authentikMissingRungs' in res.body, false, 'the ordinary response shape is unchanged');
});

test('PATCH /api/inventory/guests/:name reports only its own Authentik conflict, not another entry\'s', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', caddy: true }],
    guests: [
      { name: 'auth-lxc', type: 'lxc', vmid: 4009, host: 'pve1', ip: '192.168.1.9', authentik: true },
      { name: 'sonarr', type: 'lxc', vmid: 4010, host: 'pve1', ip: '192.168.1.10', subdomains: ['sonarr'] },
      // Already gated and already in conflict -- its conflict is in the
      // inventory-wide list on every run, including this PATCH of 'sonarr'.
      { name: 'radarr', type: 'lxc', vmid: 4011, host: 'pve1', ip: '192.168.1.11', subdomains: ['radarr'], authGroup: 'bellhop-users' },
    ],
  };
  // Provider id '99' is absent from the fake's proxyProviders, which is how
  // a non-proxy (OIDC-backed) Application -- the kind this toolkit does not
  // own and so reports as a conflict -- is modeled.
  const authentik = new FakeAuthentikClient({
    applications: [
      { id: 'sonarr', pk: 'pk-sonarr', name: 'sonarr.example.com', slug: 'sonarr', providerId: '99' },
      { id: 'radarr', pk: 'pk-radarr', name: 'radarr.example.com', slug: 'radarr', providerId: '99' },
    ],
  });
  const app = testApp(inventory, () => ({ stdout: '', stderr: '', code: 0 }), authentik);

  const res = await request(app).patch('/api/inventory/guests/sonarr').send({ authGroup: 'bellhop-users' });
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.body.authentikConflicts,
    ['sonarr'],
    "radarr's conflict belongs to a different row and must not surface on this one"
  );
});

test('PATCH /api/inventory/guests/:name reports only its own Authentik off-ladder warning, not another entry\'s', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', caddy: true }],
    guests: [
      { name: 'auth-lxc', type: 'lxc', vmid: 4009, host: 'pve1', ip: '192.168.1.9', authentik: true },
      // Both already gated with an authGroup that is not in
      // AUTHENTIK_GROUP_LADDER -- reachable only via a hand-built Inventory
      // literal (the PATCH route itself rejects an off-ladder value, see
      // authGroupChangeError), same precedent as the pre-set authGroup on
      // 'radarr' in the conflict-scoping test above.
      { name: 'sonarr', type: 'lxc', vmid: 4010, host: 'pve1', ip: '192.168.1.10', subdomains: ['sonarr'], authGroup: 'typo-group' },
      // Already off-ladder and already reported inventory-wide on every run
      // -- its warning must not leak onto sonarr's PATCH response.
      { name: 'radarr', type: 'lxc', vmid: 4011, host: 'pve1', ip: '192.168.1.11', subdomains: ['radarr'], authGroup: 'another-typo' },
    ],
  };
  const app = testApp(inventory, () => ({ stdout: '', stderr: '', code: 0 }));

  // A port-only edit leaves sonarr's already off-ladder authGroup untouched
  // (authGroupChangeError is only consulted when 'authGroup' is itself in
  // the request body), so its offLadder entry keeps showing up on every
  // sync -- exactly the drift-already-in-the-database case this response
  // field exists to surface.
  const res = await request(app).patch('/api/inventory/guests/sonarr').send({ port: 8989 });
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.body.authentikOffLadder,
    [{ slug: 'sonarr', authGroup: 'typo-group' }],
    "radarr's off-ladder warning belongs to a different row and must not surface on this one"
  );
});

const LADDER = authentikConfig().groupLadder;
const [OPEN_RUNG, , USERS_RUNG] = LADDER;

function gatedInventory(authGroup?: string): Inventory {
  return {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', authentik: true, ip: '192.168.1.5' }],
    guests: [{ name: 'sonarr', type: 'lxc', vmid: 120, host: 'pve1', ip: '192.168.1.20', subdomains: ['sonarr'], authGroup }],
  };
}

function asUser(req: request.Test): request.Test {
  return req.set('x-authentik-username', 'someone').set('x-authentik-groups', 'bellhop-app-users');
}

test('PATCH guest authGroup lets a non-admin gate an ungated guest', async () => {
  const res = await asUser(request(testApp(gatedInventory())).patch('/api/inventory/guests/sonarr').send({ authGroup: OPEN_RUNG }));
  assert.equal(res.status, 200);
  assert.equal(res.body.guest.authGroup, OPEN_RUNG);
});

test('PATCH guest authGroup lets a non-admin raise a tier to a narrower rung', async () => {
  const res = await asUser(request(testApp(gatedInventory(OPEN_RUNG))).patch('/api/inventory/guests/sonarr').send({ authGroup: USERS_RUNG }));
  assert.equal(res.status, 200);
  assert.equal(res.body.guest.authGroup, USERS_RUNG);
});

test('PATCH guest authGroup rejects a non-admin widening a tier to a broader rung, and leaves the inventory unwritten', async () => {
  const app = testApp(gatedInventory(USERS_RUNG));
  const res = await asUser(request(app).patch('/api/inventory/guests/sonarr').send({ authGroup: OPEN_RUNG }));
  assert.equal(res.status, 403);
  assert.match(res.body.error, /admin/i);

  // A regression guard for the check running before any write: an
  // implementation that returned 403 after saveInventory would still pass
  // every assertion above.
  const invRes = await request(app).get('/api/inventory');
  assert.equal(
    invRes.body.guests.find((g: any) => g.name === 'sonarr').authGroup,
    USERS_RUNG,
    'a rejected widen must not have been persisted'
  );
});

test('PATCH guest authGroup rejects a non-admin clearing the gate', async () => {
  const res = await asUser(request(testApp(gatedInventory(USERS_RUNG))).patch('/api/inventory/guests/sonarr').send({ authGroup: null }));
  assert.equal(res.status, 403);
});

test('PATCH guest authGroup lets an admin widen a tier and clear the gate', async () => {
  const widened = await asAdmin(request(testApp(gatedInventory(USERS_RUNG))).patch('/api/inventory/guests/sonarr').send({ authGroup: OPEN_RUNG }));
  assert.equal(widened.status, 200);
  assert.equal(widened.body.guest.authGroup, OPEN_RUNG);

  const cleared = await asAdmin(request(testApp(gatedInventory(USERS_RUNG))).patch('/api/inventory/guests/sonarr').send({ authGroup: null }));
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.guest.authGroup, undefined);
});

test('PATCH guest authGroup rejects a group that is not on the ladder, for an admin too', async () => {
  const res = await asAdmin(request(testApp(gatedInventory())).patch('/api/inventory/guests/sonarr').send({ authGroup: 'not-a-rung' }));
  assert.equal(res.status, 400);
  assert.match(res.body.error, /not-a-rung/);
});

test('PATCH guest authGroup rejects a non-admin changing an entry whose current authGroup is off-ladder', async () => {
  const res = await asUser(request(testApp(gatedInventory('not-a-rung'))).patch('/api/inventory/guests/sonarr').send({ authGroup: USERS_RUNG }));
  assert.equal(res.status, 403);
});

test('PATCH guest authGroup is a no-op-safe re-submit of the same value for a non-admin', async () => {
  const res = await asUser(request(testApp(gatedInventory(USERS_RUNG))).patch('/api/inventory/guests/sonarr').send({ authGroup: USERS_RUNG }));
  assert.equal(res.status, 200);
});

// unauthenticatedPaths: adding an exemption is the privileged operation
// (only adding can make something publicly reachable), so these mirror the
// authGroup raise/lower tests above but gate on ladder reachability rather
// than raise/lower direction.
function gatedInventoryWithPaths(authGroup: string | undefined, unauthenticatedPaths?: string[]): Inventory {
  return {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', authentik: true, ip: '192.168.1.5' }],
    guests: [
      { name: 'sonarr', type: 'lxc', vmid: 120, host: 'pve1', ip: '192.168.1.20', subdomains: ['sonarr'], authGroup, unauthenticatedPaths },
    ],
  };
}

test('PATCH guest unauthenticatedPaths rejects a non-admin not in an at-or-above rung from adding a path to a gated guest', async () => {
  const app = testApp(gatedInventoryWithPaths(USERS_RUNG));
  const res = await asUser(request(app).patch('/api/inventory/guests/sonarr').send({ unauthenticatedPaths: '/api/*' }));
  assert.equal(res.status, 403);
  assert.match(res.body.error, /unauthenticated path/i);
});

test('PATCH guest unauthenticatedPaths lets a non-admin in an at-or-above rung add a path to a gated guest', async () => {
  const app = testApp(gatedInventoryWithPaths(USERS_RUNG));
  const res = await request(app)
    .patch('/api/inventory/guests/sonarr')
    .set('x-authentik-username', 'someone')
    .set('x-authentik-groups', USERS_RUNG)
    .send({ unauthenticatedPaths: '/api/*' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.guest.unauthenticatedPaths, ['/api/*']);
});

test('PATCH guest unauthenticatedPaths lets an admin add a path to a gated guest', async () => {
  const app = testApp(gatedInventoryWithPaths(USERS_RUNG));
  const res = await asAdmin(request(app).patch('/api/inventory/guests/sonarr').send({ unauthenticatedPaths: '/api/*' }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.guest.unauthenticatedPaths, ['/api/*']);
});

test('PATCH guest unauthenticatedPaths lets a non-admin with no ladder membership remove a path from a gated guest', async () => {
  const app = testApp(gatedInventoryWithPaths(USERS_RUNG, ['/api/*', '/health']));
  const res = await asUser(request(app).patch('/api/inventory/guests/sonarr').send({ unauthenticatedPaths: '/api/*' }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.guest.unauthenticatedPaths, ['/api/*']);
});

test('PATCH guest unauthenticatedPaths treats reordering the same set as no addition, for a non-admin with no ladder membership', async () => {
  const app = testApp(gatedInventoryWithPaths(USERS_RUNG, ['/api/*', '/health']));
  const res = await asUser(request(app).patch('/api/inventory/guests/sonarr').send({ unauthenticatedPaths: '/health ; /api/*' }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.guest.unauthenticatedPaths, ['/health', '/api/*']);
});

test('PATCH guest unauthenticatedPaths lets a non-admin with no ladder membership add a path to an ungated guest', async () => {
  const app = testApp(gatedInventoryWithPaths(undefined));
  const res = await asUser(request(app).patch('/api/inventory/guests/sonarr').send({ unauthenticatedPaths: '/api/*' }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.guest.unauthenticatedPaths, ['/api/*']);
});

test('PATCH guest unauthenticatedPaths rejected add leaves the stored list unchanged', async () => {
  const app = testApp(gatedInventoryWithPaths(USERS_RUNG, ['/health']));
  const res = await asUser(request(app).patch('/api/inventory/guests/sonarr').send({ unauthenticatedPaths: '/health ; /api/*' }));
  assert.equal(res.status, 403);

  const invRes = await request(app).get('/api/inventory');
  assert.deepEqual(
    invRes.body.guests.find((g: any) => g.name === 'sonarr').unauthenticatedPaths,
    ['/health'],
    'a rejected add must not have been persisted'
  );
});

test('PATCH guest authGroup + unauthenticatedPaths rejects adding a path while gating to an unreachable rung', async () => {
  // Regression test: the paths check must read the *resulting* authGroup
  // (this request's own edit) rather than the stored one. A non-admin can
  // gate an ungated entry to *any* rung (that's allowed), but adding a path
  // to an entry gated at an unreachable rung should fail. This test catches
  // a bug where changing the paths check to read inventory.guests[idx].authGroup
  // instead of updated.authGroup would miss this case: stored authGroup is
  // undefined (ungated), so it would pass; resulting authGroup is USERS_RUNG
  // (unreachable to this user), so it should fail.
  const app = testApp(gatedInventoryWithPaths(undefined));
  const res = await asUser(request(app).patch('/api/inventory/guests/sonarr')).send({
    authGroup: USERS_RUNG,
    unauthenticatedPaths: '/api/*',
  });
  assert.equal(res.status, 403);
  assert.match(res.body.error, /unauthenticated path/i);

  const invRes = await request(app).get('/api/inventory');
  assert.equal(
    invRes.body.guests.find((g: any) => g.name === 'sonarr').authGroup,
    undefined,
    'rejected PATCH must not write either field'
  );
  assert.equal(invRes.body.guests.find((g: any) => g.name === 'sonarr').unauthenticatedPaths, undefined);
});
