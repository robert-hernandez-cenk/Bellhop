# Quickstart: validating the VPN gateway MCP tools

## Automated

```bash
npm run typecheck
npm test
```

Expect:
- `test/web/routes/networking.test.ts` passes with no change to its expectations (SC-003).
- `test/operations/vpn-gateway.test.ts` covers lookup errors, success passthrough, upstream failure classification, timeouts, and the connect body.
- `test/mcp/build-server.test.ts` covers the five tools listing, one success each, and an `isError` result carrying the web's message for unknown, no-ip, unreachable, and gateway-error cases. For the same fake gateway, the tool result equals the web body (SC-002).

## Manual, against a real gateway (read-only first)

1. Start the MCP server from a checkout with a real inventory: `npm run mcp` (or through an MCP client).
2. Call `get_vpn_gateway_status` with a real gateway name. Compare it with the Dashboard gateway card.
3. Call `list_vpn_gateway_servers`, `list_vpn_gateway_cities` (a country from step 2's list), and `list_vpn_gateway_groups` (NordVPN; on PIA, expect the "not supported by this provider" error).
4. Only with the operator's go-ahead: `connect_vpn_gateway` to the gateway's *current* country, so traffic lands where it already was. Then confirm with status.
