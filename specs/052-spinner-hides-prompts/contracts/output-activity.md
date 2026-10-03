# Contract: `src/web/jobs/output-activity.ts`

An internal module with no I/O and no timers. One instance per watched
`exec()` call.

```ts
export class OutputActivity {
  // Feeds one raw output chunk. Returns true when the chunk added
  // meaningful output (a new meaningful line completed, or the unfinished
  // line gained meaningful text); false when it was only redraws.
  push(chunk: string): boolean;

  // Length of the meaningful transcript. Grows only by appending, except
  // when trimmed at the front (see trimmedBy).
  get length(): number;

  // Total characters trimmed from the front so far, so a caller holding an
  // offset can adjust it.
  get trimmedBy(): number;

  // Prompt candidate: the trailing meaningful line not ended by a newline,
  // ANSI-stripped, at most 200 characters. '' when the transcript ends in a
  // newline or is empty.
  candidate(): string;

  // Last non-empty meaningful line, ANSI-stripped, at most 200 characters,
  // or '' when there is none.
  lastLine(): string;

  // Drops the first n transcript characters (output already reported by a
  // pause) and forgets the recent-line keys.
  consume(n: number): void;
}
```

Invariants:

- Redraw-only input never changes `length` and `push` returns false.
- `candidate()` and `lastLine()` never return spinner-only text that repeats
  a recent line, unless that line is genuinely the newest meaningful one.
- Retained text never exceeds 16 KiB.
