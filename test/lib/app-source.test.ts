import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  customScriptSource,
  resolveHeadSha,
  resolveAppSource,
  formatSourceNotice,
  compareBranch,
  detectConflict,
  type BranchComparison,
  changedSlugsFromFiles,
  UPSTREAM_STABLE_BASE,
  UPSTREAM_DEV_BASE,
  type CustomScriptSource,
  type AppSource,
} from '../../src/lib/app-source.ts';
import type { Inventory } from '../../src/lib/inventory.ts';

const fixtureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'github');
function fixtureText(name: string): string {
  return readFileSync(path.join(fixtureDir, name), 'utf8');
}

const HEAD_SHA_RAW = fixtureText('branch-head-sha.txt');
const SHA = HEAD_SHA_RAW.trim();
const MISSING_BRANCH_BODY = fixtureText('branch-head-missing-branch-422.json');
const MISSING_REPO_BODY = fixtureText('branch-head-missing-repo-404.json');
// Captured compare responses (redacted, research R1/R5): 8 ahead / 0 behind
// changing demo-shop, demo-shop-storefront, demo-books; and 1 ahead / 251
// behind adding demo-wiki.
const COMPARE_AHEAD_BODY = fixtureText('compare-ahead-3-apps.json');
const COMPARE_DIVERGED_BODY = fixtureText('compare-diverged-conflict.json');
const AHEAD_MERGE_BASE = (JSON.parse(COMPARE_AHEAD_BODY) as { merge_base_commit: { sha: string } }).merge_base_commit.sha;
const AHEAD_CHANGED = ['demo-books', 'demo-shop', 'demo-shop-storefront'];
const DIVERGED_MERGE_BASE = (JSON.parse(COMPARE_DIVERGED_BODY) as { merge_base_commit: { sha: string } }).merge_base_commit
  .sha;
// research R5: the conflict check reads upstream ProxmoxVED's two scripts
// for an app at the merge base and on main, through raw content.
const VED_RAW = (ref: string, file: string) => `https://raw.githubusercontent.com/community-scripts/ProxmoxVED/${ref}/${file}`;
const CT_FILE = (slug: string) => `ct/${slug}.sh`;
const INSTALL_FILE = (slug: string) => `install/${slug}-install.sh`;

const BASE_INVENTORY: Inventory = {
  domain: 'example.com',
  hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
  guests: [],
};

// Example values only (constitution Principle I) -- example-user/ProxmoxVED
// on branch my-apps is the same example the spec/plan/data-model use.
const SOURCE: CustomScriptSource = {
  owner: 'example-user',
  repo: 'ProxmoxVED',
  branch: 'my-apps',
  label: 'example-user/ProxmoxVED@my-apps',
};

function withCustomSource(repo = 'example-user/ProxmoxVED', branch = 'my-apps'): Inventory {
  return { ...BASE_INVENTORY, customScriptsRepo: repo, customScriptsBranch: branch };
}

const HEAD_SHA_URL = `https://api.github.com/repos/${SOURCE.owner}/${SOURCE.repo}/commits/${encodeURIComponent(SOURCE.branch)}`;
const CT_URL = (slug: string) => `https://raw.githubusercontent.com/${SOURCE.owner}/${SOURCE.repo}/${SHA}/ct/${slug}.sh`;
const SCRIPTS_BASE_URL = `https://raw.githubusercontent.com/${SOURCE.owner}/${SOURCE.repo}/${SHA}`;
const SHADOW_URL = (base: string, slug: string) => `${base}/ct/${slug}.sh`;

type Handler = () => Response;

// A fetch stub keyed by exact URL -- an unrouted URL throws loudly rather
// than hanging or silently 404ing, so a test that expects "no fetch calls
// for this URL" fails immediately instead of masking a bug.
function fakeFetch(routes: Record<string, Handler>): typeof fetch {
  return (async (url: unknown) => {
    const href = String(url);
    const handler = routes[href];
    if (!handler) throw new Error(`unexpected fetch: ${href}`);
    return handler();
  }) as unknown as typeof fetch;
}

// Fails any test that reaches the network at all -- used for the
// feature-off/half-config/URL-passthrough cases, which the brief requires
// to make no fetch calls whatsoever.
const throwingFetch: typeof fetch = (async () => {
  throw new Error('resolveAppSource should not have called fetch here');
}) as unknown as typeof fetch;

const COMPARE_URL = `https://api.github.com/repos/community-scripts/ProxmoxVED/compare/main...${SOURCE.owner}:${SOURCE.repo}:${SHA}`;

