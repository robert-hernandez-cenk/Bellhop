# Quickstart: validating the demo and the screenshots

Prerequisites: Node.js 24+, `npm install` done, Chrome or Edge installed. Work in a checkout
with **no** `data/` directory and no `inventory/bellhop.db`, so any accidental read of real
data would fail loudly instead of passing silently.

## 1. Automated checks

```bash
npm run typecheck
npm test            # includes the demo inventory, example-data guard, and demo API tests
npm run web:build
```

Expected: all pass. `test/docs/links.test.ts` fails if any image link in the docs is broken.

## 2. Demo command

```bash
npm run demo
```

Expected: prints `Bellhop demo running at http://localhost:3100 ...`. In a browser:

- The Dashboard lists `pve1`/`pve2` and their guests with running/stopped statuses, no
  "no authentication configured" banner, and the user shown as `admin`.
- Update, Provisioning (Install App: typing in App shows suggestions), Job History (four jobs,
  one failed), a job's page (its log), and Settings all render.
- Edit a guest's subdomain and save; it succeeds.
- Stop with Ctrl+C; start again; the edit is gone.
- `git status` shows no changes.

Also: `PORT=3100` already taken (start a second demo) → the port-in-use message; delete
`web-client/dist` → the build message.

## 3. Screenshot command

```bash
npm run docs:screenshots
```

Expected: seven `wrote docs/images/...` lines, exit 0, well under two minutes. Run it again:
the images show the same content. Open each PNG and check by eye that every name, domain and
address is an example value. Total size of `docs/images/` stays under 3 MB.

## 4. Rendered docs

View `README.md`, `docs/web-ui.md`, `docs/authentik.md`, and `docs/reverse-proxy/README.md`
rendered (GitHub preview or a local Markdown viewer), at desktop width and at phone width:
each image appears next to the text it illustrates and scales to the column.
