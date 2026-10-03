// Framework-free (no React/DOM imports) so it compiles under the root
// NodeNext config and is testable with plain node --test, same rationale as
// admin-nav.ts/settings-display.ts. One place for the job-log prompt
// banner's per-origin hint text, hint emphasis, dismiss-button label and
// which controls get the quiet/outline treatment (issue #4) -- a
// `Record<PromptOrigin | 'none', …>` table so a new PromptOrigin added to
// api/types.ts without a matching entry here fails to compile, rather than
// silently rendering no hint. `'none'` covers the page before the pause's
// origin has arrived at all -- the server itself reports a pause with no
// stored origin as `heuristic` (every pause was a heuristic guess before
// origins existed), so `'none'` is never what a live pause resolves to.
// See specs/010-prompt-banner-copy/contracts/banner-copy.md for the exact
// per-origin strings and emphasis this table pins.

import type { PromptOrigin } from '../api/types.ts';

export interface PromptBannerView {
  hint: string | null;
  hintStrong: boolean;
  dismissLabel: string;
  quiet: 'answers' | 'dismiss' | null;
}

type BannerEntry = (matchedIndex: number | null, expectedCount: number) => PromptBannerView;

// The dismiss label for every origin that isn't a confirmed 'expected'
// question -- also quoted verbatim inside the stall hint, so the two can't
// drift apart (US3, contracts/banner-copy.md).
const NOT_A_QUESTION_LABEL = 'Not a question — keep waiting';

const BANNER_VIEWS: Record<PromptOrigin | 'none', BannerEntry> = {
  expected: (matchedIndex, expectedCount) => ({
    hint:
      matchedIndex !== null && expectedCount > 0
        ? `Question ${matchedIndex + 1} of up to ${expectedCount} — matches a known prompt in this app's install script.`
        : "Matches a known prompt in this app's install script.",
    hintStrong: false,
    dismissLabel: 'Ignore — keep waiting',
    quiet: 'dismiss',
  }),
  heuristic: (_matchedIndex, expectedCount) => ({
    hint:
      expectedCount > 0
        ? "Looks like a question, but it doesn't match any prompt in this app's install script — it may not be one."
        : 'Looks like a question, but there were no known prompts for this app to check it against — it may not be one.',
    hintStrong: false,
    dismissLabel: NOT_A_QUESTION_LABEL,
    quiet: null,
  }),
  stall: () => ({
    hint:
      `No new output for 5 minutes (repeating progress or spinner lines don't count) and this does not match any known prompt — it may not be a question at all. The line above is the last new output. Choose "${NOT_A_QUESTION_LABEL}" to keep waiting, or answer if it is in fact a prompt.`,
    hintStrong: true,
    dismissLabel: NOT_A_QUESTION_LABEL,
    quiet: 'answers',
  }),
  none: () => ({
    hint: null,
    hintStrong: false,
    dismissLabel: NOT_A_QUESTION_LABEL,
    quiet: null,
  }),
};

export function promptBannerView(
  origin: PromptOrigin | null,
  matchedIndex: number | null,
  expectedCount: number,
): PromptBannerView {
  return BANNER_VIEWS[origin ?? 'none'](matchedIndex, expectedCount);
}

// Derived from the table itself, so a key added to BANNER_VIEWS is picked
// up here automatically rather than needing a second, hand-kept list.
export const PROMPT_BANNER_ORIGINS = Object.keys(BANNER_VIEWS) as Array<PromptOrigin | 'none'>;
