import Database from 'better-sqlite3';
import { logWarn } from './log.ts';
import { openDb } from './sqlite.ts';
import type { Inventory } from './inventory.ts';
import {
  compareBranch,
  customScriptSource,
  detectConflict,
  resolveHeadSha,
  type CustomScriptSource,
  type ShadowedRepo,
} from './app-source.ts';

// How stale a stored catalog may get before getScriptCatalog refetches it.
// Read-triggered only -- there is no background timer and no manual refresh
// control anywhere in the CLI or web UI.
export const CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// The custom-repository group (issue #11) is never persisted (see the
// getCustomGroup comment below for why), so it gets its own, much shorter
// TTL than the persisted upstream catalog's 24h -- an operator adding an app
// to their fork branch should see it in the suggestion list soon after,
// not up to a day later.
export const CUSTOM_CATALOG_MAX_AGE_MS = 5 * 60 * 1000;

const GITHUB_OWNER = 'community-scripts';
const CATALOG_FETCH_TIMEOUT_MS = 5000;

// The community-scripts org publishes no machine-readable catalog metadata
// (no descriptions, categories, or icons anywhere in an active repo -- the
// per-script JSON that once backed their website lives in the archived
// ProxmoxVE-Frontend-Archive). The ct/ directory listing is therefore the
// only catalog source, and slugs are all it can yield.
const STABLE_REPO = 'ProxmoxVE';
const DEV_REPO = 'ProxmoxVED';

export interface CatalogSlugs {
  stable: string[];
  dev: string[];
}

interface ContentsEntry {
  name?: unknown;
  type?: unknown;
}

// GitHub's contents API caps a single directory listing at 1000 entries,
// with no pagination support on this endpoint for a directory this size.
// ProxmoxVE's ct/ was at 591 entries on 2026-08-15 and grows steadily --
// this doesn't paginate around the ceiling, it only detects and warns when
// a listing comes back at or past it, so a future silent truncation shows
// up in the logs instead of just quietly shrinking the catalog.
const GITHUB_CONTENTS_LISTING_CEILING = 1000;

