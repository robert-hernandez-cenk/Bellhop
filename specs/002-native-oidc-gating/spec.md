# Feature Specification: Native OIDC Gating as an Alternative to Forward-Auth

**Feature Branch**: `issue-1-native-oidc-gating`

**Created**: 2026-09-24

**Status**: Draft

**Input**: User description: "#1 — Dashboard: gate an app with native Authentik OIDC, as an advanced alternative to forward-auth. Add an opt-in per-entry auth mode (`forward` default, `oidc` opt-in); in `oidc` mode the Authentik sync creates an OAuth2/OpenID provider instead of a Proxy provider, binds it with the same group-ladder rule, Caddy emits a plain reverse proxy with no forward-auth, and the Dashboard shows the issuer, client ID and client secret for the operator to paste into the app."

## Clarifications

### Session 2026-09-24

- Q: Who may change an entry's auth mode and callback address, and reveal its client secret? → A: Admin only for all three; non-admins with access can see that an entry is in OIDC mode, nothing more.
- Q: Besides the Dashboard, which front ends may surface an OIDC entry's issuer, client ID, and client secret? → A: Dashboard and a CLI command show all three; the MCP server shows issuer and client ID only, never the secret.
- Q: What happens when an OIDC-mode entry's address already has a hand-made OpenID client? → A: Conflict by default; the operator can adopt it with an explicit, per-entry, one-time action, after which the sync manages it and keeps its client ID and secret.
- Q: Should a Dashboard save that deletes a Bellhop-created OpenID client ask for confirmation? → A: Yes; the Dashboard confirms first, naming the app and saying its OIDC login stops working until new credentials are entered.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Gate an OIDC-capable app through its own login (Priority: P1)

An operator runs an app that has its own user accounts and roles and can sign users in with OpenID Connect. Today the only gate Bellhop offers is forward-auth, which either makes users log in twice or hides every user behind one shared session the app cannot tell apart. The operator marks the app's entry as OIDC-gated at an access tier, supplies the app's callback address, and runs the sync. Bellhop creates a working OpenID client in Authentik, restricted to the same groups forward-auth would have allowed, and stops putting forward-auth in front of the app.

**Why this priority**: This is the feature. Without it, native OIDC stays a fully manual job with several non-obvious failure modes (a client that permits no sign-in flow, tokens with no identity in them) that look correct until a real login fails.

**Independent Test**: Against a test inventory and a recorded Authentik, mark one gated entry as OIDC with a callback address and run the sync as a dry run, then apply. Confirm the preview names the OpenID client to be created, apply creates exactly that, the generated reverse-proxy config for the entry has no forward-auth, and the entry's Authentik access is bound to its rung and every rung above it.

**Acceptance Scenarios**:

1. **Given** an entry gated at `bellhop-app-users` in OIDC mode with callback `https://media.example.com/auth/callback`, **When** the operator runs the Authentik sync dry run, **Then** the output names an OpenID client and Application to be created for that entry, bound to `bellhop-app-users`, `bellhop-users`, and `authentik Admins`, and nothing is changed.
2. **Given** the same entry, **When** the operator applies the sync, **Then** an OpenID client exists in Authentik that allows the authorization-code sign-in flow, signs its identity tokens, releases the user's identity, profile, and email, accepts exactly the configured callback address, and is attached to an Application restricted to the same groups as the dry run.
3. **Given** the same entry after apply, **When** the operator regenerates the reverse-proxy config, **Then** the entry's site block proxies straight to the app with no forward-auth check and no outpost passthrough.
4. **Given** the sync has been applied, **When** it finishes, **Then** it checks that the provider's OpenID discovery document resolves and reports the result per entry.
5. **Given** the sync has been applied and nothing changed since, **When** the operator runs it again, **Then** it reports no changes, and the client ID and client secret are the same as before.

---

### User Story 2 - Hand the client credentials to the app (Priority: P1)

After the sync, the operator must paste the issuer address, client ID, and client secret into the app's own settings. They open the entry on the Dashboard, reveal the credentials, and copy each one with a single click.

