import type { ExecResult, SSHClient, SshTarget } from '../../lib/ssh-client.ts';
import { compilePromptHints, matchExpectedPrompt } from './prompt-matcher.ts';

// Which of the three detection tiers produced a pause. 'expected' means the
// trailing output matched one of the app script's own pre-scanned `read -p`
// prompts and is the confident case; 'heuristic' is the pre-#160 pattern
// match; 'stall' means nothing matched and output simply stopped, so this may
// not be a prompt at all. Issue #160.
export type PromptOrigin = 'expected' | 'heuristic' | 'stall';

export type PromptDetectedHandler = (
  text: string,
  expectedPrompts: string[],
  write: (text: string) => void,
  resume: () => void,
  origin: PromptOrigin,
  // Index into expectedPrompts for an 'expected' origin; null otherwise. Lets
  // the operator-facing UI number the prompt without re-implementing the
  // matcher client-side.
  matchedIndex: number | null
) => void;

export interface JobSSHClientOptions {
  // Only install-app's job sets this true (see issue #57) -- every other
  // job type leaves it unset and JobSSHClient behaves exactly as it always
  // has, with no detection overhead.
  watchForPrompts?: boolean;
  // Static read-p pre-scan results of the app's install script. As of issue
  // #160 these drive the first detection tier, not just the operator-facing
  // display they were originally added for.
  expectedPrompts?: string[];
  onPromptDetected?: PromptDetectedHandler;
  onPromptCleared?: () => void;
  // Test-only overrides -- production always uses the real-timer defaults.
  expectedSilenceMs?: number;
  silenceMs?: number;
  stallMs?: number;
  scheduleCheck?: (fn: () => void, ms: number) => { cancel: () => void };
}

const QUESTION_MARK = /\?\s*:?\s*$/;
const YES_NO_HINT = /[(<[]\s*y\s*\/\s*n\s*[)>\]]/i;
// Same escape-sequence pattern useJobStream.ts's stripAnsi() strips for
// display (duplicated, not shared -- web-client is a fully separate build,
// see CLAUDE.md's "sortInventoryForFile" precedent for this pattern).
// Community-scripts' whiptail-based build.func emits real color/cursor
// control codes even over a non-interactive-looking pty, so a raw prompt
// buffer needs this stripped before either matching against it or handing
// it to the operator as promptText.
export const ANSI_ESCAPE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][A-Za-z0-9]|[78]|[@-Z\\^_])/g;
const TRAILING_TAIL_CHARS = 200;

// Three cumulative silence thresholds, checked by one self-re-arming timer.
//
// Tier 0 is short because a hit against the script's own prompt string is
// strong evidence on its own -- silence is only needed to confirm the process
// is actually blocked rather than mid-print. (Some scripts echo a prompt's
// text back when confirming the answer; waiting for output to stop is what
// keeps that from pausing the job.) Tier 1 is where the two original patterns
// live, and they need the longer window because they are much weaker
// evidence. Tier 2 exists because neither of the above is exhaustive -- the
// pre-scan cannot see a prompt built from a variable or an app whose install
// script isn't conventionally named -- and watchForPrompts mode holds stdin
// open, so an undetected prompt would otherwise hang the job indefinitely
// (there is no EOF backstop here, and JobRunner's abandon timer only starts
// once a prompt has already been detected). Issue #160.
const DEFAULT_EXPECTED_SILENCE_MS = 2_000;
const DEFAULT_SILENCE_MS = 30_000;
const DEFAULT_STALL_MS = 5 * 60 * 1000;

// 'expected' tests the pre-scanned hints only; 'all' adds the two heuristics;
// 'stall' escalates whatever is in the buffer unconditionally.
type TierMode = 'expected' | 'all' | 'stall';
interface Tier {
  // Delay from the previous tier, not from the last chunk -- the tiers are
  // armed in sequence, so these sum to the cumulative silence thresholds.
  delayMs: number;
  mode: TierMode;
}

function realScheduleCheck(fn: () => void, ms: number): { cancel: () => void } {
  const handle = setTimeout(fn, ms);
  return { cancel: () => clearTimeout(handle) };
}

export class JobSSHClient implements SSHClient {
  private watchForPrompts: boolean;
  private expectedPrompts: string[];
  private compiledPrompts: Array<RegExp | null>;
  private tiers: Tier[];
  private tierIndex = 0;
  private onPromptDetected?: PromptDetectedHandler;
  private onPromptCleared?: () => void;
  private scheduleCheck: (fn: () => void, ms: number) => { cancel: () => void };

