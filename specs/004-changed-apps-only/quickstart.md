# Quickstart: Validating Changed-Apps-Only Resolution

Example values throughout; substitute your own fork/branch only on your own machine.

## Automated

```bash
npm run typecheck
npm test            # includes test/lib/app-source.test.ts, test/lib/script-catalog.test.ts,
                    # test/commands/install-app.test.ts, update-app.test.ts, test/operations/*
npm run web:build
```

Fixtures: `test/fixtures/github/compare-ahead-3-apps.json` (8 ahead / 0 behind / 3 apps) and
`compare-diverged-conflict.json` (1 ahead / 251 behind / 1 app that upstream also added).

## Live (manual, read-only — dry runs only)

Prerequisite: `customScriptsRepo`/`customScriptsBranch` set to a fork branch of ProxmoxVED
that adds or changes a few apps (`bellhop set-config customScriptsRepo example-user/ProxmoxVED --apply`, etc.).

1. `npm run bellhop -- install-app --host pve1 --mid 42 --app <an app the branch changes>`
   → first line is `[INFO …]` (if upstream has it) or nothing; script curls the fork at the
   pinned commit and exports `COMMUNITY_SCRIPTS_URL`.
2. `npm run bellhop -- install-app --host pve1 --mid 42 --app <an unchanged upstream app>`
   → no notice; script identical to running with the settings unset (compare by unsetting).
3. Web UI → Provisioning → Install App: the custom group lists exactly the branch's changed
   apps; a conflicting one shows `conflicts upstream`. Check desktop and ≤640px widths.
4. MCP `list_install_apps` → `custom.slugs` equals the changed set; `check_install_app` for a
   changed app returns `custom` and, when applicable, `conflict: true`.
5. Unset both settings → catalog shows no custom group, installs behave as before.
