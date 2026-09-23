import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePiaPreviewServer } from '../../src/lib/pia-preview.ts';

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

test("resolvePiaPreviewServer returns the first region's first wg server", async () => {
  const fetchImpl = fakeFetch({
    'api/client/v2/token': { ok: true, body: { token: 'session-token' } },
    'serverlist.piaservers.net': {
      ok: true,
      body: { regions: [{ name: 'US Atlanta', servers: { wg: [{ cn: 'atlanta123' }] } }] },
    },
  });
  const result = await resolvePiaPreviewServer('p0123456', 'hunter2', fetchImpl);
  assert.deepEqual(result, { hostname: 'atlanta123', country: 'US Atlanta' });
});

test('resolvePiaPreviewServer throws on invalid credentials', async () => {
  const fetchImpl = fakeFetch({
    'api/client/v2/token': { ok: false, status: 401 },
  });
  await assert.rejects(() => resolvePiaPreviewServer('p0123456', 'wrong', fetchImpl), /authentication failed/);
});

test('resolvePiaPreviewServer throws when no region is returned', async () => {
  const fetchImpl = fakeFetch({
    'api/client/v2/token': { ok: true, body: { token: 'session-token' } },
    'serverlist.piaservers.net': { ok: true, body: { regions: [] } },
  });
  await assert.rejects(() => resolvePiaPreviewServer('p0123456', 'hunter2', fetchImpl), /first region had no WireGuard-capable server/);
});
