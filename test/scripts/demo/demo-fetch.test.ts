import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoFetch, DEMO_CATALOG_SLUGS } from '../../../scripts/demo/demo-fetch.ts';
import { buildDemoInventory } from '../../../scripts/demo/demo-inventory.ts';

test('demoFetch answers the stable ct/ listing URL with the slug JSON shape fetchRepoSlugs parses', async () => {
  const res = await demoFetch('https://api.github.com/repos/community-scripts/ProxmoxVE/contents/ct');
  assert.equal(res.status, 200);
  const body = (await res.json()) as Array<{ name: string; type: string }>;
  assert.ok(Array.isArray(body));
  assert.ok(body.length > 0);
  for (const entry of body) {
    assert.equal(typeof entry.name, 'string');
    assert.ok(entry.name.endsWith('.sh'));
    assert.equal(entry.type, 'file');
  }
  const names = body.map((e) => e.name.slice(0, -'.sh'.length)).sort();
  assert.deepEqual(names, [...DEMO_CATALOG_SLUGS.stable].sort());
});

test('demoFetch answers the dev ct/ listing URL too', async () => {
  const res = await demoFetch('https://api.github.com/repos/community-scripts/ProxmoxVED/contents/ct');
  assert.equal(res.status, 200);
  const body = (await res.json()) as Array<{ name: string; type: string }>;
  const names = body.map((e) => e.name.slice(0, -'.sh'.length)).sort();
  assert.deepEqual(names, [...DEMO_CATALOG_SLUGS.dev].sort());
});

test('demoFetch returns 200 with a script body for a listed stable slug (ct and install)', async () => {
  const slug = DEMO_CATALOG_SLUGS.stable[0];
  const ctRes = await demoFetch(`https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/${slug}.sh`);
  assert.equal(ctRes.status, 200);
  const ctBody = await ctRes.text();
  assert.ok(ctBody.length > 0);

  const installRes = await demoFetch(
    `https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/install/${slug}-install.sh`
  );
  assert.equal(installRes.status, 200);
});

test('demoFetch returns 404 for an unknown URL', async () => {
  const res = await demoFetch(
    'https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/not-a-real-demo-app.sh'
  );
  assert.equal(res.status, 404);
});

test('demoFetch returns 404 for a domain it does not simulate at all', async () => {
  const res = await demoFetch('https://example.com/whatever');
  assert.equal(res.status, 404);
});

test('demo catalog slugs cover every app slug used in the demo inventory', () => {
  const inv = buildDemoInventory();
  const usedSlugs = new Set(inv.guests.map((g) => g.app).filter((app): app is string => !!app));
  assert.ok(usedSlugs.size > 0, 'expected the demo inventory to set app on at least one guest');
  const stable: readonly string[] = DEMO_CATALOG_SLUGS.stable;
  const dev: readonly string[] = DEMO_CATALOG_SLUGS.dev;
  for (const slug of usedSlugs) {
    assert.ok(stable.includes(slug) || dev.includes(slug), `demo inventory app slug '${slug}' is missing from the demo catalog`);
  }
});

// Issue #64: the demo stores an example githubApiToken, so every GitHub API
// request it makes now carries an Authorization header. demoFetch answers
// by URL alone, so the header must change nothing.
test('demoFetch answers a request carrying the GitHub token header the same as one without', async () => {
  const url = 'https://api.github.com/repos/community-scripts/ProxmoxVE/contents/ct';
  const withToken = await demoFetch(url, { headers: { 'User-Agent': 'bellhop', Authorization: 'Bearer demo-example-github-token' } });
  const without = await demoFetch(url);
  assert.equal(withToken.status, 200);
  assert.deepEqual(await withToken.json(), await without.json());
});
