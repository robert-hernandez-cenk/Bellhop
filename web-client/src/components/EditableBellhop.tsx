import { useEffect, useState } from 'react';
import { apiPatch } from '../api/client';
import type { GuestEntry } from '../api/types';
import { useWhoAmI } from '../lib/whoami';

interface Props {
  guest: GuestEntry;
  onSaved: () => void;
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'proxy-error' | 'error';

// The "this is Bellhop" row (#85): a checkbox that saves immediately and is
// admin-only (disabled with an explanatory title otherwise), like the other
// OIDC fields. Which guest is Bellhop decides whose OpenID client the web
// login trusts, so the server enforces the same rule; the title is only the
// explanation. The server refuses a second flagged guest, and that message
// is shown as-is.
export function EditableBellhop({ guest, onSaved }: Props) {
  const { whoami } = useWhoAmI();
  const [bellhop, setBellhop] = useState(guest.bellhop ?? false);
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  // Rows are keyed by guest name, not remounted on refresh (same reason as
  // EditableProxyManual), so re-sync from a fresh guest.bellhop.
  useEffect(() => {
    setBellhop(guest.bellhop ?? false);
  }, [guest.bellhop]);

  const isAdmin = !!whoami?.isAdmin;

  const toggle = async (next: boolean) => {
    setBellhop(next);
    setStatus('saving');
    setError(null);
    try {
      const res = await apiPatch<{ guest: GuestEntry; proxySynced: boolean; proxyError?: string }>(
        `/inventory/guests/${encodeURIComponent(guest.name)}`,
        { bellhop: next }
      );
      if (res.proxySynced) {
        setStatus('saved');
      } else {
        setStatus('proxy-error');
        setError(`Saved, but proxy sync failed: ${res.proxyError}`);
      }
      onSaved();
    } catch (err) {
      setBellhop(!next);
      setStatus('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div>
      <input
        type="checkbox"
        checked={bellhop}
        disabled={!isAdmin || status === 'saving'}
        onChange={(e) => void toggle(e.target.checked)}
        aria-label="This is Bellhop"
        title={isAdmin ? 'This is Bellhop' : 'Only an admin may change which guest is Bellhop itself'}
      />
      {bellhop && guest.authMode !== 'oidc' && (
        <div className="field-note">Set the auth mode to OIDC for this to take effect.</div>
      )}
      {status === 'saving' && <span className="save-status">Saving…</span>}
      {status === 'saved' && <span className="save-status">Saved, proxy synced</span>}
      {status === 'proxy-error' && <span className="save-status">Saved, proxy sync failed</span>}
      {error && <div className="warning-banner">{error}</div>}
    </div>
  );
}
