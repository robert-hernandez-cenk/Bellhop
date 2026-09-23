import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import express from 'express';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { networkingRoutes } from '../../../src/web/routes/networking.ts';
import type { Inventory } from '../../../src/lib/inventory.ts';
import { savePermissionGroup } from '../../../src/lib/permissions.ts';

const inventory: Inventory = {
  domain: 'example.com',
  hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
  guests: [
    { name: 'nordvpn-gateway-lxc', type: 'lxc', vmid: 4015, host: 'pve1', ip: '192.168.1.15', vpnGateway: 'nordvpn' },
    { name: 'media', type: 'lxc', vmid: 105, host: 'pve1' },
  ],
};

function testApp(fetchImpl: typeof fetch, groups: string[] = []) {
  const inventoryPath = path.join(mkdtempSync(path.join(tmpdir(), 'inventory-')), 'bellhop.db');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { username: 'test', groups };
    next();
  });
  app.use('/api/networking', networkingRoutes(inventory, inventoryPath, fetchImpl));
  return app;
}

test('GET /api/networking/gateways/:name/status proxies to the gateway and forwards its response', async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ connected: true, country: 'Netherlands' }) } as Response;
  }) as typeof fetch;
  const res = await request(testApp(fetchImpl)).get('/api/networking/gateways/nordvpn-gateway-lxc/status');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { connected: true, country: 'Netherlands' });
  assert.deepEqual(calls, ['http://192.168.1.15:8080/status']);
});

test('GET /api/networking/gateways/:name/servers proxies to the gateway', async () => {
  const fetchImpl = (async (url: string) => {
    assert.equal(url, 'http://192.168.1.15:8080/servers');
    return { ok: true, status: 200, json: async () => [{ name: 'Netherlands', code: 'NL' }] } as Response;
  }) as typeof fetch;
  const res = await request(testApp(fetchImpl)).get('/api/networking/gateways/nordvpn-gateway-lxc/servers');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, [{ name: 'Netherlands', code: 'NL' }]);
});

test('POST /api/networking/gateways/:name/connect forwards the country in the proxied request body', async () => {
  let sentBody: unknown;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    assert.equal(url, 'http://192.168.1.15:8080/connect');
    assert.equal(init?.method, 'POST');
    sentBody = JSON.parse(init!.body as string);
    return { ok: true, status: 200, json: async () => ({ connected: true, country: 'Canada' }) } as Response;
  }) as typeof fetch;
  const res = await request(testApp(fetchImpl))
    .post('/api/networking/gateways/nordvpn-gateway-lxc/connect')
    .send({ country: 'Canada' });
  assert.equal(res.status, 200);
  assert.deepEqual(sentBody, { country: 'Canada', city: '', group: '' });
  assert.deepEqual(res.body, { connected: true, country: 'Canada' });
});

test('GET status 404s for a guest name that is not a VPN gateway, without ever calling fetch', async () => {
  const fetchImpl = (async () => {
    throw new Error('fetch should never be called for a non-gateway guest');
  }) as typeof fetch;
  const res = await request(testApp(fetchImpl)).get('/api/networking/gateways/media/status');
  assert.equal(res.status, 404);
  assert.match(res.body.error, /Unknown VPN gateway: media/);
});

test('GET status 404s for a completely unknown name', async () => {
  const fetchImpl = (async () => {
    throw new Error('fetch should never be called');
  }) as typeof fetch;
  const res = await request(testApp(fetchImpl)).get('/api/networking/gateways/nope/status');
  assert.equal(res.status, 404);
});

test('GET status returns 502 when the gateway is unreachable', async () => {
  const fetchImpl = (async () => {
    throw new Error('ECONNREFUSED');
  }) as typeof fetch;
  const res = await request(testApp(fetchImpl)).get('/api/networking/gateways/nordvpn-gateway-lxc/status');
  assert.equal(res.status, 502);
  assert.match(res.body.error, /Failed to reach gateway/);
});

test('GET status returns 502 when the gateway itself responds with a non-2xx status', async () => {
  const fetchImpl = (async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) }) as Response) as typeof fetch;
  const res = await request(testApp(fetchImpl)).get('/api/networking/gateways/nordvpn-gateway-lxc/status');
  assert.equal(res.status, 502);
  assert.deepEqual(res.body, { error: 'boom' });
});

const inventoryWithIplessGateway: Inventory = {
  domain: 'example.com',
  hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
  guests: [{ name: 'broken-gateway-lxc', type: 'lxc', vmid: 4016, host: 'pve1', vpnGateway: 'pia' }],
};

