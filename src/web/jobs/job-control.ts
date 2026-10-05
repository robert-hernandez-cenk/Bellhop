import type { ControlAction, JobRow, JobStore } from './job-store.ts';
import { defaultIsPidAlive } from './job-store.ts';
import type { JobRunner } from './job-runner.ts';

// Shared by the web control routes (src/web/routes/jobs.ts) and the MCP
// control tools (src/mcp/build-server.ts), #6: whichever process the
// requester runs as (owner === jobRunner.owner determines "local"), this is
// the one place that decides what happens when an operator asks to
// cancel/answer/dismiss a job -- so the three front ends (three web routes,
// three MCP tools) can never disagree about the outcome. See
// specs/007-cross-process-job-control/research.md R3.
export type ControlResult = { kind: 'done' } | { kind: 'requested'; owner: string } | { kind: 'refused'; message: string };

export interface RequestJobControlDeps {
  jobStore: JobStore;
  // Only the four members requestJobControl actually needs -- a Pick
  // rather than the full JobRunner so a test can pass a plain object
  // instead of standing up a real runner (SSH client, log dir, etc.).
  jobRunner: Pick<JobRunner, 'owner' | 'cancel' | 'answerPrompt' | 'dismissPrompt'>;
  // Overridable for tests; production always uses the real check
  // (process.kill(pid, 0)).
  isPidAlive?: (pid: number) => boolean;
}

export interface RequestJobControlInput {
  job: JobRow;
  action: ControlAction;
  // Answer text for 'answer' only.
  text?: string;
  // The real (never impersonated/overlaid) username, when known: the web
  // user, or an MCP server's actor (#65/#66: the signed-in admin or api-key
  // over HTTP, the OS user over stdio). Recorded on a written request row
  // and echoed in its eventual attribution log line.
  requestedByUsername?: string;
  // Who to label the request as, when that is not this process's runner:
  // an HTTP MCP session runs inside the web service but is not the web UI
  // (#65/#66), so it passes 'mcp:http'.
  requestedByOwner?: string;
}

// Today's exact wording (src/web/routes/jobs.ts's own 409 bodies, and
// src/mcp/build-server.ts's tool errors before this) -- defined once here
// so a local and a foreign refusal for the same reason always read
// identically, whichever front end raised it.
function refusalMessage(job: JobRow, action: ControlAction): string {
  switch (action) {
    case 'cancel':
      return `Job ${job.id} is already ${job.status} — nothing to cancel`;
    case 'answer':
      return `Job ${job.id} is not awaiting input — nothing to answer`;
    case 'dismiss':
      return `Job ${job.id} is not awaiting input — nothing to dismiss`;
  }
}

// Whether `action` could ever apply to a job currently in `status` --
// mirrors the state JobRunner's own cancel/answerPrompt/dismissPrompt
// check locally (queued/running/awaiting_input all have a live
// controller; only awaiting_input has a pending prompt to answer/
// dismiss). Used only for a *foreign* job, where there's no controller to
// ask directly -- see the comment at its one call site below.
function actionApplies(status: JobRow['status'], action: ControlAction): boolean {
  if (action === 'cancel') return status === 'queued' || status === 'running' || status === 'awaiting_input';
  return status === 'awaiting_input';
}

export function requestJobControl(deps: RequestJobControlDeps, req: RequestJobControlInput): ControlResult {
  const { jobStore, jobRunner, isPidAlive = defaultIsPidAlive } = deps;
  const { job, action, text, requestedByUsername, requestedByOwner } = req;
  const owner = job.owner ?? 'web';

  if (owner === jobRunner.owner) {
    const applied =
      action === 'cancel'
        ? jobRunner.cancel(job.id)
        : action === 'answer'
          ? jobRunner.answerPrompt(job.id, text ?? '')
          : jobRunner.dismissPrompt(job.id);
    return applied ? { kind: 'done' } : { kind: 'refused', message: refusalMessage(job, action) };
  }

  // Foreign job: this process holds no controller/pendingPrompts entry for
  // it at all, so the only way to ask the owner is to write a request row
  // it will poll for -- but first rule out the cases nothing should ever
  // queue for (research.md R3).
  const mcpMatch = /^mcp:(\d+)$/.exec(owner);
  if (mcpMatch && !isPidAlive(Number(mcpMatch[1]))) {
    // "web" never matches this regex, so a web-owned job is never treated
    // as dead here -- its string carries no pid to check, and the web
    // service either answers requests or it doesn't (there's no separate
    // liveness signal for it, see research.md R3).
    return { kind: 'refused', message: `job ${job.id}'s owning process ${owner} has exited` };
  }

  if (!actionApplies(job.status, action)) {
    return { kind: 'refused', message: refusalMessage(job, action) };
  }

  jobStore.createControlRequest({
    jobId: job.id,
    action,
    text,
    requestedByOwner: requestedByOwner ?? jobRunner.owner,
    requestedByUsername,
  });
  return { kind: 'requested', owner };
}