// Lists one community-scripts repo's ct/ directory, for the persisted
// upstream catalog (fetchCatalog, below) only. The custom group no longer
// lists the fork's ct/ at all (issue #15, research R8): a fork carries every
// inherited upstream app, so its whole listing is not what the operator is
// working on -- getCustomGroup uses the branch's compare result instead.
async function fetchRepoSlugs(
  target: { owner: string; repo: string },
  fetchImpl: typeof fetch
): Promise<string[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CATALOG_FETCH_TIMEOUT_MS);
  try {
    const label = `${target.owner}/${target.repo}`;
    const url = `https://api.github.com/repos/${label}/contents/ct`;
    const response = await fetchImpl(url, {
      signal: controller.signal,
      // GitHub rejects unauthenticated API requests that send no User-Agent.
      headers: { 'User-Agent': 'bellhop', Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) throw new Error(`GitHub returned ${response.status} listing ${label}/ct`);
    const body: unknown = await response.json();
    if (!Array.isArray(body)) {
      throw new Error(`GitHub returned a non-array response listing ${label}/ct`);
    }
    if (body.length >= GITHUB_CONTENTS_LISTING_CEILING) {
      logWarn(
        `${label}/ct listing returned ${body.length} entries, at or past GitHub's ${GITHUB_CONTENTS_LISTING_CEILING}-entry contents API ceiling -- the catalog may be silently truncated`
      );
    }
    const entries = body as ContentsEntry[];
    return entries
      // A missing `type` is treated as a file, deliberately leniently -- a
      // future GitHub API shape change that stops sending `type` at all
      // must not silently blank the whole catalog (which, combined with
      // getScriptCatalog's empty-stable guard, would degrade the feature
      // rather than just failing to filter out directories).
      .filter((entry) => entry.type === undefined || entry.type === 'file')
      .map((entry) => (typeof entry.name === 'string' ? entry.name : ''))
      .filter((name) => name.endsWith('.sh'))
      .map((name) => name.slice(0, -'.sh'.length).toLowerCase())
      .sort();
  } finally {
    clearTimeout(timeout);
  }
}

// Lists every ct/<slug>.sh script in both community-scripts repos. A slug
// present in both is reported under `stable` only: checkAppUrl and
// buildInstallAppScript's generated curl both try the stable repo first and
// fall back to dev only on a 404, so the dev copy is unreachable and listing
// it would misrepresent what actually gets installed.
export async function fetchCatalog(fetchImpl: typeof fetch = fetch): Promise<CatalogSlugs> {
  const [stable, dev] = await Promise.all([
    fetchRepoSlugs({ owner: GITHUB_OWNER, repo: STABLE_REPO }, fetchImpl),
    fetchRepoSlugs({ owner: GITHUB_OWNER, repo: DEV_REPO }, fetchImpl),
  ]);
  const stableSlugs = new Set(stable);
  return { stable, dev: dev.filter((slug) => !stableSlugs.has(slug)) };
}

// Lives in the same bellhop.db file as the inventory, but as its own
// tables outside saveInventory's DELETE FROM .../re-insert list -- so a
// sync-inventory --apply run never disturbs the cached catalog. Same
// precedent as src/lib/permissions.ts's permission_groups/permission_rules.
// The single-row CHECK (id = 1) meta table mirrors the existing caddy_owner
// shape.
const CATALOG_SCHEMA = `
  CREATE TABLE IF NOT EXISTS script_catalog (
    repo TEXT NOT NULL CHECK (repo IN ('stable', 'dev')),
    slug TEXT NOT NULL,
    PRIMARY KEY (repo, slug)
  );
  CREATE TABLE IF NOT EXISTS script_catalog_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    fetched_at TEXT NOT NULL
  );
`;

function openCatalogDb(dbPath: string): Database.Database {
  return openDb(dbPath, CATALOG_SCHEMA);
}

interface CatalogRow {
  repo: 'stable' | 'dev';
  slug: string;
}

export function loadCatalog(dbPath: string): (CatalogSlugs & { fetchedAt: string }) | undefined {
  const db = openCatalogDb(dbPath);
  try {
    const meta = db.prepare('SELECT fetched_at FROM script_catalog_meta WHERE id = 1').get() as
      | { fetched_at: string }
      | undefined;
    if (!meta) return undefined;
    const rows = db.prepare('SELECT repo, slug FROM script_catalog ORDER BY slug').all() as CatalogRow[];
    return {
      stable: rows.filter((row) => row.repo === 'stable').map((row) => row.slug),
      dev: rows.filter((row) => row.repo === 'dev').map((row) => row.slug),
      fetchedAt: meta.fetched_at,
    };
  } finally {
    db.close();
  }
}

// Wholesale replace in one transaction -- a slug removed upstream must
// disappear here too, so there is nothing to merge.
export function saveCatalog(dbPath: string, catalog: CatalogSlugs, now: Date): void {
  const db = openCatalogDb(dbPath);
  try {
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM script_catalog').run();
      const insert = db.prepare('INSERT INTO script_catalog (repo, slug) VALUES (?, ?)');
      for (const slug of catalog.stable) insert.run('stable', slug);
      for (const slug of catalog.dev) insert.run('dev', slug);
      db.prepare(
        `INSERT INTO script_catalog_meta (id, fetched_at) VALUES (1, @fetched_at)
         ON CONFLICT(id) DO UPDATE SET fetched_at = excluded.fetched_at`
      ).run({ fetched_at: now.toISOString() });
    });
    tx();
  } finally {
    db.close();
  }
}

export interface ScriptCatalog extends CatalogSlugs {
  fetchedAt: string | null;
  // Informational only: true means the returned lists came from an expired
  // stored copy (or are empty) because the refetch failed. The web client
  // ignores this and renders no banner -- with no manual refresh control
  // there would be no action for one to offer.
  stale: boolean;
  // The apps the operator's configured custom script repository branch
  // changes relative to upstream ProxmoxVED (issue #15, data-model.md
  // "Catalog response") -- not the fork's whole ct/ listing. Absent when the
  // feature is off (no inventory passed, or both settings unset), when the
  // settings are half-configured, or when the head-SHA pin or compare call
  // failed -- getScriptCatalog must never throw over this, so every one of
  // those cases just omits the group rather than failing the whole catalog.
  // `slugs` (sorted) are also removed from `stable`/`dev` above (in this
  // response only -- the persisted script_catalog table is untouched).
  // `shadows` is keyed by slug, present only for a slug that also exists in
  // `stable`/`dev` before removal. `conflicts` is the subset of `slugs`
  // upstream ProxmoxVED also changed since the branch point
  // (detectConflict) -- always empty for a branch that isn't behind.
  custom?: {
    label: string;
    slugs: string[];
    shadows: Record<string, ShadowedRepo[]>;
    conflicts: string[];
  };
}

