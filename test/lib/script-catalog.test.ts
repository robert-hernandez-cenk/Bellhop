import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchCatalog,
  CATALOG_MAX_AGE_MS,
  loadCatalog,
  saveCatalog,
  getScriptCatalog,
  resetCatalogFetchState,
} from '../../src/lib/script-catalog.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { saveInventory, loadInventory, type Inventory } from '../../src/lib/inventory.ts';

function tempDbPath(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'script-catalog-')), 'bellhop.db');
}

// Builds a fetch stub that answers each repo's contents/ct listing with the
// given file names, mimicking the GitHub contents API's array-of-objects
// response shape.
function fakeContentsFetch(byRepo: Record<string, string[]>): typeof fetch {
  return (async (url: unknown) => {
    const href = String(url);
    const repo = href.includes('ProxmoxVED') ? 'ProxmoxVED' : 'ProxmoxVE';
    const names = byRepo[repo];
    if (names === undefined) return new Response(null, { status: 404 });
    return new Response(JSON.stringify(names.map((name) => ({ name, type: 'file' }))), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

test('CATALOG_MAX_AGE_MS is 24 hours', () => {
  assert.equal(CATALOG_MAX_AGE_MS, 24 * 60 * 60 * 1000);
});

test('fetchCatalog returns slugs from both repos with the .sh extension stripped', async () => {
  const result = await fetchCatalog(
    fakeContentsFetch({ ProxmoxVE: ['plex.sh', 'jellyfin.sh'], ProxmoxVED: ['budget-board.sh'] })
  );
  assert.deepEqual(result.stable, ['jellyfin', 'plex']);
  assert.deepEqual(result.dev, ['budget-board']);
});

test('fetchCatalog ignores entries that are not .sh files', async () => {
  const result = await fetchCatalog(
    fakeContentsFetch({ ProxmoxVE: ['plex.sh', 'README.md', 'headers'], ProxmoxVED: [] })
  );
  assert.deepEqual(result.stable, ['plex']);
  assert.deepEqual(result.dev, []);
});

test('fetchCatalog lowercases slugs', async () => {
  const result = await fetchCatalog(fakeContentsFetch({ ProxmoxVE: ['Plex.sh'], ProxmoxVED: [] }));
  assert.deepEqual(result.stable, ['plex']);
});

test('fetchCatalog drops a dev slug that already exists in the stable repo', async () => {
  const result = await fetchCatalog(
    fakeContentsFetch({ ProxmoxVE: ['plex.sh'], ProxmoxVED: ['plex.sh', 'budget-board.sh'] })
  );
  assert.deepEqual(result.stable, ['plex']);
  assert.deepEqual(result.dev, ['budget-board']);
});

test('fetchCatalog sends a User-Agent, since GitHub rejects unauthenticated calls without one', async () => {
  const seenHeaders: Record<string, string>[] = [];
  const fakeFetch = (async (_url: unknown, init?: RequestInit) => {
    seenHeaders.push((init?.headers ?? {}) as Record<string, string>);
    return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  await fetchCatalog(fakeFetch);
  assert.equal(seenHeaders.length, 2);
  for (const headers of seenHeaders) {
    assert.ok(headers['User-Agent']);
    assert.equal(headers.Accept, 'application/vnd.github+json');
  }
});

test('fetchCatalog rejects when a repo listing responds non-ok', async () => {
  const fakeFetch = (async () => new Response(null, { status: 403 })) as unknown as typeof fetch;
  await assert.rejects(() => fetchCatalog(fakeFetch), /403/);
});

test('fetchCatalog rejects when the network call throws', async () => {
  const fakeFetch = (async () => {
    throw new Error('ENOTFOUND api.github.com');
  }) as unknown as typeof fetch;
  await assert.rejects(() => fetchCatalog(fakeFetch), /ENOTFOUND/);
});

test('fetchCatalog excludes a directory named like a .sh file', async () => {
  const fakeFetch = (async (url: unknown) => {
    const href = String(url);
    const repo = href.includes('ProxmoxVED') ? 'ProxmoxVED' : 'ProxmoxVE';
    if (repo === 'ProxmoxVED') {
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(
      JSON.stringify([
        { name: 'plex.sh', type: 'file' },
        { name: 'foo.sh', type: 'dir' },
      ]),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }) as unknown as typeof fetch;
  const result = await fetchCatalog(fakeFetch);
  assert.deepEqual(result.stable, ['plex']);
});

test('fetchCatalog includes an entry with no type field at all', async () => {
  const fakeFetch = (async (url: unknown) => {
    const href = String(url);
    const repo = href.includes('ProxmoxVED') ? 'ProxmoxVED' : 'ProxmoxVE';
    if (repo === 'ProxmoxVED') {
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify([{ name: 'plex.sh' }]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  const result = await fetchCatalog(fakeFetch);
  assert.deepEqual(result.stable, ['plex']);
});

test('fetchCatalog warns when a repo listing comes back at GitHub\'s 1000-entry ceiling', async () => {
  // logWarn (src/lib/log.ts) writes through console.error, not console.warn.
  const originalError = console.error;
  const warnings: string[] = [];
  console.error = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  try {
    const bigListing = Array.from({ length: 1000 }, (_, i) => ({ name: `app-${i}.sh`, type: 'file' }));
    const fakeFetch = (async (url: unknown) => {
      const href = String(url);
      const repo = href.includes('ProxmoxVED') ? 'ProxmoxVED' : 'ProxmoxVE';
      if (repo === 'ProxmoxVED') {
        return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify(bigListing), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    await fetchCatalog(fakeFetch);
    assert.ok(
      warnings.some((w) => w.includes('1000') && w.includes('ProxmoxVE')),
      `expected a truncation warning naming ProxmoxVE and 1000, got: ${JSON.stringify(warnings)}`
    );
  } finally {
    console.error = originalError;
  }
});

test('loadCatalog returns undefined when nothing has been stored', () => {
  assert.equal(loadCatalog(tempDbPath()), undefined);
});

test('saveCatalog/loadCatalog round-trip both groups and the fetch timestamp', () => {
  const dbPath = tempDbPath();
  const now = new Date('2026-08-15T12:00:00.000Z');
  saveCatalog(dbPath, { stable: ['jellyfin', 'plex'], dev: ['budget-board'] }, now);
  const loaded = loadCatalog(dbPath);
  assert.deepEqual(loaded?.stable, ['jellyfin', 'plex']);
  assert.deepEqual(loaded?.dev, ['budget-board']);
  assert.equal(loaded?.fetchedAt, '2026-08-15T12:00:00.000Z');
});

test('saveCatalog fully replaces the previous catalog rather than merging', () => {
  const dbPath = tempDbPath();
  saveCatalog(dbPath, { stable: ['plex', 'removed-app'], dev: [] }, new Date('2026-08-14T00:00:00.000Z'));
  saveCatalog(dbPath, { stable: ['plex'], dev: [] }, new Date('2026-08-15T00:00:00.000Z'));
  const loaded = loadCatalog(dbPath);
  assert.deepEqual(loaded?.stable, ['plex']);
  assert.equal(loaded?.fetchedAt, '2026-08-15T00:00:00.000Z');
});

test('saveInventory leaves the stored catalog intact', () => {
  const dbPath = tempDbPath();
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
    guests: [{ name: 'media', type: 'lxc', vmid: 105, host: 'pve1' }],
  };
  saveInventory(dbPath, inventory);
  saveCatalog(dbPath, { stable: ['plex'], dev: [] }, new Date('2026-08-15T00:00:00.000Z'));
  saveInventory(dbPath, inventory);

  assert.deepEqual(loadCatalog(dbPath)?.stable, ['plex']);
  assert.equal(loadInventory(dbPath).guests.length, 1);
});

const FAILING_FETCH = (async () => {
  throw new Error('ENOTFOUND api.github.com');
}) as unknown as typeof fetch;

test('getScriptCatalog serves a fresh stored catalog without refetching', async () => {
  resetCatalogFetchState();
  const dbPath = tempDbPath();
  const storedAt = new Date('2026-08-15T00:00:00.000Z');
  saveCatalog(dbPath, { stable: ['plex'], dev: [] }, storedAt);

  let fetchCalls = 0;
  const countingFetch = (async () => {
    fetchCalls += 1;
    return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;

  const result = await getScriptCatalog(dbPath, countingFetch, new Date(storedAt.getTime() + 1000));
  assert.equal(fetchCalls, 0);
  assert.deepEqual(result.stable, ['plex']);
  assert.equal(result.stale, false);
  assert.equal(result.fetchedAt, '2026-08-15T00:00:00.000Z');
});

test('getScriptCatalog refetches and rewrites once the stored copy exceeds CATALOG_MAX_AGE_MS', async () => {
  resetCatalogFetchState();
  const dbPath = tempDbPath();
  const storedAt = new Date('2026-08-15T00:00:00.000Z');
  saveCatalog(dbPath, { stable: ['old-app'], dev: [] }, storedAt);

  const later = new Date(storedAt.getTime() + CATALOG_MAX_AGE_MS + 1000);
  const result = await getScriptCatalog(
    dbPath,
    fakeContentsFetch({ ProxmoxVE: ['plex.sh'], ProxmoxVED: ['budget-board.sh'] }),
    later
  );
  assert.deepEqual(result.stable, ['plex']);
  assert.deepEqual(result.dev, ['budget-board']);
  assert.equal(result.stale, false);
  assert.equal(result.fetchedAt, later.toISOString());
  assert.deepEqual(loadCatalog(dbPath)?.stable, ['plex']);
});

test('getScriptCatalog fetches and stores when nothing is cached yet', async () => {
  resetCatalogFetchState();
  const dbPath = tempDbPath();
  const now = new Date('2026-08-15T00:00:00.000Z');
  const result = await getScriptCatalog(dbPath, fakeContentsFetch({ ProxmoxVE: ['plex.sh'], ProxmoxVED: [] }), now);
  assert.deepEqual(result.stable, ['plex']);
  assert.equal(result.stale, false);
  assert.deepEqual(loadCatalog(dbPath)?.stable, ['plex']);
});

test('getScriptCatalog serves the stale stored copy when the refetch fails', async () => {
  resetCatalogFetchState();
  const dbPath = tempDbPath();
  const storedAt = new Date('2026-08-15T00:00:00.000Z');
  saveCatalog(dbPath, { stable: ['plex'], dev: [] }, storedAt);

  const later = new Date(storedAt.getTime() + CATALOG_MAX_AGE_MS + 1000);
  const result = await getScriptCatalog(dbPath, FAILING_FETCH, later);
  assert.deepEqual(result.stable, ['plex']);
  assert.equal(result.stale, true);
  assert.equal(result.fetchedAt, storedAt.toISOString());
});

test('getScriptCatalog returns empty lists when the fetch fails with nothing cached', async () => {
  resetCatalogFetchState();
  const result = await getScriptCatalog(tempDbPath(), FAILING_FETCH, new Date('2026-08-15T00:00:00.000Z'));
  assert.deepEqual(result.stable, []);
  assert.deepEqual(result.dev, []);
  assert.equal(result.fetchedAt, null);
  assert.equal(result.stale, true);
});

test('getScriptCatalog treats an empty stable listing as a failure rather than caching it', async () => {
  resetCatalogFetchState();
  const dbPath = tempDbPath();
  const storedAt = new Date('2026-08-15T00:00:00.000Z');
  saveCatalog(dbPath, { stable: ['plex'], dev: [] }, storedAt);

  const later = new Date(storedAt.getTime() + CATALOG_MAX_AGE_MS + 1000);
  const result = await getScriptCatalog(dbPath, fakeContentsFetch({ ProxmoxVE: [], ProxmoxVED: [] }), later);

  // Serves the previous good copy, marked stale, instead of the empty one.
  assert.deepEqual(result.stable, ['plex']);
  assert.equal(result.stale, true);
  assert.equal(result.fetchedAt, storedAt.toISOString());

  // The stored copy itself is untouched -- an empty response must not
  // overwrite it and poison the cache for a full CATALOG_MAX_AGE_MS.
  const stored = loadCatalog(dbPath);
  assert.deepEqual(stored?.stable, ['plex']);
  assert.equal(stored?.fetchedAt, storedAt.toISOString());
});

test('getScriptCatalog treats an empty stable listing as a failure with nothing cached yet', async () => {
  resetCatalogFetchState();
  const dbPath = tempDbPath();
  const result = await getScriptCatalog(
    dbPath,
    fakeContentsFetch({ ProxmoxVE: [], ProxmoxVED: ['budget-board.sh'] }),
    new Date('2026-08-15T00:00:00.000Z')
  );
  assert.deepEqual(result.stable, []);
  assert.deepEqual(result.dev, []);
  assert.equal(result.fetchedAt, null);
  assert.equal(result.stale, true);
  assert.equal(loadCatalog(dbPath), undefined);
});

test('getScriptCatalog does not treat an empty dev listing as a failure', async () => {
  resetCatalogFetchState();
  const dbPath = tempDbPath();
  const now = new Date('2026-08-15T00:00:00.000Z');
  const result = await getScriptCatalog(dbPath, fakeContentsFetch({ ProxmoxVE: ['plex.sh'], ProxmoxVED: [] }), now);
  assert.deepEqual(result.stable, ['plex']);
  assert.deepEqual(result.dev, []);
  assert.equal(result.stale, false);
  assert.deepEqual(loadCatalog(dbPath)?.stable, ['plex']);
});

test('getScriptCatalog shares one in-flight fetch across concurrent calls', async () => {
  resetCatalogFetchState();
  const dbPathA = tempDbPath();
  const dbPathB = tempDbPath();
  let fetchCalls = 0;
  const countingFetch = fakeContentsFetch({ ProxmoxVE: ['plex.sh'], ProxmoxVED: [] });
  const wrappedFetch = (async (...args: Parameters<typeof fetch>) => {
    fetchCalls += 1;
    return countingFetch(...args);
  }) as unknown as typeof fetch;
  const now = new Date('2026-08-15T00:00:00.000Z');

  const [resultA, resultB] = await Promise.all([
    getScriptCatalog(dbPathA, wrappedFetch, now),
    getScriptCatalog(dbPathB, wrappedFetch, now),
  ]);

  // One fetchCatalog() call issues 2 HTTP requests (stable + dev repos);
  // two concurrent getScriptCatalog calls sharing one in-flight fetch
  // should still total only 2, not 4.
  assert.equal(fetchCalls, 2);
  assert.deepEqual(resultA.stable, ['plex']);
  assert.deepEqual(resultB.stable, ['plex']);
});

test('getScriptCatalog skips refetching within the post-failure cooldown', async () => {
  resetCatalogFetchState();
  const dbPath = tempDbPath();
  const storedAt = new Date('2026-08-15T00:00:00.000Z');
  saveCatalog(dbPath, { stable: ['plex'], dev: [] }, storedAt);
  const later = new Date(storedAt.getTime() + CATALOG_MAX_AGE_MS + 1000);

  const first = await getScriptCatalog(dbPath, FAILING_FETCH, later);
  assert.equal(first.stale, true);

  let fetchCalls = 0;
  const countingFetch = (async () => {
    fetchCalls += 1;
    return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;

  // Still within the cooldown window -- must not call fetchImpl again.
  const soonAfter = new Date(later.getTime() + 1000);
  const second = await getScriptCatalog(dbPath, countingFetch, soonAfter);
  assert.equal(fetchCalls, 0);
  assert.equal(second.stale, true);
  assert.deepEqual(second.stable, ['plex']);

  // Past the cooldown window -- retries GitHub again.
  const muchLater = new Date(later.getTime() + 61 * 1000);
  await getScriptCatalog(dbPath, countingFetch, muchLater);
  assert.equal(fetchCalls, 2);
});
