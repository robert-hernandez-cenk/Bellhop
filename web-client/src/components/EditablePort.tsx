import { useState } from 'react';
import { apiPatch } from '../api/client';
import type { GuestEntry } from '../api/types';

interface Props {
  guest: GuestEntry;
  onSaved: () => void;
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'caddy-error' | 'error';

export function EditablePort({ guest, onSaved }: Props) {
  const [value, setValue] = useState(guest.port != null ? String(guest.port) : '');
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const current = guest.port != null ? String(guest.port) : '';
    if (value === current) return;
    setStatus('saving');
    setError(null);
    try {
      const res = await apiPatch<{ guest: GuestEntry; caddySynced: boolean; caddyError?: string }>(
        `/inventory/guests/${encodeURIComponent(guest.name)}`,
        { port: value }
      );
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
        className="inline-input inline-input-port"
        type="number"
        max={65535}
        value={value}
        placeholder="80"
        onChange={(e) => {
          setValue(e.target.value);
          setStatus('idle');
        }}
        onBlur={save}
      />
      {status === 'saving' && <span className="save-status">Saving…</span>}
      {status === 'saved' && <span className="save-status">Saved, Caddy synced</span>}
      {status === 'caddy-error' && <span className="save-status">Saved, Caddy sync failed</span>}
      {error && <div className="warning-banner">{error}</div>}
    </div>
  );
}
