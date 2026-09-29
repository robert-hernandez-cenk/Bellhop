# Feature Specification: MCP Tools for VPN Gateway Runtime Controls

**Feature Branch**: `issue-7-mcp-vpn-gateway-tools`

**Created**: 2026-09-29

**Status**: Draft

**Input**: Issue #7: "Expose the VPN gateway proxy routes (status, servers, cities, groups, connect) as MCP tools, through the shared operations layer so the web UI and the MCP server keep behaving identically for the same action."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Check a VPN gateway from an MCP client (Priority: P1)

An operator working with an AI assistant asks "is the NordVPN gateway connected, and where to?". Right now the assistant can see that the gateway exists in inventory but cannot read its live state. With this feature it can ask the gateway directly and get the same answer the Dashboard's gateway card shows: whether it is connected, the requested and resolved country and city, and the other status fields the gateway reports.

**Why this priority**: reading state is the safe, everyday use and the basis for anything else. It is also enough on its own to answer "is my VPN up?".

**Independent Test**: point an MCP client at a gateway that answers status requests, call the status tool with the gateway's name, and confirm the result is the gateway's own status body, identical to what the web UI's status endpoint returns for that gateway.

**Acceptance Scenarios**:

1. **Given** a gateway guest named `nordvpn-example-gw-lxc` with an ip in inventory, **When** the status tool is called with that name, **Then** it returns the gateway's status body unchanged.
2. **Given** a guest name that exists but is not a VPN gateway, **When** the status tool is called with it, **Then** it fails with `Unknown VPN gateway: <name>` and the gateway is never contacted.
3. **Given** a gateway whose inventory entry has no ip, **When** the status tool is called, **Then** it fails with `VPN gateway <name> has no ip in inventory`, which is a different message from the unknown-gateway one.
4. **Given** a gateway that cannot be reached, **When** the status tool is called, **Then** it fails with a message naming the address it tried, the same message the web UI shows.

---

### User Story 2 - Browse where a gateway can connect (Priority: P2)

Before switching servers, the operator (through the assistant) wants the options: which countries the provider offers, which cities in a given country, and, for NordVPN, which server groups (P2P, Double VPN, and so on). These are the three lists the Dashboard's gateway card loads into its dropdowns.

**Why this priority**: without these lists the assistant has to guess valid country, city, and group names before it can connect.

**Independent Test**: call each of the three list tools against a responding gateway and confirm each returns the gateway's list unchanged. The cities tool must pass the requested country through to the gateway.

**Acceptance Scenarios**:

1. **Given** a responding gateway, **When** the servers tool is called, **Then** it returns the gateway's country list unchanged.
2. **Given** a responding gateway, **When** the cities tool is called with country `Germany`, **Then** the gateway is asked for cities in `Germany` and its list is returned unchanged.
3. **Given** a responding gateway, **When** the groups tool is called, **Then** it returns the gateway's group list unchanged.
4. **Given** any of the three list tools and a gateway that is slow on a cold first connection, **When** the tool is called, **Then** it waits as long as the web UI's list requests do before failing.

---

### User Story 3 - Switch a gateway's VPN server from an MCP client (Priority: P3)

The operator asks the assistant to "move the NordVPN gateway to a city in Germany". The assistant connects the gateway to the requested country, city, and optional group, exactly as the Connect button on the Dashboard's gateway card does, and reports what the gateway answered.

**Why this priority**: this is the only action that changes anything. It depends on the lists from Story 2 to be useful, and on status from Story 1 to confirm the result.

**Independent Test**: call the connect tool with a country, city, and group against a gateway, and confirm the gateway receives exactly those three values (empty for any that were omitted) and that its response is returned.

**Acceptance Scenarios**:

1. **Given** a gateway, **When** connect is called with country `Germany`, city `Berlin`, and group `P2P`, **Then** the gateway receives a connect request carrying those three values and the tool returns the gateway's response.
2. **Given** a gateway, **When** connect is called with only a country, **Then** the gateway receives that country with an empty city and group, matching what the web UI sends for the same choice.
3. **Given** connect is called, **Then** it takes effect immediately with no preview step and no background job, the same as the Dashboard's Connect button.

