# Data Model: MID suggestions that account for hidden guests

No stored data changes. One derived, read-only shape:

## Occupied MIDs

`Record<hostName, number[]>`

- **Key**: name of a host the caller may see (`isResourceAllowed`, admins: all) that has a
  `midScheme`.
- **Value**: ascending, de-duplicated MIDs `m` where some inventory guest on that host has
  `vmid = midScheme.vmidBase + m` and `1 <= m <= 254`.
- **Source**: the full in-memory inventory, never the caller's filtered view.
- **Never contains**: guest names, VMIDs, IPs, or any host the caller can't see.

## Guest visibility predicate

`canSeeGuest?: (guestName: string) => boolean` on `OperationDeps`.

- Set only by the web provisioning routes, from the caller's groups at request time.
- Absent for CLI and MCP (full operator trust).
- Consumed only by `checkVmidAvailable` to decide whether its error names the occupying guest.
