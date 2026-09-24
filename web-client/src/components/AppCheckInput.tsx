import { useEffect, useRef, useState } from 'react';
import { apiGet } from '../api/client';
import type { AppCheckResponse, AppDefaults } from '../api/types';

export type CheckStatus = 'idle' | 'checking' | 'ok' | 'missing';

interface Catalog {
  stable: string[];
  dev: string[];
}

// A one-character filter can match hundreds of the ~671 catalog slugs.
// Rendering them all would push that many nodes into the DOM, which is
// especially unwelcome on a phone -- cap each group and tell the operator
// to keep typing instead.
const MAX_ROWS_PER_GROUP = 50;

// Ranks matches for one group (stable/dev rank independently, each called
// separately) so an exact match always sorts first, then prefix matches,
// then any remaining substring match -- alphabetical within each tier.
// Plain `slug.includes(query)` over the already-alphabetically-sorted
// catalog left an exact match ranked below any alphabetically-earlier slug
// that merely contains it (e.g. typing "caddy" put "alpine-caddy" at row 0
// ahead of the exact "caddy" match) -- affects 33 of 591 live slugs, mostly
// the alpine-* family. Must run before the MAX_ROWS_PER_GROUP slice, or the
// cap could cut the very match just typed.
function rankMatches(slugs: string[], query: string): string[] {
  const exact: string[] = [];
  const prefix: string[] = [];
  const substring: string[] = [];
  for (const slug of slugs) {
    if (slug === query) exact.push(slug);
    else if (slug.startsWith(query)) prefix.push(slug);
    else substring.push(slug);
  }
  return [...exact, ...prefix, ...substring];
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  checkEndpoint: string;
  onStatusChange: (status: CheckStatus) => void;
  onDefaults?: (defaults: AppDefaults) => void;
  // Fires with the app's own slug (never a pasted full URL, which isn't a
  // meaningful hostname/subdomain base) whenever the check resolves
  // successfully -- independent of onDefaults, since a script that
  // declares no var_cpu/var_ram/var_disk still has a valid slug to name
  // the guest after.
  onExists?: (appSlug: string) => void;
}