---

### Edge Cases

- The gateway answers but reports an error (a non-success response). The tool fails, and the web UI still gets its existing error status with the gateway's body passed through.
- The gateway returns something that is not valid JSON. The result is an empty object, the same as today's web behavior, rather than a crash.
- The cities tool is called with no country. The gateway is asked with an empty country, the same as the web UI's request today.
- Inventory changes while the MCP server is running (a gateway is renamed, redeployed, or given a new ip). Each tool call sees the current inventory, the same way every other MCP tool reloads it before running.
- A restricted web UI user asks for a gateway they are blocked from. The web UI still refuses (403). The MCP tools have no such restriction because they run with the local operator's full trust.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The MCP server MUST offer five gateway tools: read a gateway's status, list its countries, list its cities for a given country, list its server groups, and connect it to a country, city, and group.
- **FR-002**: Each tool MUST identify the gateway by its inventory guest name, and MUST accept only guests marked as VPN gateways.
- **FR-003**: The web UI's gateway endpoints and the MCP tools MUST share one implementation of gateway lookup, of the request sent to the gateway, and of failure classification, so the same gateway and inputs produce the same request and the same outcome from either front end.
- **FR-004**: The web UI's gateway endpoints MUST keep their current behavior exactly: the same paths, the same per-gateway permission check, the same success passthrough, the same "not found" responses for an unknown gateway or a gateway with no ip, and the same "bad gateway" response carrying the gateway's own body (or a reachability message) when the gateway fails.
- **FR-005**: A successful tool call MUST return the gateway's response body unchanged.
- **FR-006**: A failed tool call MUST come back as a tool error whose message matches what the web UI reports for the same failure: the unknown-gateway message, the no-ip message, the reachability message naming the gateway address, or, when the gateway itself returns an error, the error message in its body.
- **FR-007**: Status requests MUST keep their short wait limit, and the three list requests MUST keep their longer one, the same limits the web UI uses. Connect requests MUST keep having no wait limit.
- **FR-008**: The connect tool MUST send the country, city, and group it was given, and an empty value for any it was not given. It MUST act immediately, with no dry-run step and no background job.
- **FR-009**: Each tool call MUST see the current inventory, reloading it first the same way the existing MCP tools do.
- **FR-010**: The tools' descriptions MUST say what each one does and, for connect, that it switches the gateway immediately and briefly interrupts traffic for guests routed through it.

### Key Entities

- **VPN gateway**: an inventory guest marked as a VPN gateway for a provider (NordVPN or PIA). It has a name and a LAN ip, and runs a small management service that answers status, list, and connect requests.
- **Gateway response**: the gateway's own JSON answer (status, a country/city/group list, or a connect result), passed through to the caller unchanged.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An MCP client can do each of the five things the Dashboard's gateway card does (check status, list countries, list cities, list groups, connect) with one tool call each.
- **SC-002**: For the same gateway, inputs, and gateway answer, the MCP tool result equals the web UI endpoint's response body in 100% of the tested cases, success and failure alike.
- **SC-003**: Every existing web UI gateway test passes without changes to its expectations.
- **SC-004**: An operator can switch a gateway's server from an MCP client without opening the web UI.

## Assumptions

- Connecting a gateway is a runtime control of a running service. It is not a change to infrastructure or to the inventory, so the dry-run-by-default rule for infrastructure changes does not apply. This matches the Dashboard's Connect button, which also acts immediately. Decided with the user during design.
- The MCP server runs with the local operator's full trust, as all of its tools do. Web UI per-resource permissions are not applied to these tools.
- The gateway's management service and its request and response shapes are unchanged by this feature.
- There is no CLI command for these runtime controls, and none is added. The web UI and the MCP server are the two front ends that share this action.
- Choosing which gateway a guest routes through (`set-guest-vpn`) and deploying a gateway (`deploy-vpn-gateway`) are already available in all front ends and are out of scope.
