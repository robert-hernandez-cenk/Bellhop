import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  customScriptSource,
  resolveHeadSha,
  resolveAppSource,
  formatOverrideWarning,
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

// Routes a full custom-repository resolution: head-SHA lookup, the custom
// ct/<slug>.sh script itself (always a hit), and both upstream shadow
// probes (each defaulting to "not present" -- a plain 404).
function customFetch(slug: string, opts: { shadowStable?: boolean; shadowDev?: boolean } = {}): typeof fetch {
  return fakeFetch({
    [HEAD_SHA_URL]: () => new Response(HEAD_SHA_RAW, { status: 200 }),
    [CT_URL(slug)]: () => new Response('#!/usr/bin/env bash\n', { status: 200 }),
    [SHADOW_URL(UPSTREAM_STABLE_BASE, slug)]: () =>
      opts.shadowStable ? new Response('#!/usr/bin/env bash\n', { status: 200 }) : new Response(null, { status: 404 }),
    [SHADOW_URL(UPSTREAM_DEV_BASE, slug)]: () =>
      opts.shadowDev ? new Response('#!/usr/bin/env bash\n', { status: 200 }) : new Response(null, { status: 404 }),
  });
}

// --- customScriptSource ---

test('customScriptSource returns undefined when both settings are unset', () => {
  assert.equal(customScriptSource(BASE_INVENTORY), undefined);
});

test('customScriptSource returns the split/derived source when both settings are set', () => {
  assert.deepEqual(customScriptSource(withCustomSource()), SOURCE);
});

test('customScriptSource throws when only customScriptsRepo is set', () => {
  const inv: Inventory = { ...BASE_INVENTORY, customScriptsRepo: 'example-user/ProxmoxVED' };
  assert.throws(
    () => customScriptSource(inv),
    /customScriptsRepo and customScriptsBranch must be set together; set the missing one with "bellhop set-config <key> <value> --apply" or on the Settings page/
  );
});

