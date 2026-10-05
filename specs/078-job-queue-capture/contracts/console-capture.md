# Contract: `withCapturedConsole` and `JobRunner` ordering (#78)

## `withCapturedConsole(fn, onLine?)`

Signature unchanged: `withCapturedConsole<T>(fn: () => Promise<T>, onLine?: (line: string) => void): Promise<{ text: string; result: T }>`.

| Guarantee | Before | After |
|-----------|--------|-------|
| Starts `fn` | after every earlier capture in the process settled | immediately |
| Lines from `fn` and anything it awaits or schedules (timers, socket/SSH callbacks) while it runs | captured | captured |
| Lines from a concurrent capture | impossible (serialized) | never captured |
| Lines inside a nested capture | never: the inner call waited behind the outer one forever (deadlock) | inner capture only |
| Lines logged after `fn` settles | went to the restored console | go to the fallback console |
| `console.log`/`console.error` once no capture is active | the originals | the originals (same function objects) |
| Fallback console | n/a | the `console.log`/`console.error` in place when the first concurrent capture started, e.g. the MCP server's stderr redirect |
| Lines joined into `text` | `args.map(String).join(' ')` per call, `\n` between calls | unchanged |
| `fn` throws | rejection propagates | unchanged |

## `JobRunner`

| Guarantee | Before | After |
|-----------|--------|-------|
| `enqueue` creates a `queued` row and returns its id | synchronously | synchronously (unchanged) |
| Jobs run one at a time | process-wide, via the console chain | per runner, via the runner's own queue (each process has one runner in production) |
| Start order | enqueue order | enqueue order |
| A job cancelled while queued | `cancelled`, no work, "Job cancelled by operator" logged | unchanged |
| A failed/cancelled job holds up the next | no | no |

## `previewAndEnqueue`

Unchanged order: parse, resolve app source, `preview()`, prompt pre-scan, `enqueue`. The preview no longer waits for a running job, so the call returns in roughly the preview's own time.
