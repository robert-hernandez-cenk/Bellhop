# Contract: web login HTTP surface (#69)

All routes below are mounted in `buildApp` **before** `requireAuth` and reachable without a session in either mode. HTML responses are small server-rendered pages (no client bundle needed). Example origin: `https://bellhop.example.com`.

## GET /auth/login

Query: `returnTo` (optional).

- `returnTo` is kept only if it starts with a single `/` (not `//`, not `/\`) and parses as a same-origin path; otherwise `/`.
- OIDC not configured → **200** HTML "Web login is not configured", listing the missing setting keys and the fixes (`bellhop configure-web-login <entry> --apply`, or `bellhop set-config webUiAuthMode none --apply`).
- Discovery fails → **502** HTML "Could not reach the identity provider at `<issuer>`" with a "Try again" link.
- Otherwise → creates a login attempt (purging expired ones), sets `bellhop_login_<state>` — one cookie per attempt, so parallel sign-ins from several tabs each complete — (HttpOnly; Secure; SameSite=Lax; Path=/auth; Max-Age=600), **302** to the provider's authorization endpoint with `response_type=code`, `client_id`, `redirect_uri` (the `webUiOidcRedirectUri` setting), `scope=openid profile email offline_access`, `state`, `nonce`, `code_challenge`, `code_challenge_method=S256`.

## GET /auth/callback

Query: `code`, `state` or `error`, `error_description`.

- Missing/unknown/expired/used attempt (via the `bellhop_login_<state>` cookie named by the callback's `state`; a state the browser never started finds none), `state` mismatch, provider `error`, token exchange failure, ID-token validation failure, missing `preferred_username`, or no refresh token → **400** HTML "Sign-in failed" with a reason (never a token or secret) and a link to `/auth/login?returnTo=<attempt's returnTo>`. The attempt is consumed either way; its cookie cleared.
- Success → session created, `bellhop_session` set (HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000), `bellhop_login_<state>` cleared, **302** to the attempt's `returnTo`.

## POST /auth/logout

No body. Deletes the session for the presented cookie (if any), clears `bellhop_session`, then **303** to the provider's `end_session_endpoint?id_token_hint=…&post_logout_redirect_uri=<origin of webUiOidcRedirectUri>/auth/signed-out` when discovery advertises one, else **303** `/auth/signed-out`. Never fails because the provider is unreachable.

## GET /auth/signed-out

**200** HTML "You are signed out" with a "Sign in again" link to `/auth/login`.

## Behavior of every other route (`requireAuth`)

Resolution order (research R6): valid session (either mode, re-checked when due) → `WEB_UI_DEV_USER` → local operator in `none` mode → unauthenticated.

| Request | Unauthenticated response |
|---|---|
| `/api/*` any method | **401** `{"error":"unauthorized"}` |
| other GET/HEAD | **302** `/auth/login?returnTo=<original path and query>` |
| other methods | **401** `{"error":"unauthorized"}` |

`X-authentik-*` headers have no effect anywhere.

## WebSocket `/ws/jobs/:id`

The `upgrade` handler parses `bellhop_session` from the request's `Cookie` header and resolves it exactly as `requireAuth` does (including the re-check); with no identity the socket is destroyed. Impersonation overlay and job visibility unchanged.

## GET /api/whoami

Unchanged shape; `localOperator` stays. The client hides Sign out when `localOperator` is true.

## Web client

- `fetch` wrapper: a 401 from any `/api` call sets `window.location.href = '/auth/login?returnTo=' + encodeURIComponent(location.pathname + location.search)`.
- Sidebar Sign out: `<form method="post" action="/auth/logout"><button>Sign out</button></form>`, styled like the previous link.
