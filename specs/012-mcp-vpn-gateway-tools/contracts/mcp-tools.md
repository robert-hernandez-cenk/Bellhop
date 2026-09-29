# Contract: VPN gateway MCP tools

Every tool reloads inventory first. On success it returns the gateway's JSON body as a JSON text result. On failure it returns an `isError` result whose text is the `GatewayResult.error` message (research R2).

| Tool | Inputs | Gateway request | Timeout |
| --- | --- | --- | --- |
| `get_vpn_gateway_status` | `name: string` | `GET /status` | 5s |
| `list_vpn_gateway_servers` | `name: string` | `GET /servers` | 15s |
| `list_vpn_gateway_cities` | `name: string`, `country?: string` (default `''`) | `GET /cities?country=<encoded>` | 15s |
| `list_vpn_gateway_groups` | `name: string` | `GET /groups` | 15s |
| `connect_vpn_gateway` | `name: string`, `country?`, `city?`, `group?` (each default `''`) | `POST /connect` with JSON `{country, city, group}` | none |

`connect_vpn_gateway` acts immediately. Its description says it switches the gateway's VPN server right away and briefly interrupts traffic for every guest routed through that gateway.

# Contract: web routes (unchanged)

`/api/networking/gateways/:name/{status,servers,cities,groups}` (GET) and `/connect` (POST), each behind `requireResourceAccess` (guest `:name`):

- success: 200 with the gateway body
- `not-found`: 404 `{ error }`
- `upstream`: 502 with the gateway body, or `{ error: "Failed to reach gateway at <ip>:8080 -- <msg>" }`
