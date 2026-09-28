# Quickstart: verifying the overflow fix

This check proves the spec's success criteria (SC-001 to SC-004) in a real layout engine. It needs Chrome and a local build; it touches no real infrastructure.

## Setup

1. Build the client: `npm run web:build`.
2. Create a scratch inventory from the example file:
   `npm run bellhop -- import-yaml-inventory --yaml-path inventory/hosts.yaml.example --db-path <scratch>/bellhop.db --apply`
3. Start the service against scratch data (auth mode defaults to `auto`, so no Authentik is needed):
   `INVENTORY_FILE=<scratch>/bellhop.db WEB_DATA_DIR=<scratch>/data PORT=<port> npx tsx src/web/server.ts`
4. Insert example rows into `<scratch>/data/jobs.sqlite3` (the service creates the table on start):
   - a job in `awaiting_input` with target `examplelongguestnamewithoutanyhyphenslxc`, triggered by `administrator@example.com` impersonating `bellhop-app-users-open`
   - a job with a hyphenated target such as `example-guest-with-a-long-name-lxc`
   - a finished job with no target

## Checks

Open each page in headless Chrome with a device-metrics override (width 390, then 320, then 1280). In the page, compare `document.querySelector('.content').scrollWidth` with the viewport width, and list any element under `.content` whose bounding box extends past the viewport. Take a screenshot of each.

| Page | 390px | 320px | 1280px |
| --- | --- | --- | --- |
| `/jobs` | scrollWidth equals viewport; no offenders; wrapped values right-aligned | same | table layout as before |
| `/jobs/<long-target id>` | scrollWidth equals viewport; badge on one line; Stop visible | same | title left, badge and Stop right, one row |
| `/jobs/<hyphenated id>` | fits; badge on one line | same | one row |
| `/` (Dashboard) | scrollWidth equals viewport; inline controls usable | same | unchanged |

Expected: zero sideways scroll everywhere at 390px and 320px, and no visible change at 1280px except the badge no longer splitting.

## Automated

`npm test` includes `test/web-client/mobile-overflow-css.test.ts`, which pins the style declarations this layout depends on. `npm run typecheck` and `npm run web:build` must also pass.
