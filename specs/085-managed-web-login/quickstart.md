# Quickstart: validating the managed web login

Prerequisites: a worktree with dependencies installed; use a temp inventory
fixture (never the real database): `INVENTORY_FILE=<tmp>/bellhop.db`.

## Automated

```bash
npm run typecheck
npm test
npm run web:build
```

Key suites: `test/web/login/managed.test.ts` (resolve, refresh, last-good,
no-secret), `test/web/login/config.test.ts` (precedence), `test/web/routes/auth.test.ts`
(managed sign-in), `test/web/routes/settings.test.ts` (status + guards),
`test/lib/inventory.test.ts` (flag, at-most-one, migration).

## Manual (demo instance, example data only)

1. `npm run demo`; sign in as the seeded admin at the printed URL.
2. Guests -> Advanced on the demo Bellhop guest: turn on "This is Bellhop".
   Settings -> Web login now reports "Managed by <guest>"; General no longer
   lists the four OIDC values.
3. Fill the four custom values; the tab reports "Custom values".
4. Repeat steps 2-3 at a 640px-wide viewport (browser devtools); the tab and
   the toggle must not overflow.

Expected: matches the acceptance scenarios in [spec.md](spec.md); contracts
in [contracts/](contracts/).
