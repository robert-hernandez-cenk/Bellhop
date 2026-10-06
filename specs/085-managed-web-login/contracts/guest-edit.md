# Contract: guest edit gains `bellhop`

Applies to the one `edit-guest` operation (`PATCH /api/guests/:name` on the
web, the `edit_guest` MCP tool).

- Field: `bellhop?: boolean`. `true` flags the guest, `false` clears it;
  omitted leaves it unchanged. Only the fields passed change (existing rule).
- Authorization: admin only, like `authMode`/`oidcRedirectUris`. A non-admin
  request containing `bellhop` (changing the value) is 403
  `Only an admin may change which guest is Bellhop itself`. Resending the
  current value is not a change. MCP runs as the local admin, so it is always
  permitted.
- Validation: flagging a second guest is rejected by `validateInventory()`
  with the at-most-one message (400 on the web, error result on MCP), naming
  the other flagged guest. Nothing is saved.
- Effects: saving runs the normal push-live step; additionally the managed web
  login is refreshed after a successful save so the Settings status reflects
  the edit immediately.
- The response guest object includes `bellhop: true` when flagged.

Example request: `{ "bellhop": true }` on the guest `bellhop-lxc`.