export function AppCheckInput({ value, onChange, checkEndpoint, onStatusChange, onDefaults, onExists }: Props) {
  // Set when the check only succeeded against the dev repo (see
  // checkAppUrl's `dev` flag) -- the app isn't in the main community-scripts
  // repo yet, so the install itself relies on buildInstallAppScript's
  // curl-time fallback rather than a graduated, stable script. Driven by the
  // check response, never by which group a suggestion was clicked in, so
  // dev-ness has exactly one source of truth.
  const [devWarning, setDevWarning] = useState(false);
  // The app's own interactive `read` prompts, pre-scanned out of its install
  // script (issue #160). Shown up front so the operator knows the run needs
  // babysitting before they click Apply, rather than discovering it when the
  // job pauses several minutes in.
  const [scriptPrompts, setScriptPrompts] = useState<string[]>([]);
  // Set when the resolved source is the operator-configured custom script
  // repository (issue #11, research R5/R8) -- the repo@branch label and the
  // pinned commit's short SHA, shown so the operator knows exactly what
  // Apply will install from.
  const [custom, setCustom] = useState<{ label: string; sha: string } | undefined>(undefined);
  // Non-empty only for a custom resolution that also shadows an upstream
  // copy of the same slug (research R6) -- the ProxmoxVE/ProxmoxVED names
  // whose install this overrides.
  const [shadows, setShadows] = useState<string[]>([]);
  // Set when resolving --app itself threw (a misconfigured
  // customScriptsRepo/customScriptsBranch, or GitHub unreachable) -- shown
  // under the field, with the status left 'missing' the same as any other
  // non-existent app.
  const [checkError, setCheckError] = useState<string | undefined>(undefined);
  const [catalog, setCatalog] = useState<Catalog>({ stable: [], dev: [] });
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const listRef = useRef<HTMLUListElement>(null);
  // The (normalized) value runCheck last actually issued a check for --
  // null until the first check. select()'s immediate runCheck already
  // covers the value at selection time, so onBlur skips re-checking the
  // exact same value a second time (each check re-fetches the script from
  // raw.githubusercontent.com server-side). Only runCheck itself writes
  // this, so any edit after a check leaves it stale and still triggers a
  // re-check on the next blur.
  const lastCheckedRef = useRef<string | null>(null);

  // Fetched once per mount. A failure is swallowed: the field then behaves
  // exactly as it did before this catalog existed -- a plain text input.
  useEffect(() => {
    let cancelled = false;
    apiGet<Catalog>('/provisioning/install-app/apps')
      .then((fetched) => {
        if (!cancelled) setCatalog({ stable: fetched.stable ?? [], dev: fetched.dev ?? [] });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const runCheck = async (raw: string) => {
    if (!raw) {
      onStatusChange('idle');
      setDevWarning(false);
      setScriptPrompts([]);
      setCustom(undefined);
      setShadows([]);
      setCheckError(undefined);
      return;
    }
    // Mirror resolveAppUrl's own bare-slug-vs-URL split: a bare slug gets
    // lowercased since community-scripts is all-lowercase, but a pasted
    // full URL is left exactly as typed. Reflecting the normalized value
    // back into the field keeps what's displayed in sync with what's
    // actually checked/installed, instead of showing the original casing
    // while silently checking a different string.
    const normalized = raw.includes('://') ? raw : raw.toLowerCase();
    if (normalized !== raw) onChange(normalized);
    lastCheckedRef.current = normalized;
    onStatusChange('checking');
    try {
      const res = await apiGet<AppCheckResponse>(`${checkEndpoint}?value=${encodeURIComponent(normalized)}`);
      onStatusChange(res.exists ? 'ok' : 'missing');
      setDevWarning(!!res.dev);
      setScriptPrompts(res.exists ? res.prompts ?? [] : []);
      setCustom(res.exists ? res.custom : undefined);
      setShadows(res.exists ? res.shadows ?? [] : []);
      setCheckError(res.error);
      if (res.exists && res.defaults) onDefaults?.(res.defaults);
      if (res.exists && !normalized.includes('://')) onExists?.(normalized);
    } catch {
      onStatusChange('missing');
      setDevWarning(false);
      setScriptPrompts([]);
      setCustom(undefined);
      setShadows([]);
      setCheckError(undefined);
    }
  };

  // A pasted full URL is not a slug, so it never gets suggestions.
  const query = value.trim().toLowerCase();
  const filtering = query !== '' && !value.includes('://');
  const matchIn = (slugs: string[]) =>
    filtering ? rankMatches(slugs.filter((slug) => slug.includes(query)), query) : [];
  const stableMatches = matchIn(catalog.stable);
  const devMatches = matchIn(catalog.dev);
  const shownStable = stableMatches.slice(0, MAX_ROWS_PER_GROUP);
  const shownDev = devMatches.slice(0, MAX_ROWS_PER_GROUP);
  const flatMatches = [...shownStable, ...shownDev];
  const showPopup = open && flatMatches.length > 0;

  useEffect(() => {
    if (!showPopup || activeIndex < 0) return;
    listRef.current?.querySelector(`[data-index="${activeIndex}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, showPopup]);

  const select = (slug: string) => {
    onChange(slug);
    setOpen(false);
    setActiveIndex(-1);
    void runCheck(slug);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActiveIndex((i) => Math.min(i + 1, flatMatches.length - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
      return;
    }
    // Only swallow Enter when a suggestion is actually highlighted --
    // otherwise it must keep submitting the form (running Preview) as before.
    if (e.key === 'Enter' && showPopup && activeIndex >= 0) {
      e.preventDefault();
      select(flatMatches[activeIndex]);
    }
  };

  const renderOption = (slug: string, index: number) => (
    <li
      key={slug}
      data-index={index}
      role="option"
      aria-selected={index === activeIndex}
      className={`app-suggestion${index === activeIndex ? ' app-suggestion-active' : ''}`}
      // Fires before blur, so the click isn't lost to the popup closing first.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => select(slug)}
    >
      {slug}
    </li>
  );

  return (
    <div className="app-suggestions-wrap">
      <input
        className="field-input"
        value={value}
        placeholder="e.g. plex, or paste a full script URL"
        role="combobox"
        aria-expanded={showPopup}
        aria-autocomplete="list"
        autoComplete="off"
        onChange={(e) => {
          onChange(e.target.value);
          onStatusChange('idle');
          setDevWarning(false);
          setScriptPrompts([]);
          setCustom(undefined);
          setShadows([]);
          setCheckError(undefined);
          setOpen(true);
          setActiveIndex(-1);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          setOpen(false);
          // select() already ran a check for this exact value -- skip a
          // redundant second one (and re-fetch) unless the operator edited
          // the field since. An empty value never matches lastCheckedRef
          // (initially null, and runCheck never stores '' there), so
          // clearing the field still resets status to idle as before.
          if (value === lastCheckedRef.current) return;
          void runCheck(value);
        }}
      />
      {showPopup && (
        <ul className="app-suggestions" role="listbox" ref={listRef}>
          {shownStable.length > 0 && (
            <li className="app-suggestions-group" role="presentation">
              ProxmoxVE (stable)
            </li>
          )}
          {shownStable.map((slug, i) => renderOption(slug, i))}
          {stableMatches.length > shownStable.length && (
            <li className="app-suggestions-more" role="presentation">
              …and {stableMatches.length - shownStable.length} more — keep typing
            </li>
          )}
          {shownDev.length > 0 && (
            <li className="app-suggestions-group app-suggestions-group-dev" role="presentation">
              ProxmoxVED (development)
            </li>
          )}
          {shownDev.map((slug, i) => renderOption(slug, shownStable.length + i))}
          {devMatches.length > shownDev.length && (
            <li className="app-suggestions-more" role="presentation">
              …and {devMatches.length - shownDev.length} more — keep typing
            </li>
          )}
        </ul>
      )}
      {checkError && <div className="app-check-error">{checkError}</div>}
      {custom && (
        <div className="app-custom-notice">
          Installing from the custom script repository {custom.label} (commit {custom.sha.slice(0, 7)}).
        </div>
      )}
      {shadows.length > 0 && custom && (
        <div className="custom-override-warning">
          This installs your custom copy from {custom.label}, overriding the upstream copy in {shadows.join(', ')}.
        </div>
      )}
      {devWarning && (
        <div className="dev-app-warning">
          This app is still in development (community-scripts' ProxmoxVED repo) — it hasn't graduated to the stable
          catalog yet.
        </div>
      )}
      {scriptPrompts.length > 0 && (
        <div className="app-prompts-notice">
          This app asks up to {scriptPrompts.length} question{scriptPrompts.length === 1 ? '' : 's'} during install. The job
          will pause and wait for each answer.
          <ul className="app-prompts-notice-list">
            {scriptPrompts.map((prompt, index) => {
              // A prompt whose text is built entirely from a variable (e.g. read -p "$msg" or read -p "${VAR}")
              // strips to an empty string. Render a fallback label so the list length always matches the
              // stated count. Such a prompt also falls below the 8-character minimum for the runtime matcher,
              // so it relies on the later detection tiers anyway.
              const text = prompt.replace(/\$\{[^}]*\}/g, '').replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, '').trim();
              return <li key={`${index}-${prompt}`}>{text === '' ? <em>(question text is built at runtime)</em> : text}</li>;
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
