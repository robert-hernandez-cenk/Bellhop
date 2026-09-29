import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Inventory } from '../../src/lib/inventory.ts';
import { gatewayStatus, gatewayServers, gatewayCities, gatewayGroups, connectGateway } from '../../src/operations/vpn-gateway.ts';

const inventory: Inventory = {
  domain: 'example.com',
  hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
  guests: [
    { name: 'nordvpn-example-gw-lxc', type: 'lxc', vmid: 4015, host: 'pve1', ip: '192.0.2.15', vpnGateway: 'nordvpn' },
    { name: 'no-gateway-lxc', type: 'lxc', vmid: 105, host: 'pve1' },
  ],
};

const inventoryWithIplessGateway: Inventory = {
  domain: 'example.com',
  hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
  guests: [{ name: 'pia-example-gw-lxc', type: 'lxc', vmid: 4016, host: 'pve1', vpnGateway: 'pia' }],
};

function neverFetch(): typeof fetch {
  return (async () => {
    throw new Error('fetch should never be called');
  }) as typeof fetch;
}

test('gatewayStatus: a guest with no vpnGateway is not-found and never calls fetch', async () => {
  const result = await gatewayStatus(inventory, 'no-gateway-lxc', neverFetch());
  assert.deepEqual(result, {
    ok: false,
    kind: 'not-found',
    error: 'Unknown VPN gateway: no-gateway-lxc',
    body: { error: 'Unknown VPN gateway: no-gateway-lxc' },
  });
});

test('gatewayStatus: a completely unknown name is not-found and never calls fetch', async () => {
  const result = await gatewayStatus(inventory, 'nope', neverFetch());
  assert.deepEqual(result, {
    ok: false,
    kind: 'not-found',
    error: 'Unknown VPN gateway: nope',
    body: { error: 'Unknown VPN gateway: nope' },
  });
});

test('gatewayStatus: a gateway guest with no ip is not-found and never calls fetch', async () => {
  const result = await gatewayStatus(inventoryWithIplessGateway, 'pia-example-gw-lxc', neverFetch());
  assert.deepEqual(result, {
    ok: false,
    kind: 'not-found',
    error: 'VPN gateway pia-example-gw-lxc has no ip in inventory',
    body: { error: 'VPN gateway pia-example-gw-lxc has no ip in inventory' },
  });
});

test('gatewayStatus: success calls the gateway with a timeout signal and returns the body unchanged', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ connected: true, country: 'Netherlands' }) } as Response;
  }) as typeof fetch;
  const result = await gatewayStatus(inventory, 'nordvpn-example-gw-lxc', fetchImpl);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://192.0.2.15:8080/status');
  assert.ok(calls[0].init?.signal instanceof AbortSignal);
  assert.deepEqual(result, { ok: true, body: { connected: true, country: 'Netherlands' } });
});

test('gatewayStatus: a thrown fetch error is upstream, with the reachability message as both body.error and error', async () => {
  const fetchImpl = (async () => {
    throw new Error('connect ECONNREFUSED');
  }) as typeof fetch;
  const result = await gatewayStatus(inventory, 'nordvpn-example-gw-lxc', fetchImpl);
  assert.deepEqual(result, {
    ok: false,
    kind: 'upstream',
    error: 'Failed to reach gateway at 192.0.2.15:8080 -- connect ECONNREFUSED',
    body: { error: 'Failed to reach gateway at 192.0.2.15:8080 -- connect ECONNREFUSED' },
  });
});

test('gatewayStatus: a 502 gateway response is upstream, body unchanged, error from body.error', async () => {
  const fetchImpl = (async () => ({ ok: false, status: 502, json: async () => ({ error: 'provider down' }) }) as Response) as typeof fetch;
  const result = await gatewayStatus(inventory, 'nordvpn-example-gw-lxc', fetchImpl);
  assert.deepEqual(result, {
    ok: false,
    kind: 'upstream',
    error: 'provider down',
    body: { error: 'provider down' },
  });
});

test('gatewayStatus: a 500 response whose .json() rejects falls back to an HTTP-status error with an empty body', async () => {
  const fetchImpl = (async () =>
    ({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('not json');
      },
    }) as unknown as Response) as typeof fetch;
  const result = await gatewayStatus(inventory, 'nordvpn-example-gw-lxc', fetchImpl);
  assert.deepEqual(result, {
    ok: false,
    kind: 'upstream',
    error: 'VPN gateway nordvpn-example-gw-lxc returned HTTP 500',
    body: {},
  });
});

