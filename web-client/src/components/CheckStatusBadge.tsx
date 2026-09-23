import type { CheckStatus } from './AppCheckInput';

export function CheckStatusBadge({ status }: { status: CheckStatus }) {
  if (status === 'idle') return null;
  if (status === 'checking') return <span className="check-status check-checking">…</span>;
  if (status === 'ok') return <span className="check-status check-ok">✓</span>;
  return <span className="check-status check-missing">✗</span>;
}
