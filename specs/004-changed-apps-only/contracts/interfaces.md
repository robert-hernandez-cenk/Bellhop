# Interface Contracts: Changed-Apps-Only Custom Resolution

## `src/lib/app-source.ts`

```ts
export interface BranchComparison {
  sha: string;
  mergeBase: string;
  aheadBy: number;
  behindBy: number;
  changedSlugs: Set<string>;
}

// One rate-limited request: GET https://api.github.com/repos/community-scripts/ProxmoxVED/
//   compare/main...<owner>:<repo>:<sha>  (User-Agent: bellhop, 5s timeout, body read inside
//   the timeout like resolveHeadSha).
// Throws `Custom script repository <label>: <reason> -- check customScriptsRepo/customScriptsBranch with "bellhop set-config"`:
//   404 -> "commit <short> not found in community-scripts/ProxmoxVED's fork network (is <owner>/<repo> a fork of ProxmoxVED?)"
//   403/429 -> "GitHub rate limit reached (try again later)"
//   other non-2xx -> "GitHub returned <status>"
//   network/timeout -> "could not reach GitHub (<message>)"
//   schema mismatch -> "unexpected compare response"
//   files.length >= 300 -> "the branch changes 300 or more files, too many to tell which apps it changes"
export function compareBranch(source: CustomScriptSource, sha: string, fetchImpl: typeof fetch): Promise<BranchComparison>;

// Pure: files[] -> changed slugs (research R3).
export function changedSlugsFromFiles(files: { filename: string; status: string }[]): Set<string>;

// Raw-content conflict check (research R5). Never throws; a fetch error is logWarn'd and
// counts as "no conflict". Returns false without fetching when comparison.behindBy === 0.
export function detectConflict(slug: string, comparison: BranchComparison, fetchImpl: typeof fetch): Promise<boolean>;

export interface AppSource {
  kind: 'url' | 'upstream' | 'custom';
  slug?: string;
  custom?: CustomScriptSource & { sha: string; mergeBase: string };
  ctUrl?: string;
  scriptsBaseUrl?: string;
  shadows: ShadowedRepo[];
  changed?: boolean;   // kind 'custom' only
  conflict?: boolean;  // kind 'custom' only
}

// Resolution per data-model.md / research R6. Feature off: no network, as today.
export function resolveAppSource(app: string, inv: Inventory, fetchImpl: typeof fetch): Promise<AppSource>;

export type SourceNotice = { level: 'warn' | 'info'; message: string };
export function formatSourceNotice(source: AppSource): SourceNotice | undefined;
// formatOverrideWarning is removed; its two callers switch to formatSourceNotice.
```

## `src/lib/script-catalog.ts`

```ts
custom?: {
  label: string;
  slugs: string[];                        // changed slugs only
  shadows: Record<string, ShadowedRepo[]>;
  conflicts: string[];                    // subset of slugs
};
```

`getCustomGroup` = `resolveHeadSha` + `compareBranch` + `detectConflict` per changed slug.
Any throw → group omitted + `logWarn` + cooldown (unchanged behavior).

## `src/operations/app-check.ts` → web `GET /api/provisioning/:id/check-app`, MCP `check_install_app`

Custom resolution response gains `conflict: true` when the source conflicts (absent otherwise).

## Web client

- `AppCheckInput.tsx` `Catalog.custom` gains `conflicts: string[]`; a conflicting option shows a
  `conflicts upstream` tag (styled like `app-suggestion-override-tag`).
- Check result `conflict: true` renders a `custom-override-warning` line telling the operator
  upstream also changed the app and to rebase the branch. The existing shadows line is kept for
  the non-conflicting case.

## CLI

No new flags or commands. `install-app`/`update-app` print the notice as their first line
(`[WARN …]` for a conflict, `[INFO …]` for an override).
