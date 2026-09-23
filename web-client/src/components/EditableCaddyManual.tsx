import { useEffect, useState } from 'react';
import { apiPatch } from '../api/client';
import type { GuestEntry } from '../api/types';

interface Props {
  guest: GuestEntry;
  onSaved: () => void;
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'caddy-error' | 'error';

export function EditableCaddyManual({ guest, onSaved }: Props) {
  const [caddyManual, setCaddyManual] = useState(guest.caddyManual ?? false);
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  // Rows are keyed by guest name, not remounted on refresh, so local state
  // must be re-synced whenever a fresh guest.caddyManual comes in via props
  // (e.g. after sync-inventory or another client's edit) -- otherwise it
  // keeps showing whatever it had at mount time.
  useEffect(() => {
    setCaddyManual(guest.caddyManual ?? false);
  }, [guest.caddyManual]);

  const toggleCaddyManual = async (next: boolean) => {
    setCaddyManual(next);
    setStatus('saving');
    setError(null);
    try {
      const res = await apiPatch<{ guest: GuestEntry; caddySynced: boolean; caddyError?: string }>(
        `/inventory/guests/${encodeURIComponent(guest.name)}`,
        { caddyManual: next }
      );
      if (res.caddySynced) {
        setStatus('saved');
      } else {
        setStatus('caddy-error');
        setError(`Saved, but Caddy sync failed: ${res.caddyError}`);
      }
      onSaved();
    } catch (err) {
      setCaddyManual(!next);
      setStatus('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div>
      <input
        type="checkbox"
        checked={caddyManual}
        onChange={(e) => toggleCaddyManual(e.target.checked)}
        aria-label="Read-only Caddy"
        title="Read-only Caddy"
      />
      {status === 'saving' && <span className="save-status">Saving…</span>}
      {status === 'saved' && <span className="save-status">Saved, Caddy synced</span>}
      {status === 'caddy-error' && <span className="save-status">Saved, Caddy sync failed</span>}
      {error && <div className="warning-banner">{error}</div>}
    </div>
  );
}
