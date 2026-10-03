# Contract: web access behavior (#58)

No new endpoint. Existing responses change only in what a restricted creator
can see and do.

| Surface | Change |
| --- | --- |
| `GET /api/inventory` | A guest whose `creator` is the caller is included despite allow-list rules; guest entries now carry `creator` (`{ uid?, username, since? }`) when recorded. |
| `GET /api/guests/status` | Same inclusion rule. |
| Guest-scoped routes (`requireResourceAccess`, inline `isResourceAllowed`) | Creator passes the allow-list check; explicit block-list still 403s. |
| `GET /api/jobs`, `GET /api/jobs/:id`, cancel / answer / dismiss, `/ws/jobs/:id` | A job whose `target` is a guest the caller created is visible/controllable under the same rule, if it started at or after the creator's `since`; never when the target name is also a host name, and never for a creator without `since`. |
| `PATCH /api/inventory/guests/:name` | A `creator` key in the body is ignored; the stored creator never changes. |
| Any of the above while impersonating | Creator access ignored; exactly the impersonated group's view. |

Identity input: `X-authentik-uid` header (optional) joins the existing
`X-authentik-username`/`-email`/`-groups` headers trusted from the proxy.

MCP: `edit_guest` ignores a `creator` key; `get_inventory` returns `creator`
where recorded. MCP-created guests record no creator.
