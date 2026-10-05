# Contract: self-management guard

Applies when the `bellhopGuest` setting is set to a value `<self>`.

| Action | Entry point | Behavior for target `<self>` |
|---|---|---|
| `update-app` | `runUpdateApp` (CLI, web, MCP) | throws the refusal before resolving the app source or any remote call, dry run or apply |
| `delete-guest` | `runDeleteGuest`, plus the `delete-guest` operation's apply before its Authentik teardown | throws the refusal before any remote call, dry run or apply |
| `migrate-guest` | `runMigrateGuest` | throws the refusal before any remote call, dry run or apply |
| guest power (`start`, `shutdown`) | `runGuestPower` | throws the refusal, dry run or apply |
| `update-all` | `runUpdateAll` | `<self>` is removed from the targets and returned in `skippedSelf`; the others run unchanged. CLI summary adds `  Skipped (Bellhop's own guest): <self>` when non-empty. The operation preview appends `Skipping <self>: Bellhop's own guest (bellhopGuest setting).` |

The refusal message (one string, shared by all actions; `<action>` is `update`, `delete`, `migrate`, `start` or `shut down`):

```text
Refusing to <action> '<self>': it is Bellhop's own guest (the bellhopGuest setting), so doing that would disrupt the running Bellhop service. Act on it in Proxmox directly, or update Bellhop with its own update script. If the setting names the wrong guest, change it with "bellhop set-config bellhopGuest <name> --apply" or on the Settings page.
```

With the setting unset, or for any other target, every entry point behaves exactly as before.

`update-all` given only `<self>` (for example `--host <self>`) returns `pass: []`, `skippedSelf: ['<self>']` and no failures. It does not throw "No targets matched".
