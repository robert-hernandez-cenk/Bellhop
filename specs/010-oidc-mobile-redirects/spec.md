# Feature Specification: OIDC mobile-app redirect URIs, a mobile consent step, and an Access tab

**Feature Branch**: `issue-22-oidc-mobile-redirects`

**Created**: 2026-09-29

**Status**: Draft

**Input**: GitHub issue #22 — "OIDC: mobile-app redirect URIs with a consent step for app hand-offs, and an Access tab for auth settings"

## Background

Apps with a native mobile client often sign in through the phone's browser and are then handed back to the app. The hand-off happens in one of two ways: Authentik redirects straight to a custom-scheme callback (for example `app.example:///oauth-callback`), or it redirects to an `https://` page on the app's own server (for example `https://books.example.com/auth/openid/mobile-redirect`) that then opens the app. Bellhop has three problems with this today:

1. **A custom-scheme callback can't be entered.** An entry's callback URL list accepts only `http://` and `https://` addresses. Because `sync-authentik` reconciles the OpenID client's callback list as an exact set, a custom-scheme URI added by hand in Authentik is removed again by the next sync.
2. **Mobile logins often stall even when the callback is right.** On Android, the in-app browser tab can refuse to open an app from a redirect chain that had no user gesture in it. With an existing Authentik session, the default authorization flow is nothing but automatic redirects, so the tab sits on a blank Authentik page. One click (a consent page) before the hand-off fixes it, but it must apply to mobile hand-offs only, or every browser login gets an extra click.
3. **The guest Advanced dialog is crowded, mostly by auth.** It has 13 rows, 5 of them about auth, and some of those mean something in only one auth mode. This feature would add a sixth.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Register a mobile app's callback on an OIDC entry (Priority: P1)

An operator gates an app (for example an audiobook server) in OIDC mode and wants its Android app to sign in. They add the app's mobile callback — a custom-scheme URI or the server's `mobile-redirect` page — to a separate "mobile app redirect URLs" list on the entry. The next sync adds it to the app's OpenID client in Authentik alongside the web callbacks, and keeps it there.

**Why this priority**: Without the callback registered, the mobile sign-in fails outright. Everything else in this feature builds on this list.

**Independent Test**: Set a mobile redirect URL on an OIDC-mode entry through the Dashboard or the MCP `edit_guest` tool, run `sync-authentik`, and confirm the OpenID client's allowed callbacks are exactly the web list plus the mobile list — and that a second run reports no drift.

**Acceptance Scenarios**:

1. **Given** an OIDC-mode guest with web callback `https://books.example.com/auth/openid/callback`, **When** an admin adds mobile redirect `app.example:///oauth-callback` and the sync runs, **Then** the OpenID client allows both URIs, each matched exactly.
2. **Given** that state, **When** `sync-authentik` runs again with nothing changed, **Then** it reports no change to the client.
3. **Given** a URI listed in both the web and the mobile list of the same entry, **When** the edit is saved, **Then** it is refused with a message naming the duplicated URI.
4. **Given** a mobile redirect starting with `javascript:`, `data:`, `file:` or `vbscript:` (any letter case), **When** the edit is saved, **Then** it is refused with a message naming the rejected scheme.
5. **Given** an inventory saved before this feature, **When** it is loaded, **Then** it loads unchanged and every entry has no mobile redirect list.
6. **Given** a `hosts.yaml`-shaped file with `oidcMobileRedirectUris` on a host, guest or external site, **When** it is imported, **Then** the list round-trips into the inventory unchanged.

---

### User Story 2 - Mobile hand-offs get one consent click; browser logins do not (Priority: P2)

Once any OIDC entry has a mobile redirect URL, `sync-authentik` adds a consent step to the shared authorization flow that shows only when the login is being handed back to one of those exact mobile URLs. A phone sign-in shows one "Continue" page and then opens the app. A browser sign-in to the same app is still fully automatic.

**Why this priority**: It makes Story 1 actually work on Android. It is separable: without it, mobile sign-in works when the phone's browser permits the redirect and stalls otherwise.

**Independent Test**: Add a first mobile URL and run `sync-authentik` as a dry run, then with `--apply`. Confirm the preview lists the consent stage, its flow binding, the policy, and the policy's binding. Confirm apply creates them with the expected settings, and that the policy expression allows exactly the configured mobile URLs. Then remove the last mobile URL and confirm the next apply removes all of them.

