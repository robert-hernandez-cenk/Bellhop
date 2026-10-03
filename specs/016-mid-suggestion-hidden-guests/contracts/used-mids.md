# Contract: `GET /api/provisioning/used-mids`

Authenticated like every `/api` route (global `requireAuth`). Not admin-gated.

## Response 200

```json
{
  "usedMids": {
    "pve1": [2, 3, 7],
    "pve2": []
  }
}
```

- One key per host the caller may see that has a `midScheme`. A visible host with no guests
  in range maps to `[]`.
- Hosts the caller may not see, and hosts without a `midScheme`, are absent.
- Values are MIDs (1-254), ascending, unique. Guests the caller cannot see are counted.
- No other fields.

## Errors

None specific; an unexpected failure is a 500 with `{ "error": "<message>" }`.

## Change to existing behavior: VMID-in-use error (web preview/apply)

For install-app and migrate-guest, when the VMID is already taken by an inventory guest the
caller cannot see, the 400 (preview/apply) or job error reads:

```text
VMID 4002 on 'pve1' is already in use -- choose a different --mid
```

The `by '<guest>'` part appears only when the caller can see that guest. CLI and MCP always
include it, as before.
