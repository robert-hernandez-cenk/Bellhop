# Quickstart: verify Nginx Proxy Manager settings on the Proxy tab

## Automated

```bash
npm run typecheck
npm test
npm run web:build
```

Expected: all pass. The relevant tests cover the `usesNpmApi` flag in the
API's driver list, `proxyFieldView`'s `showNpmApiFields`, the five-tab list,
the Proxy tab's field list and the `SETTING_DEFS` group.

## Browser (demo instance, example data only)

1. `npm run web:build`, then `npm run demo` and open `http://127.0.0.1:3100/settings`.
2. Tab strip shows General, Proxy, Authentik, Cloudflare, GitHub.
3. Proxy tab with the saved/default driver (Caddy): no Nginx Proxy Manager fields.
4. Select Nginx Proxy Manager in the dropdown (don't save): NPM API URL,
   email and password appear under the dropdown; the password shows its
   set/not-set status with a masked input.
5. Type a value into the email field, switch to Traefik, then back: the
   typed value is still there; no request was sent on the switch (network tab).
6. Select each other driver (Caddy admin API, nginx, HAProxy, Traefik, No
   proxy): the three fields are hidden.
7. Repeat 2–4 at a 390 px-wide viewport: tabs and fields fit with no
   horizontal scrolling.

## Screenshots

`npm run docs:screenshots`; check `docs/images/settings-proxy-driver.png`
shows five tabs and example values only.
