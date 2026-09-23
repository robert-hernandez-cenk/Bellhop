import { useState } from 'react';
import { apiPatch } from '../api/client';
import { SubdomainsInput } from './SubdomainsInput';
import type { GuestEntry, HostEntry } from '../api/types';

interface Props {
  guest: GuestEntry;
  hosts: HostEntry[];
  guests: GuestEntry[];
  onSaved: () => void;
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'caddy-error' | 'error';

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i]);
}

export function EditableSubdomains({ guest, hosts, guests, onSaved }: Props) {
  const [value, setValue] = useState((guest.subdomains ?? []).join('; '));
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<string[]>([]);

  const applyPatch = async (body: Record<string, unknown>) => {
    setStatus('saving');
    setError(null);
    setConflicts([]);
    try {
      const res = await apiPatch<{
        guest: GuestEntry;
        caddySynced: boolean;
        caddyError?: string;
        authentikConflicts?: string[];
      }>(
        `/inventory/guests/${encodeURIComponent(guest.name)}`,
        body
      );
      setConflicts(res.authentikConflicts ?? []);
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

  const save = async (parsed: string[]) => {
    if (sameList(parsed, guest.subdomains ?? [])) return;
    await applyPatch({ subdomains: value });
  };

  return (
    <div>
      <SubdomainsInput
        value={value}
        onChange={(v) => {
          setValue(v);
          setStatus('idle');
        }}
        hosts={hosts}
        guests={guests}
        excludeName={guest.name}
        onBlurValid={save}
        className="inline-input"
      />
      {status === 'saving' && <span className="save-status">Saving…</span>}
      {status === 'saved' && <span className="save-status">Saved, Caddy synced</span>}
      {status === 'caddy-error' && <span className="save-status">Saved, Caddy sync failed</span>}
      {error && <div className="warning-banner">{error}</div>}
      {conflicts.length > 0 && (
        <div className="warning-banner">
          Authentik slug conflict: {conflicts.join(', ')} — the slug is held by an Application this
          toolkit does not manage; logins will fail until it is resolved by hand.
        </div>
      )}
    </div>
  );
}