**Acceptance Scenarios**:

1. **Given** no mobile redirect URLs anywhere in the inventory, **When** `sync-authentik` runs, **Then** nothing is added to the authorization flow.
2. **Given** the first mobile redirect URL is added to an OIDC-mode entry, **When** `sync-authentik --apply` runs, **Then** the consent stage, its binding to the authorization flow, the consent policy, and the policy's binding to that stage binding are created. The dry run before it lists exactly these.
3. **Given** the consent step exists, **When** a mobile URL is added, changed or removed (and at least one remains), **Then** the next apply updates only the policy's list of allowed URLs.
4. **Given** the consent step exists, **When** the last mobile URL is removed (or its entry leaves OIDC mode), **Then** the next apply removes the policy binding, the stage binding, the policy and the stage.
5. **Given** an object with one of Bellhop's reserved names that Bellhop didn't create, **When** `sync-authentik` runs, **Then** that object is reported as a conflict and left untouched, and the rest of the sync still completes.
6. **Given** a mobile hand-off login against real Authentik with an existing session, **When** the phone signs in, **Then** a consent page appears once and the app opens after "Continue". **Given** a browser login to the same app, **Then** no consent page appears.

---

### User Story 3 - Auth settings in their own tab, showing only what applies (Priority: P3)

The guest Advanced dialog gets two tabs: **General** (type, ip, host, vmid, subdomains, port, read-only proxy, insecure backend TLS, VPN, app) and **Access**. The Access tab shows auth group and auth mode, plus only the fields that mean something in the selected mode:

| Field | Forward-auth | OIDC |
|---|---|---|
| auth group | shown | shown |
| auth mode | shown | shown |
| unauthenticated paths | shown | hidden |
| web callback URLs | hidden | shown |
| mobile app redirect URLs | hidden | shown |
| OIDC client (issuer, client ID, secret location) | hidden | shown |
| Authentik sync/conflict banners | shown | shown |

**Why this priority**: It is a presentation improvement. Stories 1 and 2 work without it, but it makes room for the new field and stops showing settings that do nothing in the current mode.

**Independent Test**: Open the Advanced dialog for a forward-mode guest and an OIDC-mode guest, at desktop width and at 640px or narrower. Confirm the tab contents match the table above. Switch a guest's mode back and forth and confirm the hidden fields' values are still there when they reappear.

**Acceptance Scenarios**:

1. **Given** a guest with no auth mode set, **When** the Access tab is opened, **Then** it shows the forward-auth fields.
2. **Given** a guest in OIDC mode with unauthenticated paths saved from earlier, **When** the Access tab is opened, **Then** unauthenticated paths are not shown, and switching back to forward mode shows them with their saved values.
3. **Given** the mobile app redirect URLs field, **When** it is shown, **Then** one line of help says when to use it and that it adds a consent click to mobile sign-ins only.
4. **Given** a viewport 640px wide or narrower, **When** either tab is shown, **Then** the tabs and every field fit with no horizontal scrolling.

---

### Edge Cases

- **Mobile URL on a non-OIDC entry**: an entry in forward mode (or ungated) may keep a saved mobile list, the same way `oidcRedirectUris` is kept inert. It contributes nothing to any OpenID client and nothing to the consent policy.
- **The same mobile URL on two entries**: allowed. The consent policy's list holds it once.
- **An OIDC entry with mobile URLs but no web callback URLs**: the edit is still refused as incomplete, exactly as today (web callbacks stay required for OIDC mode). An entry in that state reached another way (YAML import, a hand-edited row) is skipped by the client sync as today, but its mobile URLs still count toward the consent policy (FR-011). That's harmless, since a URI with no client behind it can never be the redirect URI of a real login.
- **Special characters in a mobile URL** (quotes, backslashes, non-ASCII): the rendered policy must match the URL exactly and must never be broken or altered by it.
- **The authorization flow can't be found**: the consent step is reported as failed with the flow's slug and the setting that names it. OpenID client and forward-auth reconciliation still complete.
- **A same-named consent stage that isn't a consent stage, or a same-named policy without Bellhop's marker**: reported as a conflict, never modified or deleted.
- **Partial failure mid-reconcile** (for example the stage is created but its binding fails): the next run completes the missing pieces rather than creating duplicates.
- **A pre-existing hand-made consent stage and policy on the same flow** (under different names): left alone. The operator removes them by hand once Bellhop's copy is in place, or mobile logins show two consent pages.
- **Stale cached flow plans**: after the consent step's binding changes, cached flow plans are cleared so the next login uses the new configuration.

