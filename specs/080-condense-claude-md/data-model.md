# Data Model: destination files and topic map

Line numbers refer to the original `CLAUDE.md` at commit `6cd2f90` (4,175 lines). Use `git show 6cd2f90:CLAUDE.md` to see it.

## Destination files

| Key | File | Loaded when Claude reads... |
|---|---|---|
| ROOT | `CLAUDE.md` | every session |
| LIB | `src/lib/CLAUDE.md` | anything under `src/lib/` |
| PROXY | `src/lib/proxy/CLAUDE.md` | anything under `src/lib/proxy/` |
| DRIVERS | `src/lib/proxy/drivers/CLAUDE.md` | a driver file |
| NET | `src/commands/networking/CLAUDE.md` | a networking command |
| PROV | `src/commands/provisioning/CLAUDE.md` | a provisioning command |
| MAINT | `src/commands/maintenance/CLAUDE.md` | a maintenance command |
| OPS | `src/operations/CLAUDE.md` | the operations layer |
| WEB | `src/web/CLAUDE.md` | anything under `src/web/` |
| JOBS | `src/web/jobs/CLAUDE.md` | the job runner |
| TASKS | `src/web/tasks/CLAUDE.md` | the scheduler |
| MCP | `src/mcp/CLAUDE.md` | the MCP server |
| CLIENT | `web-client/CLAUDE.md` | anything under `web-client/` |

## Topic map

"Primary" is where the full text goes. "Pointers" are one-line references added to other files.

