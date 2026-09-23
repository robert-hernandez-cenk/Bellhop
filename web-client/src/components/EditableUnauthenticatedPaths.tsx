import { useState } from 'react';
import { apiPatch } from '../api/client';
import type { GuestEntry } from '../api/types';

interface Props {
  guest: GuestEntry;
  onSaved: () => void;
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'caddy-error' | 'error';

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i]);
}

// Mirrors parseUnauthenticatedPaths's (src/lib/inventory.ts) split/trim/
// dedupe semantics, minus the leading-'/' validation (that stays
// server-side) -- used only to compare against the previously saved value
// so a save isn't re-triggered by whitespace/ordering differences that
// don't change the resulting pattern list.
function parseLocal(value: string): string[] {
  return Array.from(new Set(value.split(';').map((s) => s.trim()).filter(Boolean)));
}

export function EditableUnauthenticatedPaths({ guest, onSaved }: Props) {
  const [value, setValue] = useState((guest.unauthenticatedPaths ?? []).join('; '));
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (sameList(parseLocal(value), guest.unauthenticatedPaths ?? [])) return;
    setStatus('saving');
    setError(null);
    try {
      const res = await apiPatch<{ guest: GuestEntry; caddySynced: boolean; caddyError?: string }>(
        `/inventory/guests/${encodeURIComponent(guest.name)}`,
        { unauthenticatedPaths: value }
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
        className="inline-input"
        type="text"
        value={value}
        placeholder="/api/*"
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
