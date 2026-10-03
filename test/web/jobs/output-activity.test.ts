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

test('consumeThrough(mark) drops everything up to the mark but keeps the recent lines', () => {
  const activity = withSeenSpinner();
  const prompt = 'Enter the API token: ';
  activity.push(`\r\n${prompt}`);
  const mark = activity.mark();
  activity.push(frame(2));
  activity.consumeThrough(mark);
  // Only the prompt's own `\r` ending, added after the mark, is left.
  assert.equal(activity.length, 1);
  // Spinner frames are still remembered, so they stay redraws after a resume.
  assert.equal(activity.push(frame(3)), false);
});

test('a re-asked prompt extending a recent line is a redraw unless it starts with an exempted prompt', () => {
  const prompt = 'Enter port: ';
  const plain = new OutputActivity();
  plain.push(prompt);
  plain.consumeThrough(plain.mark());
  // The pty echoes the answer onto the prompt's line, then the script
  // complains and asks again word for word.
  plain.push('abc\r\nInvalid port\r\n');
  assert.equal(plain.push(prompt), false, 'without an exemption it extends the echoed line');

  const exempted = new OutputActivity();
  exempted.push(prompt);
  exempted.consumeThrough(exempted.mark());
  exempted.exemptFromRedraw(prompt);
  exempted.push('abc\r\nInvalid port\r\n');
  assert.equal(exempted.push(prompt), true);
  assert.equal(exempted.candidate(), prompt);
});

test('consumeThrough(mark) can cut into the unfinished line and keeps the rest of it', () => {
  const activity = new OutputActivity();
  activity.push('Continue? (y/n) ');
  const fired = activity.mark();
  activity.push('   Enter the API token: ');
  activity.consumeThrough(fired);
  assert.equal(activity.candidate(), '   Enter the API token: ');
});

test('consumeThrough(mark) lands on the same text after the front was trimmed, and a stale mark is clamped', () => {
  const activity = new OutputActivity();
  for (let i = 0; i < 800; i += 1) activity.push(`Unpacking package number ${i}\r\n`);
  activity.push('Continue? (y/n) ');
  const fired = activity.mark();
  for (let i = 1000; i < 1800; i += 1) activity.push(`Unpacking package number ${i}\r\n`);
  activity.push('   Enter the API token: ');
  activity.consumeThrough(fired);
  assert.equal(activity.candidate(), '   Enter the API token: ');
  const before = activity.length;
  activity.consumeThrough(0);
  assert.equal(activity.length, before, 'a mark already trimmed away consumes nothing');
});

test('the transcript stays at or below 16 KiB and mark() counts every character ever kept', () => {
  const activity = new OutputActivity();
  let pushed = 0;
  for (let i = 0; i < 2000; i += 1) {
    const line = `Unpacking package number ${i}\r\n`;
    activity.push(line);
    // The pty's `\r\n` is kept as a single `\n` ending.
    pushed += line.length - 1;
  }
  assert.ok(activity.length <= 16 * 1024, `length ${activity.length}`);
  assert.ok(activity.mark() > activity.length, 'some of the front was trimmed');
  assert.equal(activity.mark(), pushed);
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

// Review fix: committing a pending `\r` line that turns out to be new must
// count as activity. Repro: after a resume (keys forgotten) the pty echoes
// the answer onto the end of the current frame, so the recent key becomes
// `<status>n`; the next frame is a prefix of that while unfinished, then
// commits as new on its `\r`.
test('a frame that was a prefix of a recent line while unfinished, then commits as new on \r, is activity', () => {
  const activity = new OutputActivity();
  assert.equal(activity.push(`${frame(0)}n`), true);
  assert.equal(activity.push(frame(1)), false, 'still a prefix of the echoed line while unfinished');
  const before = activity.length;
  assert.equal(activity.push(frame(2)), true, 'the committed frame is new, so the chunk is activity');
  assert.ok(activity.length > before);
});

test('a prompt printed onto the end of a spinner frame becomes the bare prompt, spinner text dropped', () => {
  const activity = withSeenSpinner();
  activity.push(frame(2));
  const prompt = '   Would you like to add PhpMyAdmin? <y/N> ';
  assert.equal(activity.push(prompt), true);
  assert.equal(activity.candidate(), prompt);
  assert.equal(activity.push(frame(3)), false);
  assert.equal(activity.candidate(), prompt);
  assert.equal(activity.lastLine(), prompt);
});

test('a prompt arriving in the same chunk as its spinner frame is also stripped to the bare prompt', () => {
  const activity = withSeenSpinner();
  const prompt = '   Enter the MariaDB root password: ';
  assert.equal(activity.push(`${frame(2)}${prompt}`), true);
  assert.equal(activity.candidate(), prompt);
});

test('an ordinary line that starts with an earlier line\'s text keeps its whole text', () => {
  const activity = new OutputActivity();
  activity.push('Unpacking package number 1\r\n');
  assert.equal(activity.push('Unpacking package number 10'), true);
  assert.equal(activity.candidate(), 'Unpacking package number 10');
});

// Final review, finding 2: a redraw ended by a newline (msg_ok's
// `\r\x1b[2K✔ <status>\n` after msg_info's spinner) moves the terminal past
// the line the spinner overwrote, so that line is no longer a candidate.
test('a redraw ended by a newline turns an in-place overwrite into a finished line', () => {
  const activity = withSeenSpinner();
  activity.push(frame(2));
  const before = activity.length;
  assert.equal(activity.push(`\r\x1b[2K✔ ${STATUS}\n`), false);
  assert.equal(activity.length, before, 'the ending is replaced in place, so offsets are unaffected');
  assert.equal(activity.candidate(), '');
  assert.equal(activity.lastLine(), `⠋ ${STATUS}`, 'the first frame is the line that was kept');
});

test('a redraw ended by \r\n also finishes an overwritten line', () => {
  const activity = new OutputActivity();
  activity.push('⠋ Doing X');
  activity.push('\r\x1b[2K⠙ Doing X');
  assert.equal(activity.candidate(), '⠋ Doing X', 'overwritten in place, still the candidate');
  activity.push('\r\x1b[2K✔ Doing X\r\n');
  assert.equal(activity.candidate(), '');
});

// Final review, finding 3: a line with no letters or digits keys on its
// punctuation, so `#? ` (bash select) is output; only Braille spinner glyphs
// and whitespace make a line keyless.
test('a punctuation-only prompt after a select menu is new output and the candidate', () => {
  const activity = new OutputActivity();
  activity.push('1) stable\r\n2) beta\r\n');
  assert.equal(activity.push('#? '), true);
  assert.equal(activity.candidate(), '#? ');
});

test('a Braille-only frame is still a redraw', () => {
  const activity = new OutputActivity();
  activity.push('Working\r\n');
  const before = activity.length;
  assert.equal(activity.push('\r\x1b[2K⠋ \r\x1b[2K⠙'), false);
  assert.equal(activity.length, before);
});
