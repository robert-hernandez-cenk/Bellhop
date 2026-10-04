# Quickstart: validating daily app update checks

## Automated

```bash
npm run typecheck
npm test            # includes the new scheduler, parser, store, route, CLI, and re-check tests
npm run web:build
```

The key suites:

- `test/lib/app-update-check.test.ts`: parsing every surveyed call shape (plain, guarded, `${RELEASE}` pin, `${VAR:-x}` pin, prefix, non-literal → unsupported), version normalization, and pin/latest decisions, using captured release fixtures.
- `test/web/tasks/scheduler.test.ts`: daily slot, catch-up at start, no double run, disabled, edited time, and DST spring-forward/fall-back with an injected clock.
- `test/web/routes/tasks.test.ts` / `app-updates.test.ts`: admin gate, impersonation, 400/404/409, and permission filtering.

## Manual (demo instance, no real infrastructure)

1. `npm run demo`, then open `http://127.0.0.1:3100/update`. Seeded results show an "Update available" badge, an "Up to date" note, and an error note. Check the emphasized button and the tap-to-reveal checked time.
2. Open Admin → Tasks. Change the time to a valid value and save; confirm Next run updates. Enter `25:00` and confirm it's rejected.
3. Press Run now and confirm navigation to a job in Job History triggered by the demo admin.
4. Repeat steps 1–2 at a viewport of 640px or narrower: cards, no horizontal scroll.

## Manual (real infrastructure, operator)

1. `npm run bellhop -- check-app-updates`: lines per LXC app guest, nothing saved.
2. `npm run bellhop -- check-app-updates --apply`, then reload the Update page.
3. Pick one `update available` guest, run its app update from the Update page, and confirm the badge flips to "Up to date" when the job finishes.
4. Restart the web service after 04:00 with no run yet today. Confirm a run triggered by `scheduler` appears in Job History within a minute.
