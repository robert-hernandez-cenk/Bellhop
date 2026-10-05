# Quickstart: validating web login (#69)

Example values throughout; substitute your own when running against real infrastructure.

## 1. Automated checks

```bash
npm run typecheck
npm test
npm run web:build
```

Expected: all pass; no test sets an `x-authentik-*` header to authenticate (`git grep -n "x-authentik" test/web` returns only the "headers are ignored" tests).

## 2. Local, no identity provider

```bash
npm run web:dev
```

Open the app: you are the dev user (`WEB_UI_DEV_USER`). `curl -H 'x-authentik-username: admin' http://localhost:3001/api/whoami` still answers as the dev user, never `admin`.

## 3. Demo screenshots

```bash
npm run demo           # signed-in admin via a seeded session
npm run docs:screenshots
```

Check the Sidebar shows a normal signed-in admin with Sign out, the Settings General tab shows the example OIDC settings, and every image carries example values only.

## 4. Live sign-in (deployment checkout, by hand)

Upgrade sequence (each step real-world-first; Bellhop is unreachable only between steps c and e):

a. On Bellhop's own inventory entry set `authGroup` (the lowest rung that should reach Bellhop), `authMode: oidc`, and add `https://bellhop.example.com/auth/callback` to Callback URLs.
b. `bellhop sync-authentik --apply` — creates the client and attaches `offline_access` to every Bellhop-owned OIDC provider.
c. `bellhop sync-proxy --apply` — Bellhop's route stops being forward-gated.
d. `bellhop configure-web-login bellhop --apply`.
e. In `data/authentik.env` change `WEB_UI_AUTH_MODE=authentik` to `WEB_UI_AUTH_MODE=oidc` (or delete the line and store it: `bellhop set-config webUiAuthMode oidc --apply`); deploy and restart the service.

Then verify:

1. Fresh private window → `https://bellhop.example.com/jobs` → Authentik sign-in → back on `/jobs`, signed in as yourself, admin.
2. `curl -i https://bellhop.example.com/api/whoami` (no cookie) → 401; with a forged `X-authentik-username: admin` header → 401.
3. Open a running job's log: the live stream connects.
4. Restart the service: still signed in.
5. Remove a test user from a group in Authentik; within 5 minutes of their next request their view changes. Deactivate them; their next request after the re-check is due sends them to sign-in.
6. Stop Authentik briefly (or block it): requests keep working, the service log warns once per retry; restore it.
7. Sign out → Authentik's sign-out page → `/auth/signed-out`; the old cookie (copied beforehand) gets 401.
8. Firewall: `netsh advfirewall firewall show rule name=<rule>` after reinstalling the service shows `RemoteIP: Any`.

Record each result in the PR.
