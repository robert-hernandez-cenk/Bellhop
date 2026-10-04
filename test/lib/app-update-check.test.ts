import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  parseReleaseCheck,
  normalizeVersion,
  decideOutcome,
  fetchLatestRelease,
  createReleaseCache,
  buildInstalledVersionScript,
  GITHUB_RATE_LIMIT_MESSAGE,
  type ReleaseCheck,
} from '../../src/lib/app-update-check.ts';

function fixtureText(...parts: string[]): string {
  return readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', ...parts), 'utf8');
}

// Real upstream scripts (research R2/R12): homepage.sh has a plain,
// unpinned call; immich.sh pins through a `"${RELEASE}"` reference resolved
// from a literal `RELEASE="v3.2.4"` assignment earlier in the script.
const HOMEPAGE_SCRIPT = fixtureText('community-scripts', 'homepage.sh');
const IMMICH_SCRIPT = fixtureText('community-scripts', 'immich.sh');

// Real captured GitHub API responses (research R3/R12): chmln/sd's release
// list is small and has both a draft-free stable release (v1.1.0, the
// current /releases/latest) and several pre-releases.
const RELEASES_LATEST = fixtureText('github-releases', 'releases-latest.json');
const RELEASES_LIST = fixtureText('github-releases', 'releases-list.json');

type Handler = () => Response;

// Keyed by exact URL -- an unrouted URL throws loudly instead of hanging or
// silently 404ing, so a test asserting "this endpoint is never called"
// (e.g. /latest skipped when a prefix is set) fails immediately rather than
// masking a bug. Same convention as test/lib/app-source.test.ts.
function fakeFetch(routes: Record<string, Handler>): typeof fetch {
  return (async (url: unknown) => {
    const href = String(url);
    const handler = routes[href];
    if (!handler) throw new Error(`unexpected fetch: ${href}`);
    return handler();
  }) as unknown as typeof fetch;
}

// --- parseReleaseCheck ---

test('parseReleaseCheck finds a plain, unpinned call', () => {
  assert.deepEqual(parseReleaseCheck(HOMEPAGE_SCRIPT, 'homepage'), {
    ok: true,
    check: { name: 'homepage', repo: 'gethomepage/homepage' },
  });
});

test('parseReleaseCheck resolves a "${RELEASE}" pin from a literal RELEASE="..." assignment', () => {
  assert.deepEqual(parseReleaseCheck(IMMICH_SCRIPT, 'immich'), {
    ok: true,
    check: { name: 'immich', repo: 'immich-app/immich', pin: 'v3.2.4' },
  });
});

test('parseReleaseCheck finds a call sitting behind a [[ -d x ]] && if guard', () => {
  const script = `
if [[ -d /opt/myapp ]] && if check_for_gh_release "myapp" "owner/myapp"; then
  echo hi
fi
`;
  assert.deepEqual(parseReleaseCheck(script, 'myapp'), {
    ok: true,
    check: { name: 'myapp', repo: 'owner/myapp' },
  });
});

test('parseReleaseCheck stops at a trailing shell comment', () => {
  const script = `check_for_gh_release "foo" "owner/foo" # track stable\n`;
  assert.deepEqual(parseReleaseCheck(script, 'foo'), {
    ok: true,
    check: { name: 'foo', repo: 'owner/foo' },
  });
});

test('parseReleaseCheck keeps a # inside a bare word (not a comment in sh)', () => {
  const script = `check_for_gh_release foo owner/foo v1#2\n`;
  assert.deepEqual(parseReleaseCheck(script, 'foo'), {
    ok: true,
    check: { name: 'foo', repo: 'owner/foo', pin: 'v1#2' },
  });
});

test('parseReleaseCheck accepts single-quoted and bare arguments', () => {
  const script = `check_for_gh_release 'MyApp' owner/myapp; then`;
  assert.deepEqual(parseReleaseCheck(script, 'myapp'), {
    ok: true,
    check: { name: 'myapp', repo: 'owner/myapp' },
  });
});

