import { useEffect, useState } from 'react';
import { apiGet, apiPatch } from '../api/client';
import type { GuestEntry } from '../api/types';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import { AdoptOidcClientButton } from './AdoptOidcClientButton';
import { isOidcEffective, needsOidcDeletionConfirmation } from '../lib/oidc';

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
  // T035: clearing the tier on an OIDC-effective guest deletes its OpenID
  // client (FR-022a), so that one transition is confirmed first. Every
  // other authGroup change (including lowering to a different rung while
  // staying in OIDC mode) saves straight away, same as before this feature.
  const [confirmingClear, setConfirmingClear] = useState(false);

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

  // `rethrow` is true only for the confirm-modal path (confirmClear below):
  // ConfirmDeleteModal.submit() only keeps the modal open and shows its own
  // inline error when onConfirm's promise rejects -- swallowing the error
  // here (the ordinary, non-confirmed save behavior) would make the modal
  // close and silently discard a failed confirmed save instead. Guarded on
  // `confirmed` implying `rethrow` never fires the safety-net branch below,
  // since that branch only ever runs for a non-confirmed attempt.
  const save = async (next: string, confirmed: boolean, rethrow = false) => {
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
        ...(confirmed ? { confirmOidcClientDeletion: true } : {}),
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
      const message = err instanceof Error ? err.message : String(err);
      // Safety net (U10 controller clarification): the client-side
      // isOidcEffective check in onSelectChange below should already have
      // caught this and opened the modal before ever sending -- guarded on
      // `!confirmed` so a confirmed retry that fails for some other reason
      // never loops back into the modal.
      if (!confirmed && needsOidcDeletionConfirmation(message)) {
        setAuthGroup(previous);
        setStatus('idle');
        setConfirmingClear(true);
        return;
      }
      setAuthGroup(previous);
      if (rethrow) {
        setStatus('idle');
        throw err instanceof Error ? err : new Error(message);
      }
      setStatus('error');
      setError(message);
    }
  };

  const onSelectChange = (next: string) => {
    if (next === NONE && isOidcEffective(guest)) {
      // Don't touch `authGroup` yet -- the <select> is controlled by it, so
      // leaving it unset here is what visually reverts the browser's own
      // optimistic selection while the confirmation modal is open.
      setConfirmingClear(true);
      return;
    }
    void save(next, false);
  };

  const confirmClear = () => save(NONE, true, true);

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
        onChange={(e) => onSelectChange(e.target.value)}
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
          {/* T042: canLower is admin-equivalent (auth-groups.ts derives it
              from the same isAdminUser check GET /whoami's isAdmin uses),
              so this reuses it rather than a second /whoami fetch. */}
          {canLower && isOidcEffective(guest) && <AdoptOidcClientButton entryName={guest.name} />}
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
      {confirmingClear && (
        <ConfirmDeleteModal
          message={`Clearing ${guest.name}'s access tier deletes its OpenID client. Its OIDC login stops working until new credentials are entered in the app.`}
          confirmLabel="Clear access tier"
          onConfirm={confirmClear}
          onClose={() => setConfirmingClear(false)}
        />
      )}
    </div>
  );
}
