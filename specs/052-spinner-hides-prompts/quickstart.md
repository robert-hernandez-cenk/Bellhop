# Quickstart: verifying spinner-proof prompt detection

## Automated

```bash
npm run typecheck
npm test -- test/web/jobs/output-activity.test.ts test/web/jobs/job-ssh-client.test.ts
npm test
npm run web:build
```

Expected:

- `output-activity.test.ts`: spinner frames (whole, split across chunks,
  glyph-only, check-mark finish) are classified as redraws; new text is
  activity; a `\r`-overwritten prompt stays the candidate; `\r\n` counts as a
  newline; the transcript stays bounded.
- `job-ssh-client.test.ts`: the spinner, prompt, spinner sequence pauses at
  tier 0 as `expected` with the prompt text. A spinner-only tail escalates at
  the stall tier with the last meaningful line. A stall pause clears itself
  when new meaningful output arrives, while an expected pause does not. Every
  #160 test passes unchanged.

## Manual (real infrastructure, optional)

Install an app whose install script prompts (for example `mariadb`) from the
web UI, on a host where `build.func` leaves its "unattended mode" spinner
running. The job should pause at the first question within a few seconds of
it appearing, accept an answer, and continue to the second question.
