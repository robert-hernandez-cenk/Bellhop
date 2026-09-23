import type { JobRow } from '../api/types';

const COLORS: Record<JobRow['status'], string> = {
  queued: '#86868b',
  running: '#ff9f0a',
  awaiting_input: '#bf5af2',
  success: '#34c759',
  failed: '#ff3b30',
  cancelled: '#86868b',
  interrupted: '#ac8e68',
};

const LABELS: Record<JobRow['status'], string> = {
  queued: 'QUEUED',
  running: 'RUNNING',
  awaiting_input: 'AWAITING INPUT',
  success: 'SUCCESS',
  failed: 'FAILED',
  cancelled: 'CANCELLED',
  interrupted: 'INTERRUPTED',
};

export function JobStatusBadge({ status }: { status: JobRow['status'] }) {
  return (
    <span className="job-status-badge" style={{ background: COLORS[status] }}>
      {LABELS[status]}
    </span>
  );
}
