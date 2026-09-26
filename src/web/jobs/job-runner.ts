import { EventEmitter } from 'node:events';
import type { SSHClient } from '../../lib/ssh-client.ts';
import type { JobStore, JobRow, ControlAction } from './job-store.ts';
import type { JobLog } from './job-log.ts';
import { JobSSHClient } from './job-ssh-client.ts';
import type { PromptOrigin } from './job-ssh-client.ts';
import { withCapturedConsole } from '../console-capture.ts';

// The attribution line processControlRequests appends to the job log once
// a request is applied (research.md R4) -- source is "web UI" for the web
// service's own owner string, "MCP (mcp:<pid>)" for an MCP server's, and
// " by <user>" is omitted entirely when no username was recorded (an MCP
// requester never has one).
function controlSource(owner: string): string {
  return owner === 'web' ? 'web UI' : `MCP (${owner})`;
}

function controlAttributionLine(action: ControlAction, requestedByOwner: string, requestedByUsername: string | null): string {
  const source = controlSource(requestedByOwner);
  const suffix = requestedByUsername ? ` by ${requestedByUsername}` : '';
  switch (action) {
    case 'cancel':
      return `Stop requested from ${source}${suffix}`;
    case 'answer':
      return `Answer sent from ${source}${suffix}`;
    case 'dismiss':
      return `Prompt dismissed from ${source}${suffix}`;
  }
}

export interface JobDefinition {
  command: string;
  category: 'provisioning' | 'maintenance';
  target?: string;
  argsJson: string;
  // Only install-app's job sets these (see issue #57) -- every other job
  // type omits them and JobSSHClient behaves exactly as it always has.
  watchForPrompts?: boolean;
  expectedPrompts?: string[];
  // Forwarded straight through to JobStore.createJob -- see JobRow's own
  // fields for what these mean.
  triggeredByUsername?: string;
  triggeredByImpersonating?: string;
  run: (ssh: SSHClient) => Promise<void>;
}

export interface JobRunnerOptions {
  // How long an awaiting_input job waits for an answer before it's
  // auto-cancelled (issue #57). Overridable only for tests -- production
  // always uses the 15-minute default.
  abandonPromptMs?: number;
  // Test-only overrides forwarded straight into JobSSHClient's own
  // constructor options -- let tests trigger prompt detection
  // deterministically instead of waiting on a real 30s timer.
  promptSilenceMs?: number;
  promptExpectedSilenceMs?: number;
  promptStallMs?: number;
  promptScheduleCheck?: (fn: () => void, ms: number) => { cancel: () => void };
  // Stamped on every job this runner creates, and the scope of its orphan
  // cleanup. 'web' for the web service; the MCP server passes 'mcp:<pid>' (#16).
  owner?: string;
  // How often processControlRequests() polls while this runner has active
  // jobs (#6). Overridable only for tests -- production always uses the
  // 500ms default.
  controlPollMs?: number;
}

const DEFAULT_ABANDON_PROMPT_MS = 15 * 60 * 1000;

export class JobRunner {
  readonly events = new EventEmitter();
  readonly owner: string;
  // Only holds an entry while a job is queued or actually running -- cancel()
  // uses this to both stop an in-flight job (abort() ends its current SSH
  // connection, see Ssh2SSHClient) and skip one that hasn't started yet
  // (execute() checks signal.aborted before doing anything). Removed in
  // execute()'s finally, so a stale id can never be "cancelled" after the
  // fact.
  private controllers = new Map<number, AbortController>();
  private pendingPrompts = new Map<number, { write: (text: string) => void; resume: () => void }>();
  private abandonTimers = new Map<number, NodeJS.Timeout>();
  private abandonPromptMs: number;
  private promptSilenceMs?: number;
  private promptExpectedSilenceMs?: number;
  private promptStallMs?: number;
  private promptScheduleCheck?: (fn: () => void, ms: number) => { cancel: () => void };
  private controlPollMs: number;
  // Only runs while this.controllers is non-empty (see ensureControlPoller/
  // clearControlPoller) -- FR-011's "no work while idle", and what makes
  // hasControlPoller() a meaningful test accessor.
  private controlPollTimer: NodeJS.Timeout | undefined;

