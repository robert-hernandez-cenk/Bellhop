# Quickstart: validating the reverse-proxy driver interface

All commands run against the worktree (`<wt>` below). Nothing here writes
to real infrastructure.

## 1. Automated checks

```sh
npm --prefix <wt> run typecheck
npm --prefix <wt> test
npm --prefix <wt> run web:build
```

Expected: all pass. Key suites:

| Suite | Proves |
|---|---|
| `test/lib/proxy/drivers/caddy.test.ts` | characterization: Caddy block byte-identical to the pre-refactor capture (FR-010, SC-001) |
| `test/lib/proxy/routes.test.ts` | route derivation rules, path-pattern parsing (FR-001–003, FR-014) |
| `test/lib/proxy/driver.test.ts` | capability errors with a fake no-forward-auth driver (FR-011, SC-004) |
| `test/lib/proxy/file-driver.test.ts` | script content, and the executed restore-on-failure path (FR-007) |
| `test/lib/proxy/index.test.ts` | driver selection, unknown id, missing `proxy: true`, test-only driver registration (FR-006, SC-005) |
| `test/lib/inventory.test.ts` | migration from an old-schema fixture, idempotent reopen, fresh DB, pre-`caddy_manual` DB (FR-022) |
| `test/operations/edit-guest.test.ts` | edit rejected for unsupported mode; unrelated entries don't block (FR-012) |
| `test/web/proxy-sync.test.ts` | prune gated on capability (FR-020) |

## 2. Upgrade of an old database (manual, temp copy)

1. Build an old-schema fixture with the *main-branch* code:
   `git -C <main> show main:src/lib/inventory.ts` is the reference schema;
   or copy an existing pre-upgrade `bellhop.db` into a temp directory.
2. Point the new code at the copy:
   `INVENTORY_FILE=<tmp>/bellhop.db npm --prefix <wt> run bellhop -- sync-proxy`
3. Expected: one migration log line, then the dry-run preview. Rerunning
   prints no migration line.

## 3. Read-only comparison against the live deployment

On the operator's machine only; output is never committed.

1. Copy the deployment checkout's `inventory/bellhop.db` into a temp
   directory (the worktree's seeded copy works too — the migration runs on
   the copy, never on the deployment's own database).
2. `INVENTORY_FILE=<tmp>/bellhop.db npm --prefix <wt> run bellhop -- sync-proxy`
   (dry run).
3. Read the currently deployed managed block from the proxy host
   (`sed -n '/# BEGIN bellhop-managed/,/# END bellhop-managed/p'` on the
   Caddyfile) and diff it against the preview.
4. Expected: no difference (SC-001).

## 4. Browser check (desktop and ≤ 640px)

`npm --prefix <wt> run web:dev` against a temp inventory, then check:

- Dashboard: "read-only proxy" column/card label and toggle, and the
  Advanced modal's equivalent.
- Settings: "Proxy driver" and "Proxy config path" fields save and clear;
  an invalid driver id and a relative path are rejected; "Proxy IP" shows.
- Maintenance: "Sync Proxy" preview renders the managed block.

## 5. After merge (operator)

Pull the new code in the deployment checkout and restart the service in
the same step; the first open migrates the database. Then
`bellhop sync-proxy` (dry run) should show no change.
