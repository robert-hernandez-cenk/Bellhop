# Quickstart: verifying #78

## Automated

From the worktree root:

```bash
npm run typecheck
node --test test/web/console-capture.test.ts test/web/jobs/job-runner.test.ts test/operations/core.test.ts
npm test
```

Expected: all pass. The new tests cover, without wall-clock timing:

- concurrent captures each see only their own lines; one doesn't wait for the other
- a nested capture's lines go only to the inner sink
- a line logged after a capture settles goes to the fallback console
- the console that was in place before the first capture (e.g. a redirect) is the fallback, and is restored afterwards
- a job's lines from socket/event and timer callbacks reach its log (FakeSSHClient-driven)
- `previewAndEnqueue` returns while a first job is still blocked, with the second job `queued`
- the second job doesn't start until the first finishes; a cancelled queued job never runs

## Manual (web UI, demo instance)

1. `npm run demo` and open `http://127.0.0.1:3100`.
2. Start a long action (for example Update App on one guest), then immediately start a second one.
3. Expected: the second request returns at once, and Job History shows it as `queued` while the first is `running`. It starts after the first finishes.
4. Cancel a `queued` job: it ends `cancelled` and never shows as `running`.

The demo's simulated SSH client answers quickly, so step 2 may need a slow action. If none is slow enough, the automated tests are the evidence.