  constructor(
    private store: JobStore,
    private log: JobLog,
    private baseSsh: SSHClient,
    options: JobRunnerOptions = {}
  ) {
    this.owner = options.owner ?? 'web';
    this.abandonPromptMs = options.abandonPromptMs ?? DEFAULT_ABANDON_PROMPT_MS;
    this.promptSilenceMs = options.promptSilenceMs;
    this.promptExpectedSilenceMs = options.promptExpectedSilenceMs;
    this.promptStallMs = options.promptStallMs;
    this.promptScheduleCheck = options.promptScheduleCheck;
    this.controlPollMs = options.controlPollMs ?? 500;
  }

  enqueue(def: JobDefinition): number {
    const id = this.store.createJob({
      command: def.command,
      category: def.category,
      target: def.target,
      argsJson: def.argsJson,
      expectedPromptsJson: def.expectedPrompts ? JSON.stringify(def.expectedPrompts) : undefined,
      triggeredByUsername: def.triggeredByUsername,
      triggeredByImpersonating: def.triggeredByImpersonating,
      owner: this.owner,
    });
    const logFile = this.store.get(id)!.logFile;
    const controller = new AbortController();
    this.controllers.set(id, controller);
    this.ensureControlPoller();
    void this.execute(id, logFile, def, controller);
    return id;
  }

  // One pass over this runner's own pending control requests (#6) --
  // production calls this from the poller timer below; tests call it
  // directly to avoid depending on wall-clock timing (research.md R4/R7).
  // A row for a job id this runner doesn't currently hold a controller for
  // (finished, or created directly in the store) is marked not-applicable
  // and left otherwise untouched -- covers both "the job is already over"
  // and "this row predates this process's own lifetime."
  processControlRequests(): void {
    for (const req of this.store.pendingControlRequests(this.owner)) {
      if (!this.controllers.has(req.jobId)) {
        this.store.markControlRequestHandled(req.id, 'not-applicable');
        continue;
      }
      const applied =
        req.action === 'cancel'
          ? this.cancel(req.jobId)
          : req.action === 'answer'
            ? this.answerPrompt(req.jobId, req.text ?? '')
            : this.dismissPrompt(req.jobId);
      this.store.markControlRequestHandled(req.id, applied ? 'applied' : 'not-applicable');
      if (applied) {
        const job = this.store.get(req.jobId);
        if (job) {
          this.emitLogChunk(req.jobId, job.logFile, controlAttributionLine(req.action, req.requestedByOwner, req.requestedByUsername), 'stdout');
        }
      }
    }
  }

  private ensureControlPoller(): void {
    if (this.controlPollTimer) return;
    const timer = setInterval(() => this.processControlRequests(), this.controlPollMs);
    timer.unref();
    this.controlPollTimer = timer;
  }

  private clearControlPoller(): void {
    if (this.controlPollTimer) {
      clearInterval(this.controlPollTimer);
      this.controlPollTimer = undefined;
    }
  }

  // Test accessor (research.md R7) -- lets a test assert the poller is
  // actually running/stopped without depending on its interval firing.
  hasControlPoller(): boolean {
    return this.controlPollTimer !== undefined;
  }

