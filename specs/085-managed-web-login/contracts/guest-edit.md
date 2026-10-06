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
- Lockout guard: while webUiAuthMode is oidc and the complete custom web login
  set is not in effect, an edit that stops the flagged guest qualifying
  (unflag, auth group removed, no `/auth/callback` URL, flag moved to a guest
  that cannot serve) is rejected (400 / error result): `Refusing this edit:
  webUiAuthMode is oidc and Bellhop's own guest is the only configured web
  login, so nobody could sign in afterwards (<reason>). Set webUiAuthMode to
  none first, or fill in the Web login settings`. Nothing is saved.
- Effects: saving runs the normal push-live step; additionally the managed web
  login is refreshed after a successful save (unless all four custom values
  are set) so MCP and the Settings status reflect the edit immediately.
- The response guest object includes `bellhop: true` when flagged.

Example request: `{ "bellhop": true }` on the guest `bellhop-lxc`.