**Why this priority**: The OpenID client is useless until the app is configured with it, and the credentials live only in Authentik. Without this, the operator still has to go dig through the Authentik admin UI, which is most of the manual work the feature is meant to remove.

**Independent Test**: With an OIDC-gated entry whose client exists in a recorded Authentik, open the entry's advanced settings as an admin, reveal the credentials, and confirm the issuer, client ID, and client secret shown match Authentik's, and that each has a working copy control.

**Acceptance Scenarios**:

1. **Given** an OIDC-gated entry whose client exists in Authentik, **When** an admin opens the entry's advanced settings and reveals the credentials, **Then** the issuer address, client ID, and client secret are shown, each with a copy control, read fresh from Authentik at that moment.
2. **Given** an OIDC-gated entry whose client has not been created yet (the sync has not run), **When** an admin opens the credentials, **Then** the page says the client does not exist yet and that the Authentik sync creates it, instead of showing empty values.
3. **Given** a non-admin user with access to the entry, **When** they open the entry's advanced settings, **Then** they can see that the entry uses OIDC mode but cannot reveal the client secret.
4. **Given** Authentik is not configured or unreachable, **When** an admin tries to reveal the credentials, **Then** the page shows an error saying Authentik could not be reached, and the entry's other settings still work.

---

### User Story 3 - Switch an existing app between forward-auth and OIDC (Priority: P2)

An operator has an app already gated with forward-auth and wants to move it to native OIDC, or moves an OIDC app back to forward-auth. They change the entry's mode, and the next sync replaces one kind of Authentik client with the other so the app is never gated both ways at once and no leftover client stays behind.

**Why this priority**: Most apps that would use OIDC are already gated with forward-auth, so a clean switch is how the feature gets adopted. It is second because a new entry (Story 1) delivers value without it.

**Independent Test**: With an entry gated by forward-auth in a recorded Authentik, switch its mode to OIDC and run the sync dry run and apply. Confirm the proxy client is removed from Authentik and from the outpost, an OpenID client takes its place under the same Application address, and the preview says so before anything changes. Then switch back and confirm the reverse.

**Acceptance Scenarios**:

1. **Given** an entry gated with forward-auth whose proxy client Bellhop created, **When** the operator switches it to OIDC mode and applies the sync, **Then** the proxy client is removed from Authentik and from the outpost, an OpenID client is created, and the Application keeps the same address and group bindings.
2. **Given** an OIDC-mode entry, **When** the operator switches it back to forward-auth and applies the sync, **Then** the OpenID client is deleted, a proxy client is created and added to the outpost, and the dry run warns that the app's existing OIDC login configuration will stop working.
3. **Given** an OIDC-mode entry, **When** the operator clears its access tier entirely and applies the sync, **Then** the OpenID client and Application are deleted, the same way a forward-auth entry's are today.
4. **Given** an OIDC-mode entry whose OpenID client Bellhop created, **When** an admin switches it to forward-auth or clears its tier on the Dashboard and saves, **Then** a confirmation names the app and warns its OIDC login will stop working; cancelling leaves the entry and its client unchanged, and confirming saves and pushes the change live.
5. **Given** either switch, **When** the operator previews the reverse-proxy config, **Then** the entry is never shown with forward-auth while in OIDC mode, or without it while in forward-auth mode.

---

### User Story 4 - Never disturb an OIDC client Bellhop did not create (Priority: P2)

An operator already configured an OIDC client by hand for some app, under the same address an inventory entry uses. The sync must leave that client alone and say why the entry was skipped, rather than overwriting, adopting, or deleting it. If the operator wants Bellhop to take that client over, they adopt it explicitly, and the app keeps its existing client ID and secret.

**Why this priority**: The sync's ownership rule today exists because a previous version touched Authentik objects it should not have. Creating OpenID clients widens what the sync touches, so the rule must be extended, not relaxed.

**Independent Test**: In a recorded Authentik, place a hand-made OpenID client and Application under an inventory entry's address. Run the sync with that entry in OIDC mode, then in forward-auth mode, then ungated. Confirm the hand-made objects are unchanged in every case and the entry is reported as a conflict.

**Acceptance Scenarios**:

1. **Given** a hand-made OpenID Application at an inventory entry's address, **When** the entry is set to OIDC mode and the sync is applied, **Then** the hand-made Application and client are unchanged, and the entry is reported as a conflict naming the address.
2. **Given** the same hand-made Application, **When** the entry is ungated or in forward-auth mode, **Then** the sync neither deletes nor modifies it.
3. **Given** an OpenID client that Bellhop did create, **When** its entry's gate is cleared, **Then** the sync deletes it.
4. **Given** a hand-made OpenID Application and client at an OIDC-mode entry's address, **When** an admin previews the adopt action for that entry, **Then** the preview lists every setting the sync would change on the client and its bindings, and nothing changes.
5. **Given** the same entry, **When** an admin applies the adopt action and then runs the sync, **Then** the client is managed like one Bellhop created (settings and bindings reconciled, deleted if the gate is later cleared), and its client ID and client secret are unchanged, so the app's existing login keeps working.

---

### Edge Cases

- **OIDC mode with no access tier**: the mode is inert. The entry is ungated, gets a plain reverse proxy, and no Authentik client is created. This matches how path exemptions are inert on an ungated entry.
- **OIDC mode with no callback address**: the entry is not usable. The sync skips it and reports the missing callback address naming the field that sets it. Saving an entry in OIDC mode with an access tier and no callback address is rejected with the same message.
- **Callback address that is not a valid absolute `https://` or `http://` URL**: rejected when saved, in every front end, with the same rule.
- **Path exemptions on an OIDC-mode entry**: inert, since there is no forward-auth check to exempt paths from. The Dashboard says so rather than silently ignoring them.
- **Hand-authored Caddy entry in OIDC mode**: the reverse-proxy generator skips it as it does today; the Authentik sync still reconciles its OpenID client, matching today's rule that a hand-authored Caddy entry is still managed on the Authentik side.
- **No signing key available in Authentik**: the sync fails that entry with an error naming what to create or configure, rather than creating a client whose identity tokens cannot be verified.
- **Discovery document does not resolve after apply**: reported as a failure for that entry with the address it tried. The created client is not rolled back.
- **Callback address changed**: the next sync updates the existing client's accepted callback in place; the client ID and secret do not change.
- **Access tier changed on an OIDC entry**: group bindings are reconciled the same way as for forward-auth; the client ID and secret do not change.
- **Access tier names a group absent from the ladder, or a rung that does not exist in Authentik**: reported the same way as for forward-auth entries today; no special OIDC behavior.
- **Subdomain renamed on an OIDC entry**: the same limitation as forward-auth today. The old client falls outside the sync's ownership rule and is left for the operator to delete by hand; this is documented, not fixed.
- **Existing entries after upgrade**: every entry that existed before this feature is in forward-auth mode, and its generated config and Authentik objects are unchanged.

## Requirements *(mandatory)*

### Functional Requirements

**Inventory**

- **FR-001**: Each host, guest, and external site MUST be able to carry an optional auth mode of either forward-auth or OIDC. An entry with no mode set MUST behave exactly as forward-auth does today.
- **FR-002**: Each entry MUST be able to carry an optional callback address, stored as one or more full URLs. It MUST be required when the entry is in OIDC mode and has an access tier, and MUST be ignored otherwise.
- **FR-003**: The auth mode and callback address MUST be validated by the same rule in every place they can be set, and an invalid value MUST be rejected with a message naming the field and the fix.
- **FR-004**: The inventory MUST NOT store the client secret or any other credential produced by this feature.

**Authentik sync**