| Original lines | Topic | Primary | Pointers / notes |
|---|---|---|---|
| 1-49 | Commands, testing pattern (temp SQLite fixture, `FakeSSHClient`, file-driver `sh` exception, `Ssh2SSHClient` untested) | ROOT | |
| 50-54 | Architecture intro | ROOT (map) | |
| 55-273 | Inventory schema (hosts/guests/external sites, ssh fields, subdomains, proxyManual, authGroup/authMode/effectiveAuth, oidc redirect lists, unauthenticatedPaths, unprivileged, app/appSource, creator, proxy, validateInventory rules, bridges, storages, cluster note) | LIB | ROOT map summarises it in one paragraph |
| 274-450 | Inventory DB read/write: tables, meta settings, secret_settings, saveInventory transaction, sortInventoryForFile, subdomain rowid order, #158 and caddy->proxy migrations | LIB | ROOT keeps the "full replace + deterministic sort" rule |
| 451-540 | Target resolution, `sh -c` wrapping, qm guest exec envelopes, Ssh2SSHClient auth/exit handling, SshTarget | LIB | ROOT keeps: runRemote is the only remote path; guest commands are POSIX sh; the exceptions (deploy-vpn-gateway bash, update-app inner bash, pve branch) |
| 541-561 | Machine ID | LIB | |
| 562-616 | update-all targeting, VM exclusion, package-manager detection, configure-guest --packages | LIB | MAINT and PROV get pointers |
| 617-645 | Dry-run convention and live-call-in-preview list | ROOT | |
| 646-935 | Proxy driver interface, getDriver/driverDeps, none driver, capability enforcement, fileDriver | PROXY | NET pointer for runSyncProxy |
| 936-983 | Caddy driver | DRIVERS | |
| 984-1105 | nginx driver (+ nginx-locations) | DRIVERS | PROXY pointer for `nginx-locations.ts` |
| 1106-1235 | Nginx Proxy Manager driver + npm-client | DRIVERS | LIB pointer for `npm-client.ts` |
| 1236-1308 | HAProxy driver | DRIVERS | WEB pointer (web UI behind HAProxy) is covered by WEB 3293+ |
| 1309-1487 | Traefik driver | DRIVERS | |
| 1488-1579 | Caddy admin-API driver, caddy-json/caddy-admin, convert-caddyfile | DRIVERS | PROXY pointer (caddy-json.ts/caddy-admin.ts sit in proxy/); NET pointer for convert-caddyfile |
| 1580-1619 | sync-authentik core: ownership, slug/name, ladder bindings, missingRungs/offLadder | NET | |
| 1620-1665 | Tier raise/lower authorization, unauthenticatedPaths add rule (Dashboard PATCH) | WEB | NET pointer |
| 1666-1965 | Application existence/ownership, rename caveat, native OIDC gating, mode switches, outpost reconcile, adoptableConflicts, discovery check, mobile consent, API quirks, failure isolation | NET | |
| 1966-1986 | Auth-group dropdown, syncProxyLive push-live ordering, FR-023 proxy-failure behavior | WEB (syncProxyLive); CLIENT (dropdown) | |
| 1987-2048 | OIDC field edits: admin-only, oidcEditChangeError (WEB); editDeletesOidcClient/commitGuestEdit (OPS); Advanced modal tabs, accessFieldsFor, banners (CLIENT) | split as noted | |
| 2049-2093 | OIDC credentials and adoption (CLI/web/MCP) | NET | MCP pointer; WEB pointer for `src/web/routes/oidc.ts` |
| 2094-2176 | prune-acme-challenges, CloudflareClient, syncProxyLive prune step | NET | OPS keeps "`cloudflare` is required on OperationDeps" |
| 2177-2238 | render-status-page, statusPageSkipReason | NET | |
| 2239-2269 | attach-nfs-mount | PROV | |
| 2270-2293 | sync-inventory | MAINT | |
| 2294-2320 | audit-nfs-mounts | MAINT | |
| 2321-2339 | migrate-nfs-mount | PROV | |
| 2340-2412 | migrate-guest | PROV | |
| 2413-2525 | install-app/update-app: VMID pre-check, unattended env, pickStorage, storage dropdowns, authorized_keys, interactive pty CLI path | PROV | CLIENT pointer for the select-storage field kind |
| 2526-2621 | Web prompt relay, detection tiers, OutputActivity, resume/exemption, MCP surfacing, install-script pre-scan | JOBS | PROV pointer |
| 2622-2641 | update-app in-guest run; provisioning-route inventory upsert + syncProxyLive | PROV (update-app); WEB (route upsert) | |
| 2642-2690 | Script catalog (upstream + custom group) | PROV | LIB pointer for `script-catalog.ts` |
| 2691-2793 | Custom script source resolution, COMMUNITY_SCRIPTS_URL, source notice, pin-once via previewAndEnqueue | PROV (resolution); OPS (pin-once) | LIB pointer for `app-source.ts` |
| 2794-2832 | Live TLS-backend probing | LIB (`tls-probe.ts`) | WEB pointer for the two call sites |
| 2833-2897 | Scheduler framework, task_schedules, tasks route | TASKS | |
| 2898-3001 | check-app-updates, app_update_status, post-update re-check | MAINT | WEB pointer (`/api/app-updates`); OPS pointer (re-check after update-app) |
| 3002-3070 | Proxmox access for VM creators (pve-acl) | LIB | PROV pointer |
| 3071-3113 | Web UI responsiveness/theming, FieldHelp, popover | CLIENT | ROOT keeps "mobile is first-class" |
| 3114-3134 | Web UI inventory reload | WEB | |
| 3135-3157 | Shared operations layer | OPS | |
| 3158-3208 | MCP server tools, wait_for_job elicitation, ping workaround, owner/orphan cleanup | MCP | |
| 3209-3247 | Cross-process job watching and control (job-tail, job-control, job_control_requests) | JOBS | MCP pointer |
| 3248-3292 | MCP stdout, stdin close, OIDC tools, VPN gateway tools | MCP | |
| 3293-3394 | Web UI authentication, webUiAuthMode, lockout guards | WEB | |
| 3395-3491 | User/group management, AuthentikClient, web:dev group caveat | WEB | LIB pointer for `authentik-client.ts` |
| 3492-3607 | Per-resource permissions, creator access, used-mids | WEB | LIB pointer for `permissions.ts` |
| 3608-3655 | backfill-guest-creators | MAINT | |
| 3656-3707 | Admin impersonation | WEB | CLIENT pointer (sidebar refresh) |
| 3708-3788 | Settings store/config accessor/import/liveClient/github headers | LIB | ROOT keeps "secrets never leave the store" |
| 3789-3948 | Settings page: API (WEB); UI dropdowns/proxyFieldView/tabs (CLIENT) | split as noted | |
| 3949-3982 | VPN gateway deploy credentials | PROV | |
| 3983-4001 | Project philosophy | ROOT | |
| 4002-4154 | Workflow conventions | ROOT | |
| 4155-4175 | Windows development notes | ROOT | |

## Citation names to preserve (research R4)

Each name below must appear as a heading or bold label in some `CLAUDE.md`:

| Name | Where it will be |
|---|---|
| `sortInventoryForFile` | LIB |
| Web UI authentication | WEB |
| Dry-run convention | ROOT |
| Project philosophy | ROOT |
| Settings | LIB / WEB / CLIENT |
| runRemote / target resolution | ROOT + LIB |
| cluster note | LIB |
| `--storage` note | PROV |
| phantom-success | LIB |
| single-operator assumptions | ROOT |
