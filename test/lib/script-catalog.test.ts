import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchCatalog,
  CATALOG_MAX_AGE_MS,
  CUSTOM_CATALOG_MAX_AGE_MS,
  loadCatalog,
  saveCatalog,
  getScriptCatalog,
  resetCatalogFetchState,
} from '../../src/lib/script-catalog.ts';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
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

// --- custom script repository group (issue #11) ---------------------------

const fixtureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'github');
const CUSTOM_LISTING_RAW = readFileSync(path.join(fixtureDir, 'contents-ct-listing.json'), 'utf8');
const CUSTOM_LISTING: Array<{ name: string; type: string }> = JSON.parse(CUSTOM_LISTING_RAW);
// Mirrors fetchRepoSlugs' own filtering (dirs dropped, .sh stripped,
// lowercased, sorted) so this stays correct if the fixture is ever
// recaptured -- 65 .sh files, 2 directories (deferred, headers) as of the
// 2026-09-24 capture (research.md R4).
const CUSTOM_SLUGS = CUSTOM_LISTING.filter((e) => e.type === 'file' && e.name.endsWith('.sh'))
  .map((e) => e.name.slice(0, -'.sh'.length).toLowerCase())
  .sort();

// Example values only (constitution Principle I) -- same example the
// spec/plan/data-model/app-source tests use.
const CUSTOM_OWNER = 'example-user';
const CUSTOM_REPO = 'ProxmoxVED';
const CUSTOM_BRANCH = 'my-apps';
const CUSTOM_LABEL = `${CUSTOM_OWNER}/${CUSTOM_REPO}@${CUSTOM_BRANCH}`;

function baseInventory(): Inventory {
  return {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
    guests: [],
  };
}

function withCustomSource(inv: Inventory, branch: string = CUSTOM_BRANCH): Inventory {
  return { ...inv, customScriptsRepo: `${CUSTOM_OWNER}/${CUSTOM_REPO}`, customScriptsBranch: branch };
}

