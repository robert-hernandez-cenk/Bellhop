import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ElicitRequestFormParamsSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  PromptTracker,
  buildElicitationSchema,
  buildElicitationMessage,
  lastLines,
  parseElicitationChoice,
} from '../../src/mcp/elicitation.ts';
import type { JobRow } from '../../src/web/jobs/job-store.ts';

function row(overrides: Partial<JobRow>): JobRow {
  return {
    id: 7,
    command: 'install-app',
    target: 'app-lxc',
    status: 'awaiting_input',
    promptText: '  Add Adminer? (y/N) ',
    promptOrigin: 'expected',
    ...overrides,
  } as JobRow;
}

test('buildElicitationSchema is a valid form elicitation schema', () => {
  assert.doesNotThrow(() =>
    ElicitRequestFormParamsSchema.parse({ mode: 'form', message: 'x', requestedSchema: buildElicitationSchema(row({})) })
  );
});

// Claude Code folds a long elicitation message but always shows field titles
// (#174), so the answer field carries the question too.
function answerTitle(job: JobRow): string {
  return (buildElicitationSchema(job).properties.answer as { title: string }).title;
}

test('buildElicitationSchema puts the trimmed, ANSI-stripped prompt in the answer title', () => {
  assert.equal(answerTitle(row({ promptText: '\x1b[33m   Enable TLS?\x1b[0m\r\n  [y/N]: ' })), 'Answer to: Enable TLS? [y/N]:');
});

test('buildElicitationSchema shortens a long prompt in the answer title', () => {
  const title = answerTitle(row({ promptText: 'Q'.repeat(200) }));
  assert.ok(title.length <= 'Answer to: '.length + 80, title);
  assert.ok(title.endsWith('…'));
});

test('buildElicitationSchema falls back to a plain answer title without prompt text', () => {
  assert.equal(answerTitle(row({ promptText: null })), 'Answer');
  assert.equal(answerTitle(row({ promptText: ' \x1b[0m ' })), 'Answer');
});

test('lastLines keeps only the last n lines, dropping ANSI codes and CRs', () => {
  const log = ['one', '\x1b[32mtwo\x1b[0m', 'three\r', ''].join('\n');
  assert.equal(lastLines(log, 2), 'two\nthree');
});

// Captured from a live install-app valkey run: 33 of its 41 lines are
// spinner frames, which used to fill the dialog's whole context window.
const valkeyLog: string = JSON.parse(
  readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'job-logs', 'valkey-tls-prompt.json'), 'utf8')
).log;

test('lastLines collapses a run of spinner frames to one line of its text', () => {
  assert.equal(
    lastLines(valkeyLog, 20),
    [
      'Updating Container OS',
      '',
      '  ✔️  Updated Container OS',
      '',
      'Installing Valkey',
      '',
      '  ✔️  Installed Valkey',
      '',
      '      Enable TLS for Valkey (Sentinel mode does not supported)? [y/N]:',
    ].join('\n')
  );
});

test('lastLines splits spinner frames redrawn in place on one line', () => {
  const log = '\x1b[2K⠋ Fetching release\x1b[2K⠙ Fetching release\r\x1b[2K⠹ Fetching release\ntar: Unexpected EOF in archive\n';
  assert.equal(lastLines(log, 20), 'Fetching release\ntar: Unexpected EOF in archive');
});

// Claude Code shows only the first few lines of the message (#174).
test('buildElicitationMessage leads with the trimmed prompt, then the job, then recent output', () => {
  const message = buildElicitationMessage(row({}), 'building\nAdd Adminer? (y/N) ');
  assert.equal(message.split('\n')[0], 'Add Adminer? (y/N)');
  assert.match(message, /\n\nJob 7 \(install-app on app-lxc\) is waiting for input\./);
  assert.match(message, /Recent output:\nbuilding\n/);
  assert.ok(message.indexOf('Job 7') < message.indexOf('Recent output:'));
});

