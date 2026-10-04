# Quickstart: verify #74

## Prerequisites

```sh
npm install && npm --prefix web-client install
npm run web:build
npm run demo          # http://127.0.0.1:3100, example data only
```

## Desktop (1920x1080 window)

1. Open the Dashboard. In devtools, run:
   ```js
   const s = document.querySelector('.sidebar');
   [s.getBoundingClientRect().width, s.scrollHeight <= s.clientHeight,
    [...s.querySelectorAll('a')].filter(a => a.getClientRects().length && a.getBoundingClientRect().height > 40).map(a => a.textContent)]
   ```
   Expect `220`, `true`, `[]` (no link taller than one line).
2. Simulate the full admin nav (the demo has no Authentik directory, so Users, Permissions and the picker are absent): clone two links and a block of about 100px into the sidebar, then rerun the check. Expect no scroll bar (`scrollHeight <= clientHeight`).
3. Shrink the window height until the sidebar scrolls. Expect "Deploy VPN Gateway" still on one line.
4. At a 1280px-wide window, expect no horizontal page scroll bar.

## Mobile (390px wide)

5. Open the hamburger menu. Expect the drawer at 240px, every link on one line, the backdrop closing it.

## Regression checks

```sh
npm run typecheck && npm test && npm run web:build
```

## Screenshots

```sh
npm run docs:screenshots
```

Check the regenerated `docs/images/*.png` by eye for example-only values and the wider sidebar.