test('parseReleaseCheck resolves "$VAR" from VAR="${VAR:-default}"', () => {
  const script = `
PANGOLIN_VERSION="\${PANGOLIN_VERSION:-1.23.0}"
if check_for_gh_release "Pangolin" "owner/pangolin" "$PANGOLIN_VERSION"; then
  true
fi
`;
  assert.deepEqual(parseReleaseCheck(script, 'pangolin'), {
    ok: true,
    check: { name: 'pangolin', repo: 'owner/pangolin', pin: '1.23.0' },
  });
});

test('parseReleaseCheck returns unsupported for an unresolvable variable pin', () => {
  const script = `check_for_gh_release "App" "owner/app" "$MISSING_VAR"`;
  const result = parseReleaseCheck(script, 'app');
  assert.equal(result.ok, false);
});

test('parseReleaseCheck returns unsupported when the name argument contains $', () => {
  const script = `check_for_gh_release "$APP_NAME" "owner/app"`;
  assert.equal(parseReleaseCheck(script, 'app').ok, false);
});

test('parseReleaseCheck returns unsupported when the repo argument contains $', () => {
  const script = `check_for_gh_release "App" "$REPO"`;
  assert.equal(parseReleaseCheck(script, 'app').ok, false);
});

test('parseReleaseCheck returns unsupported when the repo argument is not owner/repo shaped', () => {
  const script = `check_for_gh_release "App" "not-a-repo"`;
  assert.equal(parseReleaseCheck(script, 'app').ok, false);
});

test('parseReleaseCheck reports a named reason when there is no call at all', () => {
  assert.deepEqual(parseReleaseCheck('echo hello\n', 'noop'), {
    ok: false,
    reason: 'no check_for_gh_release call in ct/noop.sh',
  });
});

test('parseReleaseCheck reads a literal 5th-argument tag prefix, with an empty pin counting as no pin', () => {
  const script = `check_for_gh_release "App" "owner/app" "" "" "web-v"`;
  assert.deepEqual(parseReleaseCheck(script, 'app'), {
    ok: true,
    check: { name: 'app', repo: 'owner/app', prefix: 'web-v' },
  });
});

test('parseReleaseCheck returns unsupported when the 5th-argument tag prefix is a variable', () => {
  const script = `check_for_gh_release "App" "owner/app" "" "" "$PREFIX"`;
  assert.equal(parseReleaseCheck(script, 'app').ok, false);
});

test('parseReleaseCheck lowercases the name and removes spaces', () => {
  const script = `check_for_gh_release "My Cool App" "owner/app"`;
  assert.deepEqual(parseReleaseCheck(script, 'app'), {
    ok: true,
    check: { name: 'mycoolapp', repo: 'owner/app' },
  });
});

// --- normalizeVersion ---

test('normalizeVersion strips a leading v only when followed by a digit', () => {
  assert.equal(normalizeVersion('v1.2'), '1.2');
  assert.equal(normalizeVersion('vault-1'), 'vault-1');
});

// --- decideOutcome ---

test('decideOutcome: pinned install semantics are an inequality against the pin, not the latest', () => {
  const pinned: ReleaseCheck = { name: 'immich', repo: 'immich-app/immich', pin: 'v3.2.4' };
  assert.equal(decideOutcome('3.2.4', pinned, '9.9.9'), 'up-to-date');
  // Installed matches the overall latest release but not the pin -- still an update, since a
  // pin deliberately holds a version back (research R1).
  assert.equal(decideOutcome('9.9.9', pinned, '9.9.9'), 'update-available');
});

test('decideOutcome: unpinned install semantics compare against the latest release', () => {
  const unpinned: ReleaseCheck = { name: 'sd', repo: 'chmln/sd' };
  assert.equal(decideOutcome('1.1.0', unpinned, '1.1.0'), 'up-to-date');
  assert.equal(decideOutcome('1.0.0', unpinned, '1.1.0'), 'update-available');
  assert.equal(decideOutcome('', unpinned, '1.1.0'), 'update-available');
});

// --- fetchLatestRelease ---

test('fetchLatestRelease uses /latest when there is no pin or prefix', async () => {
  const fetchImpl = fakeFetch({
    'https://api.github.com/repos/chmln/sd/releases/latest': () => new Response(RELEASES_LATEST, { status: 200 }),
  });
  assert.deepEqual(await fetchLatestRelease('chmln/sd', {}, fetchImpl), { tag: 'v1.1.0', version: '1.1.0' });
});

