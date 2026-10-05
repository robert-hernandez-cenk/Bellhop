import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { apiGet, apiPost, apiPatch, apiPut, apiDelete } from '../../web-client/src/api/client.ts';

// #69 US5 (T044): a 401 from /api means the session is gone (or never
// existed) -- the client sends the browser to Bellhop's own sign-in, carrying
// the page to come back to.
const realFetch = globalThis.fetch;
const realLocation = (globalThis as { location?: unknown }).location;

function stubBrowser(status: number, pathname = '/guests', search = '?tab=lxc'): { href: string } {
  const loc = { href: '', pathname, search };
  (globalThis as { location?: unknown }).location = loc;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: 'Authentication required' }), { status })) as typeof fetch;
  return loc;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  (globalThis as { location?: unknown }).location = realLocation;
});

const helpers: Array<[string, () => Promise<unknown>]> = [
  ['apiGet', () => apiGet('/x')],
  ['apiPost', () => apiPost('/x', {})],
  ['apiPatch', () => apiPatch('/x', {})],
  ['apiPut', () => apiPut('/x', {})],
  ['apiDelete', () => apiDelete('/x')],
];

for (const [name, call] of helpers) {
  test(`${name}: a 401 redirects to /auth/login with the current path and search as returnTo`, async () => {
    const loc = stubBrowser(401);
    await assert.rejects(call());
    assert.equal(loc.href, `/auth/login?returnTo=${encodeURIComponent('/guests?tab=lxc')}`);
  });

  test(`${name}: a 403 does not redirect`, async () => {
    const loc = stubBrowser(403);
    await assert.rejects(call());
    assert.equal(loc.href, '');
  });
}