type Probe = 200 | 404 | 500 | 'throw';

function probeResponse(probe: Probe): Response {
  if (probe === 'throw') throw new Error('ETIMEDOUT');
  return probe === 200 ? new Response('#!/usr/bin/env bash\n', { status: 200 }) : new Response(null, { status: probe });
}

// Routes a full custom-repository resolution (issue #15, research R6): the
// head-SHA pin, the compare call (default: the captured ahead fixture,
// changing demo-shop/demo-shop-storefront/demo-books), both upstream ct/
// probes (default 404), and -- only when `fork` is given -- the fork's own
// ct/<slug>.sh at the pinned commit. Leaving `fork` unset means the test
// asserts that probe is never made: fakeFetch throws on an unrouted URL.
function customFetch(
  slug: string,
  opts: { stable?: Probe; dev?: Probe; fork?: Probe; compareBody?: string; extra?: Record<string, Handler> } = {}
): typeof fetch {
  const routes: Record<string, Handler> = {
    [HEAD_SHA_URL]: () => new Response(HEAD_SHA_RAW, { status: 200 }),
    [COMPARE_URL]: () => new Response(opts.compareBody ?? COMPARE_AHEAD_BODY, { status: 200 }),
    [SHADOW_URL(UPSTREAM_STABLE_BASE, slug)]: () => probeResponse(opts.stable ?? 404),
    [SHADOW_URL(UPSTREAM_DEV_BASE, slug)]: () => probeResponse(opts.dev ?? 404),
  };
  Object.assign(routes, opts.extra);
  const fork = opts.fork;
  if (fork !== undefined) routes[CT_URL(slug)] = () => probeResponse(fork);
  return fakeFetch(routes);
}

async function captureWarnings<T>(fn: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {
  const originalError = console.error;
  const warnings: string[] = [];
  // logWarn (src/lib/log.ts) writes through console.error, not console.warn.
  console.error = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  try {
    return { result: await fn(), warnings };
  } finally {
    console.error = originalError;
  }
}

// --- customScriptSource ---

test('customScriptSource returns undefined when both settings are unset', () => {
  assert.equal(customScriptSource(BASE_INVENTORY), undefined);
});

test('customScriptSource returns the split/derived source when both settings are set', () => {
  assert.deepEqual(customScriptSource(withCustomSource()), SOURCE);
});

test('customScriptSource throws naming the missing setting when only customScriptsRepo is set', () => {
  const inv: Inventory = { ...BASE_INVENTORY, customScriptsRepo: 'example-user/ProxmoxVED' };
  assert.throws(
    () => customScriptSource(inv),
    /customScriptsBranch is not set \(customScriptsRepo is\); set it with "bellhop set-config customScriptsBranch <value> --apply" or on the Settings page, or unset customScriptsRepo/
  );
});

test('customScriptSource throws naming the missing setting when only customScriptsBranch is set', () => {
  const inv: Inventory = { ...BASE_INVENTORY, customScriptsBranch: 'my-apps' };
  assert.throws(
    () => customScriptSource(inv),
    /customScriptsRepo is not set \(customScriptsBranch is\); set it with "bellhop set-config customScriptsRepo <value> --apply" or on the Settings page, or unset customScriptsBranch/
  );
});

// --- resolveHeadSha ---

test('resolveHeadSha returns the trimmed head SHA on success', async () => {
  const sha = await resolveHeadSha(SOURCE, fakeFetch({ [HEAD_SHA_URL]: () => new Response(HEAD_SHA_RAW, { status: 200 }) }));
  assert.equal(sha, SHA);
});

test('resolveHeadSha sends User-Agent/Accept headers and URL-encodes a branch containing "/"', async () => {
  const branchSource: CustomScriptSource = {
    owner: 'example-user',
    repo: 'ProxmoxVED',
    branch: 'feature/my-apps',
    label: 'example-user/ProxmoxVED@feature/my-apps',
  };
  let seenUrl = '';
  let seenHeaders: Record<string, string> = {};
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    seenUrl = String(url);
    seenHeaders = (init?.headers ?? {}) as Record<string, string>;
    return new Response(HEAD_SHA_RAW, { status: 200 });
  }) as unknown as typeof fetch;

  await resolveHeadSha(branchSource, fetchImpl);

  assert.equal(seenUrl, 'https://api.github.com/repos/example-user/ProxmoxVED/commits/feature%2Fmy-apps');
  assert.equal(seenHeaders['User-Agent'], 'bellhop');
  assert.equal(seenHeaders.Accept, 'application/vnd.github.sha');
});

