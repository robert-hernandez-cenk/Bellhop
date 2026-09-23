import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import {
  ErrorCode,
  McpError,
  type ElicitResult,
  type ProgressNotification,
  type ServerNotification,
  type ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';
import type { JobRow, JobStore } from '../web/jobs/job-store.ts';
import type { JobLog } from '../web/jobs/job-log.ts';
import type { JobRunner } from '../web/jobs/job-runner.ts';
import { MAX_LOG_CHUNK, TERMINAL_STATUSES, pageLog, requireOwned, summarizeJob } from './job-helpers.ts';
import { buildElicitationMessage, buildElicitationSchema, parseElicitationChoice, type PromptTracker } from './elicitation.ts';

export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export interface WaitForJobDeps {
  jobStore: JobStore;
  jobLog: JobLog;
  jobRunner: JobRunner;
}

export interface WaitForJobArgs {
  id: number;
  maxWaitSeconds?: number;
  logOffset?: number;
}

export const WAIT_FOR_JOB_SHAPE = {
  id: z.number().int(),
  maxWaitSeconds: z
    .number()
    .int()
    .min(1)
    .max(3600)
    .default(300)
    .describe(
      'Return still_running after this long (not enforced while the user has a prompt dialog open; an unanswered dialog returns prompt_pending after 10 minutes)'
    ),
  logOffset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(`Page the log forward from here; omitted returns the last ${MAX_LOG_CHUNK} characters`),
};

const DEFAULT_PROGRESS_INTERVAL_MS = 15_000;
// Long enough to read an installer question (the SDK's 60s default is not),
// but well under JobRunner's 15-minute abandon timer (#174): a client that
// never shows the dialog, such as a remote session, would otherwise hold the
// wait until that timer cancels the job. On timeout the SDK withdraws the
// dialog, and the prompt is handed back to the model like a decline.
const DEFAULT_ELICITATION_TIMEOUT_MS = 10 * 60 * 1000;
const LATE_ANSWER_NOTE = 'Answer not sent — prompt was already resolved\n';

type AskStep = { kind: 'continue' } | { kind: 'handed-off'; error?: string } | { kind: 'cancelling' };

// #58: blocks on a job this process owns, relaying any prompt it pauses on
// to the human via MCP elicitation. Falls back to returning prompt_pending
// (for answer_job_prompt and friends) when the client can't elicit or the
// human declines.
export async function waitForJob(
  deps: WaitForJobDeps,
  server: McpServer,
  tracker: PromptTracker,
  args: WaitForJobArgs,
  extra: ToolExtra,
  options: { progressIntervalMs?: number; elicitationTimeoutMs?: number } = {}
) {
  const { id } = args;
  requireOwned(deps, id);
  const deadline = Date.now() + (args.maxWaitSeconds ?? 300) * 1000;

  let wake: (() => void) | undefined;
  let dialog: AbortController | undefined;
  const poke = () => wake?.();
  // Subscribed before the first state read, so nothing between the read and
  // the wait can be missed.
  const onStatus = (event: { jobId: number; status: string }) => {
    if (event.jobId !== id) return;
    if (event.status !== 'awaiting_input') dialog?.abort();
    poke();
  };
  const onPrompt = (event: { jobId: number }) => {
    if (event.jobId === id) poke();
  };
  const onTrackerChange = (jobId: number) => {
    if (jobId === id) poke();
  };
  const onCallAbort = () => {
    dialog?.abort();
    poke();
  };
  deps.jobRunner.events.on('status', onStatus);
  deps.jobRunner.events.on('prompt', onPrompt);
  tracker.changes.on('change', onTrackerChange);
  extra.signal.addEventListener('abort', onCallAbort);
  const progress = startProgress(extra, () => deps.jobStore.get(id)?.status, options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS);

  const result = (outcome: 'finished' | 'prompt_pending' | 'still_running', elicitationError?: string) => {
    const job = deps.jobStore.get(id)!;
    return {
      outcome,
      job: summarizeJob(job),
      prompt: job.status === 'awaiting_input' ? { text: job.promptText, origin: job.promptOrigin } : null,
      ...(elicitationError === undefined ? {} : { elicitationError }),
      ...pageLog(deps.jobLog.read(job.logFile), args.logOffset, true),
    };
  };

  try {
    for (;;) {
      // The SDK discards a cancelled call's result; this just ends the loop.
      if (extra.signal.aborted) return result('still_running');
      const job = deps.jobStore.get(id)!;
      if (TERMINAL_STATUSES.has(job.status)) return result('finished');

      if (job.status === 'awaiting_input') {
        if (!server.server.getClientCapabilities()?.elicitation?.form) return result('prompt_pending');
        const claim = tracker.claim(id);
        if (claim.kind === 'handed-off') return result('prompt_pending');
        if (claim.kind === 'ask') {
          dialog = new AbortController();
          let step: AskStep;
          try {
            step = await askHuman(
              deps,
              server,
              job,
              extra,
              dialog.signal,
              options.elicitationTimeoutMs ?? DEFAULT_ELICITATION_TIMEOUT_MS
            );
          } catch (err) {
            // askHuman only throws for something unexpected past its own
            // elicitInput try/catch (jobStore/jobLog/jobRunner calls made
            // after the human responded) -- without this, the generation
            // would stay stuck in "asking" forever and every later waiter
            // would see 'busy' for this prompt indefinitely. Release it as
            // 'resolved' (this generation is done, not handed off or
            // cancelling) and let the error surface as this call's isError
            // result, same as any other unexpected failure.
            dialog = undefined;
            tracker.release(id, claim.generation, 'resolved');
            throw err;
          }
          dialog = undefined;
          tracker.release(
            id,
            claim.generation,
            step.kind === 'handed-off' ? 'handed-off' : step.kind === 'cancelling' ? 'cancelling' : 'resolved'
          );
          if (step.kind === 'handed-off') return result('prompt_pending', step.error);
          continue;
        }
        // 'busy': another wait_for_job call is asking, or this generation was
        // just told to cancel and hasn't left awaiting_input yet. Either
        // way, release() (or the eventual status change) pokes us.
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) return result('still_running');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = undefined;
    }
  } finally {
    deps.jobRunner.events.off('status', onStatus);
    deps.jobRunner.events.off('prompt', onPrompt);
    tracker.changes.off('change', onTrackerChange);
    extra.signal.removeEventListener('abort', onCallAbort);
    progress.stop();
  }
}

async function askHuman(
  deps: WaitForJobDeps,
  server: McpServer,
  job: JobRow,
  extra: ToolExtra,
  signal: AbortSignal,
  timeoutMs: number
): Promise<AskStep> {
  let response: ElicitResult;
  try {
    response = await server.server.elicitInput(
      {
        mode: 'form',
        message: buildElicitationMessage(job, deps.jobLog.read(job.logFile)),
        requestedSchema: buildElicitationSchema(job),
      },
      { signal, timeout: timeoutMs, relatedRequestId: extra.requestId }
    );
  } catch (err) {
    // Withdrawn because the prompt resolved elsewhere or this call was
    // cancelled: the loop re-reads the job and decides.
    if (signal.aborted) return { kind: 'continue' };
    if (err instanceof McpError && err.code === ErrorCode.RequestTimeout) {
      return {
        kind: 'handed-off',
        error: `No answer in the prompt dialog within ${formatDuration(timeoutMs)}; it was withdrawn. Ask the user in chat and send their reply with answer_job_prompt.`,
      };
    }
    return { kind: 'handed-off', error: err instanceof Error ? err.message : String(err) };
  }

  const choice = parseElicitationChoice(response);
  const stillPaused = deps.jobStore.get(job.id)?.status === 'awaiting_input';
  switch (choice.kind) {
    case 'declined':
      // Nothing to hand off if the prompt resolved while the dialog closed.
      return stillPaused ? { kind: 'handed-off' } : { kind: 'continue' };
    case 'cancel-job':
      // cancel() only aborts the controller -- the job stays awaiting_input
      // until run() actually rejects, so this generation must stay busy
      // (not askable again) until that status change lands.
      deps.jobRunner.cancel(job.id);
      return { kind: 'cancelling' };
    case 'resume':
      if (!deps.jobRunner.dismissPrompt(job.id)) deps.jobLog.append(job.logFile, LATE_ANSWER_NOTE);
      return { kind: 'continue' };
    case 'answer':
      if (!deps.jobRunner.answerPrompt(job.id, choice.text)) deps.jobLog.append(job.logFile, LATE_ANSWER_NOTE);
      return { kind: 'continue' };
  }
}

function formatDuration(ms: number): string {
  return ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000} minutes` : `${ms / 1000} seconds`;
}

function startProgress(extra: ToolExtra, statusOf: () => string | undefined, intervalMs: number): { stop: () => void } {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return { stop: () => {} };
  let ticks = 0;
  const timer = setInterval(() => {
    ticks++;
    const message = statusOf() === 'awaiting_input' ? 'awaiting answer' : 'running';
    const params: ProgressNotification['params'] = { progressToken, progress: ticks, message };
    extra.sendNotification({ method: 'notifications/progress', params }).catch(() => {});
  }, intervalMs);
  return { stop: () => clearInterval(timer) };
}