  private buffer = '';
  private paused = false;
  private pendingCheck: { cancel: () => void } | undefined;
  private currentWrite: ((text: string) => void) | undefined;
  // buffer.length at the moment fire() last paused watching -- resume()
  // slices the buffer down to this point rather than blanking it outright,
  // so output that arrived *during* the pause (see watchChunk) survives
  // into the next detection cycle instead of being discarded along with
  // the already-reported prompt text ahead of it. Issue #160 Finding 1.
  private firedAtLength = 0;
  // The text of the most recent fire(), regardless of origin -- the
  // fallback stallText() reaches for when resume() leaves nothing new in
  // the buffer, so a re-escalation to the stall tier never renders an
  // empty banner. See stallText() and resume(). Issue #160 Finding 1.
  private lastFiredText: string | undefined;

  constructor(
    private inner: SSHClient,
    private onChunk: (chunk: string, stream: 'stdout' | 'stderr') => void,
    private signal?: AbortSignal,
    options: JobSSHClientOptions = {}
  ) {
    this.watchForPrompts = options.watchForPrompts ?? false;
    this.expectedPrompts = options.expectedPrompts ?? [];
    this.onPromptDetected = options.onPromptDetected;
    this.onPromptCleared = options.onPromptCleared;
    this.scheduleCheck = options.scheduleCheck ?? realScheduleCheck;
    this.compiledPrompts = compilePromptHints(this.expectedPrompts);
    const expectedMs = options.expectedSilenceMs ?? DEFAULT_EXPECTED_SILENCE_MS;
    const heuristicMs = options.silenceMs ?? DEFAULT_SILENCE_MS;
    const stallMs = options.stallMs ?? DEFAULT_STALL_MS;
    this.tiers = [
      { delayMs: expectedMs, mode: 'expected' },
      { delayMs: Math.max(0, heuristicMs - expectedMs), mode: 'all' },
      { delayMs: Math.max(0, stallMs - heuristicMs), mode: 'stall' },
    ];
  }

  exec(target: SshTarget, command: string): Promise<ExecResult> {
    if (!this.watchForPrompts) {
      return this.inner.exec(target, command, this.onChunk, this.signal);
    }
    this.resetWatchState();
    const result = this.inner.exec(
      target,
      command,
      (chunk, stream) => {
        this.onChunk(chunk, stream);
        this.watchChunk(chunk);
      },
      this.signal,
      (write) => {
        this.currentWrite = write;
      }
    );
    return result.finally(() => this.pendingCheck?.cancel());
  }

  // Interactive mode is only available in the CLI, not in web jobs -- there's
  // no user terminal to interact with in a background job context.
  execInteractive(_target: SshTarget, _command: string): Promise<ExecResult> {
    return Promise.reject(new Error('Interactive mode is not available in web job context'));
  }

  // Straight delegation -- an SFTP upload produces no incremental output to
  // stream into the job log the way exec's onChunk does.
  putFile(target: SshTarget, remotePath: string, content: Buffer): Promise<void> {
    return this.inner.putFile(target, remotePath, content);
  }

  // A single JobSSHClient instance is reused across every exec() call an
  // install-app job makes (the vmid pre-check, the install script itself,
  // an optional NFS-attach follow-up) -- clears any leftover buffered text
  // or paused state from a previous call before a new one starts, so a
  // second exec() never inherits stale detection state from the first.
  private resetWatchState(): void {
    this.buffer = '';
    this.paused = false;
    this.pendingCheck?.cancel();
    this.pendingCheck = undefined;
    this.tierIndex = 0;
    this.currentWrite = undefined;
    this.firedAtLength = 0;
    this.lastFiredText = undefined;
  }

  // Output keeps accumulating into the buffer even while paused (Finding 1):
  // the process the operator is watching doesn't stop running just because
  // detection is paused, and a real prompt that prints while an earlier,
  // unrelated pause is still awaiting a dismiss/answer must not be silently
  // dropped -- resume() is what surfaces it. What paused does suppress is
  // arming/re-arming a tier: firing a second detection on top of a pause
  // already awaiting the operator would be confusing, and resume() is
  // responsible for restarting the watch once the operator has acted.
  private watchChunk(chunk: string): void {
    this.buffer += chunk;
    if (this.paused) return;
    // Any new output means the process is not blocked -- rewind to tier 0.
    this.armTier(0);
  }

  private armTier(index: number): void {
    this.pendingCheck?.cancel();
    this.tierIndex = index;
    const tier = this.tiers[index];
    if (tier === undefined) {
      this.pendingCheck = undefined;
      return;
    }
    this.pendingCheck = this.scheduleCheck(() => this.check(), tier.delayMs);
  }

