import { useEffect, useState } from 'react';
import { apiGet } from '../api/client';
import type { GuestEntry, WhoAmI } from '../api/types';

interface Props {
  guest: GuestEntry;
}

interface Credentials {
  issuer: string;
  clientId: string;
  clientSecret: string;
}

type CredentialField = 'issuer' | 'clientId' | 'clientSecret';

const FIELDS: Array<{ field: CredentialField; label: string }> = [
  { field: 'issuer', label: 'Issuer' },
  { field: 'clientId', label: 'Client ID' },
  { field: 'clientSecret', label: 'Client secret' },
];

// T030 -- the Advanced modal's "oidc client" row. Admin-only reveal, never
// fetched on mount and never cached across a modal close: `credentials`
// starts (and every reopen of the Advanced modal remounts this component
// fresh, so it again starts) at null, and the GET only fires from the
// button's own onClick. Non-admins get a plain note instead of a disabled
// button -- there is nothing for them to reveal (FR-020), so a visibly
// disabled control would be misleading rather than merely inert.
export function OidcCredentials({ guest }: Props) {
  const [whoami, setWhoami] = useState<WhoAmI | null>(null);
  const [credentials, setCredentials] = useState<Credentials | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<CredentialField | null>(null);

  useEffect(() => {
    apiGet<WhoAmI>('/whoami')
      .then(setWhoami)
      .catch(() => {
        // Leaves whoami null -- rendered the same as "not admin yet" below,
        // failing closed rather than showing the reveal button by default.
      });
  }, []);

  const isAdmin = !!whoami?.isAdmin;

  const reveal = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiGet<Credentials>(`/oidc/${encodeURIComponent(guest.name)}/credentials`);
      setCredentials(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const copy = (field: CredentialField, value: string) => {
    navigator.clipboard
      .writeText(value)
      .then(() => {
        setCopied(field);
        window.setTimeout(() => setCopied((c) => (c === field ? null : c)), 2000);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  };

  // Wait for whoami before rendering anything -- otherwise a non-admin would
  // briefly see the reveal button (which the server would then 403) before
  // it's swapped for the note below.
  if (whoami === null) return null;

  if (!isAdmin) {
    return <span className="oidc-credentials-note">OIDC (credentials visible to admins)</span>;
  }

  if (credentials === null) {
    return (
      <div>
        <button className="button" onClick={reveal} disabled={loading}>
          {loading ? 'Loading…' : 'Show client credentials'}
        </button>
        {/* 409/503 (not OIDC-gated yet, or Authentik unconfigured/unreachable)
            render as plain text here, same as any other save/load error in
            this modal -- the entry's other settings above are unaffected. */}
        {error && <div className="warning-banner">{error}</div>}
      </div>
    );
  }

  return (
    <div className="oidc-credentials">
      {FIELDS.map(({ field, label }) => (
        <div className="oidc-credential-row" key={field}>
          <div className="oidc-credential-label">{label}</div>
          <div className="oidc-credential-value-row">
            <code className="oidc-credential-value">{credentials[field]}</code>
            <button className="button" onClick={() => copy(field, credentials[field])}>
              {copied === field ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      ))}
      <button className="button" onClick={() => setCredentials(null)}>
        Hide
      </button>
      {error && <div className="warning-banner">{error}</div>}
    </div>
  );
}
