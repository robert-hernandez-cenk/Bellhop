# Contract: `src/web/jobs/output-activity.ts`

An internal module with no I/O and no timers. One instance per watched
`exec()` call.

```ts
// ANSI escape-sequence pattern, used for line keys and by
// src/mcp/elicitation.ts.
export const ANSI_ESCAPE: RegExp;

// How many distinct recent line keys are remembered (16).
export const RECENT_KEY_LIMIT: number;

// A line's identity for redraw detection: ANSI codes, leading decoration
// (anything before the first letter or digit) and whitespace runs ignored;
// digits kept. A line with no letters or digits keys on its ANSI-stripped
// text with Braille glyphs (U+2800-U+28FF) and whitespace removed, so `#? `
// keys as `#?`. '' only for a line of Braille glyphs and whitespace.
export function lineKey(text: string): string;

// Makes key the most recent entry of recent, keeping at most
// RECENT_KEY_LIMIT distinct keys. A line whose key is empty or already in
// recent is a redraw. Shared with src/mcp/elicitation.ts's lastLines().
export function rememberKey(recent: string[], key: string): void;

export class OutputActivity {
  // Feeds one raw output chunk. Returns true when the chunk added
  // meaningful output (a new meaningful line completed, or the unfinished
  // line gained meaningful text); false when it was only redraws.
  push(chunk: string): boolean;

  // Length of the retained meaningful transcript.
  get length(): number;

  // An absolute position in everything the transcript has ever held
  // (characters dropped from the front plus length). Later trimming does
  // not move it.
  mark(): number;

  // Drops the transcript up to a position from mark() (output a pause
  // already reported), clamped to what is still retained. May cut into the
  // unfinished line; the rest of it stays. The recent-line keys are kept.
  consumeThrough(mark: number): void;

  // Registers a reported prompt that was actually answered (never a merely
  // dismissed false positive, and never a stall, whose text may be the
  // spinner line itself) so that any line whose key starts with its key is
  // never a redraw -- a prompt re-asked verbatim after an invalid answer
  // counts as new output. The caller (JobSSHClient.resume()) is what tells
  // an answer apart from a dismiss.
  exemptFromRedraw(text: string): void;

  // Prompt candidate: the trailing meaningful line not ended by a newline,
  // ANSI-stripped, at most 200 characters. '' when the transcript ends in a
  // newline or is empty.
  candidate(): string;

  // Last non-empty meaningful line, ANSI-stripped, at most 200 characters,
  // or '' when there is none.
  lastLine(): string;
}
```

Invariants:

- Redraw-only input never changes `length` or `mark()`, and `push` returns
  false.
- A redraw ended by a newline turns a trailing in-place (`\r`) ending into a
  newline, in place (same length), so a line the spinner overwrote is no
  longer the candidate once the terminal has moved past it.
- `candidate()` and `lastLine()` never return spinner-only text that repeats
  a recent line, unless that line is genuinely the newest meaningful one.
- Retained text never exceeds 16 KiB.
