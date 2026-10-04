// Decides whether a community-scripts LXC app has an update available, by
// mirroring check_for_gh_release from community-scripts/ProxmoxVE's
// misc/tools.func exactly (research R1) rather than inventing a version
// comparison -- SC-004 requires the badge to agree with what running the
// update actually does, and copying the upstream comparison (including its
// inequality-not-semver-ordering semantics) is what guarantees that. This
// file is pure/fetch-only: it never touches an inventory, a guest, or SSH --
// src/web/tasks and the check-app-updates command (later work units) are
// what wire it to a real run.
import { z } from 'zod';

// --- Parsing a ct/*.sh script's check_for_gh_release call (research R2) ---

export interface ReleaseCheck {
  name: string; // app_lc: lowercased, spaces removed
  repo: string; // owner/repo, literal
  pin?: string; // literal, or resolved from a single-assignment variable
  prefix?: string; // literal 5th-argument tag prefix
}

export type ParseReleaseCheckResult = { ok: true; check: ReleaseCheck } | { ok: false; reason?: string };

const CALL_MARKER = 'check_for_gh_release';

// Argument 1/2 must be literal (research R2): no `$` at all, which this
// character class already excludes.
const NAME_RAW_RE = /^[A-Za-z0-9._ -]+$/;
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

// A bare `$VAR` or `${VAR}` reference and nothing else -- a pin argument
// that is partly literal and partly a variable (e.g. "prefix-$VAR") is not
// one of the two forms research R2 allows, so it's left unresolved.
const VAR_REF_RE = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/;

export function parseReleaseCheck(script: string, slug: string): ParseReleaseCheckResult {
  const idx = script.indexOf(CALL_MARKER);
  if (idx === -1) {
    return { ok: false, reason: `no check_for_gh_release call in ct/${slug}.sh` };
  }
  const args = tokenizeCallArgs(script, idx + CALL_MARKER.length);
  const [rawName, rawRepo, rawPin, , rawPrefix] = args;
  if (rawName === undefined || rawRepo === undefined) {
    return { ok: false, reason: `check_for_gh_release in ct/${slug}.sh is missing its name or repo argument` };
  }
  if (!NAME_RAW_RE.test(rawName)) {
    return { ok: false, reason: `check_for_gh_release's name argument in ct/${slug}.sh is not a literal value` };
  }
  if (!REPO_RE.test(rawRepo)) {
    return { ok: false, reason: `check_for_gh_release's repo argument in ct/${slug}.sh is not a literal owner/repo value` };
  }

  let pin: string | undefined;
  if (rawPin !== undefined && rawPin !== '') {
    const resolved = resolvePinArgument(rawPin, script);
    if (resolved === undefined) {
      return { ok: false, reason: `check_for_gh_release's pinned-version argument in ct/${slug}.sh could not be resolved` };
    }
    // An empty-string pin (e.g. a resolved-but-blank variable) counts as no
    // pin at all (research R2).
    if (resolved !== '') pin = resolved;
  }

  let prefix: string | undefined;
  if (rawPrefix !== undefined && rawPrefix !== '') {
    if (rawPrefix.includes('$')) {
      return { ok: false, reason: `check_for_gh_release's tag-prefix argument in ct/${slug}.sh is not a literal value` };
    }
    prefix = rawPrefix;
  }

  const check: ReleaseCheck = { name: rawName.toLowerCase().replace(/ /g, ''), repo: rawRepo };
  if (pin !== undefined) check.pin = pin;
  if (prefix !== undefined) check.prefix = prefix;
  return { ok: true, check };
}

