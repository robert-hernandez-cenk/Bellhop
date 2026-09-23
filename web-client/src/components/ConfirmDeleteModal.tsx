import { useState } from 'react';

interface Props {
  message: string;
  confirmLabel: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}

export function ConfirmDeleteModal({ message, confirmLabel, onConfirm, onClose }: Props) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="warning-banner">{message}</div>
        {error && <div className="warning-banner">{error}</div>}
        <div className="stats-row">
          <button className="button" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button className="button button-danger" onClick={submit} disabled={submitting}>
            {submitting ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
