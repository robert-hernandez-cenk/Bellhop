# Data Model: Accept a second action while a job is running (#78)

No persisted data changes. The jobs table, its statuses and the job log files are unchanged. Two in-memory structures change.

## Capture sink (in `src/web/console-capture.ts`)

| Field | Meaning |
|-------|---------|
| `lines: string[]` | Every line captured so far; joined with `\n` into the returned `text`. |
| `onLine?: (line) => void` | Called synchronously for each line (a job uses it to append to its log). |
| `active: boolean` | `true` while the capture's function is running; cleared when it settles. An inactive sink receives nothing. |

Module state: one `AsyncLocalStorage<CaptureSink>`, an active-capture count, and the saved fallback `console.log`/`console.error` (set at count 0 -> 1, restored at 1 -> 0 if the wrappers are still installed).

## Job queue (in `JobRunner`)

`queue: Promise<void>`, the tail of this runner's `execute` calls. Job lifecycle, unchanged in shape:

```
enqueue ─► queued ─► (its turn) ─► running ◄─► awaiting_input ─► success | failed | cancelled
              │
              └─ cancelled before its turn ─► cancelled (never marked running, no work done)
```

The next job's `execute` starts only after the previous one has settled, whatever its outcome.
