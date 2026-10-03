// Separates real installer output from a redrawing spinner, so the prompt
// detection in JobSSHClient can treat redraws as silence. Issue #52.
//
// community-scripts' host-side build.func spinner rewrites its status line
// about ten times a second (`\r\x1b[2K⠋ <status text>`) and can keep doing so
// for an entire install. Before this module, every frame counted as new
// output, so the silence tiers never ran and a `read -p` prompt printed under
// the spinner hung the job indefinitely. Here each line (split on `\r` and
// `\n`) is keyed on its text alone and compared with the recently seen lines:
// a frame repeating a recent line is a redraw and carries no information, so
// it never restarts the checks and never becomes the line they test.
//
// No I/O and no timers -- JobSSHClient owns both. One instance per watched
// exec() call.

// Same escape-sequence pattern useJobStream.ts's stripAnsi() strips for
// display (duplicated, not shared -- web-client is a fully separate build,
// see CLAUDE.md's "sortInventoryForFile" precedent for this pattern).
// Community-scripts' whiptail-based build.func emits real color/cursor
// control codes even over a non-interactive-looking pty, so output needs
// this stripped before either matching against it or handing it to the
// operator as promptText. Moved here from job-ssh-client.ts (which still
// re-exports it) for issue #52, since line keys are built from it too.
export const ANSI_ESCAPE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][A-Za-z0-9]|[78]|[@-Z\\^_])/g;

// An escape sequence a chunk boundary cut short: ANSI_ESCAPE can't match it
// yet, and without this its leftover bytes (`[2` of `\x1b[2K`) would read as
// text and make half of a spinner frame look like new output.
const INCOMPLETE_ESCAPE_AT_END = /\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*|[()])?$/;
// Spinner glyphs, check marks, bullets and indentation -- anything before the
// first letter or digit is decoration, not content.
const LEADING_DECORATION = /^[^\p{L}\p{N}]+/u;

const TAIL_CHARS = 200;
// FR-011: memory stays bounded however long the job runs.
const MAX_TRANSCRIPT_CHARS = 16 * 1024;
// Enough for a spinner alternating with a few other status lines (research
// R2); the spec's floor is 8.
const RECENT_KEY_LIMIT = 16;

