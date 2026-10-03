# Research: Prompts Hidden Behind a Redrawing Spinner

All values below are illustrative examples, not captured operational data.

## R1. What the spinner stream looks like

**Finding**: community-scripts' host-side `build.func` spinner writes a frame
roughly every 100 ms. Each frame is a carriage return, an "erase line" escape
sequence, a Braille spinner glyph and the status text, for example
`\r\x1b[2K⠋ Skipping host LXC stack upgrade prompt (unattended mode)`. In the
reported log every frame ended up on its own line. Over a pty, `\n` arrives
as `\r\n` (`onlcr`). A `read -p` prompt prints its text with no line ending
and then blocks. The next spinner frame starts with `\r`, so the prompt
counts as "overwritten in place" even though the process is blocked on it.

**Decision**: split the stream on both `\r` and `\n`, and treat `\r\n` as a
single newline ending, so that a pty's normal line ending is not mistaken
for an in-place overwrite.

## R2. Telling a redraw from activity

**Decision**: key each line by stripping ANSI escapes (the existing
`ANSI_ESCAPE` pattern), stripping leading characters that are neither
letters nor digits (spinner glyphs, check marks, whitespace), collapsing
whitespace runs and trimming. A completed line is a redraw when its key is
empty or equals one of the last 16 distinct meaningful keys. An unfinished
line is a redraw when its key is empty or is a prefix of one of those keys,
which covers a frame split across two chunks.

**Rationale**: comparing against several recent keys, not only the last one,
is what lets the first spinner frame *after* a prompt count as a redraw. The
spinner text was already seen before the prompt, so the prompt stays the
newest meaningful line. Sixteen keys covers a spinner alternating with a few
other status lines while keeping memory trivial.

**Digits are significant** (operator decision): a ticking counter or a
changing percentage is activity. Normalizing digits would let a long
download that shows only a percentage raise a false stall.

**Alternatives considered**:
- Collapse only exact repeats of the previous line. This fails the core
  case, because the frame after the prompt differs from the prompt.
- Model a virtual terminal screen. Rejected: much more code, and a prompt
  overwritten by `\r\x1b[2K` would disappear from the "screen" entirely, so
  matching would still miss it.
- Match pre-scanned prompts anywhere in recent output (the issue's second
  suggestion, taken literally). Rejected: a prompt string echoed back after
  being answered would pause the job again. Ignoring redraws keeps the real
  prompt as the last meaningful line, which gives the same result safely.

## R3. Forgetting keys on resume

**Decision**: `resume()` clears the recent-key list.

**Rationale**: a script that re-asks the same question after an invalid
answer prints an identical prompt. Without clearing, its key would count as
a redraw and the question would only surface at the 5-minute stall. The cost
is that the first spinner frame after a resume counts as one meaningful
line, which is harmless.

**Superseded in the final code review**: the cost was not harmless. Once
the keys were forgotten, the first spinner frame after an answer was new,
so it committed a second prompt printed before it with `\r` and became the
line the tiers tested. The second prompt then waited for the 5-minute
stall. `resume()` now keeps the recent keys. After an expected or
heuristic pause only, it exempts the reported prompt: a line whose key
starts with that prompt's key is never a redraw. That also covers the pty
echoing the answer onto the first asking (`Enter port: abc`), which the old
clearing missed. A stall's text is never exempted, since it may be the
spinner line itself. `JobSSHClient` now holds an absolute `mark()` and
calls `consumeThrough()` in place of R4's length/trimmed arithmetic.

## R4. Keeping existing resume semantics

**Decision**: the module exposes the meaningful transcript as one
append-only string: committed meaningful lines with their endings, plus the
unfinished line when it is meaningful. `JobSSHClient` keeps its existing
`firedAtLength` slicing against that string's length. The transcript is
trimmed at the front past 16 KiB, and the trimmed amount is subtracted from
the fired offset.

**Rationale**: it reuses the #160 Finding 1 behavior (keep output that
arrived during a pause, drop what was already reported) unchanged.

## R5. Prompt candidate and stall text

**Decision**: the candidate is the text after the last line boundary of the
transcript once trailing `\r`s are removed, empty if the transcript ends in
`\n`, capped at 200 characters. Stall text is the last non-empty line, with
the existing "(no new output since last seen)" fallback.

## R6. Stall auto-clear (operator decision)

**Decision**: when a stall pause is waiting and the module reports new
meaningful output, `JobSSHClient` calls its own `resume()`. That is the same
path a dismissal takes, so `JobRunner.onPromptCleared` clears the abandon
timer and marks the job running. Expected and heuristic pauses are not
auto-cleared.

**Rationale**: once redraws count as silence, a long spinner-only step
produces a stall pause, and the 15-minute abandon timer would otherwise
cancel a working job. The MCP `wait_for_job` dialog already aborts when the
job leaves `awaiting_input` (`src/mcp/wait-for-job.ts`), so no MCP change is
needed.
