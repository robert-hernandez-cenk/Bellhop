# Quickstart: Validating Cross-Process Job Streaming and Control

## Automated

From the worktree root:

```bash
npm run typecheck
npm test
npm run web:build
```

Tests that prove the feature (see `tasks.md` for exact files):

- `test/web/jobs/job-tail.test.ts`: tailer ticks emit new output, a split UTF-8 character intact,
  status/prompt/prompt-cleared changes, and stop after a terminal status.
- `test/web/jobs/job-store.test.ts`: control-request create/pending/handled, owner scoping, text
  cleared on handling.
- `test/web/jobs/job-runner.test.ts`: `processControlRequests()` cancels, answers and dismisses its
  own jobs, marks requests for inactive jobs not-applicable, writes the attribution line without the
  answer text.
- `test/web/jobs/job-control.test.ts`: local pass-through, dead-owner refusal, state refusals,
  request recording.
- `test/web/routes/jobs.test.ts`: 202 for foreign jobs; WebSocket streams a foreign job's new output
  and final status.
- `test/mcp/build-server.test.ts`: `cancel_job` on a web-owned job returns `requested`;
  `wait_for_job` still refuses.

## Manual (real processes, same checkout)

1. Start the web UI (`npm run web:dev`) and, in the same checkout, an MCP client connected to
   `npm run mcp`.
2. From the MCP client, apply a long-running job (for example `update-all` against a test host, or an
   `install-app` for an app known to prompt).
3. Open Job History in the web UI and click that job ("Triggered by: mcp"). Expected: the log grows
   live, the status badge changes, and a prompt banner appears if the installer asks.
4. Answer the prompt from the web UI. Expected: the job resumes within about a second, the MCP
   client's `wait_for_job` dialog (if open) is withdrawn, and the log shows
   `Answer sent from web UI by <you>`.
5. Start another MCP job and press Stop in the web UI. Expected: immediate response, then the job
   shows `cancelled` and the log shows `Stop requested from web UI by <you>`.
6. From the MCP client, call `cancel_job` on a job started from the web UI. Expected: `requested`,
   then the web page shows it cancelled.
7. Repeat steps 3 to 5 at a desktop width and at a 640px-or-narrower viewport.
