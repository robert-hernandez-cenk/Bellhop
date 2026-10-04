import type { SSHClient } from '../../lib/ssh-client.ts';
import type { Inventory } from '../../lib/inventory.ts';
import { runRemote, resolveTarget } from '../../lib/targets.ts';
import { getGuestStatuses } from '../../lib/guest-status.ts';
import { resolveAppUrl, resolveDevAppUrl } from '../provisioning/install-app.ts';
import { createAppSourceResolver, type AppSource } from '../../lib/app-source.ts';
import {
  parseReleaseCheck,
  normalizeVersion,
  decideOutcome,
  fetchLatestRelease,
  createReleaseCache,
  buildInstalledVersionScript,
  type ReleaseCache,
  type ReleaseCheck,
} from '../../lib/app-update-check.ts';
import {
  upsertAppUpdateResult,
  replaceAppUpdateResults,
  type AppUpdateResult,
  type AppUpdateStatus,
} from '../../lib/app-update-store.ts';

// --- Fetching a ct/<slug>.sh script's raw body (research R4) ---

// One result per attempt: a successful body, or a reason an operator can
// act on -- a status code (a plain 404/500/etc.) or a thrown/aborted fetch,
// named with the exact URL that failed so the saved `message` is
// actionable rather than a bare "fetch failed".
type ScriptFetchResult = { ok: true; script: string } | { ok: false; error: string };

const SCRIPT_FETCH_TIMEOUT_MS = 15_000;

interface RawFetchResult {
  ok: boolean;
  status?: number;
  body?: string;
  networkError?: string;
}

async function fetchRaw(url: string, fetchImpl: typeof fetch): Promise<RawFetchResult> {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(SCRIPT_FETCH_TIMEOUT_MS) });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, body: await res.text() };
  } catch (err) {
    return { ok: false, networkError: err instanceof Error ? err.message : String(err) };
  }
}

function rawFetchFailureMessage(url: string, res: RawFetchResult): string {
  return res.networkError ? `Could not fetch ${url}: ${res.networkError}` : `Could not fetch ${url}: HTTP ${res.status}`;
}

// kind 'custom' has already been confirmed to exist at the pinned commit
// (resolveAppSource's own ct/<slug>.sh probe), so it is fetched directly
// with no upstream fallback -- mirrors buildInstallAppScript/
// buildUpdateAppScript's own isCustom split. kind 'upstream' (or 'url',
// never actually reached here -- see the module doc comment below) tries
// the stable repo first and falls back to the dev repo only on a 404,
// the same order buildUpdateAppScript's generated curl uses.
async function fetchScriptUncached(app: string, source: AppSource, fetchImpl: typeof fetch): Promise<ScriptFetchResult> {
  if (source.kind === 'custom') {
    const res = await fetchRaw(source.ctUrl!, fetchImpl);
    return res.ok ? { ok: true, script: res.body! } : { ok: false, error: rawFetchFailureMessage(source.ctUrl!, res) };
  }

  const slug = source.slug ?? app;
  const stableUrl = resolveAppUrl(slug);
  const stable = await fetchRaw(stableUrl, fetchImpl);
  if (stable.ok) return { ok: true, script: stable.body! };
  if (stable.status === 404) {
    const devUrl = resolveDevAppUrl(slug);
    if (devUrl) {
      const dev = await fetchRaw(devUrl, fetchImpl);
      if (dev.ok) return { ok: true, script: dev.body! };
      return { ok: false, error: rawFetchFailureMessage(devUrl, dev) };
    }
  }
  return { ok: false, error: rawFetchFailureMessage(stableUrl, stable) };
}

// Shared per run (research R4's "scripts are cached per slug within a
// run"): two guests sharing the same app resolve to the same AppSource
// (createAppSourceResolver's own per-slug memoization) and therefore the
// same URL(s), so the second guest reuses the first's in-flight/settled
// fetch rather than repeating it. Keyed on the resolved custom ctUrl (not
// just the slug) for a custom source, since that's what's actually fetched.
export type ScriptCache = Map<string, Promise<ScriptFetchResult>>;

function cachedFetchScript(app: string, source: AppSource, fetchImpl: typeof fetch, cache: ScriptCache): Promise<ScriptFetchResult> {
  const key = source.kind === 'custom' ? `custom:${source.ctUrl}` : `upstream:${(source.slug ?? app).toLowerCase()}`;
  const existing = cache.get(key);
  if (existing) return existing;
  const promise = fetchScriptUncached(app, source, fetchImpl);
  cache.set(key, promise);
  return promise;
}