// Digits are kept on purpose (operator decision): a ticking percentage is
// real progress, and collapsing it would let a long download raise a false
// stall.
function lineKey(text: string): string {
  return text
    .replace(ANSI_ESCAPE, '')
    .replace(LEADING_DECORATION, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tail(text: string): string {
  return text.length > TAIL_CHARS ? text.slice(-TAIL_CHARS) : text;
}

export class OutputActivity {
  // The meaningful transcript: committed meaningful lines, each followed by
  // its ending (`\n` for a newline, `\r` for a line overwritten in place),
  // plus the unfinished line once it is meaningful. Redraw lines and their
  // endings never enter it. Append-only apart from front trimming, which is
  // what lets JobSSHClient keep holding a plain offset into it.
  private text = '';
  private trimmed = 0;
  // The raw unfinished line from its start, and whether it has been judged
  // meaningful (and so is already being appended to `text`). Sticky: once a
  // line has said something new, more characters can't make it a redraw.
  private partial = '';
  private partialMeaningful = false;
  // A `\r` that ended the last chunk. Held back until the next character,
  // because a pty sends a newline as `\r\n` and the two halves can arrive in
  // separate chunks -- committing it as an in-place overwrite too early would
  // leave a finished line looking like a waiting prompt.
  private pendingCarriageReturn = false;
  private recentKeys: string[] = [];

  get length(): number {
    return this.text.length;
  }

  get trimmedBy(): number {
    return this.trimmed;
  }

  // Returns true when the chunk added meaningful text: a new line, or more of
  // a line that is already meaningful. A line ending alone returns false, so
  // the `\r` the next spinner frame uses to overwrite a prompt does not count
  // as activity -- only a newline after meaningful text does.
  push(chunk: string): boolean {
    let active = false;
    let segmentStart = 0;
    for (let i = 0; i < chunk.length; i += 1) {
      const char = chunk[i];
      if (char !== '\r' && char !== '\n') continue;
      if (i > segmentStart) active = this.appendText(chunk.slice(segmentStart, i)) || active;
      segmentStart = i + 1;
      if (char === '\n') {
        this.pendingCarriageReturn = false;
        active = this.commitLine('\n') || active;
      } else {
        // A run of `\r`s is one ending (`\r\r\n` is still a newline).
        if (this.pendingCarriageReturn) continue;
        this.pendingCarriageReturn = true;
      }
    }
    if (segmentStart < chunk.length) active = this.appendText(chunk.slice(segmentStart)) || active;
    this.trim();
    return active;
  }

  candidate(): string {
    if (this.text.endsWith('\n')) return '';
    const withoutOverwrite = this.text.replace(/\r+$/, '');
    const boundary = Math.max(withoutOverwrite.lastIndexOf('\n'), withoutOverwrite.lastIndexOf('\r'));
    return tail(withoutOverwrite.slice(boundary + 1).replace(ANSI_ESCAPE, ''));
  }

  lastLine(): string {
    const lines = this.text
      .replace(ANSI_ESCAPE, '')
      .split(/[\r\n]+/)
      .filter((line) => line.trim().length > 0);
    const last = lines[lines.length - 1];
    return last === undefined ? '' : tail(last);
  }

  // Forgetting the recent keys is what lets a re-asked identical prompt
  // (after an invalid answer) count as new output rather than a redraw
  // (research R3). n may cut into the unfinished line; the rest of it stays.
  consume(n: number): void {
    const count = Math.max(0, Math.min(n, this.text.length));
    this.text = this.text.slice(count);
    this.recentKeys = [];
  }

  private appendText(segment: string): boolean {
    if (this.pendingCarriageReturn) {
      this.pendingCarriageReturn = false;
      this.commitLine('\r');
    }
    // Bound the raw line too: a line that never ends and never becomes
    // meaningful would otherwise grow without limit. Its key is decided long
    // before 16 KiB, so the dropped text cannot change the verdict.
    if (this.partial.length < MAX_TRANSCRIPT_CHARS) {
      this.partial += segment.slice(0, MAX_TRANSCRIPT_CHARS - this.partial.length);
    }
    if (this.partialMeaningful) {
      this.text += segment;
      return true;
    }
    // An unfinished line is still a redraw while it is a prefix of a recent
    // line, which is what makes a frame split across two chunks a redraw in
    // both halves.
    const key = lineKey(this.partial.replace(INCOMPLETE_ESCAPE_AT_END, ''));
    if (key.length === 0 || this.recentKeys.some((recent) => recent.startsWith(key))) return false;
    this.partialMeaningful = true;
    this.text += this.partial;
    return true;
  }

  private commitLine(ending: '\n' | '\r'): boolean {
    const key = lineKey(this.partial);
    let active = false;
    if (this.partialMeaningful) {
      this.text += ending;
      this.remember(key);
      active = ending === '\n';
    } else if (key.length > 0 && !this.recentKeys.includes(key)) {
      // Only reachable for a line that was a prefix of a recent one while
      // unfinished and stopped short of it -- a complete line is judged on
      // exact equality.
      this.text += this.partial + ending;
      this.remember(key);
      active = true;
    }
    this.partial = '';
    this.partialMeaningful = false;
    return active;
  }

  private remember(key: string): void {
    const existing = this.recentKeys.indexOf(key);
    if (existing !== -1) this.recentKeys.splice(existing, 1);
    this.recentKeys.push(key);
    if (this.recentKeys.length > RECENT_KEY_LIMIT) this.recentKeys.shift();
  }

  private trim(): void {
    const excess = this.text.length - MAX_TRANSCRIPT_CHARS;
    if (excess <= 0) return;
    this.text = this.text.slice(excess);
    this.trimmed += excess;
  }
}
