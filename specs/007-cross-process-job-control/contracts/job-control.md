# Contract: Job Control Across Processes

## Web API (`/api/jobs`, existing routes, behavior extended)

Visibility (`isJobVisible`) is checked first, unchanged: an invisible or unknown job is 404.

| Route | Job owned by this process | Job owned by another process |
| --- | --- | --- |
| `POST /:id/cancel` | 200 `{ "cancelled": true }` / 409 nothing to cancel (unchanged) | 202 `{ "requested": true, "owner": "mcp:4242" }`; 409 `Job N is already <status> — nothing to cancel` when terminal; 409 `job N's owning process mcp:4242 has exited` |
| `POST /:id/answer` body `{ "text": "y" }` | 200 `{ "answered": true }` / 409 (unchanged) | 202 `{ "requested": true, "owner": … }`; 409 `Job N is not awaiting input — nothing to answer`; 409 owner exited |
| `POST /:id/dismiss-prompt` | 200 `{ "dismissed": true }` / 409 (unchanged) | 202 `{ "requested": true, "owner": … }`; 409 `Job N is not awaiting input — nothing to dismiss`; 409 owner exited |

The old 409 `job N is owned by X; control it from there` is removed from these routes.

## WebSocket (`/ws/jobs/:id`, protocol unchanged)

Messages sent for a job owned by another process are the same as for a local one:

- `{ "type": "backlog", "text": "…" }`: once, on connect
- `{ "type": "status", "status": "running" }`: on connect and on every change
- `{ "type": "prompt", "text", "expectedPrompts", "origin", "matchedIndex" }`: on connect if
  paused, and whenever a new prompt appears
- `{ "type": "prompt-cleared" }`: when a shown prompt goes away
- `{ "type": "chunk", "stream": "stdout", "text": "…" }`: newly written log output. `stream` is
  always `stdout` for a foreign job, since the log file does not record which stream a line came from;
  the client does not distinguish streams.

## MCP tools

| Tool | Own job | Another process's job |
| --- | --- | --- |
| `cancel_job` | `{ "cancelled": true }` (unchanged) | `{ "requested": true, "owner": "web", "note": "…" }`, or an error with the same refusal wording as the web routes |
| `answer_job_prompt` | `{ "answered": true }` | `{ "requested": true, … }` or refusal |
| `dismiss_job_prompt` | `{ "dismissed": true }` | `{ "requested": true, … }` or refusal |
| `wait_for_job` | unchanged | still refused: `job N is owned by X; control it from there` |

## Job log attribution line (appended by the owner when it applies a remote request)

```text
Stop requested from web UI by admin
Answer sent from MCP (mcp:4242)
Prompt dismissed from web UI by test-user
```
