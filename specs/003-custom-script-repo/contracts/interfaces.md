# Interface Contracts: Custom Script Repository

Example values only: `example-user/ProxmoxVED`, branch `my-apps`, slug `myapp`, host `pve1`.

## CLI

```text
bellhop set-config customScriptsRepo example-user/ProxmoxVED --apply
bellhop set-config customScriptsBranch my-apps --apply
bellhop set-config customScriptsRepo --unset --apply        # (and the branch) turns the feature off
```

`install-app --app myapp …` / `update-app --app myapp …`: no new flags. When resolved to the custom repository:

- Dry run prints the override warning (if any) first, then the script, which contains:
  `export COMMUNITY_SCRIPTS_URL='https://raw.githubusercontent.com/example-user/ProxmoxVED/<sha>'`
  and the final line `bash -c "$(curl -fsSL 'https://raw.githubusercontent.com/example-user/ProxmoxVED/<sha>/ct/myapp.sh')"` (no upstream fallback, since the custom copy is known to exist at that commit).
- `--apply` sends exactly that script.
- A resolution failure exits non-zero with the named error before any SSH call that changes anything.

With the feature off, or for an upstream-resolved slug, the script is byte-identical to today's.

## Web API

| Endpoint | Change |
| --- | --- |
| `GET /api/settings`, `PATCH /api/settings` | Accept/return `customScriptsRepo`, `customScriptsBranch` (same `SettingsSchema` as `set-config`; admin-only as today). |
| `GET /api/provisioning/install-app/check-app?value=` | Response gains `custom`, `shadows`, `error` (see data-model.md). |
| `GET /api/provisioning/install-app/apps` | Response gains `custom` group (see data-model.md). |
| `POST /api/provisioning/install-app/{preview,apply}` | Preview text and job log start with the override warning when applicable; apply pins once (research R5). |
| `POST /api/maintenance/update-app/{preview,apply}` | Same as install-app. |
| `GET /api/inventory` | Gains `customScripts`. Guests may carry `appSource: 'custom'`. |

## Web UI

- **Settings page**: two new text fields, "Custom script repository (owner/repo)" and "Custom script branch", with the same save/clear behavior as the existing fields.
- **Install App → App field**: the suggestion popup shows a first group labelled `<owner>/<repo>@<branch> (custom)`. A slug that overrides upstream shows an "overrides ProxmoxVE" (or "ProxmoxVED") tag. After a check that resolved to the custom repository, a notice names the repository, branch and short commit. When `shadows` is non-empty, a warning-styled banner names the overridden repositories. When `error` is set, the error text is shown and the status is `missing`.
- **Dashboard / Update page app link**: for `appSource: 'custom'` guests, it links to `https://github.com/<owner>/<repo>/blob/<branch>/ct/<slug>.sh`, labelled "Open <slug> in <owner>/<repo>". There's no link when the custom settings are unset.

## MCP

- `check_install_app`: returns the same JSON as the web check (gains `custom`, `shadows`, `error`).
- `list_install_apps`: returns the same JSON as the web catalog (gains `custom`).
- `install_app` / `update_app` preview text: starts with the override warning when applicable. `apply: true` pins once, like the web path.
- `set_config`: gains the two keys automatically, since its `key` enum is built from `SETTINGS_KEYS`.
