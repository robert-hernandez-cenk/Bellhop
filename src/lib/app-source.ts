import type { Inventory } from './inventory.ts';
import { logWarn } from './log.ts';

// The two upstream community-scripts repos install-app/update-app fall back
// to when an app isn't found in a configured custom repository (or when no
// custom repository is configured at all) -- raw repo roots, not yet scoped
// to ct/. install-app.ts derives its own COMMUNITY_SCRIPTS_BASE/
// COMMUNITY_SCRIPTS_DEV_BASE (the /ct-scoped bases resolveAppUrl/
// resolveDevAppUrl actually build URLs from) from these, so the two files
// share one definition instead of two copies drifting apart.
export const UPSTREAM_STABLE_BASE = 'https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main';
export const UPSTREAM_DEV_BASE = 'https://raw.githubusercontent.com/community-scripts/ProxmoxVED/main';

const GITHUB_FETCH_TIMEOUT_MS = 5000;

// Appended to every error this module throws, naming the fix -- both
// resolveHeadSha and resolveAppSource's own custom ct/<slug>.sh fetch throw
// through this same suffix, so any resolution failure (bad settings,
// GitHub down, a typo'd branch) points the operator at the same command.
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
// non-empty for kind 'custom' (see data-model.md).
export interface AppSource {
  kind: 'url' | 'upstream' | 'custom';
  slug?: string;
  custom?: CustomScriptSource & { sha: string };
  ctUrl?: string;
  scriptsBaseUrl?: string;
  shadows: ShadowedRepo[];
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
    throw new Error(
      'customScriptsRepo and customScriptsBranch must be set together; set the missing one with "bellhop set-config <key> <value> --apply" or on the Settings page'
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
  const response = await fetchWithTimeout(
    `https://api.github.com/repos/${source.owner}/${source.repo}/commits/${encodeURIComponent(source.branch)}`,
    fetchImpl,
    prefix,
    { Accept: 'application/vnd.github.sha' }
  );
  if (!response.ok) {
    if (response.status === 404) throw new Error(`${prefix} repository not found or not public${ERROR_SUFFIX}`);
    if (response.status === 422) throw new Error(`${prefix} branch not found${ERROR_SUFFIX}`);
    throw new Error(`${prefix} GitHub returned ${response.status}${ERROR_SUFFIX}`);
  }
  const body = (await response.text()).trim();
  if (!/^[0-9a-f]{40}$/.test(body)) throw new Error(`${prefix} unexpected response${ERROR_SUFFIX}`);
  return body;
}

// Probes one upstream repo for the same slug a custom-repository app just
// resolved to, so an operator installing a fork's copy of an app that also
// exists upstream gets told their custom repository is the one actually
// winning. Unlike resolveHeadSha/resolveAppSource's own ct fetch, a failed
// probe (network error, timeout) is never fatal to the install -- it's
// purely informational, so it's logged and treated as "not shadowed" rather
// than thrown.
async function probeShadow(name: ShadowedRepo, base: string, slug: string, fetchImpl: typeof fetch): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GITHUB_FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${base}/ct/${slug}.sh`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'bellhop' },
    });
    return response.ok;
  } catch (err) {
    logWarn(`Failed to probe ${name} for a shadowed "${slug}" script: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function detectShadows(slug: string, fetchImpl: typeof fetch): Promise<ShadowedRepo[]> {
  const [stable, dev] = await Promise.all([
    probeShadow('ProxmoxVE', UPSTREAM_STABLE_BASE, slug, fetchImpl),
    probeShadow('ProxmoxVED', UPSTREAM_DEV_BASE, slug, fetchImpl),
  ]);
  const shadows: ShadowedRepo[] = [];
  if (stable) shadows.push('ProxmoxVE');
  if (dev) shadows.push('ProxmoxVED');
  return shadows;
}

// The single entry point install-app/update-app (a later unit) will call to
// decide where an --app value actually comes from. Resolves at most once
// per call -- no caching here, see research R5 for why the caller
// (previewAndEnqueue) is what's responsible for resolving once per
// operation rather than once per fetch site.
export async function resolveAppSource(app: string, inv: Inventory, fetchImpl: typeof fetch): Promise<AppSource> {
  // A pasted full script URL is used verbatim, exactly like
  // resolveAppUrl/resolveDevAppUrl already treat it -- no custom-repository
  // involvement, and therefore no network access needed to decide that.
  if (app.includes('://')) return { kind: 'url', shadows: [] };

  const slug = app.toLowerCase();
  const source = customScriptSource(inv);
  if (!source) return { kind: 'upstream', slug, shadows: [] };

  const sha = await resolveHeadSha(source, fetchImpl);
  const prefix = `Custom script repository ${source.label}:`;
  const scriptsBaseUrl = `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${sha}`;
  const ctUrl = `${scriptsBaseUrl}/ct/${slug}.sh`;

  const response = await fetchWithTimeout(ctUrl, fetchImpl, prefix);
  if (response.status === 404) return { kind: 'upstream', slug, shadows: [] };
  if (!response.ok) throw new Error(`${prefix} GitHub returned ${response.status}${ERROR_SUFFIX}`);

  const shadows = await detectShadows(slug, fetchImpl);
  return { kind: 'custom', slug, custom: { ...source, sha }, ctUrl, scriptsBaseUrl, shadows };
}

// The one logWarn line runInstallApp/runUpdateApp (a later unit) emit
// before anything else when an app resolved to the custom repository also
// shadows an upstream copy -- see research R6 for the exact wording and
// placement rationale. Returns undefined for every other case (no shadows,
// or not a custom resolution at all) so callers can `if (warning) logWarn(warning)`
// unconditionally.
export function formatOverrideWarning(source: AppSource): string | undefined {
  if (source.kind !== 'custom' || !source.custom || !source.slug || source.shadows.length === 0) return undefined;
  const shortSha = source.custom.sha.slice(0, 7);
  return `"${source.slug}" is installing from the custom script repository ${source.custom.label} (commit ${shortSha}), which overrides the upstream copy in ${source.shadows.join(', ')}. Unset customScriptsRepo/customScriptsBranch with set-config to use upstream.`;
}