test('customScriptSource throws when only customScriptsBranch is set', () => {
  const inv: Inventory = { ...BASE_INVENTORY, customScriptsBranch: 'my-apps' };
  assert.throws(() => customScriptSource(inv), /must be set together/);
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

// --- resolveAppSource ---

test('resolveAppSource makes no fetch calls when the feature is off', async () => {
  const result = await resolveAppSource('plex', BASE_INVENTORY, throwingFetch);
  assert.deepEqual(result, { kind: 'upstream', slug: 'plex', shadows: [] });
});

test('resolveAppSource throws the both-or-neither message on half-config, with no fetch call', async () => {
  const inv: Inventory = { ...BASE_INVENTORY, customScriptsRepo: 'example-user/ProxmoxVED' };
  await assert.rejects(() => resolveAppSource('plex', inv, throwingFetch), /must be set together/);
});

test('resolveAppSource passes a full URL through verbatim with no network access', async () => {
  const result = await resolveAppSource('https://example.com/install.sh', withCustomSource(), throwingFetch);
  assert.deepEqual(result, { kind: 'url', shadows: [] });
});

test('resolveAppSource lowercases a mixed-case bare slug', async () => {
  const result = await resolveAppSource('Plex', BASE_INVENTORY, throwingFetch);
  assert.equal(result.slug, 'plex');
});

test('resolveAppSource returns a custom hit with no shadows', async () => {
  const result = await resolveAppSource('myapp', withCustomSource(), customFetch('myapp'));
  assert.equal(result.kind, 'custom');
  assert.equal(result.slug, 'myapp');
  assert.deepEqual(result.shadows, []);
  assert.deepEqual(result.custom, { ...SOURCE, sha: SHA });
  assert.equal(result.ctUrl, CT_URL('myapp'));
  assert.equal(result.scriptsBaseUrl, SCRIPTS_BASE_URL);
});

test('resolveAppSource reports a shadow of ProxmoxVE only', async () => {
  const result = await resolveAppSource('myapp', withCustomSource(), customFetch('myapp', { shadowStable: true }));
  assert.equal(result.kind, 'custom');
  assert.deepEqual(result.shadows, ['ProxmoxVE']);
});

test('resolveAppSource reports a shadow of ProxmoxVED only', async () => {
  const result = await resolveAppSource('myapp', withCustomSource(), customFetch('myapp', { shadowDev: true }));
  assert.equal(result.kind, 'custom');
  assert.deepEqual(result.shadows, ['ProxmoxVED']);
});

test('resolveAppSource reports shadows of both upstream repos', async () => {
  const result = await resolveAppSource(
    'myapp',
    withCustomSource(),
    customFetch('myapp', { shadowStable: true, shadowDev: true })
  );
  assert.equal(result.kind, 'custom');
  assert.deepEqual(result.shadows, ['ProxmoxVE', 'ProxmoxVED']);
});

test('resolveAppSource falls back to upstream when the custom ct script 404s', async () => {
  const result = await resolveAppSource(
    'myapp',
    withCustomSource(),
    fakeFetch({
      [HEAD_SHA_URL]: () => new Response(HEAD_SHA_RAW, { status: 200 }),
      [CT_URL('myapp')]: () => new Response(null, { status: 404 }),
    })
  );
  assert.deepEqual(result, { kind: 'upstream', slug: 'myapp', shadows: [] });
});

test('resolveAppSource throws when the custom ct fetch returns a non-404 non-OK status', async () => {
  await assert.rejects(
    () =>
      resolveAppSource(
        'myapp',
        withCustomSource(),
        fakeFetch({
          [HEAD_SHA_URL]: () => new Response(HEAD_SHA_RAW, { status: 200 }),
          [CT_URL('myapp')]: () => new Response('server error', { status: 500 }),
        })
      ),
    /Custom script repository example-user\/ProxmoxVED@my-apps: GitHub returned 500 -- check customScriptsRepo\/customScriptsBranch with "bellhop set-config"/
  );
});

test('resolveAppSource throws "could not reach GitHub" when the custom ct fetch itself throws', async () => {
  const fetchImpl = (async (url: unknown) => {
    const href = String(url);
    if (href === HEAD_SHA_URL) return new Response(HEAD_SHA_RAW, { status: 200 });
    throw new Error('ECONNRESET');
  }) as unknown as typeof fetch;
  await assert.rejects(
    () => resolveAppSource('myapp', withCustomSource(), fetchImpl),
    /could not reach GitHub \(ECONNRESET\)/
  );
});

test('resolveAppSource treats a thrown shadow probe as absent and logs a warning via logWarn', async () => {
  const originalError = console.error;
  const warnings: string[] = [];
  console.error = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  try {
    const fetchImpl = (async (url: unknown) => {
      const href = String(url);
      if (href === HEAD_SHA_URL) return new Response(HEAD_SHA_RAW, { status: 200 });
      if (href === CT_URL('myapp')) return new Response('#!/usr/bin/env bash\n', { status: 200 });
      if (href === SHADOW_URL(UPSTREAM_STABLE_BASE, 'myapp')) throw new Error('ETIMEDOUT');
      if (href === SHADOW_URL(UPSTREAM_DEV_BASE, 'myapp')) return new Response(null, { status: 404 });
      throw new Error(`unexpected fetch: ${href}`);
    }) as unknown as typeof fetch;

    const result = await resolveAppSource('myapp', withCustomSource(), fetchImpl);
    assert.deepEqual(result.shadows, []);
    assert.ok(
      // logWarn (src/lib/log.ts) writes through console.error, not console.warn.
      warnings.some((w) => w.includes('ProxmoxVE') && w.includes('myapp') && w.includes('ETIMEDOUT')),
      `expected a shadow-probe warning naming ProxmoxVE/myapp/ETIMEDOUT, got: ${JSON.stringify(warnings)}`
    );
  } finally {
    console.error = originalError;
  }
});

// --- formatOverrideWarning ---

test('formatOverrideWarning returns undefined for a non-custom source', () => {
  assert.equal(formatOverrideWarning({ kind: 'upstream', slug: 'myapp', shadows: [] }), undefined);
  assert.equal(formatOverrideWarning({ kind: 'url', shadows: [] }), undefined);
});

test('formatOverrideWarning returns undefined when shadows is empty', () => {
  const source: AppSource = {
    kind: 'custom',
    slug: 'myapp',
    custom: { ...SOURCE, sha: SHA },
    ctUrl: CT_URL('myapp'),
    scriptsBaseUrl: SCRIPTS_BASE_URL,
    shadows: [],
  };
  assert.equal(formatOverrideWarning(source), undefined);
});

test('formatOverrideWarning formats the exact research R6 text with a 7-character short SHA', () => {
  const source: AppSource = {
    kind: 'custom',
    slug: 'myapp',
    custom: { ...SOURCE, sha: SHA },
    ctUrl: CT_URL('myapp'),
    scriptsBaseUrl: SCRIPTS_BASE_URL,
    shadows: ['ProxmoxVE', 'ProxmoxVED'],
  };
  assert.equal(
    formatOverrideWarning(source),
    `"myapp" is installing from the custom script repository example-user/ProxmoxVED@my-apps (commit ${SHA.slice(0, 7)}), which overrides the upstream copy in ProxmoxVE, ProxmoxVED. Unset customScriptsRepo/customScriptsBranch with set-config to use upstream.`
  );
});