test('fetchLatestRelease falls back to the paginated list on a non-200 /latest', async () => {
  const fetchImpl = fakeFetch({
    'https://api.github.com/repos/chmln/sd/releases/latest': () => new Response('not found', { status: 404 }),
    'https://api.github.com/repos/chmln/sd/releases?per_page=100': () => new Response(RELEASES_LIST, { status: 200 }),
  });
  assert.deepEqual(await fetchLatestRelease('chmln/sd', {}, fetchImpl), { tag: 'v1.1.0', version: '1.1.0' });
});

test('fetchLatestRelease skips drafts and pre-releases in the paginated list', async () => {
  const list = JSON.stringify([
    { tag_name: 'v2.0.0-rc1', draft: false, prerelease: true },
    { tag_name: 'v1.9.0', draft: true, prerelease: false },
    { tag_name: 'v1.8.0', draft: false, prerelease: false },
  ]);
  const fetchImpl = fakeFetch({
    'https://api.github.com/repos/example/app/releases/latest': () => new Response('', { status: 404 }),
    'https://api.github.com/repos/example/app/releases?per_page=100': () => new Response(list, { status: 200 }),
  });
  assert.deepEqual(await fetchLatestRelease('example/app', {}, fetchImpl), { tag: 'v1.8.0', version: '1.8.0' });
});

test('fetchLatestRelease filters the paginated list by tag prefix, skipping /latest entirely', async () => {
  const list = JSON.stringify([
    { tag_name: 'v2.0.0', draft: false, prerelease: false },
    { tag_name: 'web-v1.5.0', draft: false, prerelease: false },
    { tag_name: 'web-v1.4.0', draft: false, prerelease: false },
  ]);
  const fetchImpl = fakeFetch({
    'https://api.github.com/repos/example/app/releases?per_page=100': () => new Response(list, { status: 200 }),
  });
  assert.deepEqual(await fetchLatestRelease('example/app', { prefix: 'web-v' }, fetchImpl), {
    tag: 'web-v1.5.0',
    version: 'web-v1.5.0',
  });
});

test('fetchLatestRelease resolves a pinned version directly via /releases/tags/<pin>', async () => {
  const fetchImpl = fakeFetch({
    'https://api.github.com/repos/chmln/sd/releases/tags/v1.0.0': () =>
      new Response(JSON.stringify({ tag_name: 'v1.0.0', draft: false, prerelease: false }), { status: 200 }),
  });
  assert.deepEqual(await fetchLatestRelease('chmln/sd', { pin: 'v1.0.0' }, fetchImpl), {
    tag: 'v1.0.0',
    version: '1.0.0',
  });
});

// Fix round 1 (FR-017 ruling): a /releases/tags/<pin> response other than
// 200/403/429 falls back to the paginated list, mirroring upstream
// tools.func's own pipeline rather than treating "not found" as the final
// answer -- the pin ("3.2.4") and the matching list tag ("v3.2.4") are
// compared after v-normalizing both sides.
test('fetchLatestRelease falls back to the paginated list when the direct tag lookup 404s, matching by normalized tag', async () => {
  const list = JSON.stringify([
    { tag_name: 'v3.2.4', draft: false, prerelease: false },
    { tag_name: 'v3.2.3', draft: false, prerelease: false },
  ]);
  const fetchImpl = fakeFetch({
    'https://api.github.com/repos/immich-app/immich/releases/tags/3.2.4': () => new Response('', { status: 404 }),
    'https://api.github.com/repos/immich-app/immich/releases?per_page=100': () => new Response(list, { status: 200 }),
  });
  assert.deepEqual(await fetchLatestRelease('immich-app/immich', { pin: '3.2.4' }, fetchImpl), {
    tag: 'v3.2.4',
    version: '3.2.4',
  });
});