// getScriptCatalog is read-triggered on every /install-app/apps request (the
// Install App form re-fetches on every mount), with no manual refresh
// control or background timer to fall back on -- see the CATALOG_MAX_AGE_MS
// comment above. Two module-scope pieces of state keep that from hammering
// GitHub's unauthenticated 60/hour limit:
//
// - inFlightFetch memoizes a fetchCatalog() call in progress, so concurrent
//   requests that all land during the same round trip share one GitHub call
//   instead of each starting their own.
// - lastFailureAt records when a fetch last failed (including the
//   empty-listing case below); a subsequent call within
//   FETCH_FAILURE_COOLDOWN_MS of that skips retrying GitHub entirely and
//   goes straight to the same stale/empty fallback a fresh failure would
//   produce.
//
// Both are process-lifetime state, which is fine in production (one running
// web service) but means tests in the same file must call
// resetCatalogFetchState() to avoid one test's failure/in-flight state
// leaking into the next.
let inFlightFetch: Promise<CatalogSlugs> | null = null;
let lastFailureAt: number | null = null;
const FETCH_FAILURE_COOLDOWN_MS = 60 * 1000;

// The custom-repository group's own cache (issue #11), modeled on the pair
// above but deliberately never persisted to script_catalog: at a 5-minute
// TTL it would be stale in the database anyway (research R4), and adding a
// third `repo` value there would need a CHECK-constraint table rebuild for
// no real benefit. Keyed by the source's own "<owner>/<repo>@<branch>"
// label, so changing either setting changes the key and the old listing is
// never served (data-model.md "Catalog response") -- a stale cache entry
// under an old key just goes unused rather than needing an explicit evict.
// customLastFailureAt mirrors lastFailureAt's single-scalar cooldown rather
// than being keyed too: it only ever blocks a retry for a few seconds
// (FETCH_FAILURE_COOLDOWN_MS), and keeping it a single scalar matches the
// existing pattern exactly rather than adding a second Map for a rare edge
// case (a settings change landing within seconds of a prior failure).
interface CustomGroup {
  label: string;
  slugs: string[];
  conflicts: string[];
}
const customCatalogCache = new Map<string, { group: CustomGroup; fetchedAt: number }>();
let customLastFailureAt: number | null = null;

// Test-only hook: clears the module-scope state above. Never called from
// production code -- there is deliberately no way to force a refetch from
// the CLI or web UI (see the module-level "no manual refresh control"
// note).
export function resetCatalogFetchState(): void {
  inFlightFetch = null;
  lastFailureAt = null;
  customCatalogCache.clear();
  customLastFailureAt = null;
}

function fallback(stored: (CatalogSlugs & { fetchedAt: string }) | undefined): ScriptCatalog {
  if (stored) return { ...stored, stale: true };
  return { stable: [], dev: [], fetchedAt: null, stale: true };
}

async function getUpstreamCatalog(dbPath: string, fetchImpl: typeof fetch, now: Date): Promise<ScriptCatalog> {
  const stored = loadCatalog(dbPath);
  if (stored && now.getTime() - Date.parse(stored.fetchedAt) < CATALOG_MAX_AGE_MS) {
    return { ...stored, stale: false };
  }

  if (lastFailureAt !== null && now.getTime() - lastFailureAt < FETCH_FAILURE_COOLDOWN_MS) {
    return fallback(stored);
  }

  try {
    if (!inFlightFetch) {
      inFlightFetch = fetchCatalog(fetchImpl).finally(() => {
        inFlightFetch = null;
      });
    }
    const fresh = await inFlightFetch;
    // An HTTP 200 with an empty ct/ listing is indistinguishable from a
    // real success at the fetchCatalog layer, but community-scripts' stable
    // repo is never actually empty -- treat it as a failure so it falls
    // through to the same stale-serving catch below instead of overwriting
    // a good cache with an empty one for a full CATALOG_MAX_AGE_MS. `dev`
    // legitimately can be empty (community-scripts sometimes has no
    // dev-only scripts), so only `stable` is checked.
    if (fresh.stable.length === 0) {
      throw new Error('community-scripts returned an empty ct/ listing');
    }
    try {
      saveCatalog(dbPath, fresh, now);
    } catch (err) {
      // A failed write is not a failed read -- serve what was fetched.
      logWarn(`Failed to persist the community-scripts catalog: ${String(err)}`);
    }
    lastFailureAt = null;
    return { ...fresh, fetchedAt: now.toISOString(), stale: false };
  } catch (err) {
    logWarn(`Failed to refresh the community-scripts catalog: ${String(err)}`);
    lastFailureAt = now.getTime();
    return fallback(stored);
  }
}

