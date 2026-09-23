import type { JobRow, JobStatus, JobStore } from '../web/jobs/job-store.ts';
import type { JobRunner } from '../web/jobs/job-runner.ts';

// #16: a multi-minute install log can run to megabytes; returning it whole in
// one tool result would blow the client's context, so logs are paged.
export const MAX_LOG_CHUNK = 20_000;

export const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>(['success', 'failed', 'cancelled', 'interrupted']);

export const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });
export const json = (v: unknown) => text(JSON.stringify(v, null, 2));

export function summarizeJob(job: JobRow) {
  return {
    id: job.id,
    command: job.command,
    target: job.target,
    status: job.status,
    owner: job.owner ?? 'web',
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    exitCode: job.exitCode,
    errorMessage: job.errorMessage,
    triggeredByUsername: job.triggeredByUsername,
  };
}

// Cancel/answer/dismiss/wait need the job's in-memory controller and events,
// which live only in the process that owns it. Cross-process control is
// issue #165.
export function requireOwned(deps: { jobStore: JobStore; jobRunner: Pick<JobRunner, 'owner'> }, id: number): JobRow {
  const job = deps.jobStore.get(id);
  if (!job) throw new Error(`Unknown job id: ${id}`);
  const owner = job.owner ?? 'web';
  if (owner !== deps.jobRunner.owner) throw new Error(`job ${id} is owned by ${owner}; control it from there`);
  return job;
}

// get_job pages forward from an offset (default 0). wait_for_job passes
// fromTail, so an omitted offset returns the last chunk: after a wait, the
// tail is what the caller wants.
export function pageLog(log: string, logOffset: number | undefined, fromTail = false) {
  const start =
    logOffset === undefined ? (fromTail ? Math.max(0, log.length - MAX_LOG_CHUNK) : 0) : Math.min(logOffset, log.length);
  const chunk = log.slice(start, start + MAX_LOG_CHUNK);
  return { log: chunk, nextOffset: start + chunk.length, hasMore: start + chunk.length < log.length };
}
