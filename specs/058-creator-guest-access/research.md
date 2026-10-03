# Research: Creator access to guests (#58)

All values below are examples (constitution Principle I). Facts marked
"verified live" were checked read-only against a real deployment on
2026-10-03; the real values stay out of this repository.

## R1 — Which identity marks the creator

**Decision**: Store the creator as `{ uid?, username }`. Match by `uid` when
both the record and the caller carry one; otherwise compare `username`.

**Rationale**: Verified live: the identity provider's usernames were renamed
once already (a short login such as `a-user` became a full-name login such as
`Example User`), and job history still holds the old spellings. A grant keyed
on the login name would have vanished silently at that rename. Authentik's
user objects carry a `uid` — verified live: a 64-character hex string on every
user from `GET /api/v3/core/users/` — which is the value Authentik's outpost
sends as `X-authentik-uid` and which does not change when the username does.
Every forward-auth-capable proxy driver already forwards that header (Caddy
`X-Authentik-Uid`, nginx/NPM `X-authentik-uid`, Traefik `X-authentik-uid`).
The username is kept alongside it for display and as the fallback for
identities that have no uid (`WEB_UI_DEV_USER` test identities).

**Alternatives considered**: username only (rejected — the rename above);
Authentik `pk` (not sent in any forward-auth header, so a request could not be
matched against it without an API call per request).

## R2 — Where the creator is stored

**Decision**: Two nullable columns on the existing `guests` table,
`created_by_uid` and `created_by_username`, added with `ensureColumn`, surfaced
on `GuestEntry` as an optional `creator: { uid?: string; username: string }`.

**Rationale**: The record must live and die with the guest (FR-008). As a
guest column it is automatically dropped when the guest leaves inventory
(`saveInventory`'s wholesale replace), carried by `sync-inventory`'s
`{ ...existing }` merge and by `migrate-guest`'s `{ ...g, host, vmid, ip }`
rewrite, and never orphaned. Guest names are not editable, so nothing needs to
follow a rename of the guest.

**Alternatives considered**: a separate `guest_creators` table like
`permission_groups` (rejected: needs its own cleanup on delete, sync-drop and
migrate, and could leak a grant onto a later guest reusing the name).

## R3 — How creator access combines with group rules

**Decision**: Extend the pure `isAllowed(rules, groups, ref, opts)` in
`src/lib/permissions.ts` with `opts.isCreator`: for a `guest` ref, an
allow-list group treats the guest as listed when `isCreator` is true; a
block-list group is unchanged (an explicit block still denies). A new pure
`isGuestCreator(creator, caller)` decides `isCreator`: false while the caller
is impersonating, false with no creator, uid comparison when both have a uid,
username comparison otherwise.

**Rationale**: One place decides, so the inventory filter, route checks and job
visibility cannot disagree (FR-006). Matches the user's decision "explicit
block wins".

## R4 — Threading the caller through the web checks

**Decision**: `src/web/access.ts`'s `isResourceAllowed`,
`filterInventoryForUser` and `requireResourceAccess` take the caller
(`AuthUser`: groups, username, uid, impersonating) instead of bare `groups`.
They read a guest's creator from the in-memory `Inventory` the routes already
hold (refreshed per request by the `/api` reload middleware), passed in by the
route factories. `isJobVisible(rules, caller, target, creators)` takes a
`Map<guestName, GuestCreator>` built once per request from the same inventory,
so a job whose target is a guest the caller created is visible; job targets
are matched by name exactly as today.

**Rationale**: Keeps every check synchronous, avoids a DB read per check, and
reuses the inventory object every route module already closes over. The WS
upgrade handler (`src/web/routes/jobs.ts`) builds its caller from
`resolveAuthUser` plus the impersonation store, setting `impersonating` the
same way `applyImpersonation` does, so FR-007 holds there too.

## R5 — Reading `uid` from the request

**Decision**: `resolveAuthUser` reads `x-authentik-uid` into `AuthUser.uid`
when present and non-empty. `Actor` (`src/lib/pve-acl.ts`) gains `uid?`, and
`resolveActor` copies it. `applyImpersonation`'s overlay keeps `uid` (it only
replaces `groups` and sets `impersonating`), and `isGuestCreator` returns
false whenever `impersonating` is set.

## R6 — Recording the creator at creation time