// --- Per-guest outcome labels/layout shared with formatCheckAppUpdates ---

const STATUS_LABELS: Record<AppUpdateStatus, string> = {
  'update-available': 'update available',
  'up-to-date': 'up to date',
  unsupported: 'unsupported',
  'not-checked': 'not checked',
  error: 'error',
};

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorResult(guest: string, app: string, checkedAt: string, message: string, repo?: string): AppUpdateResult {
  return { guest, app, status: 'error', message, checkedAt, ...(repo !== undefined ? { repo } : {}) };
}

// --- checkOneGuest: one guest's full read-and-decide pipeline ---

// Everything checkOneGuest needs, shared across a whole run's worth of
// guests when runCheckAppUpdates builds it -- or omitted entirely by a
// single-guest caller (a `--guest` run, or update-app's post-apply
// re-check, research R10), which gets fresh, empty caches instead. `now`
// defaults to the real clock, matching every other injectable-clock
// convention in this codebase (e.g. TaskRunContext in data-model.md).
export interface CheckAppUpdatesContext {
  ssh: SSHClient;
  inventory: Inventory;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  resolver?: (app: string) => Promise<AppSource>;
  releaseCache?: ReleaseCache;
  scriptCache?: ScriptCache;
}

// Resolves the guest's app source, fetches and parses its ct/<slug>.sh
// script, reads the installed-version record inside the guest (via
// runRemote -- POSIX sh only, per CLAUDE.md), and fetches the latest
// upstream release to decide the outcome. Every failure along the way
// becomes an `error` result for this guest alone (FR-019's isolation is the
// caller's job -- see runCheckAppUpdates below -- but every expected
// failure here is already returned as a value, never thrown, so the
// caller's try/catch is only a backstop for a truly unexpected bug).
// Never checks the guest's running status itself (research R5) -- a
// full-run caller that already knows the guest is stopped skips calling
// this entirely.
export async function checkOneGuest(guestName: string, ctx: CheckAppUpdatesContext): Promise<AppUpdateResult> {
  const now = ctx.now ?? (() => new Date());
  const checkedAt = now().toISOString();
  const fetchImpl = ctx.fetchImpl ?? fetch;

  const guest = ctx.inventory.guests.find((g) => g.name === guestName);
  if (!guest || !guest.app) {
    throw new Error(`Cannot check updates for '${guestName}': no community-scripts app recorded`);
  }
  const app = guest.app;

  const resolver = ctx.resolver ?? createAppSourceResolver(ctx.inventory, fetchImpl);
  const releaseCache = ctx.releaseCache ?? createReleaseCache();
  const scriptCache = ctx.scriptCache ?? new Map();

  let source: AppSource;
  try {
    source = await resolver(app);
  } catch (err) {
    return errorResult(guestName, app, checkedAt, errMsg(err));
  }

  const scriptResult = await cachedFetchScript(app, source, fetchImpl, scriptCache);
  if (!scriptResult.ok) {
    return errorResult(guestName, app, checkedAt, scriptResult.error);
  }

  const parsed = parseReleaseCheck(scriptResult.script, app);
  if (!parsed.ok) {
    return {
      guest: guestName,
      app,
      status: 'unsupported',
      message: parsed.reason ?? `no check_for_gh_release call in ct/${app}.sh`,
      checkedAt,
    };
  }
  const check: ReleaseCheck = parsed.check;

  let installed: string;
  try {
    const versionResult = await runRemote(ctx.ssh, ctx.inventory, guestName, buildInstalledVersionScript(check.name));
    if (versionResult.code === 3) {
      return errorResult(
        guestName,
        app,
        checkedAt,
        `No installed-version record (~/.${check.name}) found in the guest; run the app's update once to create it`,
        check.repo
      );
    }
    if (versionResult.code !== 0) {
      return errorResult(
        guestName,
        app,
        checkedAt,
        `Reading the installed version failed (exit ${versionResult.code}): ${versionResult.stderr.trim() || versionResult.stdout.trim() || 'no output'}`,
        check.repo
      );
    }
    installed = (versionResult.stdout.split('\n')[0] ?? '').trim();
  } catch (err) {
    return errorResult(guestName, app, checkedAt, errMsg(err), check.repo);
  }

  let latest;
  try {
    latest = await fetchLatestRelease(check.repo, { pin: check.pin, prefix: check.prefix }, fetchImpl, releaseCache);
  } catch (err) {
    return errorResult(guestName, app, checkedAt, errMsg(err), check.repo);
  }

  const status = decideOutcome(installed, check, latest.version);
  return {
    guest: guestName,
    app,
    status,
    installedVersion: normalizeVersion(installed),
    latestVersion: latest.version,
    repo: check.repo,
    checkedAt,
  };
}

