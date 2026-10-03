# Quickstart: validating creator access (#58)

All names are examples. Never run any of this against the real inventory
except the final, read-only backfill dry run.

## Automated

```bash
npm run typecheck
npm test
npm run web:build
```

Key tests: `test/lib/permissions.test.ts` (creator rules, block precedence,
impersonation), `test/web/routes/dashboard.test.ts` (inventory filter, PATCH
ignores `creator`), `test/web/routes/jobs.test.ts` (job visibility incl. WS),
`test/operations/provisioning.test.ts` (creator recorded for web actor only),
`test/lib/inventory.test.ts` (round trip, upsert/sync/migrate preservation),
`test/commands/backfill-guest-creators.test.ts` (matching, map,
skip reasons, never overwrites, dry run writes nothing).

## Demo instance (browser)

1. `npm run demo` (127.0.0.1:3100). Pick a demo guest that has a `creator`
   in the demo inventory and open its Advanced dialog: "Created by" shows the
   username, read-only. A guest with no creator shows no such row.
2. Check at a desktop width and at ≤640px.

## Restricted-user walk-through (temp inventory)

1. Build a temp inventory with host `pve1` and guest `web-lxc`
   (`creator: { username: 'test-user' }`), plus a permission group
   `app-users` in allow-list mode listing only host `pve1`.
2. Start the web UI against it with `INVENTORY_FILE=<tmp>/bellhop.db`,
   `WEB_UI_DEV_USER=test-user`, `WEB_UI_DEV_GROUPS=app-users`: `web-lxc`
   is listed. Restart with `WEB_UI_DEV_USER=other-user`: it is not.
3. Add a block-list group `blocked` naming `web-lxc` and include it in
   `WEB_UI_DEV_GROUPS` for `test-user`: `web-lxc` disappears.

## Backfill dry run against the deployment (read-only)

From the deployment checkout:

```bash
bellhop backfill-guest-creators --map <old-login>=<current-login>
```

Review the plan; only then re-run with `--apply`.
