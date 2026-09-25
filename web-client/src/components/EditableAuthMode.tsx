import { useEffect, useState } from 'react';
import { apiPatch } from '../api/client';
import type { GuestEntry } from '../api/types';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import { AuthentikConflictBanner, AuthentikSkipBanner, type AuthentikSkip } from './AuthentikSyncBanners';
import { isOidcEffective, needsOidcDeletionConfirmation } from '../lib/oidc';
import { useWhoAmI } from '../lib/whoami';

interface OidcDiscoveryFailure {
  slug: string;
  issuer: string;
  error: string;
}

interface PatchResponse {
  guest: GuestEntry;
  caddySynced: boolean;
  caddyError?: string;
  authentikConflicts?: string[];
  authentikConflictAdoptable?: true;
  oidcDiscoveryFailures?: OidcDiscoveryFailure[];
  oidcSkipped?: AuthentikSkip[];
}

interface Props {
  guest: GuestEntry;
  onSaved: () => void;
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'caddy-error' | 'error';

function patchGuest(name: string, body: Record<string, unknown>): Promise<PatchResponse> {
  return apiPatch<PatchResponse>(`/inventory/guests/${encodeURIComponent(name)}`, body);
}

// The "auth mode" row (T021/T022) -- a Forward-auth/OIDC select. Saves
// immediately on change, admin-only (disabled with an explanatory title
// otherwise). Switching an OIDC-effective guest (authGroup set, authMode
// 'oidc') back to forward-auth deletes its OpenID client (FR-022a), so that
// one transition is gated behind ConfirmDeleteModal; every other change
// saves straight away like the sibling Editable* components.
export function EditableAuthMode({ guest, onSaved }: Props) {
  const { whoami } = useWhoAmI();
  const [mode, setMode] = useState<'forward' | 'oidc'>(guest.authMode === 'oidc' ? 'oidc' : 'forward');
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<string[]>([]);
  const [discoveryFailures, setDiscoveryFailures] = useState<OidcDiscoveryFailure[]>([]);
  const [conflictAdoptable, setConflictAdoptable] = useState(false);
  const [skipped, setSkipped] = useState<AuthentikSkip[]>([]);
  const [confirmingSwitch, setConfirmingSwitch] = useState(false);

  // Re-sync from a fresh guest.authMode the same way EditableAuthGroup does
  // -- rows are keyed by guest name, not remounted on refresh.
  useEffect(() => {
    setMode(guest.authMode === 'oidc' ? 'oidc' : 'forward');
  }, [guest.authMode]);

  const isAdmin = !!whoami?.isAdmin;
  const wasOidc = isOidcEffective(guest);

  // `rethrow` is true only for the confirm-modal path (confirmSwitch below):
  // ConfirmDeleteModal.submit() only keeps the modal open and shows its own
  // inline error when onConfirm's promise rejects -- swallowing the error
  // here (the ordinary, non-confirmed save behavior) would make the modal
  // close and silently discard a failed confirmed save instead.
  const send = async (body: Record<string, unknown>, previous: 'forward' | 'oidc', rethrow = false) => {
    setStatus('saving');
    setError(null);
    setConflicts([]);
    setConflictAdoptable(false);
    setDiscoveryFailures([]);
    setSkipped([]);
    try {
      const res = await patchGuest(guest.name, body);
      setConflicts(res.authentikConflicts ?? []);
      setConflictAdoptable(res.authentikConflictAdoptable === true);
      setDiscoveryFailures(res.oidcDiscoveryFailures ?? []);
      setSkipped(res.oidcSkipped ?? []);
      if (res.caddySynced) {
        setStatus('saved');
      } else {
        setStatus('caddy-error');
        setError(`Saved, but Caddy sync failed: ${res.caddyError}`);
      }
      onSaved();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Safety net (U10 controller clarification): reopen the confirmation
      // modal if the server still answers with the confirmation error --
      // guarded on `!body.confirmOidcClientDeletion` so a confirmed retry
      // that fails for some other reason never loops back into the modal.
      if (!body.confirmOidcClientDeletion && needsOidcDeletionConfirmation(message)) {
        setMode(previous);
        setStatus('idle');
        setConfirmingSwitch(true);
        return;
      }
      setMode(previous);
      if (rethrow) {
        setStatus('idle');
        throw err instanceof Error ? err : new Error(message);
      }
      setStatus('error');
      setError(message);
    }
  };

  const handleChange = (next: 'forward' | 'oidc') => {
    if (wasOidc && next === 'forward') {
      // Don't touch `mode` yet -- the <select> is controlled by it, so
      // leaving it unset here is what visually reverts the browser's own
      // optimistic selection while the confirmation modal is open. Cancel
      // sends nothing and needs no explicit revert as a result.
      setConfirmingSwitch(true);
      return;
    }
    const previous = mode;
    setMode(next);
    void send({ authMode: next }, previous);
  };

  const confirmSwitch = async () => {
    const previous = mode;
    setMode('forward');
    await send({ authMode: 'forward', confirmOidcClientDeletion: true }, previous, true);
  };

  const disabled = !isAdmin || status === 'saving';
  const title = isAdmin ? undefined : "Only an admin may change an app's auth mode";

  return (
    <div>
      <select
        className="field-input"
        value={mode}
        disabled={disabled}
        title={title}
        aria-label="Auth mode"
        onChange={(e) => handleChange(e.target.value as 'forward' | 'oidc')}
      >
        <option value="forward">Forward-auth</option>
        <option value="oidc">OIDC</option>
      </select>
      {!guest.authGroup && <div className="field-note">No auth group set — auth mode has no effect until one is.</div>}
      {status === 'saving' && <span className="save-status">Saving…</span>}
      {status === 'saved' && <span className="save-status">Saved, Caddy synced</span>}
      {status === 'caddy-error' && <span className="save-status">Saved, Caddy sync failed</span>}
      {error && <div className="warning-banner">{error}</div>}
      <AuthentikConflictBanner conflicts={conflicts} adoptable={conflictAdoptable} guest={guest} isAdmin={isAdmin} />
      <AuthentikSkipBanner skipped={skipped} />
      {discoveryFailures.length > 0 && (
        <div className="warning-banner">
          OIDC discovery check failed: {discoveryFailures.map((f) => `${f.slug} (${f.issuer}): ${f.error}`).join('; ')}
        </div>
      )}
      {confirmingSwitch && (
        <ConfirmDeleteModal
          message={`Switching ${guest.name} to forward-auth deletes its OpenID client. Its OIDC login stops working until new credentials are entered in the app.`}
          confirmLabel="Switch to forward-auth"
          onConfirm={confirmSwitch}
          onClose={() => setConfirmingSwitch(false)}
        />
      )}
    </div>
  );
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i]);
}

