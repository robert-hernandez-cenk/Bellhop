import { EventEmitter } from 'node:events';
import type { ElicitRequestFormParams, ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import type { JobRow } from '../web/jobs/job-store.ts';
import { ANSI_ESCAPE, type PromptOrigin } from '../web/jobs/job-ssh-client.ts';

export const ELICITATION_CONTEXT_LINES = 20;
const ANSWER_TITLE_PROMPT_CHARS = 80;

// Flat by necessity: MCP form elicitation only allows primitive fields.
// Claude Code folds a long message but always shows field titles (#174), so
// the answer field repeats the question, collapsed to one short line.
export function buildElicitationSchema(job: JobRow): ElicitRequestFormParams['requestedSchema'] {
  const prompt = (job.promptText ?? '').replace(ANSI_ESCAPE, '').replace(/\s+/g, ' ').trim();
  const shortened =
    prompt.length > ANSWER_TITLE_PROMPT_CHARS ? `${prompt.slice(0, ANSWER_TITLE_PROMPT_CHARS - 1)}…` : prompt;
  return {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        title: 'What to do',
        oneOf: [
          { const: 'answer', title: 'Send answer' },
          { const: 'resume', title: 'Not a real prompt — resume' },
          { const: 'cancel', title: 'Cancel the job' },
        ],
        default: 'answer',
      },
      answer: {
        type: 'string',
        title: shortened ? `Answer to: ${shortened}` : 'Answer',
        description: 'Sent followed by Enter. Leave empty to just press Enter.',
      },
    },
    required: ['action'],
  };
}

// Mirrors how JobView labels each detection tier (#160): a stall is a guess.
const ORIGIN_NOTES: Record<PromptOrigin, string> = {
  expected: 'The installer is asking a question it is known to ask.',
  heuristic: 'The installer went quiet after output that looks like a question.',
  stall: 'The installer has printed nothing for 5 minutes. This may not be a real question; it could still be working.',
};

// community-scripts' spinner redraws its line once per frame ("⠋ Installing
// X", "⠙ Installing X", ...), with a \r or erase-line code before each frame.
// Dozens of frames would otherwise fill every context line in the dialog.
const IN_PLACE_REDRAW = /\r|\x1b\[2K/g;
const SPINNER_FRAME = /^\s*[⠀-⣿]\s+/;

export function lastLines(log: string, n: number): string {
  const kept: string[] = [];
  for (const raw of log.replace(IN_PLACE_REDRAW, '\n').replace(ANSI_ESCAPE, '').split('\n')) {
    const line = raw.replace(SPINNER_FRAME, '').trimEnd();
    // Consecutive repeats (a run of frames, a run of blank lines) add nothing.
    // Each redraw also leaves a blank line behind, so a repeat separated from
    // its previous copy only by blanks counts as consecutive too.
    let last = kept.length - 1;
    while (line !== '' && last >= 0 && kept[last] === '') last--;
    if (last >= 0 && kept[last] === line) {
      kept.length = last + 1;
      continue;
    }
    kept.push(line);
  }
  while (kept[0] === '') kept.shift();
  while (kept[kept.length - 1] === '') kept.pop();
  return kept.slice(-n).join('\n');
}

export function buildElicitationMessage(job: JobRow, log: string): string {
  const label = `Job ${job.id} (${job.command}${job.target ? ` on ${job.target}` : ''})`;
  const note = ORIGIN_NOTES[job.promptOrigin as PromptOrigin] ?? ORIGIN_NOTES.heuristic;
  const context = lastLines(log, ELICITATION_CONTEXT_LINES);
  const prompt = (job.promptText ?? '').trim();
  // The prompt leads: Claude Code shows only the first few lines (#174).
  return [
    ...(prompt ? [prompt] : []),
    `${label} is waiting for input.`,
    note,
    ...(context ? [`Recent output:\n${context}`] : []),
  ].join('\n\n');
}

export type ElicitationChoice =
  | { kind: 'answer'; text: string }
  | { kind: 'resume' }
  | { kind: 'cancel-job' }
  | { kind: 'declined' };

// MCP's own 'decline' and 'cancel' both mean the human didn't act on the
// form; our form's 'cancel' option is the one that cancels the job.
export function parseElicitationChoice(result: ElicitResult): ElicitationChoice {
  if (result.action !== 'accept') return { kind: 'declined' };
  const content = result.content ?? {};
  if (content.action === 'resume') return { kind: 'resume' };
  if (content.action === 'cancel') return { kind: 'cancel-job' };
  return { kind: 'answer', text: typeof content.answer === 'string' ? content.answer : '' };
}

// Per-server state shared by every wait_for_job call (#58). A job's
// "generation" counts its prompt events, so one detected prompt is asked
// about at most once at a time, and a declined prompt stays handed off to
// the model until the job pauses on a new one. A generation whose answer was
// "cancel the job" also stays busy (never re-askable) until the job actually
// leaves awaiting_input -- cancel() only aborts the controller, so the job
// can sit in awaiting_input for a while after the choice is made, and
// without this a second wait_for_job loop iteration (this call or a
// concurrent one) would re-claim it and open a second, redundant dialog.
export class PromptTracker {
  readonly changes = new EventEmitter();
  private generations = new Map<number, number>();
  private asking = new Map<number, number>();
  private handedOff = new Map<number, number>();
  private cancelling = new Map<number, number>();

  constructor(events: EventEmitter) {
    events.on('prompt', ({ jobId }: { jobId: number }) => {
      this.generations.set(jobId, (this.generations.get(jobId) ?? 0) + 1);
    });
  }

  claim(jobId: number): { kind: 'ask'; generation: number } | { kind: 'busy' } | { kind: 'handed-off' } {
    const generation = this.generations.get(jobId) ?? 0;
    if (this.handedOff.get(jobId) === generation) return { kind: 'handed-off' };
    if (this.asking.get(jobId) === generation) return { kind: 'busy' };
    if (this.cancelling.get(jobId) === generation) return { kind: 'busy' };
    this.asking.set(jobId, generation);
    return { kind: 'ask', generation };
  }

  release(jobId: number, generation: number, outcome: 'resolved' | 'handed-off' | 'cancelling'): void {
    if (this.asking.get(jobId) === generation) this.asking.delete(jobId);
    if (outcome === 'handed-off') this.handedOff.set(jobId, generation);
    if (outcome === 'cancelling') this.cancelling.set(jobId, generation);
    this.changes.emit('change', jobId);
  }
}