// Tokenizes the shell words following a `check_for_gh_release` call,
// starting right after the function name. Accepts double-quoted,
// single-quoted, and bare words, and stops (without consuming) at `;`,
// `then`, `&&`, `||`, a newline, or end of string (research R2) -- so a
// call guarded by `[[ -d x ]] && if check_for_gh_release ...; then` is read
// the same as a bare `check_for_gh_release ...` call.
function tokenizeCallArgs(script: string, start: number): string[] {
  const args: string[] = [];
  let i = start;
  const len = script.length;
  while (i < len) {
    while (i < len && (script[i] === ' ' || script[i] === '\t')) i++;
    if (i >= len || script[i] === '\n' || script[i] === ';') break;
    if (script.startsWith('&&', i) || script.startsWith('||', i)) break;
    if (script.startsWith('then', i) && isWordBoundaryAfter(script, i + 4)) break;

    const ch = script[i];
    if (ch === '"' || ch === "'") {
      const end = findClosingQuote(script, i + 1, ch);
      args.push(script.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < len && !/\s/.test(script[j]) && script[j] !== ';' && !script.startsWith('&&', j) && !script.startsWith('||', j)) {
      j++;
    }
    args.push(script.slice(i, j));
    i = j;
  }
  return args;
}

function isWordBoundaryAfter(script: string, idx: number): boolean {
  return idx >= script.length || !/[A-Za-z0-9_]/.test(script[idx]);
}

// Double quotes support `\"` escaping (matching POSIX sh); single quotes
// don't support escaping at all, so this is only reached with quoteChar
// `'` when there's no backslash handling to do.
function findClosingQuote(script: string, start: number, quoteChar: string): number {
  let i = start;
  while (i < script.length) {
    if (quoteChar === '"' && script[i] === '\\') {
      i += 2;
      continue;
    }
    if (script[i] === quoteChar) return i;
    i++;
  }
  return script.length;
}

// Resolves a pin argument that is either already literal, or a bare
// variable reference resolved through a single literal assignment
// elsewhere in the same script (research R2): `VAR="x"`, or
// `VAR="${VAR:-x}"` (the self-referential default form community-scripts
// itself uses, where the default is used).
function resolvePinArgument(rawPin: string, script: string): string | undefined {
  if (!rawPin.includes('$')) return rawPin;
  const match = VAR_REF_RE.exec(rawPin);
  if (!match) return undefined;
  return resolveVariable(match[1], script);
}

function resolveVariable(varName: string, script: string): string | undefined {
  const escaped = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const assignRe = new RegExp(`^\\s*${escaped}="([^"]*)"`, 'gm');
  const matches = [...script.matchAll(assignRe)];
  if (matches.length !== 1) return undefined;
  const value = matches[0][1];
  if (!value.includes('$')) return value;
  const selfDefaultRe = new RegExp(`^\\$\\{${escaped}:-([^}]*)\\}$`);
  const defaultMatch = selfDefaultRe.exec(value);
  if (!defaultMatch) return undefined;
  const fallback = defaultMatch[1];
  return fallback.includes('$') ? undefined : fallback;
}

// --- Version normalization and the outcome decision (research R1) ---

// A leading `v` is stripped only when followed by a digit, for both tags
// and the installed version (`v1.2` -> `1.2`, `vault-1` unchanged).
export function normalizeVersion(tag: string): string {
  return /^v[0-9]/.test(tag) ? tag.slice(1) : tag;
}

export type AppUpdateOutcome = 'update-available' | 'up-to-date';

// Pinned: update available exactly when installed != pin. Unpinned: when
// installed is empty or != latest. This is an inequality, not a semver
// ordering (research R1) -- `latest` is assumed already normalized (the
// `version` field of a LatestRelease), and `installed`/`check.pin` are
// normalized here so a 'v'-prefixed pin or installed-version file still
// compares correctly.
export function decideOutcome(installed: string, check: ReleaseCheck, latest: string): AppUpdateOutcome {
  const normalizedInstalled = normalizeVersion(installed);
  if (check.pin !== undefined) {
    return normalizedInstalled !== normalizeVersion(check.pin) ? 'update-available' : 'up-to-date';
  }
  return !normalizedInstalled || normalizedInstalled !== latest ? 'update-available' : 'up-to-date';
}

// --- Fetching the latest release from GitHub (research R3) ---

export const GITHUB_REQUEST_TIMEOUT_MS = 15_000;
export const GITHUB_RATE_LIMIT_MESSAGE = 'GitHub API rate limit reached; the next scheduled check will retry';

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};

const ReleaseSchema = z.object({
  tag_name: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
});
const ReleaseListSchema = z.array(ReleaseSchema);
type Release = z.infer<typeof ReleaseSchema>;

export interface LatestRelease {
  tag: string; // raw tag, e.g. "v1.1.0"
  version: string; // normalizeVersion(tag)
}

// Shared across one run so each repository is queried once (FR-017): keyed
// by `repo|pin|prefix`, holding the in-flight/settled promise rather than
// just a result, so concurrent callers for the same key share one request
// and a failure poisons only that one cache entry (every guest using that
// repository sees the same error).
export type ReleaseCache = Map<string, Promise<LatestRelease>>;

export function createReleaseCache(): ReleaseCache {
  return new Map();
}