test('gatewayServers calls /servers with a timeout signal', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => [{ name: 'Netherlands', code: 'NL' }] } as Response;
  }) as typeof fetch;
  const result = await gatewayServers(inventory, 'nordvpn-example-gw-lxc', fetchImpl);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://192.0.2.15:8080/servers');
  assert.ok(calls[0].init?.signal instanceof AbortSignal);
  assert.deepEqual(result, { ok: true, body: [{ name: 'Netherlands', code: 'NL' }] });
});

test('gatewayGroups calls /groups with a timeout signal', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => [{ name: 'Double VPN', identifier: 'legacy_double_vpn' }] } as Response;
  }) as typeof fetch;
  const result = await gatewayGroups(inventory, 'nordvpn-example-gw-lxc', fetchImpl);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://192.0.2.15:8080/groups');
  assert.ok(calls[0].init?.signal instanceof AbortSignal);
  assert.deepEqual(result, { ok: true, body: [{ name: 'Double VPN', identifier: 'legacy_double_vpn' }] });
});

test('gatewayCities encodes a country with special characters in the query string', async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => [{ name: 'Sarajevo', id: '1' }] } as Response;
  }) as typeof fetch;
  const result = await gatewayCities(inventory, 'nordvpn-example-gw-lxc', 'Bosnia & Herzegovina', fetchImpl);
  assert.deepEqual(calls, ['http://192.0.2.15:8080/cities?country=Bosnia%20%26%20Herzegovina']);
  assert.deepEqual(result, { ok: true, body: [{ name: 'Sarajevo', id: '1' }] });
});

test('gatewayCities with an empty country sends an empty query value', async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => [] } as Response;
  }) as typeof fetch;
  await gatewayCities(inventory, 'nordvpn-example-gw-lxc', '', fetchImpl);
  assert.deepEqual(calls, ['http://192.0.2.15:8080/cities?country=']);
});

test('connectGateway POSTs the selection as JSON with no timeout signal', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ connected: true, country: 'Germany' }) } as Response;
  }) as typeof fetch;
  const result = await connectGateway(inventory, 'nordvpn-example-gw-lxc', { country: 'Germany' }, fetchImpl);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://192.0.2.15:8080/connect');
  assert.equal(calls[0].init?.method, 'POST');
  assert.equal((calls[0].init?.headers as Record<string, string>)['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init!.body as string), { country: 'Germany', city: '', group: '' });
  assert.equal(calls[0].init?.signal, undefined);
  assert.deepEqual(result, { ok: true, body: { connected: true, country: 'Germany' } });
});

test('connectGateway sends the full selection when country, city, and group are all given', async () => {
  let sentBody: unknown;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    sentBody = JSON.parse(init!.body as string);
    return { ok: true, status: 200, json: async () => ({ connected: true }) } as Response;
  }) as typeof fetch;
  await connectGateway(inventory, 'nordvpn-example-gw-lxc', { country: 'Netherlands', city: 'Amsterdam', group: 'legacy_double_vpn' }, fetchImpl);
  assert.deepEqual(sentBody, { country: 'Netherlands', city: 'Amsterdam', group: 'legacy_double_vpn' });
});

test('connectGateway: a 502 gateway response is upstream, error from body.error', async () => {
  const fetchImpl = (async () => ({ ok: false, status: 502, json: async () => ({ error: 'no servers matched' }) }) as Response) as typeof fetch;
  const result = await connectGateway(inventory, 'nordvpn-example-gw-lxc', { country: 'Germany' }, fetchImpl);
  assert.deepEqual(result, {
    ok: false,
    kind: 'upstream',
    error: 'no servers matched',
    body: { error: 'no servers matched' },
  });
});

test('connectGateway: an unknown gateway is not-found and never calls fetch', async () => {
  const result = await connectGateway(inventory, 'nope', { country: 'Germany' }, neverFetch());
  assert.deepEqual(result, {
    ok: false,
    kind: 'not-found',
    error: 'Unknown VPN gateway: nope',
    body: { error: 'Unknown VPN gateway: nope' },
  });
});
