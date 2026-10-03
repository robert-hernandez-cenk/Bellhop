import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OutputActivity } from '../../../src/web/jobs/output-activity.ts';

// One build.func-style spinner frame: return to column 0, erase the line,
// draw a Braille glyph and the status text. Issue #52.
const STATUS = 'Skipping host LXC stack upgrade prompt (unattended mode)';
const GLYPHS = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴'];
function frame(index: number, text = STATUS): string {
  return `\r\x1b[2K${GLYPHS[index % GLYPHS.length]} ${text}`;
}

// Pushes enough frames that the status line has been seen and committed, so
// every later frame repeats a recent line.
function withSeenSpinner(): OutputActivity {
  const activity = new OutputActivity();
  assert.equal(activity.push(frame(0)), true, 'the first frame is new text');
  activity.push(frame(1));
  return activity;
}

test('whole spinner frames repeating a seen line are redraws: push returns false and length is unchanged', () => {
  const activity = withSeenSpinner();
  const before = activity.length;
  for (let i = 2; i < 12; i += 1) {
    assert.equal(activity.push(frame(i)), false, `frame ${i}`);
  }
  assert.equal(activity.length, before);
});

test('a frame split across two chunks is a redraw in both halves', () => {
  const activity = withSeenSpinner();
  activity.push(frame(2));
  const before = activity.length;
  assert.equal(activity.push('\r\x1b[2K⠼ Skipping host LX'), false);
  assert.equal(activity.push('C stack upgrade prompt (unattended mode)'), false);
  // Split inside the escape sequence itself.
  assert.equal(activity.push('\r\x1b['), false);
  assert.equal(activity.push(`2K⠴ ${STATUS}`), false);
  assert.equal(activity.length, before);
});

test('a glyph-only frame is a redraw, even before anything has been seen', () => {
  const activity = new OutputActivity();
  assert.equal(activity.push('\r⠋'), false);
  assert.equal(activity.push('\r\x1b[2K⠙'), false);
  assert.equal(activity.length, 0);
});

test('a check-mark line repeating the spinner text is a redraw', () => {
  const activity = withSeenSpinner();
  activity.push(frame(2));
  const before = activity.length;
  assert.equal(activity.push(`\r\x1b[2K✔ ${STATUS}\r\n`), false);
  assert.equal(activity.length, before);
});

test('new text is activity', () => {
  const activity = withSeenSpinner();
  const before = activity.length;
  assert.equal(activity.push('\r\nSetting up MariaDB'), true);
  assert.ok(activity.length > before);
  assert.equal(activity.candidate(), 'Setting up MariaDB');
});

test('digits are significant: a changing percentage is activity each time', () => {
  const activity = new OutputActivity();
  assert.equal(activity.push('\rDownloading 45%'), true);
  assert.equal(activity.push('\rDownloading 46%'), true);
  assert.equal(activity.push('\rDownloading 46%'), false, 'an exact repeat is still a redraw');
  assert.equal(activity.candidate(), 'Downloading 46%');
});

test('a prompt overwritten in place by the next spinner frame stays the candidate', () => {
  const activity = withSeenSpinner();
  const prompt = '   Would you like to add PhpMyAdmin? <y/N> ';
  assert.equal(activity.push(`\r\n${prompt}`), true);
  assert.equal(activity.candidate(), prompt);
  const afterPrompt = activity.length;
  assert.equal(activity.push(frame(2)), false);
  assert.equal(activity.push(frame(3)), false);
  assert.equal(activity.push(frame(4)), false);
  assert.equal(activity.candidate(), prompt);
  assert.equal(activity.lastLine(), prompt);
  // Only the prompt's own `\r` ending was added.
  assert.equal(activity.length, afterPrompt + 1);
});

test('a prompt printed onto the end of a spinner frame is still candidate text containing the prompt', () => {
  const activity = withSeenSpinner();
  activity.push(frame(2));
  assert.equal(activity.push('Would you like to add PhpMyAdmin? <y/N> '), true);
  assert.equal(activity.push(frame(3)), false);
  assert.ok(activity.candidate().endsWith('Would you like to add PhpMyAdmin? <y/N> '));
});

test('a line ended by \\r\\n is complete output: no candidate, but it is the last line', () => {
  const activity = new OutputActivity();
  activity.push('line\r\n');
  assert.equal(activity.candidate(), '');
  assert.equal(activity.lastLine(), 'line');
});

test('\\r\\n split across two chunks is still one newline ending', () => {
  const activity = new OutputActivity();
  activity.push('line\r');
  assert.equal(activity.candidate(), 'line', 'a bare \\r ending still leaves the line as the candidate');
  activity.push('\n');
  assert.equal(activity.candidate(), '');
  assert.equal(activity.lastLine(), 'line');
});

test('consume(n) drops the first n characters and forgets recent lines', () => {
  const activity = new OutputActivity();
  const prompt = 'Enter the API token: ';
  activity.push(`${prompt}\r`);
  activity.push('\x1b[2K');
  const length = activity.length;
  activity.consume(length);
  assert.equal(activity.length, 0);
  assert.equal(activity.candidate(), '');
  // The identical prompt re-asked after an answer is activity again.
  assert.equal(activity.push(`\r\n${prompt}`), true);
  assert.equal(activity.candidate(), prompt);
});

test('consume(n) can cut into the unfinished line and keeps the rest of it', () => {
  const activity = new OutputActivity();
  activity.push('Continue? (y/n) ');
  const fired = activity.length;
  activity.push('   Enter the API token: ');
  activity.consume(fired);
  assert.equal(activity.candidate(), '   Enter the API token: ');
});

test('the transcript stays at or below 16 KiB and trimmedBy reports what was trimmed', () => {
  const activity = new OutputActivity();
  let pushed = 0;
  for (let i = 0; i < 2000; i += 1) {
    const line = `Unpacking package number ${i}\r\n`;
    activity.push(line);
    // The pty's `\r\n` is kept as a single `\n` ending.
    pushed += line.length - 1;
  }
  assert.ok(activity.length <= 16 * 1024, `length ${activity.length}`);
  assert.ok(activity.trimmedBy > 0);
  assert.equal(activity.length + activity.trimmedBy, pushed);
  assert.equal(activity.lastLine(), 'Unpacking package number 1999');
});

test('candidate and lastLine are capped at 200 characters and ANSI-stripped', () => {
  const activity = new OutputActivity();
  const long = `\x1b[32m${'x'.repeat(300)}\x1b[0m end? `;
  activity.push(long);
  const candidate = activity.candidate();
  assert.equal(candidate.length, 200);
  assert.ok(!candidate.includes('\x1b'));
  assert.ok(candidate.endsWith('x end? '));

  activity.push('\r\n');
  const last = activity.lastLine();
  assert.equal(last.length, 200);
  assert.ok(!last.includes('\x1b'));
  assert.ok(last.endsWith('x end? '));
});

test('lastLine is empty when nothing meaningful has arrived', () => {
  const activity = new OutputActivity();
  activity.push('\r⠋\r⠙');
  assert.equal(activity.lastLine(), '');
  assert.equal(activity.candidate(), '');
});