// The list fallback also applies the prefix filter, same as the unpinned
// path. The pin itself carries the prefix text (as a real pinned tag would
// -- normalizeVersion only ever strips a bare leading `v` + digit, never a
// prefix), so an `other-`-prefixed tag sharing the same numeric suffix is
// never a false match.
test('fetchLatestRelease falls back to the paginated list for a pin with a tag prefix too', async () => {
  const list = JSON.stringify([
    { tag_name: 'web-v1.5.0', draft: false, prerelease: false },
    { tag_name: 'other-v1.5.0', draft: false, prerelease: false },
  ]);
  const fetchImpl = fakeFetch({
    'https://api.github.com/repos/example/app/releases/tags/web-v1.5.0': () => new Response('', { status: 404 }),
    'https://api.github.com/repos/example/app/releases?per_page=100': () => new Response(list, { status: 200 }),
  });
  assert.deepEqual(await fetchLatestRelease('example/app', { pin: 'web-v1.5.0', prefix: 'web-v' }, fetchImpl), {
    tag: 'web-v1.5.0',
    version: 'web-v1.5.0',
  });
});

// A draft or pre-release at the direct tag never counts as a match -- it
// falls through to the list path exactly like a non-200 would. The list's
// matching tag is counted via a handler spy, since the pin and the list
// entry share the same tag text and so would produce the same *value*
// whether or not the fallback actually ran -- the spy is what proves the
// list endpoint was really hit rather than the direct 200 being accepted.
test('fetchLatestRelease falls back to the list when the directly-tagged pin is itself a pre-release', async () => {
  const list = JSON.stringify([{ tag_name: 'v1.0.0', draft: false, prerelease: false }]);
  let listCalls = 0;
  const fetchImpl = fakeFetch({
    'https://api.github.com/repos/example/app/releases/tags/v1.0.0': () =>
      new Response(JSON.stringify({ tag_name: 'v1.0.0', draft: false, prerelease: true }), { status: 200 }),
    'https://api.github.com/repos/example/app/releases?per_page=100': () => {
      listCalls += 1;
      return new Response(list, { status: 200 });
    },
  });
  assert.deepEqual(await fetchLatestRelease('example/app', { pin: 'v1.0.0' }, fetchImpl), {
    tag: 'v1.0.0',
    version: '1.0.0',
  });
  assert.equal(listCalls, 1);
});

test('fetchLatestRelease falls back to the list when the directly-tagged pin is a draft', async () => {
  const list = JSON.stringify([{ tag_name: 'v1.0.0', draft: false, prerelease: false }]);
  let listCalls = 0;
  const fetchImpl = fakeFetch({
    'https://api.github.com/repos/example/app/releases/tags/v1.0.0': () =>
      new Response(JSON.stringify({ tag_name: 'v1.0.0', draft: true, prerelease: false }), { status: 200 }),
    'https://api.github.com/repos/example/app/releases?per_page=100': () => {
      listCalls += 1;
      return new Response(list, { status: 200 });
    },
  });
  assert.deepEqual(await fetchLatestRelease('example/app', { pin: 'v1.0.0' }, fetchImpl), {
    tag: 'v1.0.0',
    version: '1.0.0',
  });
  assert.equal(listCalls, 1);
});

test('fetchLatestRelease throws naming the pin and repo when no tag in the fallback list matches', async () => {
  const fetchImpl = fakeFetch({
    'https://api.github.com/repos/chmln/sd/releases/tags/v9.9.9': () => new Response('{"message":"Not Found"}', { status: 404 }),
    'https://api.github.com/repos/chmln/sd/releases?per_page=100': () => new Response(RELEASES_LIST, { status: 200 }),
  });
  await assert.rejects(() => fetchLatestRelease('chmln/sd', { pin: 'v9.9.9' }, fetchImpl), (err: unknown) => {
    const message = String((err as Error).message);
    assert.match(message, /chmln\/sd/);
    assert.match(message, /v9\.9\.9/);
    return true;
  });
});

// A non-404 failure fetching the fallback list (e.g. a 500) is a GitHub API
// failure, not a "not found" -- the wording must say so.
test('fetchLatestRelease names the HTTP status, not "not found", when the pin-fallback list fetch itself fails', async () => {
  const fetchImpl = fakeFetch({
    'https://api.github.com/repos/chmln/sd/releases/tags/v9.9.9': () => new Response('', { status: 404 }),
    'https://api.github.com/repos/chmln/sd/releases?per_page=100': () => new Response('', { status: 500 }),
  });
  await assert.rejects(() => fetchLatestRelease('chmln/sd', { pin: 'v9.9.9' }, fetchImpl), (err: unknown) => {
    const message = String((err as Error).message);
    assert.match(message, /500/);
    assert.doesNotMatch(message, /not found/);
    return true;
  });
});