test('resolveHeadSha throws a "branch not found" error on 422', async () => {
  await assert.rejects(
    () => resolveHeadSha(SOURCE, fakeFetch({ [HEAD_SHA_URL]: () => new Response(MISSING_BRANCH_BODY, { status: 422 }) })),
    /Custom script repository example-user\/ProxmoxVED@my-apps: branch not found -- check customScriptsRepo\/customScriptsBranch with "bellhop set-config"/
  );
});

test('resolveHeadSha throws a "repository not found or not public" error on 404', async () => {
  await assert.rejects(
    () => resolveHeadSha(SOURCE, fakeFetch({ [HEAD_SHA_URL]: () => new Response(MISSING_REPO_BODY, { status: 404 }) })),
    /repository not found or not public/
  );
});

test('resolveHeadSha throws naming the status on any other non-OK response', async () => {
  await assert.rejects(
    () => resolveHeadSha(SOURCE, fakeFetch({ [HEAD_SHA_URL]: () => new Response('rate limited', { status: 403 }) })),
    /GitHub returned 403/
  );
});

test('resolveHeadSha throws "could not reach GitHub" when the fetch itself throws', async () => {
  const fetchImpl = (async () => {
    throw new Error('ENOTFOUND api.github.com');
  }) as unknown as typeof fetch;
  await assert.rejects(() => resolveHeadSha(SOURCE, fetchImpl), /could not reach GitHub \(ENOTFOUND api\.github\.com\)/);
});

test('resolveHeadSha throws "unexpected response" when the body is not a 40-hex SHA', async () => {
  await assert.rejects(
    () => resolveHeadSha(SOURCE, fakeFetch({ [HEAD_SHA_URL]: () => new Response('not-a-sha', { status: 200 }) })),
    /unexpected response/
  );
});

// Item 8 of the final fix wave: response.text() must be read while the same
// timeout/AbortController that guards the fetch() call is still active, so a
// stalled body read is bounded by GITHUB_FETCH_TIMEOUT_MS the same as a
// stalled connection. Before the fix, text() ran after fetchWithTimeout's own
// try/finally had already returned (and cleared the timeout), so an error
// thrown from text() propagated raw -- this simulates that failure directly
// (rather than waiting out a real 5s timeout) and asserts it gets the same
// "could not reach GitHub" wrapping a fetch()-level failure gets.
test('resolveHeadSha wraps a failure from reading the response body the same as a failed fetch (item 8)', async () => {
  const fetchImpl = (async () => ({
    ok: true,
    status: 200,
    text: () => {
      throw new Error('aborted');
    },
  })) as unknown as typeof fetch;
  await assert.rejects(() => resolveHeadSha(SOURCE, fetchImpl), /could not reach GitHub \(aborted\)/);
});

// --- changedSlugsFromFiles (research R3) ---

function fixtureFiles(body: string): { filename: string; previous_filename?: string; status: string }[] {
  return (JSON.parse(body) as { files: { filename: string; previous_filename?: string; status: string }[] }).files;
}

test('changedSlugsFromFiles yields exactly the three changed apps from the ahead fixture', () => {
  assert.deepEqual([...changedSlugsFromFiles(fixtureFiles(COMPARE_AHEAD_BODY))].sort(), AHEAD_CHANGED);
});

test('changedSlugsFromFiles ignores json/ and other non-script files', () => {
  const files = [
    { filename: 'json/demo-notes.json', status: 'modified' },
    { filename: 'misc/build.func', status: 'modified' },
    { filename: 'ct/headers/demo-notes', status: 'added' },
  ];
  assert.deepEqual([...changedSlugsFromFiles(files)], []);
});

test('changedSlugsFromFiles does not count a removed script', () => {
  assert.deepEqual([...changedSlugsFromFiles([{ filename: 'ct/demo-notes.sh', status: 'removed' }])], []);
});

test('changedSlugsFromFiles counts both names of a renamed script', () => {
  const files = [{ filename: 'ct/demo-new.sh', previous_filename: 'ct/demo-old.sh', status: 'renamed' }];
  assert.deepEqual([...changedSlugsFromFiles(files)].sort(), ['demo-new', 'demo-old']);
});

test('changedSlugsFromFiles counts an install-script-only change', () => {
  assert.deepEqual([...changedSlugsFromFiles([{ filename: 'install/demo-notes-install.sh', status: 'modified' }])], [
    'demo-notes',
  ]);
});