## Requirements *(mandatory)*

### Functional Requirements

**Mobile redirect list**

- **FR-001**: Hosts, guests and external sites MUST accept an optional ordered list of mobile app redirect URIs (`oidcMobileRedirectUris`), stored alongside `oidcRedirectUris` and preserved across every inventory write, including `sync-inventory`.
- **FR-002**: Each mobile redirect URI MUST be an absolute URI with a scheme. Custom schemes MUST be accepted. The `javascript:`, `data:`, `file:` and `vbscript:` schemes MUST be rejected regardless of letter case, with a message naming the rejected value.
- **FR-003**: A URI MUST NOT appear in both the web list and the mobile list of the same entry. This rule MUST be enforced wherever an entry's OIDC configuration is validated on edit — the Dashboard guest edit and the MCP `edit_guest` tool, through the one shared edit path. It MUST NOT be enforced on inventory load, so a saved inventory always loads.
- **FR-004**: The web callback list MUST keep its current rules unchanged (http(s) only; required for an OIDC-mode entry with subdomains). The mobile list MUST be optional in every mode.
- **FR-005**: An inventory saved before this feature MUST load unchanged, with no mobile list on any entry.
- **FR-006**: The mobile list MUST be editable through the Dashboard's guest edit (admin-only in both directions, the same rule as web callback URLs), the MCP `edit_guest` tool (no admin check, matching its existing trust level), and YAML import (`import-yaml-inventory`) for all three entry types. No new CLI edit command is added.
- **FR-007**: For each Bellhop-owned OpenID client, `sync-authentik` MUST set the allowed callbacks to the entry's web list plus its mobile list: deduplicated, web list first, every URI matched exactly. Drift detection, the dry-run preview and `adopt-oidc-client` MUST cover both lists.
- **FR-008**: A change to only the mobile list MUST be reported as callback-list drift on the OpenID client, the same as a web-list change. It MUST never rotate the client's credentials.

**Mobile consent step**

- **FR-009**: When at least one mobile redirect URI is in effect, `sync-authentik` MUST ensure these four objects exist on the authorization flow named by `AUTHENTIK_AUTHORIZATION_FLOW_SLUG`:
  - a consent stage named `bellhop-mobile-app-consent` that always requires consent;
  - a binding of that stage to the flow whose policies are evaluated at the moment the stage is reached, never when the flow plan is built (and so never taken from a cached plan);
  - an expression policy named `bellhop-consent-on-mobile-redirect`;
  - a binding of that policy to the stage binding.
- **FR-010**: The policy MUST pass only when the current login's redirect URI exactly matches one of the mobile URIs in effect. Any error while it is evaluated MUST mean "no consent page" (today's behavior), never a blocked login.
- **FR-011**: The mobile URIs in effect MUST be the union, without duplicates, of the mobile lists of every entry that `sync-authentik` treats as an OIDC-mode candidate. A mobile list on a forward-mode or ungated entry MUST NOT contribute.
- **FR-012**: When the set of mobile URIs in effect changes, the next apply MUST update the policy so it allows exactly the new set. When the set is empty, the next apply MUST remove the policy binding, the stage binding, the policy and the stage — leaving nothing of Bellhop's on the flow.
- **FR-013**: The policy MUST carry a Bellhop marker. Bellhop MUST treat the policy as its own only when the marker is present, and the stage as its own only when it is a consent stage. A same-named object Bellhop does not own MUST be reported as a conflict and left untouched.
- **FR-014**: Bellhop MUST repair drift on objects it owns: the stage's consent mode, the stage binding's evaluation settings, and the policy's expression.
- **FR-015**: After any change to the stage binding or the policy on apply, Bellhop MUST clear Authentik's cached flow plans so the next login uses the new configuration.
- **FR-016**: The dry run MUST list every consent-step change `--apply` would make: created, updated (with which setting), removed, and conflicts. Apply MUST make exactly those changes.
- **FR-017**: A consent-step failure (the flow not found, an API error) MUST be reported with what failed and how to fix it. It MUST NOT stop OpenID client, forward-auth, binding or outpost reconciliation in the same run. On `--apply` it MUST make the CLI exit non-zero. A conflict alone MUST NOT.
- **FR-018**: The Dashboard's push-live sync (run after a guest edit) MUST surface consent-step conflicts and failures as warnings in the job log and service log. It MUST NOT fail the save.

