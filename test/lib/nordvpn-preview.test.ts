import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveNordVpnPreviewServer } from '../../src/lib/nordvpn-preview.ts';

function fakeFetch(responses: Record<string, { ok: boolean; status?: number; body?: unknown }>): typeof fetch {
  return (async (url: string) => {
    const match = Object.entries(responses).find(([key]) => url.includes(key));
    if (!match) throw new Error(`unexpected fetch url: ${url}`);
    const [, res] = match;
    return {
      ok: res.ok,
      status: res.status ?? (res.ok ? 200 : 500),
      json: async () => res.body,
    } as Response;
  }) as typeof fetch;
}

test('resolveNordVpnPreviewServer returns the first recommended server', async () => {
  const fetchImpl = fakeFetch({
    'users/services/credentials': { ok: true, body: { nordlynx_private_key: 'priv' } },
    'servers/recommendations': {
      ok: true,
      body: [{ hostname: 'nl123.nordvpn.com', locations: [{ country: { name: 'Netherlands' } }] }],
    },
  });
  const result = await resolveNordVpnPreviewServer('my-token', fetchImpl);
  assert.deepEqual(result, { hostname: 'nl123.nordvpn.com', country: 'Netherlands' });
});

test('resolveNordVpnPreviewServer throws on an invalid token', async () => {
  const fetchImpl = fakeFetch({
    'users/services/credentials': { ok: false, status: 401 },
  });
  await assert.rejects(() => resolveNordVpnPreviewServer('bad-token', fetchImpl), /authentication failed/);
});

test('resolveNordVpnPreviewServer throws when no server is returned', async () => {
  const fetchImpl = fakeFetch({
    'users/services/credentials': { ok: true, body: { nordlynx_private_key: 'priv' } },
    'servers/recommendations': { ok: true, body: [] },
  });
  await assert.rejects(() => resolveNordVpnPreviewServer('my-token', fetchImpl), /no WireGuard-capable server/);
});
