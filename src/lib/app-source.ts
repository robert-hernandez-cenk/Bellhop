import { z } from 'zod';
import type { Inventory } from './inventory.ts';
import { logWarn } from './log.ts';

// The two upstream community-scripts repos install-app/update-app resolve
// to for every app a configured custom branch doesn't change (or for every
// app, when no custom repository is configured at all) -- raw repo roots, not yet scoped
// to ct/. install-app.ts derives its own COMMUNITY_SCRIPTS_BASE/
// COMMUNITY_SCRIPTS_DEV_BASE (the /ct-scoped bases resolveAppUrl/
// resolveDevAppUrl actually build URLs from) from these, so the two files
// share one definition instead of two copies drifting apart.
export const UPSTREAM_STABLE_BASE = 'https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main';
export const UPSTREAM_DEV_BASE = 'https://raw.githubusercontent.com/community-scripts/ProxmoxVED/main';

const GITHUB_FETCH_TIMEOUT_MS = 5000;

// Appended to every error this module throws, naming the fix --
// resolveHeadSha, compareBranch and resolveAppSource's own fork ct/<slug>.sh
// fetch all throw through this same suffix, so any resolution failure (bad
// settings, GitHub down, a typo'd branch, a repo that isn't a ProxmoxVED
// fork) points the operator at the same command.
const ERROR_SUFFIX = ' -- check customScriptsRepo/customScriptsBranch with "bellhop set-config"';

// A validated, split-apart customScriptsRepo/customScriptsBranch pair, with
// the human-readable "<owner>/<repo>@<branch>" label used in every message
// and log line this module produces.
export interface CustomScriptSource {
  owner: string;
  repo: string;
  branch: string;
  label: string;
}

export type ShadowedRepo = 'ProxmoxVE' | 'ProxmoxVED';

// The outcome of resolving a single --app value to somewhere Bellhop can
// curl from. `slug` is absent only for kind 'url' (a pasted full script URL
// has no community-scripts slug). `custom`/`ctUrl`/`scriptsBaseUrl` are set
// only for kind 'custom'; `shadows` is always present but only ever
// non-empty for kind 'custom' (see data-model.md). `changed`/`conflict` are
// set only for kind 'custom' (issue #15): `changed` is true when the branch
// changes this app, false for a fork-only resolution; `conflict` is true
// only when upstream also changed a changed app since the branch point.
// `custom.mergeBase` is where the branch left upstream ProxmoxVED main.
export interface AppSource {
  kind: 'url' | 'upstream' | 'custom';
  slug?: string;
  custom?: CustomScriptSource & { sha: string; mergeBase: string };
  ctUrl?: string;
  scriptsBaseUrl?: string;
  shadows: ShadowedRepo[];
  changed?: boolean;
  conflict?: boolean;
}

// Reads the two related settings off the loaded inventory and validates
// their both-or-neither rule (see the SettingsSchema comment in
// src/lib/inventory.ts for why that rule lives here rather than in the
// schema itself). Returns undefined when the feature is off (both unset) --
// every caller in this module treats that as "resolve against upstream
// only, no network access needed to find that out."
export function customScriptSource(inv: Inventory): CustomScriptSource | undefined {
  const { customScriptsRepo, customScriptsBranch } = inv;
  if (!customScriptsRepo && !customScriptsBranch) return undefined;
  if (!customScriptsRepo || !customScriptsBranch) {
    // Name which setting is actually missing (rather than a generic "must be
    // set together") so the operator doesn't have to go check both --
    // set-config's own error output should point at the one key that's
    // actually wrong.
    const missing = customScriptsRepo ? 'customScriptsBranch' : 'customScriptsRepo';
    const present = customScriptsRepo ? 'customScriptsRepo' : 'customScriptsBranch';
    throw new Error(
      `${missing} is not set (${present} is); set it with "bellhop set-config ${missing} <value> --apply" or on the Settings page, or unset ${present}`
    );
  }
  // SettingsSchema's regex on customScriptsRepo guarantees exactly one '/',
  // with the repo half forbidden from containing another -- a plain
  // indexOf split is therefore exact, not just a best guess.
  const slashIndex = customScriptsRepo.indexOf('/');
  const owner = customScriptsRepo.slice(0, slashIndex);
  const repo = customScriptsRepo.slice(slashIndex + 1);
  return { owner, repo, branch: customScriptsBranch, label: `${owner}/${repo}@${customScriptsBranch}` };
}

