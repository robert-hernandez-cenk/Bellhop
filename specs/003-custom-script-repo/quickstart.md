# Quickstart: Validating the Custom Script Repository Feature

Uses example values from `contracts/interfaces.md`. Run these against a temporary inventory (`INVENTORY_FILE=<tmp>/bellhop.db`) unless a step says it needs real infrastructure.

## Automated

```bash
npm run typecheck
npm test                 # includes test/lib/app-source.test.ts, updated install-app/update-app/script-catalog/app-check/settings tests
npm run web:build
```

Key assertions (see tasks.md for the full list):

1. Feature off: `buildInstallAppScript`/`buildUpdateAppScript` output is byte-identical to the pre-change output for the same inputs.
2. Custom-only slug: the script exports `COMMUNITY_SCRIPTS_URL` at `…/<owner>/<repo>/<sha>` and curls `…/<sha>/ct/<slug>.sh` with no upstream fallback.
3. Overriding slug: `shadows` lists the upstream repositories, and the captured preview text starts with the override warning.
4. Half-configured, 404/422 on the head lookup, or a network error: resolution throws a message naming `customScriptsRepo`/`customScriptsBranch`, and no SSH exec is recorded on the `FakeSSHClient`.
5. `previewAndEnqueue` resolves once: the fetch stub sees one head-SHA request per apply, and the job's apply uses the same SHA even when the stub's branch head changes after enqueue.
6. Catalog: the custom group is listed and upstream copies of its slugs are removed, the listing is refetched after 5 minutes but not before, a key change discards the old listing, and a listing failure leaves the upstream groups intact.

## CLI dry run (no infrastructure changed)

```bash
bellhop set-config customScriptsRepo example-user/ProxmoxVED --apply
bellhop set-config customScriptsBranch my-apps --apply
bellhop install-app --host pve1 --mid 42 --app myapp --hostname myapp
```

Expect: no error, `COMMUNITY_SCRIPTS_URL` at a 40-hex commit, and the override warning at the top if `myapp` also exists upstream.

## Web UI (desktop and ≤640px)

1. Settings page: set both fields, reload, and confirm they persist. A malformed repository (`not-a-repo`) is rejected with the same message as `set-config`.
2. Install App: typing a custom slug shows the custom group first. Picking an overriding slug shows the override banner. Preview shows the warning first.
3. Dashboard: a guest with `appSource: 'custom'` links to the GitHub blob URL.

## Live (real infrastructure, operator-approved)

Install one fork-only app from the operator's fork with `--apply`, then confirm inside the container that the installed app is the fork branch's version (e.g. a marker the branch's install script writes), and that `/usr/bin/update` carries the pinned `COMMUNITY_SCRIPTS_URL`. Record the result in the PR description, not in the repository.