- **FR-005**: For a gated entry in OIDC mode, the Authentik sync MUST create or maintain an OpenID client and an Application at the entry's canonical address, in place of the proxy client it creates for forward-auth.
- **FR-006**: The OpenID client MUST be confidential, MUST explicitly permit the authorization-code sign-in flow, MUST sign its identity tokens with a signing key, MUST release the `openid`, `profile`, and `email` scopes, and MUST accept exactly the entry's configured callback addresses.
- **FR-007**: The Application's group bindings MUST follow the existing ladder rule unchanged: the entry's rung and every rung above it, with the same handling of missing rungs, off-ladder groups, and hand-added bindings as forward-auth entries.
- **FR-008**: An OIDC-mode entry MUST NOT be added to the forward-auth outpost.
- **FR-009**: Repeated sync runs with no inventory change MUST report no changes and MUST NOT rotate the client ID or client secret. A change to the callback address or access tier MUST be applied in place without rotating them.
- **FR-010**: When an entry's mode changes, the sync MUST remove the client of the old kind (including outpost membership, for a proxy client) and create the client of the new kind, so an entry is never backed by both.
- **FR-011**: The sync MUST only create, modify, or delete an OpenID client or Application that it can identify as having been created by Bellhop. Any other OpenID client or Application at an inventory address MUST be left unchanged and the entry reported in the existing conflicts list, with a pointer to the adopt action.
- **FR-011a**: An admin MUST be able to adopt a hand-made OpenID client and Application at an OIDC-mode entry's address with an explicit, per-entry action. The action MUST default to a dry run listing every setting it would change on the client and its bindings, MUST act only on apply, and MUST be offered as one action with the same rule in the CLI, web UI, and MCP server. After adoption, the client MUST be treated exactly as one Bellhop created, and its client ID and client secret MUST NOT change. Adoption MUST refuse a client that is not an OpenID client, and an entry that is not in OIDC mode with an access tier.
- **FR-012**: When a gated OIDC entry's tier is cleared or the entry is removed, the sync MUST delete its Bellhop-created OpenID client and Application.
- **FR-013**: After applying, the sync MUST fetch each OIDC entry's OpenID discovery document and report per entry whether it resolved. A failure MUST be reported but MUST NOT roll back the change. From the CLI it MUST make the command exit non-zero. When the sync runs as part of saving a Dashboard edit, it MUST be shown to the admin as a warning and MUST NOT fail the save.
- **FR-014**: The dry run MUST show every client, Application, binding, and outpost change that apply would make, and MUST warn when a change will delete an OpenID client, because the app's existing login configuration stops working when it does.
- **FR-015**: If no usable signing key exists, the sync MUST fail the affected entry with an error that says what to configure, and MUST continue with the other entries.

**Reverse-proxy config**

- **FR-016**: The reverse-proxy generator MUST emit a plain reverse proxy for an OIDC-mode entry: no forward-auth check, no outpost passthrough, and no path-exemption matcher. Output for forward-auth entries MUST be unchanged.

**Dashboard and other front ends**

- **FR-017**: A guest's auth mode and callback address MUST be editable in the Dashboard's advanced settings, alongside its access tier and path exemptions. Hosts and external sites remain editable only through the database or CLI, as their access tier is today.
- **FR-018**: Changing an entry's auth mode or callback address MUST be restricted to admins in both directions (including switching back to forward-auth), because switching to OIDC removes the forward-auth gate in front of the app and the callback address decides where Authentik sends sign-in tokens.
- **FR-019**: For an OIDC-mode entry, an admin MUST be able to reveal its issuer address, client ID, and client secret, each with a copy control. The values MUST be read from Authentik when revealed, not from Bellhop's own storage.
- **FR-019a**: A CLI command MUST print an OIDC entry's issuer address, client ID, and client secret, read from Authentik at that moment. It is read-only and needs no `--apply`.
- **FR-019b**: The MCP server MUST be able to report an OIDC entry's issuer address and client ID, and MUST NOT return the client secret by any tool. Where the secret would otherwise be relevant, it MUST say that the secret is available from the Dashboard or the CLI command.
- **FR-020**: Non-admin users MUST NOT be able to retrieve the client secret through any front end, including by impersonation: an admin impersonating a non-admin group sees what that group would see.
- **FR-021**: The client secret MUST NOT appear in job history, logs, the jobs database, or any sync output.
- **FR-022**: The same edit made through the web UI and the MCP server MUST be accepted or rejected by the same rule, and saving an edit MUST push the change live through the same combined sync step existing guest edits use.
- **FR-022a**: An edit that would delete a Bellhop-created OpenID client (switching the entry to forward-auth, or clearing its access tier) MUST be explicitly confirmed before it is saved. The Dashboard MUST show a confirmation naming the app and stating that its OIDC login stops working until new credentials are entered in the app; cancelling leaves the entry unchanged. The MCP server MUST reject the same edit unless it carries an explicit confirmation, with an error saying so. An edit that deletes nothing asks for no confirmation.