// Shared by resolveHeadSha and resolveAppSource's own custom ct/<slug>.sh
// fetch: a timed GitHub request that turns a thrown/aborted fetch into the
// same "could not reach GitHub" error shape both call sites throw for every
// other failure. A non-throwing non-OK response is returned as-is -- the
// caller inspects `.status`/`.ok` itself, since 404 means something
// different to each of the two callers (an unknown branch vs. "fall back
// to upstream").
async function fetchWithTimeout(
  url: string,
  fetchImpl: typeof fetch,
  prefix: string,
  headers?: Record<string, string>
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GITHUB_FETCH_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { signal: controller.signal, headers: { 'User-Agent': 'bellhop', ...headers } });
  } catch (err) {
    throw new Error(`${prefix} could not reach GitHub (${err instanceof Error ? err.message : String(err)})${ERROR_SUFFIX}`);
  } finally {
    clearTimeout(timeout);
  }
}

// Resolves a configured branch to its current head commit -- the pin every
// custom-repository raw URL this module builds is based on (research R2/R3:
// a branch-name raw URL is only cache-fresh for 5 minutes and would let
// preview/apply silently diverge; a commit-SHA raw URL is immutable).
export async function resolveHeadSha(source: CustomScriptSource, fetchImpl: typeof fetch): Promise<string> {
  const prefix = `Custom script repository ${source.label}:`;
  // Deliberately not built on fetchWithTimeout here (unlike every other
  // caller in this module): that helper clears its timeout as soon as
  // fetchImpl's promise settles, before a caller ever reads the response
  // body -- fine for a caller that only inspects .ok/.status, but this is
  // the one call site that also reads the body (the SHA itself). Reading it
  // after the timeout already cleared would leave a stalled body read
  // completely unbounded, so response.text() runs inside this try, while the
  // same AbortController/timeout that guards the fetch() call is still live.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GITHUB_FETCH_TIMEOUT_MS);
  let response: Response;
  let body: string;
  try {
    response = await fetchImpl(
      `https://api.github.com/repos/${source.owner}/${source.repo}/commits/${encodeURIComponent(source.branch)}`,
      { signal: controller.signal, headers: { 'User-Agent': 'bellhop', Accept: 'application/vnd.github.sha' } }
    );
    body = (await response.text()).trim();
  } catch (err) {
    throw new Error(`${prefix} could not reach GitHub (${err instanceof Error ? err.message : String(err)})${ERROR_SUFFIX}`);
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    if (response.status === 404) throw new Error(`${prefix} repository not found or not public${ERROR_SUFFIX}`);
    if (response.status === 422) throw new Error(`${prefix} branch not found${ERROR_SUFFIX}`);
    throw new Error(`${prefix} GitHub returned ${response.status}${ERROR_SUFFIX}`);
  }
  if (!/^[0-9a-f]{40}$/.test(body)) throw new Error(`${prefix} unexpected response${ERROR_SUFFIX}`);
  return body;
}

// The upstream repository a custom branch is compared against (issue #15,
// research R1): a fork of ProxmoxVED, compared to its `main`. Fixed rather
// than configurable -- #11 already assumed a VED-shaped fork, and a fork of
// ProxmoxVE (stable) is out of scope (spec Assumptions).
const COMPARE_UPSTREAM = 'community-scripts/ProxmoxVED';

// GitHub's compare endpoint stops listing files at 300 (research R4); the
// file list isn't pageable, so a list that long can't be trusted to be
// complete.
const COMPARE_FILE_CAP = 300;

// The parsed result of comparing a pinned custom-branch commit against
// upstream ProxmoxVED main (data-model.md BranchComparison).
export interface BranchComparison {
  sha: string;
  mergeBase: string;
  aheadBy: number;
  behindBy: number;
  changedSlugs: Set<string>;
}