// --- compareBranch (contracts/interfaces.md) ---

const COMPARE_ERROR_SUFFIX = ' -- check customScriptsRepo/customScriptsBranch with "bellhop set-config"';

function compareFetch(handler: Handler): typeof fetch {
  return fakeFetch({ [COMPARE_URL]: handler });
}

test('compareBranch requests the pinned three-dot compare URL with a bellhop User-Agent', async () => {
  let seenUrl = '';
  let seenHeaders: Record<string, string> = {};
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    seenUrl = String(url);
    seenHeaders = (init?.headers ?? {}) as Record<string, string>;
    return new Response(COMPARE_AHEAD_BODY, { status: 200 });
  }) as unknown as typeof fetch;
  await compareBranch(SOURCE, SHA, fetchImpl);
  assert.equal(seenUrl, COMPARE_URL);
  assert.equal(seenHeaders['User-Agent'], 'bellhop');
});

test('compareBranch parses the ahead fixture', async () => {
  const result = await compareBranch(SOURCE, SHA, compareFetch(() => new Response(COMPARE_AHEAD_BODY, { status: 200 })));
  assert.equal(result.sha, SHA);
  assert.equal(result.mergeBase, AHEAD_MERGE_BASE);
  assert.equal(result.aheadBy, 8);
  assert.equal(result.behindBy, 0);
  assert.deepEqual([...result.changedSlugs].sort(), AHEAD_CHANGED);
});

test('compareBranch parses the diverged fixture', async () => {
  const result = await compareBranch(SOURCE, SHA, compareFetch(() => new Response(COMPARE_DIVERGED_BODY, { status: 200 })));
  assert.equal(result.aheadBy, 1);
  assert.equal(result.behindBy, 251);
  assert.deepEqual([...result.changedSlugs], ['demo-wiki']);
});

function assertCompareError(pattern: string) {
  return (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.ok(err.message.startsWith(`Custom script repository ${SOURCE.label}: `), err.message);
    assert.ok(err.message.includes(pattern), `expected "${pattern}" in: ${err.message}`);
    assert.ok(err.message.endsWith(COMPARE_ERROR_SUFFIX), err.message);
    return true;
  };
}

test('compareBranch names the fork network on 404', async () => {
  await assert.rejects(
    () => compareBranch(SOURCE, SHA, compareFetch(() => new Response('{"message":"Not Found"}', { status: 404 }))),
    assertCompareError(`commit ${SHA.slice(0, 7)} not found in community-scripts/ProxmoxVED's fork network`)
  );
});

for (const status of [403, 429]) {
  test(`compareBranch reports a rate limit on ${status}`, async () => {
    await assert.rejects(
      () => compareBranch(SOURCE, SHA, compareFetch(() => new Response('{}', { status }))),
      assertCompareError('rate limit')
    );
  });
}

test('compareBranch names any other non-OK status', async () => {
  await assert.rejects(
    () => compareBranch(SOURCE, SHA, compareFetch(() => new Response('oops', { status: 500 }))),
    assertCompareError('GitHub returned 500')
  );
});

test('compareBranch reports "could not reach GitHub" when the fetch throws', async () => {
  const fetchImpl = (async () => {
    throw new Error('ENOTFOUND api.github.com');
  }) as unknown as typeof fetch;
  await assert.rejects(() => compareBranch(SOURCE, SHA, fetchImpl), assertCompareError('could not reach GitHub (ENOTFOUND'));
});

test('compareBranch reports "could not reach GitHub" when reading the body fails', async () => {
  const fetchImpl = (async () => ({
    ok: true,
    status: 200,
    text: () => {
      throw new Error('aborted');
    },
  })) as unknown as typeof fetch;
  await assert.rejects(() => compareBranch(SOURCE, SHA, fetchImpl), assertCompareError('could not reach GitHub (aborted)'));
});

test('compareBranch rejects a response missing merge_base_commit', async () => {
  const body = JSON.parse(COMPARE_AHEAD_BODY) as Record<string, unknown>;
  delete body.merge_base_commit;
  await assert.rejects(
    () => compareBranch(SOURCE, SHA, compareFetch(() => new Response(JSON.stringify(body), { status: 200 }))),
    assertCompareError('unexpected compare response')
  );
});

test('compareBranch rejects a non-JSON body as an unexpected compare response', async () => {
  await assert.rejects(
    () => compareBranch(SOURCE, SHA, compareFetch(() => new Response('<html>', { status: 200 }))),
    assertCompareError('unexpected compare response')
  );
});