**Documentation**

- **FR-023**: The README MUST describe OIDC mode, when to choose it over forward-auth, what the operator must configure in the app, and that linking a first OIDC login to an existing app account is the operator's job (let the first login create an account, then move the identity onto the real one).

### Key Entities

- **Auth mode**: a per-entry choice between forward-auth (the default) and OIDC. Only meaningful when the entry has an access tier.
- **Callback address**: one or more full URLs where Authentik may send a signed-in user back to the app. Operator-supplied, because apps use different callback paths and sometimes different hosts.
- **OpenID client**: the Authentik object that holds the client ID, client secret, allowed sign-in flow, signing key, released scopes, and accepted callback addresses. Created and owned by the sync; its credentials are read from Authentik on demand and never copied into Bellhop's storage.
- **Application**: unchanged from forward-auth. Addressed by the entry's canonical subdomain, bound to the ladder rungs, now backed by either a proxy client or an OpenID client.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An operator can take an OIDC-capable app from ungated to signing users in through Authentik without opening the Authentik admin UI: set mode, tier, and callback on the Dashboard, save, and copy three values into the app.
- **SC-002**: The first real sign-in through an OIDC client created by the sync succeeds without any manual correction to the client in Authentik.
- **SC-003**: 100% of existing inventory entries produce the same reverse-proxy config and the same Authentik objects after the upgrade as before it.
- **SC-004**: Running the sync twice in a row with no inventory change produces no changes on the second run and the same client credentials both times.
- **SC-005**: No OpenID client or Application that Bellhop did not create is modified or deleted by the sync, in any mode combination, unless an admin has adopted it.
- **SC-008**: An app already configured by hand with an OpenID client can be brought under Bellhop without re-entering any credential in the app.
- **SC-006**: The client secret appears in no stored record Bellhop keeps (the inventory, the jobs database, job history, and logs) and in no MCP tool response.
- **SC-007**: No entry is ever served with forward-auth while in OIDC mode, or with a Bellhop-managed OpenID client while in forward-auth mode, after a sync completes.

## Assumptions

- **Client secret is read on demand, never stored.** The issue's own recommendation: Authentik keeps the secret retrievable, so reading it when an admin reveals it keeps secrets out of the inventory database.
- **Credentials and mode changes are admin-only** (confirmed in Clarifications). The web UI already treats widening an app's audience as admin-only. Switching to OIDC removes the forward-auth gate, and the callback address controls where tokens are sent, so both are treated the same way. Revealing the secret is admin-only for the same reason. Unlike access tiers, there is no "narrowing" exception: switching back to forward-auth is also admin-only, because it deletes the OpenID client and breaks the app's configured login.
- **Existing Proxy clients for the same address are replaced, not refused.** When the entry's mode changes and the proxy client is one the sync created, the sync replaces it (Story 3). A client the sync did not create is a conflict and is left alone unless an admin adopts it (Story 4). This answers the issue's open question about a lingering Proxy provider.
- **The callback address is stored as full URLs, not a path.** A path appended to the entry's subdomain breaks for apps that expect a callback on a different host, which the issue calls out.
- **Signing key default**: Authentik's built-in self-signed certificate is an acceptable default, as the issue states. How the sync picks a key when that certificate has been renamed or removed is a planning decision, subject to FR-015.
- **Scopes are fixed**: `openid`, `profile`, and `email`. Per-entry scope selection is out of scope.
- **Out of scope**, as in the issue: changing the default mode for existing entries, dynamic client registration, rotating the client secret from Bellhop, writing the secret into a config file on the guest, and automatic account linking inside the app.
- **Depends on** the existing Authentik API credentials (`data/authentik.env`) and the group ladder from issue #8. Without Authentik configured, OIDC mode is saved but the sync and credential reveal fail with the existing "not configured" error.