const CompareFileSchema = z.object({
  filename: z.string(),
  previous_filename: z.string().optional(),
  status: z.string(),
});

// Only the fields compareBranch reads -- zod strips the rest (commits,
// patches, URLs), so an unrelated addition to GitHub's response never
// breaks parsing.
const CompareResponseSchema = z.object({
  merge_base_commit: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) }),
  ahead_by: z.number().int().nonnegative(),
  behind_by: z.number().int().nonnegative(),
  files: z.array(CompareFileSchema),
});

const CT_SCRIPT_PATTERN = /^ct\/([^/]+)\.sh$/;
const INSTALL_SCRIPT_PATTERN = /^install\/([^/]+)-install\.sh$/;

function slugFromScriptPath(path: string): string | undefined {
  return (CT_SCRIPT_PATTERN.exec(path) ?? INSTALL_SCRIPT_PATTERN.exec(path))?.[1];
}

// research R3: an app is changed when its ct/<slug>.sh or
// install/<slug>-install.sh is added, modified or renamed on the branch --
// only those two scripts decide what gets installed. A deletion leaves
// nothing in the fork to install, so it never makes an app changed; a
// rename counts both the old and new names.
export function changedSlugsFromFiles(
  files: { filename: string; previous_filename?: string; status: string }[]
): Set<string> {
  const slugs = new Set<string>();
  for (const file of files) {
    if (file.status === 'removed') continue;
    for (const path of [file.filename, file.previous_filename]) {
      const slug = path === undefined ? undefined : slugFromScriptPath(path);
      if (slug) slugs.add(slug);
    }
  }
  return slugs;
}