test('GET status 404s with a distinct message when the gateway guest has no ip, without ever calling fetch', async () => {
  const fetchImpl = (async () => {
    throw new Error('fetch should never be called when the gateway has no ip');
  }) as typeof fetch;
  const inventoryPath = path.join(mkdtempSync(path.join(tmpdir(), 'inventory-')), 'bellhop.db');
  const app = express();
  app.use(express.json());
  app.use('/api/networking', networkingRoutes(inventoryWithIplessGateway, inventoryPath, fetchImpl));
  const res = await request(app).get('/api/networking/gateways/broken-gateway-lxc/status');
  assert.equal(res.status, 404);
  assert.match(res.body.error, /VPN gateway broken-gateway-lxc has no ip in inventory/);
});

test('GET /api/networking/gateways/:name/cities proxies to the gateway with the country query param', async () => {
  const fetchImpl = (async (url: string) => {
    assert.equal(url, 'http://192.168.1.15:8080/cities?country=Netherlands');
    return { ok: true, status: 200, json: async () => [{ name: 'Amsterdam', id: '9236' }] } as Response;
  }) as typeof fetch;
  const res = await request(testApp(fetchImpl)).get('/api/networking/gateways/nordvpn-gateway-lxc/cities?country=Netherlands');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, [{ name: 'Amsterdam', id: '9236' }]);
});

test('GET /api/networking/gateways/:name/groups proxies to the gateway', async () => {
  const fetchImpl = (async (url: string) => {
    assert.equal(url, 'http://192.168.1.15:8080/groups');
    return { ok: true, status: 200, json: async () => [{ name: 'Double VPN', identifier: 'legacy_double_vpn' }] } as Response;
  }) as typeof fetch;
  const res = await request(testApp(fetchImpl)).get('/api/networking/gateways/nordvpn-gateway-lxc/groups');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, [{ name: 'Double VPN', identifier: 'legacy_double_vpn' }]);
});

test('POST /api/networking/gateways/:name/connect forwards city and group alongside country', async () => {
  let sentBody: unknown;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    assert.equal(url, 'http://192.168.1.15:8080/connect');
    sentBody = JSON.parse(init!.body as string);
    return { ok: true, status: 200, json: async () => ({ connected: true, country: 'Netherlands', city: 'Amsterdam', group: 'legacy_double_vpn' }) } as Response;
  }) as typeof fetch;
  const res = await request(testApp(fetchImpl))
    .post('/api/networking/gateways/nordvpn-gateway-lxc/connect')
    .send({ country: 'Netherlands', city: 'Amsterdam', group: 'legacy_double_vpn' });
  assert.equal(res.status, 200);
  assert.deepEqual(sentBody, { country: 'Netherlands', city: 'Amsterdam', group: 'legacy_double_vpn' });
  assert.deepEqual(res.body, { connected: true, country: 'Netherlands', city: 'Amsterdam', group: 'legacy_double_vpn' });
});

test('GET /api/networking/gateways/:name/status returns 403 for a restricted group targeting a blocked gateway guest', async () => {
  const fetchImpl = (async () => {
    throw new Error('should not be called');
  }) as typeof fetch;
  const inventoryPath = path.join(mkdtempSync(path.join(tmpdir(), 'inventory-')), 'bellhop.db');
  savePermissionGroup(inventoryPath, 'family', {
    mode: 'block-list',
    resources: [{ type: 'guest', name: 'nordvpn-gateway-lxc' }],
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { username: 'test', groups: ['family'] };
    next();
  });
  app.use('/api/networking', networkingRoutes(inventory, inventoryPath, fetchImpl));

  const res = await request(app).get('/api/networking/gateways/nordvpn-gateway-lxc/status');
  assert.equal(res.status, 403);
});

test('GET /api/networking/gateways/:name/status succeeds for a restricted group targeting an allowed gateway guest', async () => {
  const fetchImpl = (async () => {
    return { ok: true, status: 200, json: async () => ({ connected: false }) } as Response;
  }) as typeof fetch;
  const inventoryPath = path.join(mkdtempSync(path.join(tmpdir(), 'inventory-')), 'bellhop.db');
  savePermissionGroup(inventoryPath, 'family', { mode: 'block-list', resources: [] });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { username: 'test', groups: ['family'] };
    next();
  });
  app.use('/api/networking', networkingRoutes(inventory, inventoryPath, fetchImpl));

  const res = await request(app).get('/api/networking/gateways/nordvpn-gateway-lxc/status');
  assert.equal(res.status, 200);
});
