// Turns the static `read -p` prompt hints parsePromptHints() scrapes out of an
// app's install script (src/web/routes/provisioning.ts) into matchers for the
// live output stream. Issue #160.
//
// The reason this is not a string comparison: a hint is captured from the
// script *source*, so it still carries shell expansions. cloudflare-ddns
// asks `read -rp "${TAB3}Enter the Cloudflare API token: "`, and what the pty
// actually prints is `   Enter the Cloudflare API token: `. Every expansion
// becomes a wildcard, which also covers a value interpolated into the middle
// of a prompt (`"Enter value [$default]: "`).
//
// Kept free of any dependency on JobSSHClient so it can be unit-tested on the
// real prompt corpus in isolation.

const EXPANSION = /\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*/;
const REGEX_META = /[.*+?^${}()|[\]\\]/g;
// A hint has to carry enough literal text to be distinctive. `read -p "$msg" x`
// leaves nothing at all, and a bare `"> "` leaves one character -- compiled,
// either would match essentially every line and pause the job the first time
// output went quiet.
const MIN_LITERAL_LENGTH = 8;

function compilePromptHint(hint: string): RegExp | null {
  const segments = hint
    .split(EXPANSION)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  const literalLength = segments.reduce((total, segment) => total + segment.length, 0);
  if (literalLength < MIN_LITERAL_LENGTH) return null;
  const pattern = segments
    // Escape first, then relax whitespace: a run of spaces/tabs in the source
    // may be rendered differently (or collapsed) by the time it reaches us.
    .map((segment) => segment.replace(REGEX_META, (char) => `\\${char}`).replace(/\s+/g, '\\s+'))
    .join('[\\s\\S]*?');
  try {
    return new RegExp(pattern);
  } catch {
    // Defensive: every metacharacter is escaped above, so this should be
    // unreachable. A hint that somehow still fails to compile is dropped from
    // matching rather than thrown into a running job.
    return null;
  }
}

// Compiled once per job rather than per check -- an install can sit in the
// watch loop for twenty minutes, and there is no reason to rebuild the same
// four regexes every two seconds.
export function compilePromptHints(hints: string[]): Array<RegExp | null> {
  return hints.map(compilePromptHint);
}

// Returns the *index* of the matching hint, not a boolean, so the operator-
// facing UI can say "question 2 of up to 4" without duplicating this matching
// logic client-side (it used to, and the two disagreed -- see JobView).
export function matchExpectedPrompt(trailing: string, compiled: Array<RegExp | null>): number | null {
  for (let index = 0; index < compiled.length; index += 1) {
    const pattern = compiled[index];
    if (pattern !== null && pattern.test(trailing)) return index;
  }
  return null;
}