// One rate-limited request (research R1/R2): upstream ProxmoxVED main
// compared, three-dot, against the branch's pinned head commit. The head is
// addressed as <owner>:<repo>:<sha> rather than a branch name because a
// branch-name head can be silently answered from a different fork in the
// same network; a commit either exists in upstream's fork network or 404s.
// Every failure is a named error -- never a fallback to upstream (FR-006).
export async function compareBranch(
  source: CustomScriptSource,
  sha: string,
  fetchImpl: typeof fetch
): Promise<BranchComparison> {
  const prefix = `Custom script repository ${source.label}:`;
  const url = `https://api.github.com/repos/${COMPARE_UPSTREAM}/compare/main...${source.owner}:${source.repo}:${sha}`;
  // Body read inside the timeout, for the same reason as resolveHeadSha.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GITHUB_FETCH_TIMEOUT_MS);
  let response: Response;
  let body: string;
  try {
    response = await fetchImpl(url, { signal: controller.signal, headers: { 'User-Agent': 'bellhop' } });
    body = await response.text();
  } catch (err) {
    throw new Error(`${prefix} could not reach GitHub (${err instanceof Error ? err.message : String(err)})${ERROR_SUFFIX}`);
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    if (response.status === 404)
      throw new Error(
        `${prefix} commit ${sha.slice(0, 7)} not found in ${COMPARE_UPSTREAM}'s fork network (is ${source.owner}/${source.repo} a fork of ProxmoxVED?)${ERROR_SUFFIX}`
      );
    if (response.status === 403 || response.status === 429)
      throw new Error(`${prefix} GitHub rate limit reached (try again later)${ERROR_SUFFIX}`);
    throw new Error(`${prefix} GitHub returned ${response.status}${ERROR_SUFFIX}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error(`${prefix} unexpected compare response${ERROR_SUFFIX}`);
  }
  const parsed = CompareResponseSchema.safeParse(json);
  if (!parsed.success) throw new Error(`${prefix} unexpected compare response${ERROR_SUFFIX}`);
  if (parsed.data.files.length >= COMPARE_FILE_CAP)
    throw new Error(
      `${prefix} the branch changes ${COMPARE_FILE_CAP} or more files, too many to tell which apps it changes${ERROR_SUFFIX}`
    );
  return {
    sha,
    mergeBase: parsed.data.merge_base_commit.sha,
    aheadBy: parsed.data.ahead_by,
    behindBy: parsed.data.behind_by,
    changedSlugs: changedSlugsFromFiles(parsed.data.files),
  };
}

// A raw-content read of one upstream ProxmoxVED script at one ref, for the
// conflict check: its body, 'absent' (404), or undefined when the read
// failed any other way (thrown fetch, non-404 non-OK status).
async function readUpstreamScript(ref: string, file: string, fetchImpl: typeof fetch): Promise<string | 'absent' | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GITHUB_FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`https://raw.githubusercontent.com/${COMPARE_UPSTREAM}/${ref}/${file}`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'bellhop' },
    });
    if (response.status === 404) return 'absent';
    if (!response.ok) return undefined;
    return await response.text();
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

// research R5: did upstream ProxmoxVED also change this (branch-changed)
// app since the branch point? Compares the app's ct/ and install/ scripts
// at the merge base against upstream main through raw content -- no API
// quota and no 300-file cap, unlike a reverse compare, whose file list a
// branch far behind upstream would routinely exceed. A script present on
// one side only counts as different; absent on both counts as the same.
// Informational only (FR-013): a failed read is logged once and counts as
// no conflict; this never throws. Skipped entirely, with no request, when
// the branch isn't behind (FR-008) -- upstream can't have moved on then.
export async function detectConflict(slug: string, comparison: BranchComparison, fetchImpl: typeof fetch): Promise<boolean> {
  if (comparison.behindBy === 0) return false;
  const files = [`ct/${slug}.sh`, `install/${slug}-install.sh`];
  const reads = await Promise.all(
    files.flatMap((file) => [
      readUpstreamScript(comparison.mergeBase, file, fetchImpl),
      readUpstreamScript('main', file, fetchImpl),
    ])
  );
  if (reads.some((read) => read === undefined)) {
    logWarn(
      `Could not check whether upstream ${COMPARE_UPSTREAM} also changed "${slug}" since the branch point; treating it as not conflicting`
    );
    return false;
  }
  return reads[0] !== reads[1] || reads[2] !== reads[3];
}

type UpstreamPresence = 'present' | 'absent' | 'error';

// Probes one upstream repo's ct/<slug>.sh (a raw request -- no API quota).
// Tri-state because the two resolveAppSource paths read it differently
// (research R6): for a changed slug it only feeds `shadows`, so an error is
// informational and reads as "not shadowed"; for an unchanged slug an error
// means "can't tell", which resolves to upstream rather than to a possibly
// stale inherited fork copy. Never throws -- a thrown fetch is logged.
async function probeUpstream(
  name: ShadowedRepo,
  base: string,
  slug: string,
  fetchImpl: typeof fetch
): Promise<UpstreamPresence> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GITHUB_FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${base}/ct/${slug}.sh`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'bellhop' },
    });
    if (response.ok) return 'present';
    return response.status === 404 ? 'absent' : 'error';
  } catch (err) {
    logWarn(`Failed to probe ${name} for a "${slug}" script: ${err instanceof Error ? err.message : String(err)}`);
    return 'error';
  } finally {
    clearTimeout(timeout);
  }
}

async function probeBothUpstreams(slug: string, fetchImpl: typeof fetch): Promise<[UpstreamPresence, UpstreamPresence]> {
  return Promise.all([
    probeUpstream('ProxmoxVE', UPSTREAM_STABLE_BASE, slug, fetchImpl),
    probeUpstream('ProxmoxVED', UPSTREAM_DEV_BASE, slug, fetchImpl),
  ]);
}

// The upstream repos a changed slug overrides, for the override notice.
function shadowsFrom([stable, dev]: [UpstreamPresence, UpstreamPresence]): ShadowedRepo[] {
  const shadows: ShadowedRepo[] = [];
  if (stable === 'present') shadows.push('ProxmoxVE');
  if (dev === 'present') shadows.push('ProxmoxVED');
  return shadows;
}

// The single entry point install-app/update-app, checkAppUrl and
// previewAndEnqueue call to decide where an --app value actually comes
// from. Resolves at most once per call -- no caching here; previewAndEnqueue
// is what resolves once per operation rather than once per fetch site.
//
// Issue #15 (research R6): with a custom repository configured, only the
// apps the branch actually changes come from the fork --
//   1. changed on the branch -> the fork at the pinned commit;
//   2. otherwise, upstream VE/VED has it (or a probe can't tell) -> upstream,
//      identical to the feature being off;
//   3. otherwise, the fork has it at the pinned commit -> the fork
//      (fork-only, nowhere else to get it);
//   4. otherwise -> upstream, which then fails the same way feature-off does.
// The only rate-limited requests are the head-SHA pin and the compare
// (spec SC-006); every probe is a raw-content request.
export async function resolveAppSource(app: string, inv: Inventory, fetchImpl: typeof fetch): Promise<AppSource> {
  // A pasted full script URL is used verbatim, exactly like
  // resolveAppUrl/resolveDevAppUrl already treat it -- no custom-repository
  // involvement, and therefore no network access needed to decide that.
  if (app.includes('://')) return { kind: 'url', shadows: [] };

  const slug = app.toLowerCase();
  const source = customScriptSource(inv);
  if (!source) return { kind: 'upstream', slug, shadows: [] };

  const sha = await resolveHeadSha(source, fetchImpl);
  const comparison = await compareBranch(source, sha, fetchImpl);
  const prefix = `Custom script repository ${source.label}:`;
  const scriptsBaseUrl = `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${sha}`;
  const ctUrl = `${scriptsBaseUrl}/ct/${slug}.sh`;
  const custom = { ...source, sha, mergeBase: comparison.mergeBase };
  const upstream = await probeBothUpstreams(slug, fetchImpl);

  // The compare already proved ct/ or install/ exists on the branch for a
  // changed slug, so the fork's ct/ script isn't probed here.
  if (comparison.changedSlugs.has(slug)) {
    const shadows = shadowsFrom(upstream);
    const conflict = await detectConflict(slug, comparison, fetchImpl);
    return { kind: 'custom', slug, custom, ctUrl, scriptsBaseUrl, shadows, changed: true, conflict };
  }

  if (upstream.some((presence) => presence !== 'absent')) return { kind: 'upstream', slug, shadows: [] };

  const response = await fetchWithTimeout(ctUrl, fetchImpl, prefix);
  if (response.status === 404) return { kind: 'upstream', slug, shadows: [] };
  if (!response.ok) throw new Error(`${prefix} GitHub returned ${response.status}${ERROR_SUFFIX}`);
  return { kind: 'custom', slug, custom, ctUrl, scriptsBaseUrl, shadows: [], changed: false, conflict: false };
}

// The one line runInstallApp/runUpdateApp emit before anything else about
// where an app is coming from (research R7) -- the first line of a dry
// run, a captured preview, and the job log alike:
//   - a changed app upstream also changed since the branch point -> a
//     'warn' telling the operator to rebase (the install still proceeds
//     from the fork, whose copy is the one being tested);
//   - a changed app that replaces an upstream copy -> one 'info' line;
//   - anything else (a changed app upstream never had, a fork-only app, an
//     upstream or pasted-URL resolution) -> undefined, no notice at all.
export type SourceNotice = { level: 'warn' | 'info'; message: string };

export function formatSourceNotice(source: AppSource): SourceNotice | undefined {
  if (source.kind !== 'custom' || !source.custom || !source.slug || !source.changed) return undefined;
  const shortSha = source.custom.sha.slice(0, 7);
  if (source.conflict) {
    return {
      level: 'warn',
      message: `"${source.slug}" changed upstream in ProxmoxVED since ${source.custom.label} branched (merge base ${source.custom.mergeBase.slice(0, 7)}); installing the custom copy at commit ${shortSha}. Rebase ${source.custom.branch} onto upstream main to pick up the upstream changes.`,
    };
  }
  if (source.shadows.length === 0) return undefined;
  return {
    level: 'info',
    message: `"${source.slug}" is installing from the custom script repository ${source.custom.label} (commit ${shortSha}) in place of the upstream copy in ${source.shadows.join(', ')}.`,
  };
}