**Access tab**

- **FR-019**: The guest Advanced dialog MUST present two tabs, General and Access, holding the fields listed in User Story 3. General is selected when the dialog opens.
- **FR-020**: The Access tab MUST show the fields for the entry's current auth mode (unset means forward-auth) per the table in User Story 3. A field for the other mode MUST be hidden, not disabled, and its saved value MUST be kept.
- **FR-021**: The mobile app redirect URLs field MUST show one line of help text: use it for a native app's sign-in callback, and it adds a consent click to mobile sign-ins only.
- **FR-022**: Both tabs MUST work at desktop width and at 640px or narrower, with no horizontal page scroll.

**Documentation**

- **FR-023**: README's "OIDC mode" section and the `sync-authentik` part of `CLAUDE.md` MUST describe the mobile list, the consent step (names, ownership, removal, cache clearing, and the extra Authentik token permissions it needs), and the Access tab. `inventory/hosts.yaml.example` MUST show the new field.

### Key Entities

- **Mobile redirect list**: an optional ordered list of absolute URIs on a host, guest or external site. Inert unless the entry is in OIDC mode.
- **OpenID client callback set**: the exact set of callback URIs Authentik allows for an entry's client — its web list plus its mobile list.
- **Mobile consent step**: four Authentik objects Bellhop owns on the shared authorization flow — the consent stage, its flow binding, the consent policy, and the policy's binding. They exist only while at least one mobile URI is in effect.
- **Mobile URI set**: the deduplicated union of every OIDC-mode candidate's mobile list. It is the only input to the consent policy.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An operator can register a native app's custom-scheme callback on an OIDC entry, and it survives any number of later syncs (zero manual re-adds).
- **SC-002**: A phone sign-in with an existing session to an app with a registered mobile URL completes with exactly one consent click, and a browser sign-in to the same app completes with zero.
- **SC-003**: With no mobile URLs anywhere, a sync leaves the authorization flow byte-for-byte as it was: zero Bellhop objects on it.
- **SC-004**: Removing the last mobile URL and running one apply leaves zero Bellhop consent objects in Authentik.
- **SC-005**: A second consecutive sync with no inventory change reports zero changes, both for OpenID clients and for the consent step.
- **SC-006**: The Access tab never shows a field that has no effect in the entry's selected auth mode: at most 3 auth fields in forward mode and at most 5 in OIDC mode. Today 5 are always shown, and this feature would have made it 6.

## Assumptions

- The authorization flow Bellhop adds the consent step to is the same one it already assigns to every provider it creates (`AUTHENTIK_AUTHORIZATION_FLOW_SLUG`, default `default-provider-authorization-implicit-consent`). The flow is shared with proxy providers; that's harmless, because only exact mobile URIs match.
- The login's OAuth parameters, including its redirect URI, are available to a policy evaluated when the stage is reached, under Authentik's `goauthentik.io/providers/oauth2/params` plan-context key. This was established in the issue from Authentik's source, and is confirmed by the operator's own hand-made policy on the live flow reading the same key.
- The Authentik API token already used by `sync-authentik` can be granted permission to manage consent stages, flow-stage bindings, expression policies and policy bindings, and to clear the flow cache. README lists these as extra permissions needed once any mobile URL is set.
- Bellhop picks a fixed stage order within the flow (10, matching Authentik's own stock explicit-consent flow). It does not coordinate with other stages an operator binds by hand.
- Hosts and external sites have no web editing surface today; they stay YAML/DB-only. The Access grouping applies to the guest dialog only.
- The operator's existing hand-made consent stage and policy (different names) are not migrated or removed by Bellhop.
