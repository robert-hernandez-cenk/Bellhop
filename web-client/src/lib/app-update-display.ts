import type { AppUpdateResult } from '../api/types.ts';

// Framework-free (no React/DOM imports) so it compiles under the root
// NodeNext config and is testable with plain node --test, same precedent as
// admin-nav.ts/settings-display.ts. `formatTime` is injected rather than
// called directly (Intl.DateTimeFormat/toLocaleString) so this function
// stays clock- and locale-free for tests, and so the caller controls
// exactly how a checkedAt timestamp reads in the UI.
export type AppUpdateTone = 'available' | 'quiet';

export interface AppUpdateView {
  tone: AppUpdateTone;
  // The badge/note's own visible text.
  text: string;
  // Tap/click-disclosure body (research R11) -- always includes
  // "Checked <time>", with the failure reason appended for an error.
  details: string;
}

// check-app-updates.ts's one real not-checked reason today is the sentence
// "Guest is stopped" (capitalized, as a standalone message). Mid-sentence
// after "Not checked: " that capital reads oddly, so the first letter is
// lower-cased here (fix round 1) -- "Not checked: guest is stopped" --
// rather than hand-tuning the stored message's wording for display.
function lowercaseFirst(text: string): string {
  return text.length === 0 ? text : text[0]!.toLowerCase() + text.slice(1);
}

// research R11: unsupported renders nothing at all -- not an error, not a
// quiet note, nothing an operator could mistake for a problem with their
// app. Every other status gets a view; the switch is exhaustive so a sixth
// AppUpdateStatus added later fails typecheck here rather than silently
// falling through.
export function appUpdateView(result: AppUpdateResult, formatTime: (iso: string) => string): AppUpdateView | null {
  const checked = `Checked ${formatTime(result.checkedAt)}`;
  switch (result.status) {
    case 'update-available':
      return {
        tone: 'available',
        text: `Update available ${result.installedVersion} → ${result.latestVersion}`,
        details: checked,
      };
    case 'up-to-date':
      return {
        tone: 'quiet',
        text: `Up to date (${result.installedVersion})`,
        details: checked,
      };
    case 'error':
      return {
        tone: 'quiet',
        text: 'Update check failed',
        details: result.message ? `${checked} -- ${result.message}` : checked,
      };
    case 'not-checked':
      return {
        tone: 'quiet',
        text: `Not checked: ${result.message ? lowercaseFirst(result.message) : 'unknown reason'}`,
        details: checked,
      };
    case 'unsupported':
      return null;
    default: {
      // Exhaustiveness guard: a sixth AppUpdateStatus added without a case
      // above fails typecheck here (result.status would no longer be
      // assignable to `never`) rather than silently rendering nothing.
      const exhaustive: never = result.status;
      return exhaustive;
    }
  }
}