test('fetchLatestRelease reports a 403 on the direct tag lookup as a rate-limit error with no fallback', async () => {
  const fetchImpl = fakeFetch({
    'https://api.github.com/repos/chmln/sd/releases/tags/v1.0.0': () => new Response('', { status: 403 }),
  });
  await assert.rejects(
    () => fetchLatestRelease('chmln/sd', { pin: 'v1.0.0' }, fetchImpl),
    new RegExp(GITHUB_RATE_LIMIT_MESSAGE)
  );
});

test('fetchLatestRelease reports a 403 on /latest as a rate-limit error with no fallback', async () => {
  const fetchImpl = fakeFetch({
    'https://api.github.com/repos/chmln/sd/releases/latest': () => new Response('', { status: 403 }),
  });
  await assert.rejects(() => fetchLatestRelease('chmln/sd', {}, fetchImpl), new RegExp(GITHUB_RATE_LIMIT_MESSAGE));
});

test('fetchLatestRelease reports a 429 on the paginated list as a rate-limit error', async () => {
  const fetchImpl = fakeFetch({
    'https://api.github.com/repos/chmln/sd/releases?per_page=100': () => new Response('', { status: 429 }),
  });
  await assert.rejects(
    () => fetchLatestRelease('chmln/sd', { prefix: 'v' }, fetchImpl),
    new RegExp(GITHUB_RATE_LIMIT_MESSAGE)
  );
});

test('fetchLatestRelease names the repo and status for an otherwise-unrecognized failure', async () => {
  const fetchImpl = fakeFetch({
    'https://api.github.com/repos/chmln/sd/releases/latest': () => new Response('', { status: 404 }),
    'https://api.github.com/repos/chmln/sd/releases?per_page=100': () => new Response('', { status: 500 }),
  });
  await assert.rejects(() => fetchLatestRelease('chmln/sd', {}, fetchImpl), (err: unknown) => {
    const message = String((err as Error).message);
    assert.match(message, /chmln\/sd/);
    assert.match(message, /500/);
    return true;
  });
});

test('fetchLatestRelease issues one request per repo|pin|prefix across repeated calls when given a shared cache', async () => {
  const cache = createReleaseCache();
  let calls = 0;
  const fetchImpl = fakeFetch({
    'https://api.github.com/repos/chmln/sd/releases/latest': () => {
      calls += 1;
      return new Response(RELEASES_LATEST, { status: 200 });
    },
  });
  // Concurrent calls must share the same in-flight promise, not just dedupe
  // after the fact -- this is what proves the cache is keyed/populated
  // synchronously before the fetch resolves.
  await Promise.all([
    fetchLatestRelease('chmln/sd', {}, fetchImpl, cache),
    fetchLatestRelease('chmln/sd', {}, fetchImpl, cache),
  ]);
  await fetchLatestRelease('chmln/sd', {}, fetchImpl, cache);
  assert.equal(calls, 1);
});

// --- buildInstalledVersionScript ---

test('buildInstalledVersionScript emits the documented POSIX read script', () => {
  assert.equal(
    buildInstalledVersionScript('homepage'),
    [
      'f="${HOME:-/root}/.homepage"',
      'if [ -f "$f" ]; then cat "$f"; exit 0; fi',
      'set -- /opt/*_version.txt',
      'if [ "$#" -eq 1 ] && [ -f "$1" ]; then cat "$1"; exit 0; fi',
      'exit 3',
    ].join('\n')
  );
});

// -- Issue #64 US3: authenticated GitHub requests ----------------------------

async function withGithubToken(token: string | undefined, fn: () => Promise<void>): Promise<void> {
  const original = process.env.GITHUB_API_TOKEN;
  if (token === undefined) delete process.env.GITHUB_API_TOKEN;
  else process.env.GITHUB_API_TOKEN = token;
  try {
    await fn();
  } finally {
    if (original === undefined) delete process.env.GITHUB_API_TOKEN;
    else process.env.GITHUB_API_TOKEN = original;
  }
}

