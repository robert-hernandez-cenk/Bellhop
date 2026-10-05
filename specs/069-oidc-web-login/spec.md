# Feature Specification: Web UI login through Bellhop's own OpenID Connect client

**Feature Branch**: `issue-69-oidc-web-login`

**Created**: 2026-10-05

**Status**: Draft

**Input**: Issue #69. The web UI authenticates by trusting the identity headers a reverse proxy adds after Authentik forward-auth. That trust holds only while a firewall rule lets nothing but the proxy reach Bellhop's port, it ties Bellhop's own login to the proxy driver (HAProxy cannot forward-gate, so the web UI has to be hand-routed), and the default `auto` mode silently serves a full-admin local operator when the headers are missing. Replace header trust with Bellhop signing users in itself, as an OpenID Connect client of Authentik.

## User Scenarios & Testing *(mandatory)*

The actors are the **operator** (Bellhop's sole administrator), **web users** (people the operator lets into the web UI, some of them restricted by per-resource permissions), and **Authentik** (the identity provider that holds their accounts and groups).

### User Story 1 - Sign in to the web UI through Authentik (Priority: P1)

A web user opens Bellhop in a browser. With no session, they are sent to Authentik's sign-in page; after signing in there, they land back on the Bellhop page they first asked for, signed in as themselves with their Authentik groups. Their admin rights, per-resource permissions, guest-creator access and job attribution behave exactly as before.

**Why this priority**: this is the replacement for header trust; nothing else in the feature matters without it.

**Independent Test**: with OIDC configured and the mode set to `oidc`, open a deep link (for example the Jobs page) in a fresh browser, complete Authentik sign-in, and confirm the page loads as that user with the right admin status and filtered inventory.

**Acceptance Scenarios**:

1. **Given** mode `oidc` and no session, **When** the browser navigates to any web UI page, **Then** it is redirected to sign in and, after a successful Authentik sign-in, returned to that same page.
2. **Given** mode `oidc` and no session, **When** a client calls any `/api` endpoint, **Then** it receives 401 with no data.
3. **Given** a signed-in user who is in the admin group, **When** they open the Users or Settings page, **Then** they have admin access; a signed-in user outside it gets the same 403s and filtered views a restricted user gets today.
4. **Given** a signed-in user, **When** they create a guest, start a job, or impersonate a group (admin), **Then** the guest's recorded creator, the job's attribution and impersonation work as before, keyed on Authentik's stable user id.
5. **Given** a signed-in user watching a job, **When** the job-log live stream connects, **Then** it is authorized from the same session, and refused without one.
6. **Given** mode `oidc`, **When** a request arrives carrying `X-authentik-*` identity headers but no session, **Then** it is treated as unauthenticated (the headers are ignored).

---

### User Story 2 - Sign out, and sessions that end on their own (Priority: P1)

A signed-in user clicks Sign out and is signed out of Bellhop (and of Authentik, where Authentik supports it). A session that is never signed out ends by itself after a fixed lifetime, so a user the operator removes from a group, or deactivates, loses that access by the next sign-in at the latest.

**Why this priority**: without a way to end sessions, a removed admin would keep their rights indefinitely.

**Independent Test**: sign in, sign out, and confirm the next API call returns 401 and the old session cookie no longer works. Separately, age a session past its lifetime and confirm it is refused.

**Acceptance Scenarios**:

1. **Given** a signed-in user, **When** they click Sign out, **Then** their session is destroyed server-side, the browser's cookie is cleared, and they are sent to Authentik's sign-out page when Authentik advertises one.
2. **Given** a session older than 8 hours, **When** it is presented, **Then** it is refused as if absent and the user must sign in again.
3. **Given** a signed-in user, **When** the Bellhop service restarts, **Then** they are still signed in.

---

### User Story 3 - Configure Bellhop's own sign-in client in one step (Priority: P2)

The operator marks Bellhop's own inventory entry as OIDC-gated with its callback URL, runs the existing Authentik reconcile so Authentik creates the client, then runs one command that reads the client's issuer, id and secret back from Authentik and stores them, together with the callback URL, in Bellhop's settings. They then switch the web UI's mode to `oidc`.

**Why this priority**: sign-in cannot work until the client exists and Bellhop knows its credentials; doing it by hand means copying a secret around.

**Independent Test**: on an inventory whose Bellhop entry is OIDC-gated and reconciled, run the command as a dry run and confirm it prints the four values it would store (the secret only as "set"), then with `--apply` and confirm the settings now hold them.

**Acceptance Scenarios**:

1. **Given** an OIDC-gated entry with a reconciled Authentik client, **When** the operator runs the configure command without `--apply`, **Then** it prints the issuer, client id and callback URL it would store and says the secret would be stored, without printing the secret and without writing anything.
2. **Given** the same, **When** run with `--apply`, **Then** the issuer, client id, callback URL and client secret are stored in the settings store.
3. **Given** an entry that is unknown, not OIDC-gated, has no Authentik client yet, or has no callback URL, **When** the command runs, **Then** it fails with a message naming the problem and stores nothing.
4. **Given** stored OIDC settings, **When** the operator opens the Settings page, **Then** the issuer, client id and callback URL are shown and editable, and the client secret shows only whether it is set.

---

### User Story 4 - Switching modes without locking yourself out (Priority: P2)

The operator switches the web UI from `none` to `oidc` on the Settings page. Bellhop refuses the switch unless sign-in is fully configured and the operator has already signed in through it as an admin, so the switch can never leave nobody able to sign in. From the command line the switch is unrestricted, which is the recovery path.

**Why this priority**: the Settings page is reachable in `none` mode by anyone who can reach Bellhop; a premature switch would lock the operator out of the web UI.

**Independent Test**: on the Settings page in `none` mode, try to save mode `oidc` with incomplete OIDC settings (refused), with complete settings but no signed-in session (refused), signed in as a non-admin (refused), and signed in as an admin (accepted).

**Acceptance Scenarios**:

1. **Given** incomplete OIDC settings, **When** a Settings save sets mode `oidc`, **Then** it is refused with a message naming the missing settings.
2. **Given** complete OIDC settings and no valid session on the request, **When** a Settings save sets mode `oidc`, **Then** it is refused with a message telling the operator to sign in first through the login link.
3. **Given** a valid session naming a user who would not be an admin under the admin-group settings after this save, **When** a Settings save sets mode `oidc`, **Then** it is refused.
4. **Given** a valid session naming an admin, **When** a Settings save sets mode `oidc`, **Then** it is saved, and the change is logged naming who made it.
5. **Given** any state, **When** the operator sets the mode from the command line, **Then** it is stored without these checks.

---

### User Story 5 - Running without an identity provider (Priority: P3)

An operator who has no Authentik, or who runs local development or the demo instance, uses mode `none`. That is also what an install with no mode set gets. They are served as the local operator with full admin rights, the web UI shows its existing "not authenticated" banner, and the service logs a warning at start-up.

**Why this priority**: existing behavior for single-user installs, retained by the operator's decision; it only has to keep working.

**Independent Test**: with no mode set, start the service and confirm the start-up warning, the banner, and admin access as the local operator.

**Acceptance Scenarios**:

1. **Given** no mode set, **When** the service starts, **Then** it runs in `none` mode and logs a warning that the web UI is served without authentication.
2. **Given** a stored mode of `auto`, **When** the service or CLI opens the settings store, **Then** the stored value is cleared (so the mode is `none`); **Given** a stored `authentik`, **Then** it becomes `oidc`.
3. **Given** the `WEB_UI_AUTH_MODE` environment variable set to `auto` or `authentik`, **When** the service starts, **Then** it refuses to start with a message naming the value to use instead.

---

### User Story 6 - The same login under every proxy driver (Priority: P3)

Bellhop's own route is no longer forward-gated, so its web UI is reachable and signs in the same way behind Caddy, nginx, Nginx Proxy Manager, Traefik or HAProxy, with no hand-authored routing. Forward-auth for other apps behind the proxy is unchanged. The Windows service's firewall rule no longer restricts which address may reach Bellhop.

**Why this priority**: removes a limitation and simplifies setup, but follows automatically from Stories 1-2.

**Independent Test**: generate HAProxy config for an inventory whose Bellhop entry is OIDC-gated and confirm it is an ordinary routed backend; install the Windows service and confirm its firewall rule has no remote-address restriction.

**Acceptance Scenarios**:

1. **Given** the HAProxy driver, **When** Bellhop's entry is OIDC-gated, **Then** its route is generated like any other OIDC-gated app and sign-in works through it.
2. **Given** the Windows service installer, **When** it adds its firewall rule, **Then** the rule allows the port from any address.

### Edge Cases

- `returnTo` naming another site, a protocol-relative URL (`//evil.example`), or anything not a same-origin path is ignored in favor of `/`.
- A callback with a missing, unknown, expired (older than 10 minutes) or already-used login attempt, a mismatched `state`, or an Authentik error response shows a sign-in failure page with a link to try again; nothing is signed in.
- An ID token whose issuer, audience, signature, nonce or expiry does not validate is rejected.
- An ID token with no `preferred_username` is rejected (Bellhop's attribution is keyed on a username); missing `groups` means no groups.
- Authentik unreachable at sign-in: a sign-in failure page names the issuer that could not be reached; existing sessions keep working.
- OIDC settings incomplete while mode is `oidc`: page navigations go to a "web login not configured" page naming the missing settings and the recovery commands; API calls still 401.
- The session store unreadable or corrupt at start-up: the service fails to start rather than serving unauthenticated.
- A user signed in in two browsers has two independent sessions; signing out of one leaves the other.
- `WEB_UI_DEV_USER` set (dev/test only) still supplies an identity when no session is present, in either mode's place as today; it must never be set in production.
- Expired sessions and login attempts are removed, so the store does not grow without bound.

## Requirements *(mandatory)*

### Functional Requirements

**Modes**

- **FR-001**: The web UI auth mode MUST accept exactly `oidc` and `none`; an unset mode MUST mean `none`.
- **FR-002**: A stored mode of `authentik` MUST be rewritten to `oidc`, and a stored `auto` MUST be cleared, the first time the settings store is opened after upgrade; the rewrite MUST be idempotent.
- **FR-003**: An environment override of the mode set to any other value (including `auto` or `authentik`) MUST stop the service at start-up with a message naming the accepted values and, for the two removed ones, the replacement.
- **FR-004**: In `none` mode every request MUST be served as the local operator, with the existing start-up warning and web UI banner.

**Configuration**

- **FR-005**: The settings store MUST hold the OIDC issuer URL, client id and callback URL as ordinary settings, and the client secret as a write-only secret, each with an environment-variable override, following the existing settings rules (a secret never appears in any response, log, error, job record or tool output).
- **FR-006**: A CLI command MUST, given an inventory entry name, read that entry's Authentik OIDC client's issuer, client id and secret, and take its callback URL from the entry's redirect URIs (the one whose path is `/auth/callback`; failing if there is none), and store all four. Without `--apply` it MUST only print what it would store, showing the secret only as being set.
- **FR-007**: The Settings page MUST show the three non-secret OIDC settings as editable and the secret as set/unset, in the same way as other settings.

**Sign-in flow**

- **FR-008**: Bellhop MUST provide a sign-in entry point, a callback, and a sign-out endpoint that are reachable without a session in every mode, whenever OIDC settings are complete.
- **FR-009**: Sign-in MUST use the authorization-code flow with PKCE, a single-use `state` and a `nonce`, and MUST validate the ID token's signature, issuer, audience, nonce and expiry before creating a session.
- **FR-010**: A pending sign-in attempt MUST expire after 10 minutes and MUST be usable once.
- **FR-011**: After sign-in the browser MUST be sent to the page originally requested when that was a same-origin path, else `/`.
- **FR-012**: The signed-in identity MUST take the username from `preferred_username`, the stable user id from `sub`, the email from `email`, and the groups from `groups`.

**Sessions**

- **FR-013**: A session MUST be held server-side and survive a service restart. The browser MUST hold only an unguessable session id (at least 256 bits of randomness) in a cookie marked `HttpOnly`, `Secure` and `SameSite=Lax`; the server MUST store only a one-way hash of that id.
- **FR-014**: A session MUST expire 8 hours after sign-in regardless of activity. Expired sessions and attempts MUST be removed.
- **FR-015**: Sign-out MUST destroy the session server-side, clear the cookie, and send the browser to the identity provider's end-session endpoint when it advertises one (else to a signed-out page).

**Request authentication**

- **FR-016**: In `oidc` mode every web UI and `/api` request except the sign-in endpoints MUST require a valid session (or, dev/test only, `WEB_UI_DEV_USER`). Without one, `/api` requests MUST get 401 and page navigations MUST be redirected to sign-in with the requested path as the return target.
- **FR-017**: The job-log live stream MUST authenticate from the same session cookie and refuse the connection without a valid one.
- **FR-018**: Bellhop's own authentication MUST NOT read any `X-authentik-*` request header.
- **FR-019**: Admin status, per-resource permissions, impersonation, guest-creator access and job attribution MUST work unchanged on top of the session identity.

**Lockout guard**

- **FR-020**: A Settings page save that sets the mode to `oidc` MUST be refused unless every OIDC setting is set and the request carries a valid session whose user is an admin under the admin-group settings as they will be after the save; the refusal MUST say which condition failed. A successful switch away from `none` MUST be logged naming the user.
- **FR-021**: Setting the mode from the CLI or MCP MUST remain unrestricted.

**Web client**

- **FR-022**: When any API call returns 401, the web client MUST send the browser to sign-in with the current page as the return target.
- **FR-023**: The Sign out link MUST use Bellhop's own sign-out endpoint, and MUST stay hidden for the local operator.

**Proxy and firewall**

- **FR-024**: The Windows service's firewall rule MUST allow Bellhop's port from any remote address.
- **FR-025**: Forward-auth gating of other inventory entries MUST be unchanged.

**Documentation and tests**

- **FR-026**: User documentation (Authentik setup, environment variables, configuration, web UI, the HAProxy limits section) and the contributor guidance files MUST describe the new modes, settings, command, sign-in setup steps and the recovery path, and drop the header-trust and firewall-scoping explanations.
- **FR-027**: Automated tests MUST authenticate through real sessions, not identity headers, and the demo instance MUST keep producing signed-in-admin screenshots.

### Key Entities

- **Session**: the hash of the session id; the user's username, stable id, email and groups; created and expiry times.
- **Login attempt**: the `state`, PKCE verifier, nonce, return path and creation time of a sign-in in progress; deleted when used or expired.
- **OIDC client settings**: issuer URL, client id, callback URL (settings) and client secret (secret).
- **Web UI auth mode**: `oidc` or `none` (unset = `none`).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In `oidc` mode, 100% of requests without a valid session are refused (401 or redirect to sign-in), including requests that carry forged identity headers, whatever proxy or network path they arrive by.
- **SC-002**: A user can go from opening a Bellhop link to seeing that page signed in within one Authentik sign-in, with no other step.
- **SC-003**: A user removed from the admin group loses admin access within 8 hours, and immediately on their next sign-in.
- **SC-004**: Signing out makes the old session unusable on the very next request.
- **SC-005**: Restarting the service signs nobody out.
- **SC-006**: Configuring the sign-in client takes one command after the existing Authentik reconcile, with no secret copied by hand.
- **SC-007**: No secret value appears in any API response, log line, error, or CLI output produced by this feature.
- **SC-008**: The full automated test suite passes with no test relying on identity headers for authentication.

## Assumptions

- Authentik's default `profile` scope includes a `groups` claim in the ID token; Bellhop requests `openid profile email`.
- Bellhop's public URL is served over HTTPS through the proxy, so a `Secure` cookie is sent; local development over plain HTTP uses mode `none` or `WEB_UI_DEV_USER` (browsers also accept `Secure` cookies on `localhost`).
- One Bellhop instance per deployment; sessions are not shared across instances.
- Authentik's issuer for an application is the per-application issuer `runOidcCredentials` already reports.
- The callback path is fixed at `/auth/callback`; the operator lists `https://<bellhop host>/auth/callback` in Bellhop's entry's OIDC redirect URIs.
- Group changes reaching an existing session within the 8-hour lifetime is acceptable (operator decision); there is no refresh-token or API re-check.
- With header trust gone, the firewall's remote-address restriction no longer protects anything in `oidc` mode; in `none` mode the operator accepts that anyone who can reach the port is an admin (operator decision).

## Out of Scope

- Identity providers other than Authentik (the flow is standard OIDC and should not preclude them, but only Authentik is tested).
- The MCP server's authentication (stays the API key, #66).
- The first-run setup walkthrough that creates the client and flips the mode (#70).
- Refresh-token or Authentik-API re-checking of group membership during a session.
- Sharing sessions across several Bellhop instances.
