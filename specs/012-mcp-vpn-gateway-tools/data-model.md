# Data Model: MCP Tools for VPN Gateway Runtime Controls

No stored data changes. The feature reads existing inventory fields and passes the gateway agent's JSON through.

## VPN gateway (inventory guest, read-only)

| Field | Use |
| --- | --- |
| `name` | Identifies the gateway in both front ends |
| `vpnGateway` | Must be set (`nordvpn` or `pia`) for the guest to count as a gateway |
| `ip` | The management API address, `http://<ip>:8080` |

Lookup rules: no guest with that name and `vpnGateway` set gives `Unknown VPN gateway: <name>`. A matching guest with no `ip` gives `VPN gateway <name> has no ip in inventory`.

## GatewayResult (shared return type)

```text
ok: true   -> body: the gateway's JSON, unchanged
ok: false  -> kind: 'not-found' | 'upstream'
              error: message shown to MCP callers (see research R2)
              body:  what the web route returns ({ error } or the gateway's JSON)
```

## Gateway agent payloads (first-party, `vpn-gateway-agent/httpapi`)

- **Status / connect response**: `connected`, `country`, `resolvedCountry`, `city`, `resolvedCity`, `group`, `publicIp`, `server`, `dns`, `since`, `lastHealthCheck`, `lastHealthCheckOk`
- **Connect request**: `{ country, city, group }` (strings, empty when not chosen)
- **Lists**: arrays returned by the provider (`/servers` countries, `/cities?country=`, `/groups`)
- **Error**: `{ error: string }` with 400/404/500/502