function headerCapturingFetch(body: string, status = 200): { fetchImpl: typeof fetch; headers: () => Record<string, string> } {
  let seen: Record<string, string> = {};
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    seen = (init?.headers ?? {}) as Record<string, string>;
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, headers: () => seen };
}

test('fetchLatestRelease (/latest) sends Authorization: Bearer <token> when githubApiToken is configured', async () => {
  await withGithubToken('github_pat_example0000', async () => {
    const { fetchImpl, headers } = headerCapturingFetch(RELEASES_LATEST);
    await fetchLatestRelease('chmln/sd', {}, fetchImpl);
    assert.equal(headers().Authorization, 'Bearer github_pat_example0000');
    assert.equal(headers()['User-Agent'], 'bellhop');
    assert.equal(headers().Accept, 'application/vnd.github+json');
  });
});

test('fetchLatestRelease (/latest) sends no Authorization header when no token is configured', async () => {
  await withGithubToken(undefined, async () => {
    const { fetchImpl, headers } = headerCapturingFetch(RELEASES_LATEST);
    await fetchLatestRelease('chmln/sd', {}, fetchImpl);
    assert.ok(!('Authorization' in headers()));
  });
});

test('fetchLatestRelease (/latest) throws the named 401 error, never the token, before the rate-limit check', async () => {
  await withGithubToken('github_pat_example0000', async () => {
    await assert.rejects(
      () => fetchLatestRelease('chmln/sd', {}, fakeFetch({ 'https://api.github.com/repos/chmln/sd/releases/latest': () => new Response('{}', { status: 401 }) })),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /^Fetching the latest release for chmln\/sd: GitHub rejected the configured GitHub API token \(401\)/);
        assert.ok(!err.message.includes('github_pat_example0000'));
        return true;
      }
    );
  });
});

test('fetchLatestRelease (pinned /releases/tags/<pin>) sends Authorization: Bearer <token> when configured', async () => {
  await withGithubToken('github_pat_example0000', async () => {
    const { fetchImpl, headers } = headerCapturingFetch(JSON.stringify({ tag_name: 'v1.0.0', draft: false, prerelease: false }));
    await fetchLatestRelease('chmln/sd', { pin: 'v1.0.0' }, fetchImpl);
    assert.equal(headers().Authorization, 'Bearer github_pat_example0000');
  });
});

test('fetchLatestRelease (pinned /releases/tags/<pin>) throws the named 401 error', async () => {
  await withGithubToken('github_pat_example0000', async () => {
    await assert.rejects(
      () =>
        fetchLatestRelease(
          'chmln/sd',
          { pin: 'v1.0.0' },
          fakeFetch({ 'https://api.github.com/repos/chmln/sd/releases/tags/v1.0.0': () => new Response('{}', { status: 401 }) })
        ),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /^Fetching the latest release for chmln\/sd: GitHub rejected the configured GitHub API token \(401\)/);
        assert.ok(!err.message.includes('github_pat_example0000'));
        return true;
      }
    );
  });
});

test('fetchLatestRelease (paginated /releases list) sends Authorization: Bearer <token> when configured', async () => {
  await withGithubToken('github_pat_example0000', async () => {
    const list = JSON.stringify([{ tag_name: 'web-v1.5.0', draft: false, prerelease: false }]);
    const { fetchImpl, headers } = headerCapturingFetch(list);
    await fetchLatestRelease('example/app', { prefix: 'web-v' }, fetchImpl);
    assert.equal(headers().Authorization, 'Bearer github_pat_example0000');
  });
});

test('fetchLatestRelease (paginated /releases list) throws the named 401 error', async () => {
  await withGithubToken('github_pat_example0000', async () => {
    await assert.rejects(
      () =>
        fetchLatestRelease(
          'example/app',
          { prefix: 'web-v' },
          fakeFetch({ 'https://api.github.com/repos/example/app/releases?per_page=100': () => new Response('{}', { status: 401 }) })
        ),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /^Fetching the latest release for example\/app: GitHub rejected the configured GitHub API token \(401\)/);
        assert.ok(!err.message.includes('github_pat_example0000'));
        return true;
      }
    );
  });
});
