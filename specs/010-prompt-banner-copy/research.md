# Research: Prompt banner copy per detection origin

No `NEEDS CLARIFICATION` items were left in the Technical Context. The
decisions below record the choices made while designing.

## R1 — Where the per-origin choices live

- **Decision**: A framework-free `promptBannerView(origin, matchedIndex, expectedCount)` in `web-client/src/lib/prompt-banner.ts`, backed by a `Record<PromptOrigin | 'none', …>` table.
- **Rationale**: The issue asks for compiler-checked exhaustiveness; a `Record` keyed by the union fails to compile if an origin is added without copy. Framework-free means it runs under `node --test` (same as `admin-nav.ts`), so every origin's copy is unit-tested without a DOM.
- **Alternatives considered**: Keep inline JSX branches with a `switch` + `never` check (exhaustive, but untestable without rendering React); put the table inside `JobView.tsx` (same problem).

## R2 — Treatment of dismiss on a confirmed (`expected`) prompt

- **Decision**: Label "Ignore — keep waiting" (em dash, matching R3's label below), styled as a quiet outline button; answer controls keep normal styling.
- **Rationale**: Chosen by the operator during design, over rename-only and hiding. Hiding would remove the only in-banner escape from a mis-numbered or already-answered prompt short of stopping the job; a label alone would still give skipping the same visual weight as answering. First chosen as "Skip this question"; code review of the finished feature pointed out that dismiss sends nothing to the installer (`JobSSHClient.resume()` only clears the pause and re-arms the watch timer) — the installer never actually skips the question, it keeps waiting on it exactly as before. "Skip" implied otherwise, so the operator changed the label to "Ignore — keep waiting", which describes what dismissing actually does.

## R3 — Dismiss label for `heuristic`, `stall`, and unrecorded pauses

- **Decision**: "Not a question — keep waiting" for all three.
- **Rationale**: "Not stuck" describes the job, not the line; in a heuristic pause the job isn't stuck either way — the question is whether the line is a question. The new label states the operator's actual judgment and mirrors the MCP dialog's "Not a real prompt — resume" (`src/mcp/elicitation.ts`), so both front ends name the action the same way. One label for one action also keeps the stall hint's reference to it stable.
- **Alternatives considered**: Keep "Not stuck — keep waiting" for stall/heuristic (issue's minimal option) — rejected because it would leave the stall hint's button name and the MCP wording disagreeing.

## R4 — Heuristic hint when there were no known prompts

- **Decision**: Two variants, chosen by `expectedCount > 0`.
- **Rationale**: A heuristic pause also happens when the pre-scan had nothing to scan (a pasted script URL, an app without a conventionally named install script, a non-`install-app` job). "Doesn't match any prompt in this app's install script" would then imply a script was checked; the second variant says there was nothing to check against.

## R5 — Emphasis mechanism

- **Decision**: A per-button `.prompt-banner-quiet` class decided by the view's `quiet` field (`'answers' | 'dismiss' | null`), replacing `.prompt-banner-actions-stall > .button:not(:last-child)` and `.prompt-banner-actions-stall .prompt-banner-freetext .button`.
- **Rationale**: The positional selector hard-codes "dismiss is the last child"; expected needs the opposite (dismiss quiet). A class on the element states intent directly and keeps both directions to one rule. The quiet style's declarations are unchanged from today's stall rule, so stall looks identical (FR-007). The banner's background and text colour are fixed (not themed), so the quiet style needs no dark-theme variant.

## R6 — Heuristic hint styling

- **Decision**: The ordinary (softened) hint style; only stall uses `.prompt-banner-hint-stall`.
- **Rationale**: Stall's strong styling exists because it may not be a question at all and dismiss is the recommended action. A heuristic pause matched a question shape, so answering and dismissing are equally plausible — equal button weight, ordinary hint.
