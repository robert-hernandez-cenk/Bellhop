# Contract: command behavior and messages under `proxyDriver = none`

Exact strings live as exported constants so tests and callers share them.

| Where | Behavior | Text |
| --- | --- | --- |
| `runSyncProxy` (all callers) | No SSH, no proxy-host lookup, no route derivation; returns `proxyHost: null`, `preview` = message | `NO_PROXY_SYNC_MESSAGE` = `proxyDriver is 'none' -- Bellhop manages no reverse proxy, so there is nothing to write` |
| CLI `sync-proxy` (dry run) | Prints the message via `logInfo`, exit 0 | as above |
| CLI `sync-proxy --apply` | Prints the message via `logInfo`, exit 0 | as above |
| `sync-proxy` operation (web/MCP) preview | The message | as above |
| `sync-proxy` operation apply | Logs the message | as above |
| `runRenderStatusPage` (CLI + operation) | Throws before any SSH | `NO_PROXY_STATUS_PAGE_ERROR` = `proxyDriver is 'none' -- there is no Bellhop-managed proxy to serve a status page -- ` + `settingFix('proxyDriver', 'caddy')` |
| `syncProxyLive`, `migrate-guest` | Skip the render, log one line, continue | `statusPageSkipReason()` → `proxyDriver is 'none' -- skipping the status page render` (or the existing `statusPagePathSkipMessage()` when the path is unset) |
| `syncProxyLive` prune step | Existing capability skip | `pruneAcmeDriverSkipMessage('none')` (unchanged) |
| `commitGuestEdit` capability check | Never rejects (both modes supported) | — |
| `sync-authentik` | Unchanged | — |

Unset / `caddy`: every row behaves exactly as before (SC-003).
