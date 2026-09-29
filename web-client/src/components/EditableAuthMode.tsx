import { useEffect, useState } from 'react';
import { apiPatch } from '../api/client';
import type { GuestEntry } from '../api/types';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import { AuthentikConflictBanner, AuthentikSkipBanner, type AuthentikSkip } from './AuthentikSyncBanners';
import { isOidcEffective, needsOidcDeletionConfirmation, needsCallbackUrlsBeforeOidc } from '../lib/oidc';
import { useWhoAmI } from '../lib/whoami';

interface OidcDiscoveryFailure {
  slug: string;
  issuer: string;
  error: string;
}

interface PatchResponse {
  guest: GuestEntry;
  proxySynced: boolean;
  proxyError?: string;
  authentikConflicts?: string[];
  authentikConflictAdoptable?: true;
  oidcDiscoveryFailures?: OidcDiscoveryFailure[];
  oidcSkipped?: AuthentikSkip[];
  // Set only when this save changed the mobile redirect list and the
  // instance-wide mobile consent step reported a conflict or error.
  mobileConsentProblems?: string[];
}

interface Props {
  guest: GuestEntry;
  onSaved: () => void;
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'proxy-error' | 'error';

function patchGuest(name: string, body: Record<string, unknown>): Promise<PatchResponse> {
  return apiPatch<PatchResponse>(`/inventory/guests/${encodeURIComponent(name)}`, body);
}

// The "auth mode" row -- a Forward-auth/OIDC select. Saves
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
      if (res.proxySynced) {
        setStatus('saved');
      } else {
        setStatus('proxy-error');
        setError(`Saved, but proxy sync failed: ${res.proxyError}`);
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
      {status === 'saved' && <span className="save-status">Saved, proxy synced</span>}
      {status === 'proxy-error' && <span className="save-status">Saved, proxy sync failed</span>}
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

// One of the two additive OIDC callback-URL lists a guest carries (issue
// #22): the web browser's own callback (oidcRedirectUris) and a native
// app's (oidcMobileRedirectUris). Both fields are ';'-separated inputs
// saved on blur, admin-only, sharing every bit of edit/save/error/
// Authentik-banner handling -- see useOidcUrlListField below.
type OidcUrlListFieldName = 'oidcRedirectUris' | 'oidcMobileRedirectUris';

// Shared state/save logic for one OIDC callback-URL list field. Neither
// field itself triggers the OIDC-client deletion confirmation (only
// switching modes or clearing the access tier does, per FR-022a) -- the
// server still validates each entry (400 otherwise), surfaced the same way
// any other save error is: the web list must be absolute http(s) URLs, while
// the mobile list also allows custom schemes (javascript:/data:/file:/
// vbscript: are rejected).
function useOidcUrlListField(guest: GuestEntry, onSaved: () => void, field: OidcUrlListFieldName) {
  const { whoami } = useWhoAmI();
  const storedValue = guest[field];
  const [value, setValue] = useState((storedValue ?? []).join('; '));
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<string[]>([]);
  const [discoveryFailures, setDiscoveryFailures] = useState<OidcDiscoveryFailure[]>([]);
  const [conflictAdoptable, setConflictAdoptable] = useState(false);
  const [skipped, setSkipped] = useState<AuthentikSkip[]>([]);
  const [mobileConsentProblems, setMobileConsentProblems] = useState<string[]>([]);

  useEffect(() => {
    setValue((storedValue ?? []).join('; '));
    // storedValue (guest[field]) is the real dependency; guest/field are
    // stable props of the calling component for the lifetime of this hook
    // instance, included so a future field/guest identity change is never
    // silently missed by the linter's exhaustive-deps rule.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedValue]);

  const isAdmin = !!whoami?.isAdmin;

  const save = async () => {
    if (sameList(parseLocal(value), storedValue ?? [])) return;
    setStatus('saving');
    setError(null);
    setConflicts([]);
    setConflictAdoptable(false);
    setDiscoveryFailures([]);
    setSkipped([]);
    setMobileConsentProblems([]);
    try {
      const res = await patchGuest(guest.name, { [field]: value });
      setConflicts(res.authentikConflicts ?? []);
      setConflictAdoptable(res.authentikConflictAdoptable === true);
      setDiscoveryFailures(res.oidcDiscoveryFailures ?? []);
      setSkipped(res.oidcSkipped ?? []);
      setMobileConsentProblems(res.mobileConsentProblems ?? []);
      if (res.proxySynced) {
        setStatus('saved');
      } else {
        setStatus('proxy-error');
        setError(`Saved, but proxy sync failed: ${res.proxyError}`);
      }
      onSaved();
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return {
    value,
    setValue,
    status,
    setStatus,
    error,
    conflicts,
    conflictAdoptable,
    skipped,
    discoveryFailures,
    mobileConsentProblems,
    isAdmin,
    save,
  };
}

interface OidcUrlListFieldProps extends Props {
  field: OidcUrlListFieldName;
  placeholder: string;
  disabledTitle: string;
  // Extra help text rendered below the "Only used in OIDC mode." note.
  helpNote?: string;
}

// Shared render for one OIDC callback-URL list row -- the input, its
// notes, and the same Authentik banners every Editable* OIDC row shows.
function OidcUrlListField({ guest, onSaved, field, placeholder, disabledTitle, helpNote }: OidcUrlListFieldProps) {
  const {
    value,
    setValue,
    status,
    setStatus,
    error,
    conflicts,
    conflictAdoptable,
    skipped,
    discoveryFailures,
    mobileConsentProblems,
    isAdmin,
    save,
  } = useOidcUrlListField(guest, onSaved, field);

  return (
    <div>
      <input
        className="inline-input"
        type="text"
        value={value}
        placeholder={placeholder}
        disabled={!isAdmin || status === 'saving'}
        title={isAdmin ? undefined : disabledTitle}
        onChange={(e) => {
          setValue(e.target.value);
          setStatus('idle');
        }}
        onBlur={save}
      />
      {!isOidcEffective(guest) && <div className="field-note">Only used in OIDC mode.</div>}
      {helpNote && <div className="field-note">{helpNote}</div>}
      {status === 'saving' && <span className="save-status">Saving…</span>}
      {status === 'saved' && <span className="save-status">Saved, proxy synced</span>}
      {status === 'proxy-error' && <span className="save-status">Saved, proxy sync failed</span>}
      {error && <div className="warning-banner">{error}</div>}
      <AuthentikConflictBanner conflicts={conflicts} adoptable={conflictAdoptable} guest={guest} isAdmin={isAdmin} />
      <AuthentikSkipBanner skipped={skipped} />
      {discoveryFailures.length > 0 && (
        <div className="warning-banner">
          OIDC discovery check failed: {discoveryFailures.map((f) => `${f.slug} (${f.issuer}): ${f.error}`).join('; ')}
        </div>
      )}
      {field === 'oidcMobileRedirectUris' && mobileConsentProblems.length > 0 && (
        <div className="warning-banner">
          Saved, but the mobile consent step was not updated: {mobileConsentProblems.join('; ')}
        </div>
      )}
    </div>
  );
}

// The "callback urls" row -- the web browser's own OIDC callback address.
// Shown in forward mode too while a gated guest has none (issue #22 final
// review F1), since the server refuses the switch to OIDC until one is set.
export function EditableOidcRedirectUris({ guest, onSaved }: Props) {
  return (
    <OidcUrlListField
      guest={guest}
      onSaved={onSaved}
      field="oidcRedirectUris"
      placeholder="https://media.example.com/auth/callback"
      disabledTitle="Only an admin may change callback URLs"
      helpNote={needsCallbackUrlsBeforeOidc(guest) ? 'Needed before switching auth mode to OIDC.' : undefined}
    />
  );
}

// The "mobile app redirect urls" row -- a native app's own callback
// address, additive to oidcRedirectUris (issue #22).
export function EditableOidcMobileRedirectUris({ guest, onSaved }: Props) {
  return (
    <OidcUrlListField
      guest={guest}
      onSaved={onSaved}
      field="oidcMobileRedirectUris"
      placeholder="com.example.app:/auth/callback"
      disabledTitle="Only an admin may change mobile app redirect URLs"
      helpNote="For a native app's sign-in callback (custom scheme or its mobile-redirect page). Adds one consent click to mobile sign-ins only."
    />
  );
}
