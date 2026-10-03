# Data Model: Creator access to guests (#58)

## GuestCreator (new, `src/lib/inventory.ts`)

| Field | Type | Rules |
| --- | --- | --- |
| `uid` | string, optional | Non-empty when present. The identity provider's stable user identifier (Authentik `uid`, sent as `X-authentik-uid`). |
| `username` | string | Non-empty. Login name at the time the record was written; used for display and as the match fallback. |
| `since` | string, optional | Non-empty ISO-8601 time the record was written: the web apply's clock, or the creating job's `startedAt` for the backfill. Bounds the job lift: only jobs that started at or after it. Absent means no job lift (guest access itself is unaffected). |

Zod: `GuestCreatorSchema = z.object({ uid: z.string().min(1).optional(), username: z.string().min(1), since: z.string().min(1).optional() })`.

## GuestEntry (extended)

- `creator?: GuestCreator` — new, optional. Absent for every guest created
  before this feature (until back-filled), and for guests created via MCP, the
  CLI, the synthetic local operator, or found by `sync-inventory`.

Lifecycle:

| Event | Effect on `creator` |
| --- | --- |
| Web create-lxc / create-vm / install-app / deploy-vpn-gateway by a real person | Set to `{ uid?, username, since }` of the real person (impersonation ignored); `since` is the apply's current time. |
| Same host+VMID upserted again with an actor | Replaced by the new actor, with a new `since`. |
| Same host+VMID upserted again without an actor | Kept. |
| `sync-inventory` refreshes an existing guest | Kept (`{ ...existing }`). |
| `sync-inventory` adds a newly discovered guest | Absent. |
| `migrate-guest` | Kept (host/VMID/IP rewritten only). |
| Guest removed from inventory | Gone with the row. |
| Dashboard PATCH / MCP `edit_guest` | Never changed; a `creator` key in the input is ignored. |
| `backfill-guest-creators --apply` | Set only when currently absent; `since` is the creating job's `startedAt`. |

## Storage (`inventory/bellhop.db`, `guests` table)

Three nullable `TEXT` columns, added by `ensureColumn`:

- `created_by_uid`
- `created_by_username`
- `created_by_since`

Load: `creator` is present iff `created_by_username` is non-null; `uid` iff
`created_by_uid` is non-null; `since` iff `created_by_since` is non-null. Save:
written from `guest.creator` (all null when absent). No migration of existing rows is needed.

## AuthUser (extended, `src/web/auth.ts`)

- `uid?: string` — from the `x-authentik-uid` header when present and
  non-empty; absent for dev/test identities and the local operator.

## Actor (extended, `src/lib/pve-acl.ts`)

- `uid?: string` — copied from the real (non-impersonated) `AuthUser` by
  `resolveActor`.

## Access decision (pure, `src/lib/permissions.ts`)

`isGuestCreator(creator, caller)`:

1. `caller.impersonating` set → `false`.
2. `creator` absent → `false`.
3. Both `creator.uid` and `caller.uid` present → `creator.uid === caller.uid`.
4. Otherwise → `creator.username === caller.username`.

`isAllowed(rules, groups, ref, { isCreator })`, per restricted group of the
caller:

| Group mode | Guest listed | `isCreator` | Group allows? |
| --- | --- | --- | --- |
| allow-list | yes | any | yes |
| allow-list | no | true (guest ref) | yes |
| allow-list | no | false | no |
| block-list | yes | any | **no** (explicit block wins) |
| block-list | no | any | yes |

Result is still the intersection across groups; admin bypass precedes it.

Jobs (`isJobVisible`, `src/web/routes/jobs.ts`) apply the same table by
target name, with `isCreator` true only when all of these hold:

1. `guestCreators(inventory)` has the target: a guest with a creator whose
   name is **not** also a host name (a job target is an untyped name, and the
   guest-creating commands target the host).
2. `isGuestCreator(creator, caller)`.
3. `creator.since` is present, the job has a `startedAt`, and
   `startedAt >= since` (compared as instants). Otherwise no lift, so a
   reused guest name never exposes the earlier guest's jobs.

## Backfill report (`backfill-guest-creators`)

- `updates[]`: `{ guest, host, vmid, username, uid?, since?, jobId }` (`since`
  is the job's `startedAt`). With `--apply`, an update the reload re-check drops
  moves to `skipped` (`already-has-creator` or `no-matching-guest`).
- `skipped[]`: `{ jobId, command, reason, detail }`, `reason` ∈
  `unknown-user` | `no-matching-guest` | `already-has-creator` |
  `unparseable-args` | `superseded`
- `applied: boolean`
