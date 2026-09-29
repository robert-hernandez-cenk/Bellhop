# Contract: command behavior and messages under `proxyDriver = none`

Exact strings live as exported constants so tests and callers share them.

| Where | Behavior | Text |
| --- | --- | --- |
| `runSyncProxy` (all callers) | No SSH, no proxy-host lookup, no route derivation; returns `proxyHost: null`, `applied: false` (even with `--apply`), `preview` = message | `NO_PROXY_SYNC_MESSAGE` = `proxyDriver is 'none' -- Bellhop manages no reverse proxy, so there is nothing to write` |
| CLI `sync-proxy` (dry run) | Prints the message via `logInfo`, exit 0 | as above |
| CLI `sync-proxy --apply` | Prints the message via `logInfo`, exit 0 | as above |
| `sync-proxy` operation (web/MCP) preview | The message | as above |
| `sync-proxy` operation apply | Logs the message | as above |
| `runRenderStatusPage` (CLI + operation) | Throws before any SSH | `NO_PROXY_STATUS_PAGE_ERROR` = `proxyDriver is 'none' -- there is no Bellhop-managed proxy to serve a status page -- ` + `settingFix('proxyDriver', 'caddy')` |
| `syncProxyLive`, `migrate-guest` (sync step) | Log `runSyncProxy`'s `preview` via `logInfo`; `migrate-guest` omits its "Pushing the new IP ... live via the proxy" line | `NO_PROXY_SYNC_MESSAGE` |
| `syncProxyLive`, `migrate-guest` (status page) | Skip the render, log one line via `logInfo`, continue | `statusPageSkipReason()` → `{ message: "proxyDriver is 'none' -- skipping the status page render", level: 'info' }` (or the existing `statusPagePathSkipMessage()` when the path is unset) |
| `syncProxyLive` prune step | Existing capability skip | `pruneAcmeDriverSkipMessage('none')` (unchanged) |
| `commitGuestEdit` capability check | Never rejects (both modes supported) | — |
| `sync-authentik` | Unchanged | — |

Unset / `caddy`: every row behaves exactly as before (SC-003).

## A managed driver that serves no status page

None ships today; the case is kept distinct from `none` so a future driver gets an accurate message.

| Where | Behavior | Text |
| --- | --- | --- |
| `runRenderStatusPage` | Throws before any SSH | `statusPageUnsupportedError(id)` = `The '<id>' proxy driver does not serve a status page -- clear statusPagePath (bellhop set-config statusPagePath --unset --apply, or on the web UI's Settings page) or choose a proxyDriver that serves one` |
| `syncProxyLive`, `migrate-guest` | Skip the render, continue; `logWarn` when `statusPagePath` is set (it is being ignored), else `logInfo` | `The '<id>' proxy driver does not serve a status page -- skipping the status page render` |
