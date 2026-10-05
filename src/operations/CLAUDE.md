# Operations layer

The shared operations layer (`src/operations/`, #16): the one implementation of every preview/apply action behind both the web UI and the MCP server. The CLI does not use it.

## Shared operations layer

- Every preview/apply action the web UI or MCP server can run is one `Operation` (`src/operations/types.ts`): a zod input `shape`, `target`/`targetType`, `preview()`, and `apply()`, registered in `src/operations/index.ts`.
- The web routes (`provisioning.ts`, `maintenance.ts`, and the Dashboard's guest PATCH via `src/operations/edit-guest.ts`) are thin adapters that keep only HTTP, permission, and attribution concerns.
- Field builders in `src/operations/fields.ts` accept both the web form's string encoding (`'4'`, `'true'`, `''`) and typed JSON, so one shape serves both front ends.
- A new web form field must also be added to its operation's `shape`, or schema parsing strips it. `test/operations/provisioning.test.ts` checks this for every `PROVISIONING_COMMANDS` field.
- `previewAndEnqueue` (`src/operations/core.ts`) is the single implementation of "preview outside the job, then enqueue with the preview logged at the top": the ordering that avoids the `withCapturedConsole` deadlock.

### Pin-once source resolution (`resolvesApp`)

An `Operation` may set `resolvesApp: true` (`install-app`, `update-app`; #11). `previewAndEnqueue` then resolves a custom-script-repository source **once per operation**, before `preview()` runs, and stores it on the parsed input's internal `appSource` field.

- `appSource` is never part of the operation's zod `shape` (so a request body can't supply it) and never serialized into the job's persisted `argsJson` (`enqueue()` stringifies the original `raw` input, not the mutated one).
- `op.preview`, the `watchForPrompts` prompt pre-scan (`promptsForSource` for a `'custom'` resolution, `checkAppUrl` otherwise; unchanged for non-`resolvesApp` operations and for a pasted URL, which has no `scriptsBaseUrl` to scan), and the job's `apply()` (which receives `input.appSource` as `InstallAppOptions.source`/`UpdateAppOptions.source`) all read the same pinned commit.
- Without this, one operation resolved up to three times (preview, prompt pre-scan, apply inside a job that may start much later). Now a branch push after the pin can never make what ran diverge from the preview text at the top of the job log.
- This is narrower than "preview and apply always match": the web UI's standalone Preview button (`POST /api/provisioning/:id/preview`, which calls `op.preview` directly) and the App check (`GET .../check-app`) each pin their own commit at whatever moment they're called. A push between a standalone Preview/check and a later Apply is the case this can't cover; the job log's own preview line shows the commit apply actually used.
- The CLI has no shared pin: a dry run and a separate `--apply` each resolve independently, like every other live lookup (authorized_keys, NFS storage paths).

See `src/commands/provisioning/CLAUDE.md` (`resolveAppSource` and the custom-repository mechanism).

### `OperationDeps`

- `cloudflare` is **required** on `OperationDeps` (`src/operations/types.ts`). `syncProxyLive` treats a missing client as unconfigured and skips `prune-acme-challenges` silently, so a required field turns a forgotten deps literal into a compile error instead of a cleanup that quietly never runs. It stays optional on `AppDeps` and `syncProxyLive`'s own deps (defaulting to `UnconfiguredCloudflareClient`, like `impersonationStore`) only so tests that don't care need no change. `src/web/server.ts` and `src/mcp/server.ts` always pass `buildCloudflareClient()`.
- `syncProxyLive` is reached through this layer (`edit-guest.ts`, `provisioning.ts`), so the web UI and the MCP server both run it. Only the guest-edit and create/install/delete-guest paths prune; `sync-proxy`, `render-status-page`, and `migrate-guest` call `runSyncProxy`/`runRenderStatusPage` directly and never clean up stale TXT records. See `src/commands/networking/CLAUDE.md` (`prune-acme-challenges`) and `src/web/CLAUDE.md` (`syncProxyLive`).
- `actor` (`Actor | undefined`) is the real signed-in person. It is set only by the web provisioning router's `deps()` via `resolveActor(req)` (`src/web/impersonation.ts`): `req.realUser ?? req.user`, so an impersonating admin's actor is their own real account, never the impersonated group; `undefined` for the synthetic local operator (`localOperator: true`). The CLI and the MCP server (including `create_vm`) never set it.
- `now` (injectable clock) feeds `creatorFromActor(deps.actor, deps.now?.())`.
- `canSeeGuest` is a per-request predicate built by the web provisioning routes from `isResourceAllowed`. `checkVmidAvailable` uses it to drop the occupying guest's name from its error when the caller can't see that guest; the CLI and MCP server pass none, so their errors still name it.

## Guest creator and Proxmox access (`provisioning.ts`)

- `recordProvisionedGuest` (`create-lxc`/`create-vm`/`install-app`) and `deploy-vpn-gateway`'s operation set a new guest's `creator` from `creatorFromActor(deps.actor, deps.now?.())`. A real person gets a creator record; every other path (MCP, CLI, local operator) gets none.
- `upsertGuestEntry` keeps the existing `creator` on a repeat apply with no actor, and replaces it on a repeat apply with one (a real re-creation is a deliberate new authorship record).
- A `creator` field in a Dashboard PATCH is ignored because `applyGuestEdits` (`edit-guest.ts`) copies only the fields it names. MCP `edit_guest` is additionally protected because `EDIT_GUEST_SHAPE`'s zod object strips unknown keys.
- `grantCreatorAccess` is called from `create-vm`'s operation `apply()` in a `finally` wrapped around `recordProvisionedGuest`, deliberately not sequenced after it. `runCreateVm` having succeeded means the VM already exists in Proxmox, so the grant is attempted even if recording it in inventory or pushing its subdomains live then fails the job. `grantCreatorAccess` never throws (every outcome is a logged line and a return value), so it can't mask the error `recordProvisionedGuest` raised. A grant happens only for a web job with a real person; `grantCreatorAccess`'s `no-actor` branch reports "nothing to grant to" for every other case as one informational line. It is off entirely without `pveUserRealm`.
- See `src/lib/CLAUDE.md` (`pve-acl`) for the realm/ACL mechanics, and `src/web/CLAUDE.md` (per-resource group permissions, creator access, `isJobVisible`) for how a creator record is used for authorization.

## Guest edit (`edit-guest.ts`)

`commitGuestEdit` is extracted from the Dashboard's guest-PATCH handler and shared unchanged by the MCP server's `edit_guest` tool via `runEditGuest`.

- **OIDC client deletion confirmation**: `editDeletesOidcClient`/`OIDC_CLIENT_DELETION_CONFIRMATION_ERROR` reject (400) an edit that takes an entry from `effectiveAuth() === 'oidc'` to anything else (switching to forward-auth, or clearing `authGroup` while still in OIDC mode) unless the request carries `confirmOidcClientDeletion: true`. It's decided from inventory state alone, not whether the sync ever created a client. `commitGuestEdit` checks it before anything is validated or written, so an unconfirmed edit leaves the entry and its client untouched. MCP `edit_guest` accepts the same flag; its description tells the model to ask the user first, since the MCP server has no dialog of its own. The Dashboard's `EditableAuthMode` shows a `ConfirmDeleteModal` and reopens it if the server still rejects a confirmed save (a concurrent edit changed something first).
- **`oidcConfigErrors`** (required-callback rule, mobile/web cross-list duplicates) is enforced only from `commitGuestEdit`, never from `validateInventory()`, so a saved inventory always loads regardless of a hand-edited row or an `AUTHENTIK_AUTHORIZATION_FLOW_SLUG` change. The cross-list duplicate check runs only for an edit that changed either list (`checkCrossListDuplicates`), so an already-saved duplicate never blocks an unrelated edit. See `src/lib/CLAUDE.md` for the field definitions.
- **Capability check**: `commitGuestEdit` runs `checkCapabilities` against the *edited* guest's own route only (derived alone by `buildRouteForEntry`), so another entry's capability mismatch, missing authentik ip, or bad exempt path can never block this edit; it surfaces the next time that entry is synced or edited, or as `proxySynced: false` from the push-live step. See `src/lib/proxy/CLAUDE.md` (capability enforcement).
- **Push-live**: a successful save runs the combined `syncProxyLive` step. The inventory write has already happened by then, so a proxy failure is reported as `proxySynced: false, proxyError: <message>` rather than rejecting the request.
- **Echoed results**: the edited guest's own `oidcDiscoveryFailures`; `oidcSkipped` (its entries from both `authentikOidcSkipped` and `authentikForwardSkipped`, rendered by `AuthentikSkipBanner`); `authentikConflicts` and `authentikConflictAdoptable` (narrowed from `authentikAdoptableConflicts`); and `mobileConsentProblems` (instance-wide, echoed only when the edit changed that guest's `oidcMobileRedirectUris`, order-sensitive compare).
- The push-live step writes the proxy configuration *before* syncing Authentik, so switching to OIDC drops `forward_auth` first. A skipped or failed *Authentik* sync therefore leaves the app ungated at the edge until the next successful one. A failed *proxy* sync does not: `sync-authentik` still runs after it.
- See `src/web/CLAUDE.md` for the admin-only checks (`oidcEditChangeError`, tier raise/lower, `unauthenticatedPaths`) that the Dashboard route applies before calling `commitGuestEdit`.

## `update-app` post-apply re-check (`maintenance.ts`)

After a successful web/MCP `update-app` apply (`result.result?.code === 0`), the same job calls `checkOneGuest` for that guest and upserts its result before finishing, so the Update page's badge never claims an update is still available right after one was applied.

- A failed re-check is only `logWarn`ed and never fails the already-successful update job.
- A non-zero script exit skips the re-check entirely, leaving the last recorded result alone.
- It runs only when the update's `app` matches the guest's recorded `app` (one info line otherwise).
- It resolves through the job's already-pinned `appSource` when there is one, so it reads the exact script just run rather than resolving a custom branch a second time.

See `src/commands/maintenance/CLAUDE.md` (`check-app-updates`).
