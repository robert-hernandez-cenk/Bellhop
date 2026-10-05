// Framework-free (no React/DOM imports) so it compiles under the root
// NodeNext config and is testable with plain node --test, like task-display.ts.
import type { JobRow } from '../api/types.ts';

const FRONT_END_LABELS: Record<NonNullable<JobRow['triggeredVia']>, string> = {
  web: 'web UI',
  mcp: 'MCP',
};

// The job list's "triggered by" cell: the real user, the group they were
// impersonating if any, and the front end the job came from (#65/#66).
// Older rows and the scheduler's own runs have no front end.
export function triggeredByLabel(job: Pick<JobRow, 'triggeredByUsername' | 'triggeredByImpersonating' | 'triggeredVia'>): string {
  if (!job.triggeredByUsername) return '—';
  const who = job.triggeredByImpersonating
    ? `${job.triggeredByUsername} (as: ${job.triggeredByImpersonating})`
    : job.triggeredByUsername;
  return job.triggeredVia ? `${who} via ${FRONT_END_LABELS[job.triggeredVia]}` : who;
}
