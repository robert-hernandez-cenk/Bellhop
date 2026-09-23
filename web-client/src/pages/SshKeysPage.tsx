import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiGet, apiPost } from '../api/client';
import type { GuestEntry } from '../api/types';
import { PageDescription } from '../components/PageDescription';

export function SshKeysPage() {
  const navigate = useNavigate();
  const [guests, setGuests] = useState<GuestEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [syncHost, setSyncHost] = useState('');
  const [syncPreview, setSyncPreview] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const [pushKey, setPushKey] = useState('');
  const [pushSelected, setPushSelected] = useState<Set<string>>(new Set());
  const [pushing, setPushing] = useState(false);

  useEffect(() => {
    apiGet<{ guests: GuestEntry[] }>('/inventory').then((data) => {
      setGuests(data.guests.filter((g) => g.type === 'lxc'));
    });
  }, []);

  const runSyncPreview = async () => {
    setError(null);
    setPreviewing(true);
    try {
      const res = await apiPost<{ preview: string }>('/maintenance/sync-ssh-keys/preview', {
        host: syncHost || undefined,
      });
      setSyncPreview(res.preview);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewing(false);
    }
  };

  const runSyncApply = async () => {
    setSyncing(true);
    setError(null);
    try {
      const res = await apiPost<{ jobId: number }>('/maintenance/sync-ssh-keys/apply', { host: syncHost || undefined });
      navigate(`/jobs/${res.jobId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSyncing(false);
    }
  };

  const togglePushGuest = (name: string) => {
    setPushSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const runPush = async () => {
    setPushing(true);
    setError(null);
    try {
      const res = await apiPost<{ jobId: number }>('/maintenance/push-ssh-key/apply', {
        key: pushKey.trim(),
        guests: [...pushSelected],
      });
      navigate(`/jobs/${res.jobId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPushing(false);
    }
  };

  return (
    <div>
      <h2>SSH Keys</h2>
      <PageDescription>
        Manage SSH access to existing lxc guests. Both operations below are idempotent -- safe to
        re-run, and neither ever removes a key already present on a guest.
      </PageDescription>
      {error && <div className="warning-banner">{error}</div>}

      <h3>Sync from host</h3>
      <PageDescription>
        Ensure a guest's authorized_keys includes whatever its own parent Proxmox host currently
        trusts. Leave the guest field blank to sync every lxc guest.
      </PageDescription>
      <div className="form-field">
        <label className="label">Guest (optional, blank = all lxc guests)</label>
        <select className="field-input" value={syncHost} onChange={(e) => setSyncHost(e.target.value)}>
          <option value="">All lxc guests</option>
          {guests.map((g) => (
            <option key={g.name} value={g.name}>
              {g.name}
            </option>
          ))}
        </select>
      </div>
      <button className="button" onClick={runSyncPreview} disabled={previewing}>
        {previewing ? 'Previewing…' : 'Preview'}
      </button>
      {syncPreview !== null && (
        <div>
          <pre className="preview-pane">{syncPreview}</pre>
          <button className="button" onClick={runSyncApply} disabled={syncing}>
            {syncing ? 'Applying…' : 'Apply'}
          </button>
        </div>
      )}

      <h3>Push a key</h3>
      <PageDescription>
        Ensure one explicit SSH public key is present on the guests you select below -- for a new
        device's key that isn't on any Proxmox host's own authorized_keys yet.
      </PageDescription>
      <div className="form-field">
        <label className="label">SSH public key</label>
        <input
          className="field-input"
          type="text"
          value={pushKey}
          onChange={(e) => setPushKey(e.target.value)}
          placeholder="ssh-ed25519 AAAA... user@host"
        />
      </div>
      <div className="form-field">
        <label className="label">Guests</label>
        {guests.map((g) => (
          <label key={g.name} style={{ display: 'block' }}>
            <input type="checkbox" checked={pushSelected.has(g.name)} onChange={() => togglePushGuest(g.name)} />
            {' '}
            {g.name}
          </label>
        ))}
      </div>
      <button className="button" onClick={runPush} disabled={pushing || !pushKey.trim() || pushSelected.size === 0}>
        {pushing ? 'Pushing…' : 'Push'}
      </button>
    </div>
  );
}
