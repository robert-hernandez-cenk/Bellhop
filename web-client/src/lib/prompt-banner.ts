// Framework-free (no React/DOM imports) so it compiles under the root
// NodeNext config and is testable with plain node --test, same rationale as
// admin-nav.ts/settings-display.ts. One place for the job-log prompt
// banner's per-origin hint text, hint emphasis, dismiss-button label and
// which controls get the quiet/outline treatment (issue #4) -- a
// `Record<PromptOrigin | 'none', …>` table so a new PromptOrigin added to
// api/types.ts without a matching entry here fails to compile, rather than
// silently rendering no hint. Phase 2 (this file's first version)
// reproduces today's JobView.tsx behavior exactly; later phases (see
// specs/010-prompt-banner-copy/contracts/banner-copy.md) change individual
// table entries, not this structure.

import type { PromptOrigin } from '../api/types.ts';

export interface PromptBannerView {
  hint: string | null;
  hintStrong: boolean;
  dismissLabel: string;
  quiet: 'answers' | 'dismiss' | null;
}

type BannerEntry = (matchedIndex: number | null, expectedCount: number) => PromptBannerView;

// Today's only dismiss-button label -- every origin uses it for now; a
// later phase gives 'expected' and the rest their own labels (research R2/R3).
const TODAY_DISMISS_LABEL = 'Not stuck — keep waiting';

const BANNER_VIEWS: Record<PromptOrigin | 'none', BannerEntry> = {
  expected: (matchedIndex, expectedCount) => ({
    hint:
      matchedIndex !== null && expectedCount > 0
        ? `Question ${matchedIndex + 1} of up to ${expectedCount} — matches a known prompt in this app's install script.`
        : "Matches a known prompt in this app's install script.",
    hintStrong: false,
    dismissLabel: TODAY_DISMISS_LABEL,
    quiet: null,
  }),
  heuristic: () => ({
    hint: null,
    hintStrong: false,
    dismissLabel: TODAY_DISMISS_LABEL,
    quiet: null,
  }),
  stall: () => ({
    hint:
      'Output stopped for 5 minutes and this does not match any known prompt — it may not be a question at all. The line above is the last output received. Dismiss to keep waiting, or answer if it is in fact a prompt.',
    hintStrong: true,
    dismissLabel: TODAY_DISMISS_LABEL,
    quiet: 'answers',
  }),
  none: () => ({
    hint: null,
    hintStrong: false,
    dismissLabel: TODAY_DISMISS_LABEL,
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
