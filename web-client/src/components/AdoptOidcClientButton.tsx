import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiPost } from '../api/client';

interface Props {
  entryName: string;
}

// FR-011a's per-entry "adopt an existing hand-made OpenID client" action,
// rendered inline inside a conflict banner (EditableAuthGroup.tsx /
// EditableAuthMode.tsx) only when the conflict belongs to an OIDC-effective
// guest and the viewer is admin (T042). Preview-then-apply, same shape as
// every other shared Operation (src/operations/); apply enqueues a job and
// navigates there, the same apply-then-navigate precedent EditableVpn.tsx
// already uses for its own job-backed action.
export function AdoptOidcClientButton({ entryName }: Props) {
  const navigate = useNavigate();
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPreview = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiPost<{ preview: string }>(`/oidc/${encodeURIComponent(entryName)}/adopt/preview`, {});
      setPreview(res.preview);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiPost<{ jobId: number }>(`/oidc/${encodeURIComponent(entryName)}/adopt/apply`, {});
      navigate(`/jobs/${res.jobId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  if (preview === null) {
    return (
      <div className="adopt-oidc-client">
        <button className="button" onClick={loadPreview} disabled={busy}>
          {busy ? 'Loading preview…' : 'Adopt existing client'}
        </button>
        {error && <div className="warning-banner">{error}</div>}
      </div>
    );
  }

  return (
    <div className="adopt-oidc-client">
      <pre className="preview-pane">{preview}</pre>
      <div className="stats-row">
        <button className="button" onClick={() => setPreview(null)} disabled={busy}>
          Cancel
        </button>
        <button className="button" onClick={apply} disabled={busy}>
          {busy ? 'Adopting…' : 'Confirm adopt'}
        </button>
      </div>
      {error && <div className="warning-banner">{error}</div>}
    </div>
  );
}
