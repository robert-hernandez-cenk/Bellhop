# Quickstart: validating #64

All against a worktree copy (never the deployment checkout's database).

## Automated

```bash
npm run typecheck && npm test && npm run web:build
```

Key suites: `test/lib/config.test.ts` (precedence, snapshot, malformed rows),
`test/lib/config-import.test.ts` (idempotent, never overwrites, key-only logs, files untouched),
`test/lib/github.test.ts` + each GitHub call site's tests (header present iff token set, 401 text),
`test/web/routes/settings.test.ts` (sources, secrets never returned, env-pinned refusal, both
guards, 403 for non-admin/impersonating), `test/commands/maintenance/set-config.test.ts` (argv
refused, stdin accepted, value never printed), a leak test that seeds unique secret values and
searches API responses, status page HTML, inventory YAML, job rows and captured logs.

## Manual (web UI)

1. `npm run web:dev` in the worktree (dev user is admin via `WEB_UI_DEV_GROUPS`).
2. Settings page: six tabs; GitHub tab -> Replace token -> Save -> input empties, shows "set".
3. Reload: still "set", value never visible; DevTools network response has no token.
4. Start with `GITHUB_API_TOKEN=x` in the environment -> field read-only "set by environment".
5. Change `authentikAdminGroup` to a group the dev user lacks -> confirmation, then 409 refusal.
6. Set `webUiAuthMode` to `authentik` from the dev session (no forward-auth headers) -> 409.
7. Repeat 2-6 at 375px width and in dark theme.

## Manual (CLI)

```bash
printf 'example-token' | npm run bellhop -- set-config githubApiToken --stdin --apply
npm run bellhop -- set-config githubApiToken example-token     # refused
```

## Import

Copy a database with no moved settings plus `data/authentik.env`; start the CLI once; the log
lists imported keys only; a second run imports nothing; the file is unchanged (`sha256sum`).
