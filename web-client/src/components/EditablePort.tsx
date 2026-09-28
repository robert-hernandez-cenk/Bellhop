import { useState } from 'react';
import { apiPatch } from '../api/client';
import type { GuestEntry } from '../api/types';

interface Props {
  guest: GuestEntry;
  onSaved: () => void;
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'proxy-error' | 'error';

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
      const res = await apiPatch<{ guest: GuestEntry; proxySynced: boolean; proxyError?: string }>(
        `/inventory/guests/${encodeURIComponent(guest.name)}`,
        { port: value }
      );
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
      {status === 'saved' && <span className="save-status">Saved, proxy synced</span>}
      {status === 'proxy-error' && <span className="save-status">Saved, proxy sync failed</span>}
      {error && <div className="warning-banner">{error}</div>}
    </div>
  );
}
