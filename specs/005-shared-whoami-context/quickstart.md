# Quickstart: validating the shared identity

## Automated

```bash
npm run typecheck              # root, includes test/web-client/*.test.ts
npm test                       # includes the whoami store rules (contracts/whoami-store.md)
npm run web:build              # web client strict build
npm --prefix web-client run lint   # no warnings beyond the 3 existing set-state-in-effect ones
```

## In a browser

Setup: `npm run web:dev` (API on :3001, Vite on :5173), open `http://localhost:5173` with
the network panel filtered to `whoami`. The dev user is an admin when `WEB_UI_DEV_GROUPS`
matches the configured `AUTHENTIK_ADMIN_GROUP` (see CLAUDE.md). Impersonation needs a
configured Authentik directory (`data/authentik.env`). Run every check at a desktop width
and at 375px (≤640px, where the Sidebar is a drawer).

| # | Steps | Expected |
| --- | --- | --- |
| 1 | Load `/` | exactly 1 `/api/whoami` request |
| 2 | Open the Advanced modal of an OIDC-gated guest (or any guest) | 0 new `/whoami` requests; auth-mode controls enabled for an admin; credentials row shows the reveal button |
| 3 | Load `/users` directly | exactly 1 `/whoami`; own account's delete/deactivate disabled; Groups section present |
| 4 | Sidebar → Impersonate a restricted group → Start | no page reload (preserve-log stays, no document request); 1 new `/whoami`; banner "Impersonating: …"; Admin nav hidden; Dashboard refetches `/inventory` and shows only what the group may see |
| 5 | Stop impersonating | no reload; 1 new `/whoami`; banner gone; Admin nav back; Dashboard back to the full view |
| 6 | Block `/api/whoami` in devtools (request blocking), reload | no admin nav or admin controls; Sidebar shows the load error with a Retry button; unblock and Retry restores everything |