// --- runCheckAppUpdates: the command's full entry point ---

export interface RunCheckAppUpdatesOptions {
  guest?: string;
  apply?: boolean;
}

export interface RunCheckAppUpdatesDeps {
  ssh: SSHClient;
  inventory: Inventory;
  inventoryPath: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface RunCheckAppUpdatesResult {
  results: AppUpdateResult[];
  saved: boolean;
}

// `--guest <name>`: skips the status query entirely (research R5) and
// upserts just that one row -- the three validation messages below are
// verbatim from contracts/cli.md. Without `--guest`: every `lxc` guest
// with an `app` recorded (FR-012) is checked, a guest the one status query
// (getGuestStatuses) reports `stopped` is reported `not-checked` with no
// remote call at all, and a guest whose *host's* status query failed is
// still attempted -- getGuestStatuses already folds a failed host into its
// own `failures` list rather than `statuses`, so such a guest simply has
// no entry in `statuses` and falls through to a normal attempt below.
export async function runCheckAppUpdates(
  opts: RunCheckAppUpdatesOptions,
  deps: RunCheckAppUpdatesDeps
): Promise<RunCheckAppUpdatesResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => new Date());
  const ctx: CheckAppUpdatesContext = {
    ssh: deps.ssh,
    inventory: deps.inventory,
    fetchImpl,
    now,
    resolver: createAppSourceResolver(deps.inventory, fetchImpl),
    releaseCache: createReleaseCache(),
    scriptCache: new Map(),
  };

  if (opts.guest) {
    const target = resolveTarget(deps.inventory, opts.guest);
    if (target.kind !== 'lxc') {
      throw new Error(`${opts.guest} is not an LXC guest -- check-app-updates only checks LXC guests`);
    }
    if (!target.guest.app) {
      throw new Error(`${opts.guest} has no community-scripts app recorded -- nothing to check`);
    }

    const result = await checkOneGuest(opts.guest, ctx);
    if (opts.apply) {
      upsertAppUpdateResult(deps.inventoryPath, result);
    }
    return { results: [result], saved: !!opts.apply };
  }

  const eligible = deps.inventory.guests.filter((g) => g.type === 'lxc' && g.app);
  const { statuses } = await getGuestStatuses(deps.ssh, deps.inventory);

  const results: AppUpdateResult[] = [];
  for (const guest of eligible) {
    if (statuses[guest.name] === 'stopped') {
      results.push({ guest: guest.name, app: guest.app!, status: 'not-checked', message: 'Guest is stopped', checkedAt: now().toISOString() });
      continue;
    }
    try {
      results.push(await checkOneGuest(guest.name, ctx));
    } catch (err) {
      results.push({ guest: guest.name, app: guest.app!, status: 'error', message: errMsg(err), checkedAt: now().toISOString() });
    }
  }
  results.sort((a, b) => a.guest.localeCompare(b.guest));

  if (opts.apply) {
    replaceAppUpdateResults(deps.inventoryPath, results);
  }
  return { results, saved: !!opts.apply };
}

// --- CLI/job-log formatting (contracts/cli.md's line layout) ---

const GUEST_COL_WIDTH = 12;
const APP_COL_WIDTH = 12;
const STATUS_COL_WIDTH = 18;

function formatResultLine(r: AppUpdateResult): string {
  const label = STATUS_LABELS[r.status];
  let detail: string;
  if (r.status === 'update-available') {
    detail = `${r.installedVersion} -> ${r.latestVersion}   (${r.repo})`;
  } else if (r.status === 'up-to-date') {
    detail = r.repo ? `${r.installedVersion}   (${r.repo})` : (r.installedVersion ?? '');
  } else {
    detail = r.message ?? '';
  }
  return `${r.guest.padEnd(GUEST_COL_WIDTH)}${r.app.padEnd(APP_COL_WIDTH)}${label.padEnd(STATUS_COL_WIDTH)}${detail}`;
}

// One line per guest, sorted by name (runCheckAppUpdates already sorts its
// full-run results; a `--guest` result is trivially sorted on its own).
// Deliberately excludes the CLI's `[DRY RUN]` trailer line -- that belongs
// to the CLI layer (src/cli.ts), which prints it separately per
// contracts/cli.md, so this function's output is identical for a dry run
// and an applied run and reusable as-is for the scheduler's job log
// (research R9).
export function formatCheckAppUpdates(result: RunCheckAppUpdatesResult): string {
  return result.results.map(formatResultLine).join('\n');
}