**Decision**: `recordProvisionedGuest` (`src/operations/provisioning.ts`) sets
`creator` from `deps.actor` for create-lxc, create-vm and install-app.
`deploy-vpn-gateway` writes its own inventory entry inside
`runDeployVpnGateway`, so it gains an optional `creator` option that its
operation passes from `deps.actor`; the CLI passes none. `upsertGuestEntry`
uses `entry.creator ?? existing.creator`, so a repeat apply for the same
host+VMID with no actor (e.g. MCP) keeps the recorded creator, and a real
re-create by a signed-in person records them.

**Rationale**: `deps.actor` is already exactly "the real signed-in person, or
undefined for MCP/CLI/local operator" (issue #53), satisfying FR-002/FR-003
without new plumbing.

## R7 — Protecting the field from edits

**Decision**: No change to `EDIT_GUEST_SHAPE` (zod object, unknown keys
stripped) or `applyGuestEdits` (applies only named fields). Tests pin that a
`creator` key in a Dashboard PATCH body or an MCP `edit_guest` call is ignored
and the stored creator is unchanged (FR-009).

## R8 — Backfill data source and matching

**Decision**: A CLI-only command `backfill-guest-creators [--map <old=new>]...
[--apply]` (`src/commands/maintenance/backfill-guest-creators.ts`). It reads
`data/jobs.sqlite3` through `JobStore`, considers only rows with
`command ∈ {create-lxc, create-vm, install-app, deploy-vpn-gateway}`,
`status = 'success'` and a non-null `triggered_by_username` other than `mcp`.
From `args_json` it takes `host`, `mid` and the guest name (`hostname` for
create-lxc/install-app, `name` for create-vm/deploy-vpn-gateway), derives the
VMID with `resolveMid`, and matches a current guest with the same host, VMID
and name. Newest `started_at` wins per guest. Login names go through `--map`
first, then are resolved against `AuthentikClient.listUsers()` (which gains
`uid`), giving `{ uid, username }`. Guests with an existing creator are never
touched. Every skip is reported with a reason: `unknown-user`,
`no-matching-guest`, `already-has-creator`, `unparseable-args`, `superseded`.

**Rationale**: Verified live: `triggered_by_username` exists on job rows and
successful create jobs by restricted users exist; MCP jobs are recorded as the
literal `mcp`; rows before actor tracking are null. `args_json` stores the raw
form input (secrets redacted), which always includes host, mid and the name.
CLI-only is deliberate: it is a one-time operator migration, like
`import-yaml-inventory` and `convert-caddyfile`, and an `Operation` would
expose a fleet-wide inventory rewrite to the web UI for no ongoing use.

**Without Authentik configured**: the command fails with the same
"not configured" error the Users page gives, naming `data/authentik.env` —
it cannot attach a uid without the directory, and username-only records would
re-introduce R1's rename problem.

## R9 — Display

**Decision**: The Advanced guest modal's General tab shows a read-only
"Created by" row with `creator.username` when present and omits the row
otherwise, with a `FieldHelp` entry in `advanced-field-help.ts` explaining
that the creator always keeps access unless a block-list names the guest.
`GET /api/inventory` already returns full guest entries, so `creator` reaches
the client with no route change. The uid is not shown.

## R10 — Single-operator assumptions

None introduced. The backfill's `--map` pairs are operator input, never
defaults; real old/new login names are never committed.

## R11 — Job visibility hardening (final review)

**Decision 1**: `guestCreators` (`src/web/access.ts`) leaves out any guest
whose name equals a host name, so the job lift never applies to such a name.
The guest's own access (inventory, routes) is unchanged; only the name-keyed
job lift is withheld. No `validateInventory` rule.

**Rationale**: A job's `target` is an untyped name, and the guest-creating
commands record the *host* as their target. Without the exclusion, a
restricted user could create a guest named like a host they cannot access and
then see and control every job on that host. A validation rule would close it
too, but could make an already-saved inventory unloadable.

**Decision 2**: The creator record gains an optional `since` (ISO-8601,
`created_by_since` column): the web apply's clock when recorded, or the
creating job's `startedAt` for the backfill. The job lift applies only to jobs
that started at or after `since`; a creator without `since`, or a job with no
`startedAt`, gets no job lift. Guest access itself never reads `since`.

**Rationale**: Job history is keyed by name, so a guest re-created under a
deleted guest's name would otherwise expose the old guest's jobs (their logs
and controls) to the new guest's creator. Failing closed when `since` is
missing keeps any record without a known time from widening job visibility.
A queued job that has not started yet is likewise hidden from the lift until
it starts.
