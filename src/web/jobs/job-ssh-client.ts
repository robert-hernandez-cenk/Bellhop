import type { ExecResult, SSHClient, SshTarget } from '../../lib/ssh-client.ts';
import { compilePromptHints, matchExpectedPrompt } from './prompt-matcher.ts';
import { OutputActivity } from './output-activity.ts';

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
// 'stall' escalates the last meaningful output unconditionally.
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

  // The meaningful output seen so far, with spinner redraws filtered out --
  // what every tier tests, and what decides whether a chunk counts as
  // activity at all. Replaced the raw output buffer in issue #52.
  private activity = new OutputActivity();
  private paused = false;
  // Which tier fired the pause currently waiting, or undefined while not
  // paused -- watchChunk reads this to decide whether new output is allowed
  // to clear the pause on its own (issue #52 Unit 2, FR-012). Set in fire(),
  // cleared in resume()/resetWatchState().
  private pausedOrigin: PromptOrigin | undefined;
  private pendingCheck: { cancel: () => void } | undefined;
  private currentWrite: ((text: string) => void) | undefined;
  // activity.mark() at the moment fire() last paused watching -- resume()
  // consumes the transcript up to this point rather than blanking it
  // outright, so output that arrived *during* the pause (see watchChunk)
  // survives into the next detection cycle instead of being discarded
  // along with the already-reported prompt text ahead of it. Issue #160
  // Finding 1. The mark is absolute, so it stays right even when the
  // bounded transcript loses its front during a long pause (issue #52).
  private firedMark = 0;
  // The text of the most recent fire(), regardless of origin -- the
  // fallback stallText() reaches for when resume() leaves nothing new in
  // the transcript, so a re-escalation to the stall tier never renders an
  // empty banner. See stallText() and resume(). Issue #160 Finding 1.
  private lastFiredText: string | undefined;
  // Set by the wrapped write() handed to onPromptDetected the moment it is
  // actually called -- i.e. the operator answered (JobRunner.answerPrompt
  // calls write(text) then resume()) rather than merely dismissed a false
  // positive (JobRunner.dismissPrompt calls only resume()). resume() reads
  // this to decide whether to exempt the reported prompt's text from redraw
  // detection; a dismissed prompt must never set it. Reset in fire() and
  // resetWatchState().
  private answeredSinceFire = false;

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
  // an optional NFS-attach follow-up) -- clears any leftover output, recent
  // lines, or paused state from a previous call before a new one starts, so
  // a second exec() never inherits stale detection state from the first.
  private resetWatchState(): void {
    this.activity = new OutputActivity();
    this.paused = false;
    this.pausedOrigin = undefined;
    this.pendingCheck?.cancel();
    this.pendingCheck = undefined;
    this.tierIndex = 0;
    this.currentWrite = undefined;
    this.firedMark = 0;
    this.lastFiredText = undefined;
    this.answeredSinceFire = false;
  }

  // Output keeps accumulating into the transcript even while paused (Finding
  // 1): the process the operator is watching doesn't stop running just
  // because detection is paused, and a real prompt that prints while an
  // earlier, unrelated pause is still awaiting a dismiss/answer must not be
  // silently dropped -- resume() is what surfaces it. What paused does
  // suppress is arming/re-arming a tier: firing a second detection on top of
  // a pause already awaiting the operator would be confusing, and resume() is
  // responsible for restarting the watch once the operator has acted.
  private watchChunk(chunk: string): void {
    const meaningful = this.activity.push(chunk);
    if (this.paused) {
      // Only a stall pause clears itself on new meaningful output (FR-012,
      // research R6, operator decision -- see the spec's Assumptions). An
      // 'expected' or 'heuristic' pause is confident evidence of a real
      // waiting question, so it stays paused until the operator actually
      // answers or dismisses it, exactly as before issue #52. A stall is
      // different: it exists purely as a backstop for "nothing matched and
      // output simply stopped," so once meaningful output resumes there is
      // nothing left to believe is still waiting on an answer, and leaving
      // it paused would only block the operator's attention (and hold the
      // abandon countdown running) on a job that is, in fact, still
      // working. A redraw never clears it either way -- push() already
      // returned false for one, so a spinner that keeps going through a
      // stall pause cannot end it on its own.
      if (this.pausedOrigin === 'stall' && meaningful) this.resume();
      return;
    }
    // New meaningful output means the process is not blocked -- rewind to
    // tier 0. A chunk that only redraws a recent line (a spinner frame) is
    // silence, not activity: before issue #52 every frame re-armed tier 0,
    // so a spinner that never stopped kept every tier from ever running.
    if (meaningful) this.armTier(0);
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
    // is a pure function of the meaningful transcript, and any meaningful
    // change rearms at tier 0 (see watchChunk), so a hint that misses here
    // sees identical text at tiers 1/2 and cannot match there either.
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
    this.pausedOrigin = origin;
    this.pendingCheck?.cancel();
    this.pendingCheck = undefined;
    // Remember how much of the transcript this detection already covers,
    // and what it said, so resume() can drop the now-stale prefix without
    // losing output that arrives during the pause, and stallText() has
    // something to fall back to if nothing new ever does. Issue #160
    // Finding 1.
    this.firedMark = this.activity.mark();
    this.lastFiredText = text;
    this.answeredSinceFire = false;
    const innerWrite = this.currentWrite ?? (() => {});
    // Wrapped so resume() can tell an actual answer (this gets called) from
    // a dismiss (it never does) without JobRunner or the PromptDetectedHandler
    // signature having to say so explicitly.
    const write = (answerText: string) => {
      this.answeredSinceFire = true;
      innerWrite(answerText);
    };
    this.onPromptDetected?.(text, this.expectedPrompts, write, () => this.resume(), origin, matchedIndex);
  }

  // A stall is the one origin whose text is not itself prompt-shaped, so the
  // trailing partial line is often empty (output that ended with a newline and
  // then stopped). Falling back to the last non-empty meaningful line is what
  // makes the escalation banner say something useful instead of nothing --
  // and, since redraws never enter the transcript, never a spinner frame.
  private stallText(): string {
    const trailing = this.trailingText();
    if (trailing.trim().length > 0) return trailing;
    const last = this.activity.lastLine();
    if (last.length > 0) return last;
    // Nothing at all has arrived since resume() last consumed the transcript --
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

  // The most recent meaningful line, ANSI-stripped, unless a newline ended
  // it. A line ended by a bare \r still counts: a `read -p` prompt prints no
  // ending, and the next spinner frame's \r is what "overwrites" it while the
  // process is in fact blocked on it (issue #52). See OutputActivity.
  private trailingText(): string {
    return this.activity.candidate();
  }

  // Clears paused state and resumes watching -- called both when an answer
  // was written (JobRunner.answerPrompt) and when the operator dismisses a
  // false positive (JobRunner.dismissPrompt); the two differ in whether
  // something was written to the channel first, which answeredSinceFire
  // (set by fire()'s wrapped write(), read just below) is what lets this
  // method tell apart.
  //
  // Two things this deliberately does NOT do (Finding 1, issue #160):
  //   - It does not blank the transcript outright. Consuming only the
  //     already-fired prefix (firedMark) keeps whatever arrived during
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
    const origin = this.pausedOrigin;
    this.paused = false;
    this.pausedOrigin = undefined;
    this.activity.consumeThrough(this.firedMark);
    this.firedMark = 0;
    // The recent lines are kept, so the spinner is still a redraw after an
    // answer; forgetting them let the first frame after it commit the next
    // prompt with `\r` and take its place as the line the tiers test. A
    // prompt the script re-asks verbatim after an invalid answer is exempted
    // instead, so it still counts as new output. Never a stall's text: that
    // may be the spinner line itself. And only after an actual answer
    // (answeredSinceFire) -- a merely dismissed false positive must not be
    // exempted, or a spinner status line that happened to match a heuristic
    // would have every later frame of itself counted as new meaningful
    // output once dismissed, re-arming tier 0 forever and never reaching the
    // stall tier (the original #52 hang).
    if ((origin === 'expected' || origin === 'heuristic') && this.answeredSinceFire && this.lastFiredText !== undefined) {
      this.activity.exemptFromRedraw(this.lastFiredText);
    }
    this.armTier(0);
    this.onPromptCleared?.();
  }
}