async function githubGet(path: string, fetchImpl: typeof fetch): Promise<Response> {
  return fetchImpl(`${GITHUB_API_BASE}${path}`, {
    headers: GITHUB_HEADERS,
    signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
  });
}

function toLatestRelease(release: Release): LatestRelease {
  return { tag: release.tag_name, version: normalizeVersion(release.tag_name) };
}

function statusError(repo: string, status: number): Error {
  if (status === 403 || status === 429) return new Error(GITHUB_RATE_LIMIT_MESSAGE);
  return new Error(`GitHub API returned ${status} fetching releases for ${repo}`);
}

function pickLatestFromList(releases: Release[], repo: string, prefix: string | undefined): LatestRelease {
  let candidates = releases.filter((r) => !r.draft && !r.prerelease);
  if (prefix) candidates = candidates.filter((r) => r.tag_name.startsWith(prefix));
  const first = candidates[0];
  if (!first) {
    throw new Error(
      prefix ? `No stable release matching prefix '${prefix}' found for ${repo}` : `No stable release found for ${repo}`
    );
  }
  return toLatestRelease(first);
}

async function fetchLatestReleaseUncached(
  repo: string,
  opts: { pin?: string; prefix?: string },
  fetchImpl: typeof fetch
): Promise<LatestRelease> {
  // Pinned versions are tried directly against the tag they name, and must
  // exist there -- a pin is an operator/upstream-script decision to hold a
  // specific release, not "whatever happens to be newest" (research R1/R3).
  if (opts.pin) {
    const res = await githubGet(`/repos/${repo}/releases/tags/${encodeURIComponent(opts.pin)}`, fetchImpl);
    if (res.status === 200) return toLatestRelease(ReleaseSchema.parse(await res.json()));
    if (res.status === 403 || res.status === 429) throw new Error(GITHUB_RATE_LIMIT_MESSAGE);
    throw new Error(`Pinned version '${opts.pin}' not found for ${repo} (GitHub API returned ${res.status})`);
  }

  // No pin and no prefix: /latest is the efficient path and is used as-is
  // on success. A prefix needs the full list to filter, so it skips
  // straight there. Either way, a rate-limit status short-circuits with no
  // fallback -- it's still rate-limited either path.
  if (!opts.prefix) {
    const res = await githubGet('/repos/' + repo + '/releases/latest', fetchImpl);
    if (res.status === 200) return toLatestRelease(ReleaseSchema.parse(await res.json()));
    if (res.status === 403 || res.status === 429) throw new Error(GITHUB_RATE_LIMIT_MESSAGE);
    // Any other non-200 (e.g. the repo has no releases yet, so /latest
    // 404s) falls through to the paginated list below.
  }

  const listRes = await githubGet(`/repos/${repo}/releases?per_page=100`, fetchImpl);
  if (listRes.status !== 200) throw statusError(repo, listRes.status);
  const releases = ReleaseListSchema.parse(await listRes.json());
  return pickLatestFromList(releases, repo, opts.prefix);
}

export function fetchLatestRelease(
  repo: string,
  opts: { pin?: string; prefix?: string },
  fetchImpl: typeof fetch = fetch,
  cache?: ReleaseCache
): Promise<LatestRelease> {
  if (!cache) return fetchLatestReleaseUncached(repo, opts, fetchImpl);
  const key = `${repo}|${opts.pin ?? ''}|${opts.prefix ?? ''}`;
  const existing = cache.get(key);
  if (existing) return existing;
  const promise = fetchLatestReleaseUncached(repo, opts, fetchImpl);
  cache.set(key, promise);
  return promise;
}

// --- Reading the installed version inside the guest (research R6) ---

// Sent through runRemote(ssh, inventory, guest, script) by the command/
// scheduler work units -- this module never executes it itself. Exit 0:
// the trimmed first line of stdout is the installed version. Exit 3: no
// record found (neither $HOME/.<name> nor exactly one /opt/*_version.txt).
// Nothing is written (FR-020) -- read-only, matching upstream's own
// current-version file without ever migrating a legacy one.
export function buildInstalledVersionScript(name: string): string {
  return [
    `f="\${HOME:-/root}/.${name}"`,
    'if [ -f "$f" ]; then cat "$f"; exit 0; fi',
    'set -- /opt/*_version.txt',
    'if [ "$#" -eq 1 ] && [ -f "$1" ]; then cat "$1"; exit 0; fi',
    'exit 3',
  ].join('\n');
}