test('compareBranch refuses a file list at the 300-file cap', async () => {
  const body = JSON.parse(COMPARE_AHEAD_BODY) as { files: unknown[] };
  const template = body.files[body.files.length - 1];
  while (body.files.length < 300) body.files.push(template);
  await assert.rejects(
    () => compareBranch(SOURCE, SHA, compareFetch(() => new Response(JSON.stringify(body), { status: 200 }))),
    assertCompareError('300 or more files')
  );
});

// --- detectConflict (research R5) ---

// Values from the captured diverged fixture (1 ahead / 251 behind, adds
// demo-wiki, which upstream added too after the branch point).
const DIVERGED: BranchComparison = {
  sha: SHA,
  mergeBase: DIVERGED_MERGE_BASE,
  aheadBy: 1,
  behindBy: 251,
  changedSlugs: new Set(['demo-wiki']),
};

type RawSide = 404 | 500 | 'throw' | string;

function rawResponse(side: RawSide): Response {
  if (side === 'throw') throw new Error('ECONNRESET');
  if (typeof side === 'number') return new Response(null, { status: side });
  return new Response(side, { status: 200 });
}

// Routes the four raw reads for one slug; records every URL requested.
function conflictFetch(
  slug: string,
  sides: { baseCt: RawSide; baseInstall: RawSide; mainCt: RawSide; mainInstall: RawSide }
): { fetchImpl: typeof fetch; seen: string[] } {
  const seen: string[] = [];
  const routes: Record<string, Handler> = {
    [VED_RAW(DIVERGED_MERGE_BASE, CT_FILE(slug))]: () => rawResponse(sides.baseCt),
    [VED_RAW(DIVERGED_MERGE_BASE, INSTALL_FILE(slug))]: () => rawResponse(sides.baseInstall),
    [VED_RAW('main', CT_FILE(slug))]: () => rawResponse(sides.mainCt),
    [VED_RAW('main', INSTALL_FILE(slug))]: () => rawResponse(sides.mainInstall),
  };
  const inner = fakeFetch(routes);
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    seen.push(String(url));
    return inner(url as string, init);
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

test('detectConflict returns false without fetching when the branch is not behind', async () => {
  const ahead: BranchComparison = { ...DIVERGED, behindBy: 0 };
  assert.equal(await detectConflict('demo-wiki', ahead, throwingFetch), false);
});

test('detectConflict reads both scripts at the merge base and on main, and flags 404-vs-200 as a conflict', async () => {
  const { fetchImpl, seen } = conflictFetch('demo-wiki', {
    baseCt: 404,
    baseInstall: 404,
    mainCt: '#!/usr/bin/env bash\n# upstream demo-wiki\n',
    mainInstall: '#!/usr/bin/env bash\n# upstream demo-wiki install\n',
  });
  assert.equal(await detectConflict('demo-wiki', DIVERGED, fetchImpl), true);
  assert.deepEqual(seen.sort(), [
    VED_RAW(DIVERGED_MERGE_BASE, CT_FILE('demo-wiki')),
    VED_RAW(DIVERGED_MERGE_BASE, INSTALL_FILE('demo-wiki')),
    VED_RAW('main', CT_FILE('demo-wiki')),
    VED_RAW('main', INSTALL_FILE('demo-wiki')),
  ].sort());
});

test('detectConflict returns false when both scripts are identical on both sides', async () => {
  const { fetchImpl } = conflictFetch('demo-wiki', {
    baseCt: 'ct body\n',
    baseInstall: 'install body\n',
    mainCt: 'ct body\n',
    mainInstall: 'install body\n',
  });
  assert.equal(await detectConflict('demo-wiki', DIVERGED, fetchImpl), false);
});

test('detectConflict returns false when both scripts are absent on both sides', async () => {
  const { fetchImpl } = conflictFetch('demo-wiki', { baseCt: 404, baseInstall: 404, mainCt: 404, mainInstall: 404 });
  assert.equal(await detectConflict('demo-wiki', DIVERGED, fetchImpl), false);
});

test('detectConflict flags a difference in only the install script', async () => {
  const { fetchImpl } = conflictFetch('demo-wiki', {
    baseCt: 'ct body\n',
    baseInstall: 'install body v1\n',
    mainCt: 'ct body\n',
    mainInstall: 'install body v2\n',
  });
  assert.equal(await detectConflict('demo-wiki', DIVERGED, fetchImpl), true);
});

for (const failure of ['throw', 500] as const) {
  test(`detectConflict treats a ${failure === 'throw' ? 'thrown fetch' : 'server error'} as no conflict and logs one warning`, async () => {
    const { fetchImpl } = conflictFetch('demo-wiki', {
      baseCt: failure,
      baseInstall: failure,
      mainCt: 'ct body\n',
      mainInstall: 'install body\n',
    });
    const { result, warnings } = await captureWarnings(() => detectConflict('demo-wiki', DIVERGED, fetchImpl));
    assert.equal(result, false);
    assert.equal(warnings.length, 1, JSON.stringify(warnings));
    assert.ok(warnings[0].includes('demo-wiki'), warnings[0]);
  });
}

// --- resolveAppSource ---

test('resolveAppSource makes no fetch calls when the feature is off', async () => {
  const result = await resolveAppSource('plex', BASE_INVENTORY, throwingFetch);
  assert.deepEqual(result, { kind: 'upstream', slug: 'plex', shadows: [] });
});

test('resolveAppSource throws the both-or-neither message on half-config, with no fetch call', async () => {
  const inv: Inventory = { ...BASE_INVENTORY, customScriptsRepo: 'example-user/ProxmoxVED' };
  await assert.rejects(() => resolveAppSource('plex', inv, throwingFetch), /customScriptsBranch is not set \(customScriptsRepo is\)/);
});

test('resolveAppSource passes a full URL through verbatim with no network access', async () => {
  const result = await resolveAppSource('https://example.com/install.sh', withCustomSource(), throwingFetch);
  assert.deepEqual(result, { kind: 'url', shadows: [] });
});

test('resolveAppSource lowercases a mixed-case bare slug', async () => {
  const result = await resolveAppSource('Plex', BASE_INVENTORY, throwingFetch);
  assert.equal(result.slug, 'plex');
});

// (a) research R6: a slug the branch changes resolves to the fork at the
// pinned commit without probing the fork's ct/ script at all.
test('resolveAppSource resolves a changed slug to the fork at the pinned commit', async () => {
  const result = await resolveAppSource('demo-shop', withCustomSource(), customFetch('demo-shop'));
  assert.deepEqual(result, {
    kind: 'custom',
    slug: 'demo-shop',
    custom: { ...SOURCE, sha: SHA, mergeBase: AHEAD_MERGE_BASE },
    ctUrl: CT_URL('demo-shop'),
    scriptsBaseUrl: SCRIPTS_BASE_URL,
    shadows: [],
    changed: true,
    conflict: false,
  });
});

test('resolveAppSource matches a mixed-case changed slug', async () => {
  const result = await resolveAppSource('Demo-Books', withCustomSource(), customFetch('demo-books'));
  assert.equal(result.kind, 'custom');
  assert.equal(result.changed, true);
});

// (i) a changed slug that also exists upstream reports what it overrides.
test('resolveAppSource reports a changed slug shadowing ProxmoxVE only', async () => {
  const result = await resolveAppSource('demo-shop', withCustomSource(), customFetch('demo-shop', { stable: 200 }));
  assert.equal(result.kind, 'custom');
  assert.deepEqual(result.shadows, ['ProxmoxVE']);
});

test('resolveAppSource reports a changed slug shadowing ProxmoxVED only', async () => {
  const result = await resolveAppSource('demo-shop', withCustomSource(), customFetch('demo-shop', { dev: 200 }));
  assert.equal(result.kind, 'custom');
  assert.deepEqual(result.shadows, ['ProxmoxVED']);
});

test('resolveAppSource reports a changed slug shadowing both upstream repos', async () => {
  const result = await resolveAppSource(
    'demo-shop',
    withCustomSource(),
    customFetch('demo-shop', { stable: 200, dev: 200 })
  );
  assert.equal(result.kind, 'custom');
  assert.deepEqual(result.shadows, ['ProxmoxVE', 'ProxmoxVED']);
});

test('resolveAppSource treats a thrown shadow probe for a changed slug as absent and logs a warning', async () => {
  const { result, warnings } = await captureWarnings(() =>
    resolveAppSource('demo-shop', withCustomSource(), customFetch('demo-shop', { stable: 'throw' }))
  );
  assert.equal(result.kind, 'custom');
  assert.deepEqual(result.shadows, []);
  assert.ok(
    warnings.some((w) => w.includes('ProxmoxVE') && w.includes('demo-shop') && w.includes('ETIMEDOUT')),
    `expected a shadow-probe warning naming ProxmoxVE/demo-shop/ETIMEDOUT, got: ${JSON.stringify(warnings)}`
  );
});

// (b) an unchanged slug upstream has resolves exactly as with the feature
// off, and the fork is never probed (no fork route: fakeFetch would throw).
const UPSTREAM_PRESENCE: [string, { stable?: Probe; dev?: Probe }][] = [
  ['ProxmoxVE', { stable: 200 }],
  ['ProxmoxVED', { dev: 200 }],
  ['both upstream repos', { stable: 200, dev: 200 }],
];
for (const [label, opts] of UPSTREAM_PRESENCE) {
  test(`resolveAppSource resolves an unchanged slug present in ${label} to upstream`, async () => {
    const result = await resolveAppSource('plex', withCustomSource(), customFetch('plex', opts));
    assert.deepEqual(result, { kind: 'upstream', slug: 'plex', shadows: [] });
  });
}

// (c) when an upstream probe can't tell, prefer upstream over a possibly
// stale inherited fork copy.
test('resolveAppSource resolves an unchanged slug to upstream when an upstream probe throws', async () => {
  const { result } = await captureWarnings(() =>
    resolveAppSource('plex', withCustomSource(), customFetch('plex', { stable: 'throw' }))
  );
  assert.deepEqual(result, { kind: 'upstream', slug: 'plex', shadows: [] });
});

test('resolveAppSource resolves an unchanged slug to upstream when an upstream probe returns a server error', async () => {
  const { result } = await captureWarnings(() =>
    resolveAppSource('plex', withCustomSource(), customFetch('plex', { dev: 500 }))
  );
  assert.deepEqual(result, { kind: 'upstream', slug: 'plex', shadows: [] });
});

// (d) fork-only: absent upstream, present in the fork at the pinned commit.
test('resolveAppSource resolves a fork-only unchanged slug to the fork with no shadows', async () => {
  const result = await resolveAppSource('demo-legacy', withCustomSource(), customFetch('demo-legacy', { fork: 200 }));
  assert.deepEqual(result, {
    kind: 'custom',
    slug: 'demo-legacy',
    custom: { ...SOURCE, sha: SHA, mergeBase: AHEAD_MERGE_BASE },
    ctUrl: CT_URL('demo-legacy'),
    scriptsBaseUrl: SCRIPTS_BASE_URL,
    shadows: [],
    changed: false,
    conflict: false,
  });
});

// (e) absent everywhere: upstream, so it fails later exactly as feature-off does.
test('resolveAppSource resolves a slug absent everywhere to upstream', async () => {
  const result = await resolveAppSource('nope', withCustomSource(), customFetch('nope', { fork: 404 }));
  assert.deepEqual(result, { kind: 'upstream', slug: 'nope', shadows: [] });
});

// (f) the fork probe failing any other way is a named error.
test('resolveAppSource throws when the fork ct probe returns a non-404 non-OK status', async () => {
  await assert.rejects(
    () => resolveAppSource('demo-legacy', withCustomSource(), customFetch('demo-legacy', { fork: 500 })),
    /Custom script repository example-user\/ProxmoxVED@my-apps: GitHub returned 500 -- check customScriptsRepo\/customScriptsBranch with "bellhop set-config"/
  );
});

test('resolveAppSource throws "could not reach GitHub" when the fork ct probe itself throws', async () => {
  await assert.rejects(
    () => resolveAppSource('demo-legacy', withCustomSource(), customFetch('demo-legacy', { fork: 'throw' })),
    /could not reach GitHub \(ETIMEDOUT\)/
  );
});

// (g) a compare failure is a named error, never a fallback to upstream.
test('resolveAppSource throws a named error when the compare call fails, never falling back to upstream', async () => {
  await assert.rejects(
    () =>
      resolveAppSource(
        'plex',
        withCustomSource(),
        fakeFetch({
          [HEAD_SHA_URL]: () => new Response(HEAD_SHA_RAW, { status: 200 }),
          [COMPARE_URL]: () => new Response('{"message":"Not Found"}', { status: 404 }),
        })
      ),
    /Custom script repository example-user\/ProxmoxVED@my-apps: commit [0-9a-f]{7} not found in community-scripts\/ProxmoxVED's fork network.* -- check customScriptsRepo\/customScriptsBranch with "bellhop set-config"/
  );
});

// T011 (US2): the diverged fixture's demo-wiki was absent upstream at the
// merge base and is present on upstream main -- upstream added the same app
// after the branch point, which is a conflict. The upstream ProxmoxVED ct/
// probe and the conflict check's main-side ct/ read are the same URL.
test('resolveAppSource flags a conflict for a changed slug upstream also changed since the branch point', async () => {
  const result = await resolveAppSource(
    'demo-wiki',
    withCustomSource(),
    customFetch('demo-wiki', {
      compareBody: COMPARE_DIVERGED_BODY,
      dev: 200,
      extra: {
        [VED_RAW(DIVERGED_MERGE_BASE, CT_FILE('demo-wiki'))]: () => new Response(null, { status: 404 }),
        [VED_RAW(DIVERGED_MERGE_BASE, INSTALL_FILE('demo-wiki'))]: () => new Response(null, { status: 404 }),
        [VED_RAW('main', INSTALL_FILE('demo-wiki'))]: () => new Response('#!/usr/bin/env bash\n', { status: 200 }),
      },
    })
  );
  assert.equal(result.kind, 'custom');
  assert.equal(result.changed, true);
  assert.equal(result.conflict, true);
  assert.equal(result.custom?.mergeBase, DIVERGED_MERGE_BASE);
  assert.deepEqual(result.shadows, ['ProxmoxVED']);
});

test('resolveAppSource reports no conflict when upstream left a changed slug alone since the branch point', async () => {
  const same = () => new Response('#!/usr/bin/env bash\n', { status: 200 });
  const result = await resolveAppSource(
    'demo-wiki',
    withCustomSource(),
    customFetch('demo-wiki', {
      compareBody: COMPARE_DIVERGED_BODY,
      dev: 200,
      extra: {
        [VED_RAW(DIVERGED_MERGE_BASE, CT_FILE('demo-wiki'))]: same,
        [VED_RAW(DIVERGED_MERGE_BASE, INSTALL_FILE('demo-wiki'))]: same,
        [VED_RAW('main', INSTALL_FILE('demo-wiki'))]: same,
      },
    })
  );
  assert.equal(result.conflict, false);
});

// FR-008: an ahead-only branch (behind_by 0) never makes a conflict read --
// customFetch routes none of the raw conflict URLs, so any read would throw.
test('resolveAppSource makes no conflict reads when the branch is not behind', async () => {
  const { result, warnings } = await captureWarnings(() =>
    resolveAppSource('demo-shop', withCustomSource(), customFetch('demo-shop', { dev: 200 }))
  );
  assert.equal(result.conflict, false);
  assert.deepEqual(warnings, []);
});

// --- formatSourceNotice (research R7) ---

function customSource(overrides: Partial<AppSource> = {}): AppSource {
  return {
    kind: 'custom',
    slug: 'demo-wiki',
    custom: { ...SOURCE, sha: SHA, mergeBase: DIVERGED_MERGE_BASE },
    ctUrl: CT_URL('demo-wiki'),
    scriptsBaseUrl: SCRIPTS_BASE_URL,
    shadows: [],
    changed: true,
    conflict: false,
    ...overrides,
  };
}

test('formatSourceNotice warns to rebase when a changed app conflicts with upstream', () => {
  assert.deepEqual(formatSourceNotice(customSource({ conflict: true, shadows: ['ProxmoxVED'] })), {
    level: 'warn',
    message: `"demo-wiki" changed upstream in ProxmoxVED since example-user/ProxmoxVED@my-apps branched (merge base ${DIVERGED_MERGE_BASE.slice(0, 7)}); installing the custom copy at commit ${SHA.slice(0, 7)}. Rebase my-apps onto upstream main to pick up the upstream changes.`,
  });
});

test('formatSourceNotice gives one info line when a changed app replaces an upstream copy without conflicting', () => {
  assert.deepEqual(formatSourceNotice(customSource({ shadows: ['ProxmoxVE', 'ProxmoxVED'] })), {
    level: 'info',
    message: `"demo-wiki" is installing from the custom script repository example-user/ProxmoxVED@my-apps (commit ${SHA.slice(0, 7)}) in place of the upstream copy in ProxmoxVE, ProxmoxVED.`,
  });
});

test('formatSourceNotice says nothing for a changed app absent upstream, a fork-only app, an upstream or a url source', () => {
  assert.equal(formatSourceNotice(customSource()), undefined);
  assert.equal(formatSourceNotice(customSource({ changed: false })), undefined);
  assert.equal(formatSourceNotice({ kind: 'upstream', slug: 'plex', shadows: [] }), undefined);
  assert.equal(formatSourceNotice({ kind: 'url', shadows: [] }), undefined);
});
