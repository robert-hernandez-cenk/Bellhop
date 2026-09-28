import { StringDecoder } from 'node:string_decoder';
import { defaultIsPidAlive, type JobRow, type JobStatus, type JobStore } from './job-store.ts';
import type { JobLog } from './job-log.ts';
import { logWarn } from '../../lib/log.ts';

// A job owned by another process (issue #6, research.md R1): this process's
// JobRunner never fires 'chunk'/'status'/'prompt'/'prompt-cleared' events for
// it, since those come from the exec channel the *owning* process holds.
// Instead this polls the two things both processes share: the job row in
// data/jobs.sqlite3, and the log file the owner appends to. One tick is one
// poll -- the caller (attachJobsWebSocket) drives it on a setInterval; tests
// call tick() directly so they need no wall-clock dependence.

const TERMINAL: JobStatus[] = ['success', 'failed', 'cancelled', 'interrupted'];

export interface ForeignJobTailOptions {
  jobStore: JobStore;
  jobLog: JobLog;
  jobId: number;
  // The row/offset the connection handler already sent status/prompt/backlog
  // from -- seeds this tail's "last sent" comparison state so its first tick
  // never re-sends what the client already has.
  initial: { offset: number; row: JobRow };
  send: (msg: object) => void;
  // Overridable for tests (a real crashed-pid scenario is otherwise
  // unreproducible deterministically). Defaults to the same liveness check
  // JobStore's own orphan cleanup uses.
  isPidAlive?: (pid: number) => boolean;
}

export interface ForeignJobTail {
  tick(): void;
  stop(): void;
  readonly stopped: boolean;
}

interface PromptState {
  text: string;
  origin: string;
  matchedIndex: number | null;
}

function promptStateOf(row: JobRow): PromptState | null {
  if (row.status !== 'awaiting_input' || !row.promptText) return null;
  return { text: row.promptText, origin: row.promptOrigin ?? 'heuristic', matchedIndex: row.promptMatchedIndex };
}

function samePrompt(a: PromptState | null, b: PromptState | null): boolean {
  if (a === null || b === null) return a === b;
  return a.text === b.text && a.origin === b.origin && a.matchedIndex === b.matchedIndex;
}

export function createForeignJobTail(options: ForeignJobTailOptions): ForeignJobTail {
  const { jobStore, jobLog, jobId, send } = options;
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  const logFile = options.initial.row.logFile;
  let offset = options.initial.offset;
  const decoder = new StringDecoder('utf8');
  let lastStatus: JobStatus = options.initial.row.status;
  let lastPrompt = promptStateOf(options.initial.row);
  let stopped = false;

  const tick = (): void => {
    if (stopped) return;
    try {
      // Row first, then log (research.md R1): the owner always appends its
      // final log line before calling markFinished, so observing a terminal
      // row here guarantees that write already landed on disk and this same
      // tick's log read picks it up -- reading in the other order could
      // observe a terminal row with the last chunk still unread.
      const row = jobStore.get(jobId);

      const bytes = jobLog.readBytes(logFile, offset);
      offset += bytes.length;
      const text = decoder.write(bytes);
      if (text.length > 0) send({ type: 'chunk', stream: 'stdout', text });

      if (!row) {
        stopped = true;
        return;
      }

      // If the owning MCP process has crashed mid-job, its row is stuck
      // wherever its last write left it (running/awaiting_input) -- nothing
      // will ever change it short of the web service's own next-startup
      // orphan cleanup (JobStore.interruptOrphaned). Without this check an
      // open page would poll this row/log forever. Stop watching rather
      // than touch the row or log ourselves (FR-004: watching never
      // modifies the job) -- no status/prompt message is invented, since
      // the row's actual status hasn't changed.
      const ownerMatch = /^mcp:(\d+)$/.exec(row.owner ?? '');
      if (ownerMatch && !isPidAlive(Number(ownerMatch[1]))) {
        logWarn(`foreign job tail for job ${jobId} stopping: owning process ${row.owner} is no longer running`);
        stopped = true;
        return;
      }

      if (row.status !== lastStatus) {
        send({ type: 'status', status: row.status });
        lastStatus = row.status;
      }

      const prompt = promptStateOf(row);
      if (!samePrompt(prompt, lastPrompt)) {
        if (prompt) {
          send({
            type: 'prompt',
            text: prompt.text,
            expectedPrompts: row.expectedPromptsJson ? JSON.parse(row.expectedPromptsJson) : [],
            origin: prompt.origin,
            matchedIndex: prompt.matchedIndex,
          });
        } else {
          send({ type: 'prompt-cleared' });
        }
        lastPrompt = prompt;
      }

      if (TERMINAL.includes(row.status)) stopped = true;
    } catch (err) {
      logWarn(`foreign job tail for job ${jobId} failed, stopping: ${(err as Error).message}`);
      stopped = true;
    }
  };

  return {
    tick,
    stop(): void {
      stopped = true;
    },
    get stopped(): boolean {
      return stopped;
    },
  };
}
