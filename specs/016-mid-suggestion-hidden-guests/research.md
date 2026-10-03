# Research: MID suggestions that account for hidden guests

## R1. Where the suggestion's data comes from

- **Decision**: a new authenticated route, `GET /api/provisioning/used-mids`, returning
  `{ usedMids: { [hostName]: number[] } }` for every host the caller may see, computed from the
  unfiltered in-memory inventory. Loaded once by `ProvisioningForm` next to `/inventory`.
- **Rationale**: the form's suggestion logic is synchronous inside `setField`; a per-form-load
  map keeps it synchronous and needs one request instead of one per host change. Numbers only
  satisfies FR-002.
- **Alternatives considered**:
  - `GET .../next-mid?host=X`: a request on every host change and an async race inside
    `setField`; also doesn't serve the on-blur warning, which needs the full set.
  - Return hidden guests from `/api/inventory` with names stripped: changes a widely used
    response and risks leaking other fields; rejected (spec non-goal).

## R2. Which MIDs count as occupied

- **Decision**: for each guest on the host, `vmid - midScheme.vmidBase` if it lies in
  `resolveMid`'s accepted range (1-254); hosts without `midScheme` are omitted. Sorted ascending,
  deduplicated. The client still limits its suggestion to its own `MID_MIN`..`MID_MAX` (2-252).
- **Rationale**: matches what `resolveMid` could hand out, so any MID a user can submit is
  covered; the client's narrower suggestion range is unchanged behavior.
- **Alternatives**: returning raw VMIDs (leaks nothing extra but makes the client redo the base
  arithmetic it already has; MIDs are what the field holds).

## R3. Which hosts are included

- **Decision**: those passing `isResourceAllowed(inventoryPath, groups, { type: 'host', name })`;
  admins get all. Groups come from `req.user.groups`, so impersonation applies automatically.
- **Rationale**: same rule `GET /api/inventory` uses for hosts; a host the user can't see can't
  be picked in the form anyway.

## R4. Error text for a hidden conflicting guest

- **Decision**: `checkVmidAvailable(ssh, inv, hostName, vmid, canSeeGuest?)`. When the
  inventory guest exists and `canSeeGuest` is given and returns false, the error uses the
  existing no-name wording: `VMID <vmid> on '<host>' is already in use -- choose a different
  --mid`. With no predicate (CLI, MCP), behavior is unchanged.
- **Rationale**: the no-name wording already exists for live-but-untracked VMIDs, so a hidden
  guest is indistinguishable from an untracked one, which is exactly what the caller should
  learn. Optional parameter keeps CLI/MCP call sites and tests untouched (FR-007).
- **Alternatives**: catching and rewriting the error in the web route (string surgery, brittle);
  filtering the inventory passed to the command (would break `resolveMid`/migration logic that
  legitimately needs the full inventory).

## R5. How the predicate reaches the command

- **Decision**: `OperationDeps.canSeeGuest?: (name: string) => boolean`. The provisioning router's
  `deps()` becomes `deps(req)` and sets it to
  `(name) => isResourceAllowed(inventoryPath, groups, { type: 'guest', name })` with the caller's
  groups captured. `previewAndEnqueue` already spreads deps into the job's `apply`, so preview
  and apply both see it. `runInstallApp`/`runMigrateGuest` read it from their deps argument
  (their deps types gain the optional field) and pass it to `checkVmidAvailable`.
- **Rationale**: one injection point, no change to the MCP server (which builds deps without it).
- **Scope check**: only install-app and migrate-guest call `checkVmidAvailable`. create-lxc/
  create-vm rely on Proxmox's own duplicate-VMID error, which names no guest. The maintenance
  router's operations never call it, so it needs no change.

## R6. Load failure

- **Decision**: if `/used-mids` fails, the form keeps `usedMids` unset, suggests nothing (empty
  MID field), and shows the error in the form's existing error area (FR-008). The collision
  warning shows nothing while the set is unknown; the apply-time check remains the backstop.
- **Rationale**: falling back to the filtered guest list would reintroduce the bug silently.

## R7. Collision warning text

- **Decision**: pure helper `midCollisionMessage(host, mid, usedMids, visibleGuests)` in
  `web-client/src/lib/mid.ts`: `null` when free (or when the occupied list is unknown and no
  visible guest holds it -- code review: a visible holder still warns while the list is pending
  or failed to load, as before #54); if a visible guest holds the VMID,
  today's text `MID <n> is already used by <name> (vmid <vmid>) on <host>.`; otherwise
  `MID <n> is already in use on <host>.`
- **Rationale**: framework-free so it is tested under `test/web-client/` like `admin-nav.ts`.