// A combined fetch stub covering both the upstream community-scripts
// listings (fetchCatalog's own two calls) and the custom repository's own
// contents/ct listing -- matched by owner/repo prefix only (ignoring the
// ?ref= query), so a test that changes the configured branch doesn't need a
// second stub. Defaults `stable` to a non-empty list since getUpstreamCatalog
// treats an empty stable listing as a failure (see the test above).
function buildFetch(
  opts: {
    stable?: string[];
    dev?: string[];
    customOwner?: string;
    customRepo?: string;
    customResponse?: 'fixture' | 'error' | { status: number } | string[];
    onCustomCall?: () => void;
  } = {}
): typeof fetch {
  const stable = opts.stable ?? ['plex'];
  const dev = opts.dev ?? [];
  const customPrefix = `https://api.github.com/repos/${opts.customOwner ?? CUSTOM_OWNER}/${opts.customRepo ?? CUSTOM_REPO}/contents/ct`;
  return (async (url: unknown) => {
    const href = String(url);
    if (href.startsWith(customPrefix)) {
      opts.onCustomCall?.();
      const response = opts.customResponse ?? 'fixture';
      if (response === 'error') throw new Error('ENOTFOUND api.github.com');
      if (response === 'fixture') {
        return new Response(CUSTOM_LISTING_RAW, { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (Array.isArray(response)) {
        return new Response(JSON.stringify(response.map((name) => ({ name: `${name}.sh`, type: 'file' }))), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(null, { status: response.status });
    }
    if (href.startsWith('https://api.github.com/repos/community-scripts/ProxmoxVED/contents/ct')) {
      return new Response(JSON.stringify(dev.map((name) => ({ name: `${name}.sh`, type: 'file' }))), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (href.startsWith('https://api.github.com/repos/community-scripts/ProxmoxVE/contents/ct')) {
      return new Response(JSON.stringify(stable.map((name) => ({ name: `${name}.sh`, type: 'file' }))), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
}

test('getScriptCatalog returns a custom group whose slugs come from the fixture, directories dropped', async () => {
  resetCatalogFetchState();
  const now = new Date('2026-09-24T00:00:00.000Z');
  const result = await getScriptCatalog(tempDbPath(), buildFetch(), now, withCustomSource(baseInventory()));
  assert.ok(result.custom, 'expected a custom group');
  assert.equal(result.custom?.label, CUSTOM_LABEL);
  assert.deepEqual(result.custom?.slugs, CUSTOM_SLUGS);
});

test('getScriptCatalog removes a custom-group slug from stable and records the shadow', async () => {
  resetCatalogFetchState();
  const now = new Date('2026-09-24T00:00:00.000Z');
  // 'aliasvault' is one of the fixture's .sh files -- seed it into the
  // upstream stable listing too so it shadows ProxmoxVE.
  const result = await getScriptCatalog(
    tempDbPath(),
    buildFetch({ stable: ['plex', 'aliasvault'] }),
    now,
    withCustomSource(baseInventory())
  );
  assert.ok(!result.stable.includes('aliasvault'), 'expected aliasvault to be removed from stable');
  assert.deepEqual(result.custom?.shadows.aliasvault, ['ProxmoxVE']);
});

test('getScriptCatalog does not refetch the custom listing again within 5 minutes', async () => {
  resetCatalogFetchState();
  const dbPath = tempDbPath();
  const inv = withCustomSource(baseInventory());
  const now = new Date('2026-09-24T00:00:00.000Z');
  let customCalls = 0;
  const fetchImpl = buildFetch({
    onCustomCall: () => {
      customCalls += 1;
    },
  });

  await getScriptCatalog(dbPath, fetchImpl, now, inv);
  assert.equal(customCalls, 1);
  await getScriptCatalog(dbPath, fetchImpl, new Date(now.getTime() + CUSTOM_CATALOG_MAX_AGE_MS - 1000), inv);
  assert.equal(customCalls, 1);
});

test('getScriptCatalog refetches the custom listing once 5 minutes pass', async () => {
  resetCatalogFetchState();
  const dbPath = tempDbPath();
  const inv = withCustomSource(baseInventory());
  const now = new Date('2026-09-24T00:00:00.000Z');
  let customCalls = 0;
  const fetchImpl = buildFetch({
    onCustomCall: () => {
      customCalls += 1;
    },
  });

  await getScriptCatalog(dbPath, fetchImpl, now, inv);
  await getScriptCatalog(dbPath, fetchImpl, new Date(now.getTime() + CUSTOM_CATALOG_MAX_AGE_MS + 1000), inv);
  assert.equal(customCalls, 2);
});

test('getScriptCatalog fetches again under a new cache key when the branch setting changes', async () => {
  resetCatalogFetchState();
  const dbPath = tempDbPath();
  const now = new Date('2026-09-24T00:00:00.000Z');
  let customCalls = 0;
  const fetchImpl = buildFetch({
    onCustomCall: () => {
      customCalls += 1;
    },
  });

  await getScriptCatalog(dbPath, fetchImpl, now, withCustomSource(baseInventory(), CUSTOM_BRANCH));
  assert.equal(customCalls, 1);
  // Same `now` (well within the 5-minute TTL of the first fetch) but a
  // different branch -- must not be served from the my-apps cache entry.
  await getScriptCatalog(dbPath, fetchImpl, now, withCustomSource(baseInventory(), 'other-branch'));
  assert.equal(customCalls, 2);
});

test('a custom listing failure returns the upstream groups unchanged, omits custom, and logs a warning', async () => {
  resetCatalogFetchState();
  // logWarn (src/lib/log.ts) writes through console.error, not console.warn.
  const originalError = console.error;
  const warnings: string[] = [];
  console.error = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  try {
    const now = new Date('2026-09-24T00:00:00.000Z');
    const result = await getScriptCatalog(
      tempDbPath(),
      buildFetch({ stable: ['plex'], customResponse: 'error' }),
      now,
      withCustomSource(baseInventory())
    );
    assert.equal(result.custom, undefined);
    assert.deepEqual(result.stable, ['plex']);
    assert.ok(
      warnings.some((w) => w.includes(CUSTOM_LABEL)),
      `expected a warning naming ${CUSTOM_LABEL}, got: ${JSON.stringify(warnings)}`
    );
  } finally {
    console.error = originalError;
  }
});

test('half-configured custom settings omit the group without throwing', async () => {
  resetCatalogFetchState();
  const originalError = console.error;
  const warnings: string[] = [];
  console.error = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  try {
    const now = new Date('2026-09-24T00:00:00.000Z');
    // customScriptsBranch is deliberately left unset -- customScriptSource
    // throws its both-or-neither error, which getCustomGroup must catch.
    const inv: Inventory = { ...baseInventory(), customScriptsRepo: `${CUSTOM_OWNER}/${CUSTOM_REPO}` };
    const result = await getScriptCatalog(tempDbPath(), buildFetch({ stable: ['plex'] }), now, inv);
    assert.equal(result.custom, undefined);
    assert.deepEqual(result.stable, ['plex']);
    assert.ok(warnings.length > 0, 'expected a warning to be logged');
  } finally {
    console.error = originalError;
  }
});

test('getScriptCatalog makes no custom fetch when the feature is off', async () => {
  resetCatalogFetchState();
  const now = new Date('2026-09-24T00:00:00.000Z');
  let customCalls = 0;
  const fetchImpl = buildFetch({
    onCustomCall: () => {
      customCalls += 1;
    },
  });
  const result = await getScriptCatalog(tempDbPath(), fetchImpl, now, baseInventory());
  assert.equal(customCalls, 0);
  assert.equal(result.custom, undefined);
});

test('getScriptCatalog makes no custom fetch when no inventory is passed at all', async () => {
  resetCatalogFetchState();
  const now = new Date('2026-09-24T00:00:00.000Z');
  let customCalls = 0;
  const fetchImpl = buildFetch({
    onCustomCall: () => {
      customCalls += 1;
    },
  });
  const result = await getScriptCatalog(tempDbPath(), fetchImpl, now);
  assert.equal(customCalls, 0);
  assert.equal(result.custom, undefined);
});