test('buildElicitationMessage wording depends on the detection tier', () => {
  assert.match(buildElicitationMessage(row({ promptOrigin: 'expected' }), ''), /known to ask/);
  assert.match(buildElicitationMessage(row({ promptOrigin: 'heuristic' }), ''), /looks like a question/);
  assert.match(buildElicitationMessage(row({ promptOrigin: 'stall' }), ''), /may not be a real question/);
  assert.doesNotMatch(buildElicitationMessage(row({}), ''), /Recent output/);
});

test('buildElicitationMessage caps context at 20 lines', () => {
  const log = Array.from({ length: 30 }, (_, i) => `line${i}`).join('\n');
  const message = buildElicitationMessage(row({}), log);
  assert.ok(!message.includes('line9\n'));
  assert.ok(message.includes('line10\n'));
  assert.ok(message.endsWith('line29'));
});

test('parseElicitationChoice maps each response', () => {
  assert.deepEqual(parseElicitationChoice({ action: 'accept', content: { action: 'answer', answer: 'y' } }), { kind: 'answer', text: 'y' });
  assert.deepEqual(parseElicitationChoice({ action: 'accept', content: { action: 'answer' } }), { kind: 'answer', text: '' });
  assert.deepEqual(parseElicitationChoice({ action: 'accept', content: { action: 'resume' } }), { kind: 'resume' });
  assert.deepEqual(parseElicitationChoice({ action: 'accept', content: { action: 'cancel' } }), { kind: 'cancel-job' });
  assert.deepEqual(parseElicitationChoice({ action: 'decline' }), { kind: 'declined' });
  assert.deepEqual(parseElicitationChoice({ action: 'cancel' }), { kind: 'declined' });
});

test('PromptTracker lets one caller ask per prompt and hands off a decline', () => {
  const events = new EventEmitter();
  const tracker = new PromptTracker(events);
  events.emit('prompt', { jobId: 1 });

  const first = tracker.claim(1);
  assert.deepEqual(first, { kind: 'ask', generation: 1 });
  assert.deepEqual(tracker.claim(1), { kind: 'busy' });

  // Released without a decline (answered, or the dialog was withdrawn): askable again.
  tracker.release(1, 1, 'resolved');
  assert.deepEqual(tracker.claim(1), { kind: 'ask', generation: 1 });

  // Declined: handed off for this prompt only.
  tracker.release(1, 1, 'handed-off');
  assert.deepEqual(tracker.claim(1), { kind: 'handed-off' });

  events.emit('prompt', { jobId: 1 });
  assert.deepEqual(tracker.claim(1), { kind: 'ask', generation: 2 });
  assert.deepEqual(tracker.claim(2), { kind: 'ask', generation: 0 });
});

test('PromptTracker.release emits change with the job id', () => {
  const tracker = new PromptTracker(new EventEmitter());
  const seen: number[] = [];
  tracker.changes.on('change', (id: number) => seen.push(id));
  tracker.release(3, 0, 'resolved');
  assert.deepEqual(seen, [3]);
});

test('PromptTracker keeps a cancelling generation busy until a new prompt arrives', () => {
  const events = new EventEmitter();
  const tracker = new PromptTracker(events);
  events.emit('prompt', { jobId: 1 });

  const claim = tracker.claim(1);
  assert.deepEqual(claim, { kind: 'ask', generation: 1 });
  tracker.release(1, claim.generation, 'cancelling');

  // Still busy, even though nothing is actively asking -- the job is
  // presumed to still be awaiting_input while it winds down.
  assert.deepEqual(tracker.claim(1), { kind: 'busy' });
  assert.deepEqual(tracker.claim(1), { kind: 'busy' });

  // A genuinely new prompt (a new generation) is askable again.
  events.emit('prompt', { jobId: 1 });
  assert.deepEqual(tracker.claim(1), { kind: 'ask', generation: 2 });
});
