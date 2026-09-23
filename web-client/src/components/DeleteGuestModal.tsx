import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiPost } from '../api/client';
import type { GuestEntry, HostEntry } from '../api/types';

interface Props {
  guest: GuestEntry;
  hosts: HostEntry[];
  onClose: () => void;
}

export function DeleteGuestModal({ guest, hosts, onClose }: Props) {
  const navigate = useNavigate();
  const [confirmName, setConfirmName] = useState('');
  const [backup, setBackup] = useState(false);
  const [backupStorage, setBackupStorage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const host = hosts.find((h) => h.name === guest.host);
  const backupStorages = (host?.storages ?? []).filter((s) => s.active && s.content.includes('backup'));
  const nameMatches = confirmName === guest.name;

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiPost<{ jobId: number }>('/provisioning/delete-guest/apply', {
        guest: guest.name,
        backup,
        backupStorage: backup ? backupStorage : undefined,
      });
      onClose();
      navigate(`/jobs/${res.jobId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="warning-banner">
          This will permanently destroy "{guest.name}" (vmid {guest.vmid}) on {guest.host}. This cannot be undone.
        </div>
        <div className="form-field">
          <label className="label">Type "{guest.name}" to confirm</label>
          <input
            className="field-input"
            value={confirmName}
            onChange={(e) => setConfirmName(e.target.value)}
            placeholder={`Type "${guest.name}" to confirm`}
          />
        </div>
        <div className="form-field">
          <label>
            <input
              type="checkbox"
              checked={backup}
              disabled={backupStorages.length === 0}
              onChange={(e) => {
                setBackup(e.target.checked);
                setBackupStorage('');
              }}
            />{' '}
            Back up before deleting (vzdump)
          </label>
          {backupStorages.length === 0 && (
            <div className="page-description">No backup-capable storage found on {guest.host}</div>
          )}
        </div>
        {backup && backupStorages.length > 0 && (
          <div className="form-field">
            <label className="label">Backup storage</label>
            <select className="field-input" value={backupStorage} onChange={(e) => setBackupStorage(e.target.value)}>
              <option value="">Select storage…</option>
              {backupStorages.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {error && <div className="warning-banner">{error}</div>}
        <div className="stats-row">
          <button className="button" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button
            className="button button-danger"
            onClick={submit}
            disabled={!nameMatches || submitting || (backup && !backupStorage)}
          >
            {submitting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}
