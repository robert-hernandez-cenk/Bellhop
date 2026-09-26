import { useEffect, useState } from 'react';
import { apiPatch } from '../api/client';
import type { GuestEntry } from '../api/types';

interface Props {
  guest: GuestEntry;
  onSaved: () => void;
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'proxy-error' | 'error';

export function EditableProxyManual({ guest, onSaved }: Props) {
  const [proxyManual, setProxyManual] = useState(guest.proxyManual ?? false);
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  // Rows are keyed by guest name, not remounted on refresh, so local state
  // must be re-synced whenever a fresh guest.proxyManual comes in via props
  // (e.g. after sync-inventory or another client's edit) -- otherwise it
  // keeps showing whatever it had at mount time.
  useEffect(() => {
    setProxyManual(guest.proxyManual ?? false);
  }, [guest.proxyManual]);

  const toggleProxyManual = async (next: boolean) => {
    setProxyManual(next);
    setStatus('saving');
    setError(null);
    try {
      const res = await apiPatch<{ guest: GuestEntry; proxySynced: boolean; proxyError?: string }>(
        `/inventory/guests/${encodeURIComponent(guest.name)}`,
        { proxyManual: next }
      );
      if (res.proxySynced) {
        setStatus('saved');
      } else {
        setStatus('proxy-error');
        setError(`Saved, but proxy sync failed: ${res.proxyError}`);
      }
      onSaved();
    } catch (err) {
      setProxyManual(!next);
      setStatus('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div>
      <input
        type="checkbox"
        checked={proxyManual}
        onChange={(e) => toggleProxyManual(e.target.checked)}
        aria-label="Read-only proxy"
        title="Read-only proxy"
      />
      {status === 'saving' && <span className="save-status">Saving…</span>}
      {status === 'saved' && <span className="save-status">Saved, proxy synced</span>}
      {status === 'proxy-error' && <span className="save-status">Saved, proxy sync failed</span>}
      {error && <div className="warning-banner">{error}</div>}
    </div>
  );
}