// Computes the custom group -- the slugs the configured branch changes, and
// which of those upstream also changed (issue #15, research R8) -- memoized
// by getScriptCatalog's own cache/cooldown below. Pins the branch head
// (resolveHeadSha) and compares it against upstream ProxmoxVED
// (compareBranch), the same two rate-limited requests resolveAppSource
// makes; the conflict check costs no API quota (detectConflict reads raw
// content, and only when the branch is behind). Returns undefined for every
// case data-model.md says omits the group: feature off (no inventory, or
// both settings unset), half-configured (customScriptSource throws), or
// either GitHub call failing -- every one of those is logged via logWarn
// except "feature off", which isn't a problem to warn about at all.
async function getCustomGroup(
  inventory: Inventory | undefined,
  fetchImpl: typeof fetch,
  now: Date
): Promise<CustomGroup | undefined> {
  if (!inventory) return undefined;

  let source: CustomScriptSource | undefined;
  try {
    source = customScriptSource(inventory);
  } catch (err) {
    logWarn(`Skipping the custom script catalog group: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
  if (!source) return undefined;

  const cached = customCatalogCache.get(source.label);
  if (cached && now.getTime() - cached.fetchedAt < CUSTOM_CATALOG_MAX_AGE_MS) {
    return cached.group;
  }

  if (customLastFailureAt !== null && now.getTime() - customLastFailureAt < FETCH_FAILURE_COOLDOWN_MS) {
    // Still cooling down from a recent failure -- skip the network calls and
    // omit the group entirely rather than retry on every single catalog
    // request while the fork (or GitHub itself) is unreachable.
    return undefined;
  }

  try {
    const sha = await resolveHeadSha(source, fetchImpl);
    const comparison = await compareBranch(source, sha, fetchImpl);
    const slugs = [...comparison.changedSlugs].sort();
    // detectConflict never throws (a failed read is logged and counts as no
    // conflict) and makes no fetch at all when the branch isn't behind.
    const flags = await Promise.all(slugs.map((slug) => detectConflict(slug, comparison, fetchImpl)));
    const group: CustomGroup = { label: source.label, slugs, conflicts: slugs.filter((_, i) => flags[i]) };
    customCatalogCache.set(source.label, { group, fetchedAt: now.getTime() });
    customLastFailureAt = null;
    return group;
  } catch (err) {
    logWarn(`Failed to fetch the custom script catalog (${source.label}): ${err instanceof Error ? err.message : String(err)}`);
    customLastFailureAt = now.getTime();
    return undefined;
  }
}

// Strips the custom group's slugs out of stable/dev (in this response only
// -- the persisted script_catalog table this reads from is never touched)
// and records, per removed slug, which upstream repo(s) it shadowed.
function withCustomGroup(base: ScriptCatalog, custom: CustomGroup): ScriptCatalog {
  const stableSet = new Set(base.stable);
  const devSet = new Set(base.dev);
  const customSlugs = new Set(custom.slugs);
  const shadows: Record<string, ShadowedRepo[]> = {};
  for (const slug of custom.slugs) {
    const shadowedBy: ShadowedRepo[] = [];
    if (stableSet.has(slug)) shadowedBy.push('ProxmoxVE');
    if (devSet.has(slug)) shadowedBy.push('ProxmoxVED');
    if (shadowedBy.length > 0) shadows[slug] = shadowedBy;
  }
  return {
    ...base,
    stable: base.stable.filter((slug) => !customSlugs.has(slug)),
    dev: base.dev.filter((slug) => !customSlugs.has(slug)),
    custom: { label: custom.label, slugs: custom.slugs, shadows, conflicts: custom.conflicts },
  };
}

// Never rejects. Every failure path degrades to the best list available,
// because an unusable dropdown must not block the Install App form -- the
// App field stays free text and check-app still validates whatever is typed.
// `inventory` is optional so every existing call site/test that doesn't
// care about the custom group needs no change; every real caller (the web
// route and the MCP tool, issue #11) now passes it.
export async function getScriptCatalog(
  dbPath: string,
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date(),
  inventory?: Inventory
): Promise<ScriptCatalog> {
  const base = await getUpstreamCatalog(dbPath, fetchImpl, now);
  const custom = await getCustomGroup(inventory, fetchImpl, now);
  return custom ? withCustomGroup(base, custom) : base;
}