  private check(): void {
    const tier = this.tiers[this.tierIndex];
    if (tier === undefined) return;
    const trailing = this.trailingText();
    // Checked at every tier so a hint match always outranks a heuristic or
    // stall verdict. In practice this only ever fires at tier 0: trailingText()
    // is a pure function of this.buffer, and any buffer change rearms at tier
    // 0 (see watchChunk), so a hint that misses here sees identical text at
    // tiers 1/2 and cannot match there either.
    const matchedIndex = matchExpectedPrompt(trailing, this.compiledPrompts);
    if (matchedIndex !== null) {
      this.fire(trailing, 'expected', matchedIndex);
      return;
    }
    if (tier.mode === 'all' && (QUESTION_MARK.test(trailing) || YES_NO_HINT.test(trailing))) {
      this.fire(trailing, 'heuristic', null);
      return;
    }
    if (tier.mode === 'stall') {
      this.fire(this.stallText(), 'stall', null);
      return;
    }
    this.armTier(this.tierIndex + 1);
  }

  private fire(text: string, origin: PromptOrigin, matchedIndex: number | null): void {
    this.paused = true;
    this.pendingCheck?.cancel();
    this.pendingCheck = undefined;
    // Remember how much of the buffer this detection already covers, and
    // what it said, so resume() can drop the now-stale prefix without
    // losing output that arrives during the pause, and stallText() has
    // something to fall back to if nothing new ever does. Issue #160
    // Finding 1.
    this.firedAtLength = this.buffer.length;
    this.lastFiredText = text;
    const write = this.currentWrite ?? (() => {});
    this.onPromptDetected?.(text, this.expectedPrompts, write, () => this.resume(), origin, matchedIndex);
  }

  // A stall is the one origin whose text is not itself prompt-shaped, so the
  // trailing partial line is often empty (output that ended with a newline and
  // then stopped). Falling back to the last non-empty line is what makes the
  // escalation banner say something useful instead of nothing.
  private stallText(): string {
    const trailing = this.trailingText();
    if (trailing.trim().length > 0) return trailing;
    const clean = this.buffer.replace(ANSI_ESCAPE, '');
    const lines = clean.split(/[\r\n]+/).filter((line) => line.trim().length > 0);
    const last = lines[lines.length - 1];
    if (last !== undefined) {
      return last.length > TRAILING_TAIL_CHARS ? last.slice(-TRAILING_TAIL_CHARS) : last;
    }
    // Nothing at all has arrived since resume() last trimmed the buffer --
    // without this fallback, a dismissed/answered prompt that is never
    // followed by further output would eventually re-escalate to the stall
    // tier with an empty banner, exactly the outcome this tier exists to
    // avoid. Fall back to whatever last fired, labelled so the operator
    // reads it as stale rather than fresh. Issue #160 Finding 1.
    if (this.lastFiredText !== undefined) {
      return `(no new output since last seen) ${this.lastFiredText}`;
    }
    return '';
  }

  private trailingText(): string {
    // Strip ANSI escapes before finding the line boundary and testing --
    // a pty's colorized/cursor-controlled output (see Finding 1) can carry
    // escape sequences right after the visible prompt text that would
    // otherwise defeat the trailing-`?` match or land in the operator-
    // facing promptText verbatim. A bare \r (a redrawn-in-place progress
    // line, common in build.func output) is treated as a line boundary the
    // same way useJobStream.ts's splitLines() already does for display.
    const clean = this.buffer.replace(ANSI_ESCAPE, '');
    const lastBoundary = Math.max(clean.lastIndexOf('\n'), clean.lastIndexOf('\r'));
    const tail = lastBoundary === -1 ? clean : clean.slice(lastBoundary + 1);
    return tail.length > TRAILING_TAIL_CHARS ? tail.slice(-TRAILING_TAIL_CHARS) : tail;
  }

  // Clears paused state and resumes watching -- called both when an answer
  // was written (JobRunner.answerPrompt) and when the operator dismisses a
  // false positive (JobRunner.dismissPrompt); the two differ only in
  // whether something was written to the channel first.
  //
  // Two things this deliberately does NOT do (Finding 1, issue #160):
  //   - It does not blank the buffer outright. Slicing off only the
  //     already-fired prefix (firedAtLength) keeps whatever arrived during
  //     the pause -- e.g. a real prompt that printed while an unrelated
  //     false positive was still awaiting a dismiss -- visible to the next
  //     check() instead of discarding it right when the operator finally
  //     acts.
  //   - It does not leave the watchdog disarmed. Before this fix, resume()
  //     armed nothing and only a subsequent chunk could ever re-arm one --
  //     for a dismissed false positive with no further output (the
  //     Dismiss button's own advertised use case), that chunk never comes,
  //     and the job hangs forever with no bound at all. armTier(0) here is
  //     what keeps a genuinely-stuck job walking back up through the tiers
  //     (and, eventually, JobRunner's 15-minute abandon timer) instead of
  //     going permanently quiet.
  private resume(): void {
    this.paused = false;
    this.buffer = this.buffer.slice(this.firedAtLength);
    this.firedAtLength = 0;
    this.armTier(0);
    this.onPromptCleared?.();
  }
}
