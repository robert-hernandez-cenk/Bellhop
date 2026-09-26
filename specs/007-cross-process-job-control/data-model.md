# Data Model: Cross-Process Job Streaming and Control

## Job (existing, `jobs` table in `data/jobs.sqlite3`)

Unchanged. Fields this feature reads from another process: `owner` (`'web'`, `'mcp:<pid>'`, or
null meaning `'web'`), `status`, `log_file`, `prompt_text`, `expected_prompts_json`,
`prompt_origin`, `prompt_matched_index`.

## Job control request (new, `job_control_requests` table in `data/jobs.sqlite3`)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | INTEGER PK AUTOINCREMENT | Application order. |
| `job_id` | INTEGER NOT NULL | References `jobs.id` (not enforced as a foreign key, matching `jobs` having none). |
| `action` | TEXT NOT NULL | `CHECK (action IN ('cancel', 'answer', 'dismiss'))`. |
| `text` | TEXT | Answer text for `answer` only; set to NULL once handled. |
| `requested_by_owner` | TEXT NOT NULL | Requesting process: `'web'` or `'mcp:<pid>'`. |
| `requested_by_username` | TEXT | Real web user, when known; null from MCP. |
| `created_at` | TEXT NOT NULL | ISO timestamp. |
| `handled_at` | TEXT | Null while pending. |
| `result` | TEXT | `'applied'` or `'not-applicable'`; null while pending. |

Index: `(handled_at, job_id)` is unnecessary at this scale; the pending query is
`SELECT r.* FROM job_control_requests r JOIN jobs j ON j.id = r.job_id WHERE r.handled_at IS NULL
AND COALESCE(j.owner, 'web') = ? ORDER BY r.id`.

### Lifecycle

```text
pending (handled_at NULL) --owner applies--> handled, result = applied
                          --job not active / method returned false--> handled, result = not-applicable
```

A request is never re-applied: `handled_at` is set in the same statement that records the result.
A handled row is kept (it is a small audit record with the text cleared).

## New `JobStore` methods

- `createControlRequest({ jobId, action, text?, requestedByOwner, requestedByUsername? }): number`
- `pendingControlRequests(owner: string): ControlRequestRow[]`
- `markControlRequestHandled(id: number, result: 'applied' | 'not-applicable'): void`

## New `JobLog` method

- `readBytes(name: string, offset = 0): Buffer`: the log file's bytes from `offset`; an empty
  buffer when the file is missing or shorter than `offset`.