// Mirrors EditableUnauthenticatedPaths' own split/trim/dedupe compare, used
// only to skip a no-op save.
function parseLocal(value: string): string[] {
  return Array.from(new Set(value.split(';').map((s) => s.trim()).filter(Boolean)));
}

// The "callback urls" row (T021/T022) -- a ';'-separated Callback URLs
// input, saved on blur, admin-only. Never itself triggers the OIDC-client
// deletion confirmation (only switching modes or clearing the access tier
// does, per FR-022a) -- the server still validates each URL is an absolute
// http(s) address (400 otherwise), surfaced the same way any other save
// error is.
export function EditableOidcRedirectUris({ guest, onSaved }: Props) {
  const { whoami } = useWhoAmI();
  const [value, setValue] = useState((guest.oidcRedirectUris ?? []).join('; '));
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<string[]>([]);
  const [discoveryFailures, setDiscoveryFailures] = useState<OidcDiscoveryFailure[]>([]);
  const [conflictAdoptable, setConflictAdoptable] = useState(false);
  const [skipped, setSkipped] = useState<AuthentikSkip[]>([]);

  useEffect(() => {
    setValue((guest.oidcRedirectUris ?? []).join('; '));
  }, [guest.oidcRedirectUris]);

  const isAdmin = !!whoami?.isAdmin;

  const save = async () => {
    if (sameList(parseLocal(value), guest.oidcRedirectUris ?? [])) return;
    setStatus('saving');
    setError(null);
    setConflicts([]);
    setConflictAdoptable(false);
    setDiscoveryFailures([]);
    setSkipped([]);
    try {
      const res = await patchGuest(guest.name, { oidcRedirectUris: value });
      setConflicts(res.authentikConflicts ?? []);
      setConflictAdoptable(res.authentikConflictAdoptable === true);
      setDiscoveryFailures(res.oidcDiscoveryFailures ?? []);
      setSkipped(res.oidcSkipped ?? []);
      if (res.caddySynced) {
        setStatus('saved');
      } else {
        setStatus('caddy-error');
        setError(`Saved, but Caddy sync failed: ${res.caddyError}`);
      }
      onSaved();
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div>
      <input
        className="inline-input"
        type="text"
        value={value}
        placeholder="https://media.example.com/auth/callback"
        disabled={!isAdmin || status === 'saving'}
        title={isAdmin ? undefined : 'Only an admin may change callback URLs'}
        onChange={(e) => {
          setValue(e.target.value);
          setStatus('idle');
        }}
        onBlur={save}
      />
      {!isOidcEffective(guest) && <div className="field-note">Only used in OIDC mode.</div>}
      {status === 'saving' && <span className="save-status">Saving…</span>}
      {status === 'saved' && <span className="save-status">Saved, Caddy synced</span>}
      {status === 'caddy-error' && <span className="save-status">Saved, Caddy sync failed</span>}
      {error && <div className="warning-banner">{error}</div>}
      <AuthentikConflictBanner conflicts={conflicts} adoptable={conflictAdoptable} guest={guest} isAdmin={isAdmin} />
      <AuthentikSkipBanner skipped={skipped} />
      {discoveryFailures.length > 0 && (
        <div className="warning-banner">
          OIDC discovery check failed: {discoveryFailures.map((f) => `${f.slug} (${f.issuer}): ${f.error}`).join('; ')}
        </div>
      )}
    </div>
  );
}