  // Returns false when the job isn't queued/running (already finished, or
  // never existed) -- both are "nothing to cancel", not an error, so the
  // route layer decides what that means for the HTTP response.
  cancel(id: number): boolean {
    const controller = this.controllers.get(id);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  // Writes an operator-submitted answer into the job's paused exec channel
  // and resumes prompt watching. Returns false when the job isn't actually
  // awaiting input (unknown id, already answered, already finished) -- same
  // "nothing to do" convention as cancel().
  answerPrompt(id: number, text: string): boolean {
    const pending = this.pendingPrompts.get(id);
    if (!pending) return false;
    pending.write(text.endsWith('\n') ? text : `${text}\n`);
    pending.resume();
    return true;
  }

  // Clears an awaiting_input job's paused state without writing anything to
  // its exec channel -- for a false-positive detection the operator knows
  // isn't actually a stuck prompt.
  dismissPrompt(id: number): boolean {
    const pending = this.pendingPrompts.get(id);
    if (!pending) return false;
    pending.resume();
    return true;
  }

  // Called once at process startup, before any new job is enqueued (see
  // src/web/server.ts) -- closes out every row left in a non-terminal
  // status by a previous process that died mid-job. See JobStore.
  // interruptOrphaned for why these rows can never legitimately belong to
  // the current process.
  reconcileOrphanedJobs(): void {
    const orphaned: JobRow[] = this.store.interruptOrphaned(this.owner);
    for (const row of orphaned) {
      const note =
        row.status === 'queued'
          ? `Interrupted: service restarted before this job started running. No remote work was performed.\n`
          : `Interrupted: service restarted while this job was ${row.status}. Remote work may have completed — check the log above and verify manually.\n`;
      this.log.append(row.logFile, note);
    }
  }

  // For a process that is exiting (the MCP server's stdin closing, #16):
  // aborts every queued/running job this runner holds, waits briefly for
  // them to settle as 'cancelled', then closes out any row it still owns in
  // a non-terminal status the same way a restart would.
  async shutdown(timeoutMs = 5000): Promise<void> {
    for (const controller of this.controllers.values()) controller.abort();
    const deadline = Date.now() + timeoutMs;
    while (this.controllers.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    this.clearControlPoller();
    this.reconcileOrphanedJobs();
  }

  // Shared by execute()'s own emitChunk closure and processControlRequests'
  // attribution line, so a local WebSocket viewer sees the latter too (both
  // append to the log and emit the same 'chunk' event).
  private emitLogChunk(jobId: number, logFile: string, text: string, stream: 'stdout' | 'stderr'): void {
    this.log.append(logFile, text.endsWith('\n') ? text : `${text}\n`);
    this.events.emit('chunk', { jobId, stream, text });
  }

  private async execute(id: number, logFile: string, def: JobDefinition, controller: AbortController): Promise<void> {
    const emitChunk = (text: string, stream: 'stdout' | 'stderr') => this.emitLogChunk(id, logFile, text, stream);

    const onPromptDetected = (
      text: string,
      expectedPrompts: string[],
      write: (text: string) => void,
      resume: () => void,
      origin: PromptOrigin,
      matchedIndex: number | null
    ) => {
      this.pendingPrompts.set(id, { write, resume });
      const timer = setTimeout(() => {
        emitChunk('Job cancelled — no answer to prompt within 15 minutes', 'stderr');
        this.cancel(id);
      }, this.abandonPromptMs);
      this.abandonTimers.set(id, timer);
      this.store.markAwaitingInput(id, text, origin, matchedIndex);
      this.events.emit('status', { jobId: id, status: 'awaiting_input' });
      this.events.emit('prompt', { jobId: id, text, expectedPrompts, origin, matchedIndex });
    };

    const onPromptCleared = () => {
      this.pendingPrompts.delete(id);
      const timer = this.abandonTimers.get(id);
      if (timer) {
        clearTimeout(timer);
        this.abandonTimers.delete(id);
      }
      this.store.markRunning(id);
      this.events.emit('status', { jobId: id, status: 'running' });
      this.events.emit('prompt-cleared', { jobId: id });
    };

    try {
      await withCapturedConsole(
        async () => {
          // A job can be cancelled while it's still waiting its turn in
          // withCapturedConsole's serializing chain (only one job actually
          // runs at a time) -- skip it entirely rather than starting work
          // that's already been called off.
          if (controller.signal.aborted) throw new Error('Job cancelled');
          this.store.markRunning(id);
          this.events.emit('status', { jobId: id, status: 'running' });
          const jobSsh = new JobSSHClient(this.baseSsh, (chunk, stream) => emitChunk(chunk, stream), controller.signal, {
            watchForPrompts: def.watchForPrompts,
            expectedPrompts: def.expectedPrompts,
            onPromptDetected,
            onPromptCleared,
            expectedSilenceMs: this.promptExpectedSilenceMs,
            silenceMs: this.promptSilenceMs,
            stallMs: this.promptStallMs,
            scheduleCheck: this.promptScheduleCheck,
          });
          await def.run(jobSsh);
        },
        (line) => emitChunk(line, 'stdout')
      );

      this.store.markFinished(id, { status: 'success', exitCode: 0 });
      this.events.emit('status', { jobId: id, status: 'success' });
    } catch (err) {
      const cancelled = controller.signal.aborted;
      const message = err instanceof Error ? err.message : String(err);
      emitChunk(cancelled ? 'Job cancelled by operator' : `ERROR: ${message}`, 'stderr');
      this.store.markFinished(id, {
        status: cancelled ? 'cancelled' : 'failed',
        exitCode: 1,
        errorMessage: cancelled ? 'Cancelled by operator' : message,
      });
      this.events.emit('status', { jobId: id, status: cancelled ? 'cancelled' : 'failed' });
    } finally {
      this.controllers.delete(id);
      this.pendingPrompts.delete(id);
      const timer = this.abandonTimers.get(id);
      if (timer) {
        clearTimeout(timer);
        this.abandonTimers.delete(id);
      }
      if (this.controllers.size === 0) this.clearControlPoller();
    }
  }
}
