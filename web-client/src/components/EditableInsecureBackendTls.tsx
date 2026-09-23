import { useEffect, useState } from 'react';
import { apiPatch } from '../api/client';
import type { GuestEntry } from '../api/types';

interface Props {
  guest: GuestEntry;
  onSaved: () => void;
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'caddy-error' | 'error';

export function EditableInsecureBackendTls({ guest, onSaved }: Props) {
  const [insecureBackendTls, setInsecureBackendTls] = useState(guest.insecureBackendTls ?? false);
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  // Rows are keyed by guest name, not remounted on refresh, so local state
  // must be re-synced whenever a fresh guest.insecureBackendTls comes in via
  // props (e.g. after sync-inventory or another client's edit) -- otherwise
  // it keeps showing whatever it had at mount time.
  useEffect(() => {
    setInsecureBackendTls(guest.insecureBackendTls ?? false);
  }, [guest.insecureBackendTls]);

  const toggleInsecureBackendTls = async (next: boolean) => {
    setInsecureBackendTls(next);
    setStatus('saving');
    setError(null);
    try {
      const res = await apiPatch<{ guest: GuestEntry; caddySynced: boolean; caddyError?: string }>(
        `/inventory/guests/${encodeURIComponent(guest.name)}`,
        { insecureBackendTls: next }
      );
      if (res.caddySynced) {
        setStatus('saved');
      } else {
        setStatus('caddy-error');
        setError(`Saved, but Caddy sync failed: ${res.caddyError}`);
      }
      onSaved();
    } catch (err) {
      setInsecureBackendTls(!next);
      setStatus('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div>
      <input
        type="checkbox"
        checked={insecureBackendTls}
        onChange={(e) => toggleInsecureBackendTls(e.target.checked)}
        aria-label="Insecure backend TLS"
        title="Insecure backend TLS"
      />
      {status === 'saving' && <span className="save-status">Saving…</span>}
      {status === 'saved' && <span className="save-status">Saved, Caddy synced</span>}
      {status === 'caddy-error' && <span className="save-status">Saved, Caddy sync failed</span>}
      {error && <div className="warning-banner">{error}</div>}
    </div>
  );
}
