import { useEffect, useState } from 'react';
import { apiGet, apiPatch } from '../api/client';
import type { GuestEntry } from '../api/types';

interface Rung {
  name: string;
  // null when Authentik is unconfigured -- existence is simply unknown then,
  // which is different from known-missing.
  exists: boolean | null;
}

interface AuthGroupsResponse {
  configured: boolean;
  canLower: boolean;
  rungs: Rung[];
}

interface OffLadderEntry {
  slug: string;
  authGroup: string;
}

interface PatchResponse {
  guest: GuestEntry;
  caddySynced: boolean;
  caddyError?: string;
  authentikConflicts?: string[];
  authentikOffLadder?: OffLadderEntry[];
  authentikMissingRungs?: string[];
}

interface Props {
  guest: GuestEntry;
  onSaved: () => void;
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'caddy-error' | 'error';

const NONE = '';

export function EditableAuthGroup({ guest, onSaved }: Props) {
  const [authGroup, setAuthGroup] = useState(guest.authGroup ?? NONE);
  const [ladder, setLadder] = useState<AuthGroupsResponse | null>(null);
  const [ladderError, setLadderError] = useState<string | null>(null);
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<string[]>([]);
  const [offLadder, setOffLadder] = useState<OffLadderEntry[]>([]);
  const [missingRungs, setMissingRungs] = useState<string[]>([]);

  // Rows are keyed by guest name, not remounted on refresh, so local state
  // must be re-synced whenever a fresh guest.authGroup comes in via props
  // (e.g. after sync-inventory or another client's edit) -- otherwise it
  // keeps showing whatever it had at mount time.
  useEffect(() => {
    setAuthGroup(guest.authGroup ?? NONE);
  }, [guest.authGroup]);

  // Fetched here rather than lifted to the Dashboard: the Advanced modal is
  // per-guest and mounted only while open, so this is one request per modal
  // open, not one per table row.
  useEffect(() => {
    apiGet<AuthGroupsResponse>('/auth-groups')
      .then(setLadder)
      .catch((err) => setLadderError(err instanceof Error ? err.message : String(err)));
  }, []);

  const save = async (next: string) => {
    const previous = authGroup;
    setAuthGroup(next);
    setStatus('saving');
    setError(null);
    setConflicts([]);
    setOffLadder([]);
    setMissingRungs([]);
    try {
      const res = await apiPatch<PatchResponse>(`/inventory/guests/${encodeURIComponent(guest.name)}`, {
        authGroup: next === NONE ? null : next,
      });
      setConflicts(res.authentikConflicts ?? []);
      setOffLadder(res.authentikOffLadder ?? []);
      setMissingRungs(res.authentikMissingRungs ?? []);
      if (res.caddySynced) {
        setStatus('saved');
      } else {
        setStatus('caddy-error');
        setError(`Saved, but Caddy sync failed: ${res.caddyError}`);
      }
      onSaved();
    } catch (err) {
      setAuthGroup(previous);
      setStatus('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const rungs = ladder?.rungs ?? [];
  const canLower = ladder?.canLower ?? false;
  const curIdx = rungs.findIndex((r) => r.name === authGroup);
  // A stored value that is no longer a ladder rung: the server refuses every
  // change to it from a non-admin, so mirror that here.
  const curOffLadder = authGroup !== NONE && curIdx === -1;
  const disabled = ladder === null || !ladder.configured || ladderError !== null || status === 'saving';

  const optionDisabled = (idx: number, exists: boolean | null): boolean => {
    if (exists === false) return true;
    if (canLower) return false;
    if (curOffLadder) return true;
    return idx < curIdx;
  };

  return (
    <div>
      <select
        className="field-input"
        value={authGroup}
        disabled={disabled}
        onChange={(e) => save(e.target.value)}
        aria-label="Auth group"
        title="Auth group"
      >
        <option value={NONE} disabled={!canLower && authGroup !== NONE}>
          No authentication
        </option>
        {rungs.map((rung, idx) => (
          <option key={rung.name} value={rung.name} disabled={optionDisabled(idx, rung.exists)}>
            {rung.exists === false ? `${rung.name} (missing in Authentik)` : rung.name}
          </option>
        ))}
        {/* A stored authGroup that is no longer on the ladder still has to
            render, or the controlled <select> would silently display a
            different value than is actually saved -- same reason
            EditableVpn keeps a "(missing)" option for a deleted gateway. */}
        {curOffLadder && (
          <option value={authGroup} disabled>
            {authGroup} (not on the ladder)
          </option>
        )}
      </select>
      {status === 'saving' && <span className="save-status">Saving…</span>}
      {status === 'saved' && <span className="save-status">Saved, Caddy synced</span>}
      {status === 'caddy-error' && <span className="save-status">Saved, Caddy sync failed</span>}
      {ladder !== null && !ladder.configured && (
        <div className="warning-banner">Authentik is not configured, so auth tiers cannot be changed here.</div>
      )}
      {ladderError && <div className="warning-banner">Could not load auth groups: {ladderError}</div>}
      {error && <div className="warning-banner">{error}</div>}
      {conflicts.length > 0 && (
        <div className="warning-banner">
          Authentik slug conflict: {conflicts.join(', ')} — the slug is held by an Application this
          toolkit does not manage; logins will fail until it is resolved by hand.
        </div>
      )}
      {offLadder.length > 0 && (
        <div className="warning-banner">
          Unknown auth group: {offLadder.map((o) => o.authGroup).join(', ')} — not on the configured
          ladder, so this entry was skipped and its Authentik state left untouched.
        </div>
      )}
      {missingRungs.length > 0 && (
        <div className="warning-banner">
          Missing in Authentik: {missingRungs.join(', ')} — these ladder rungs do not exist, so no
          bindings were written for them.
        </div>
      )}
    </div>
  );
}
