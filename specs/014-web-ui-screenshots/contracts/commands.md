# Contract: `npm run demo` and `npm run docs:screenshots`

## `npm run demo`

Runs `tsx scripts/demo/serve.ts`.

| Input | Meaning |
| --- | --- |
| `PORT` (env) | Port to listen on. Default `3100`. |

Behavior:

1. If `web-client/dist/index.html` does not exist: print
   `The web UI has not been built yet. Run: npm run web:build` and exit 1.
2. Otherwise start the demo instance (research R1), bound to 127.0.0.1 only, then print
   `Bellhop demo running at http://127.0.0.1:<port> -- example data only, nothing reaches a real host. Press Ctrl+C to stop.`
3. On `EADDRINUSE`: print `Port <port> is already in use. Set PORT to another port, e.g. PORT=3200 npm run demo` and exit 1.
4. On SIGINT/SIGTERM: stop the server, remove the temp directory, exit 0.

Guarantees: reads nothing under `data/` or `inventory/bellhop.db`; writes only to its temp
directory; opens no outbound network connection.

## `npm run docs:screenshots`

Runs `tsx scripts/capture-screenshots.ts`.

Behavior:

1. If `web-client/dist/index.html` does not exist: same message and exit code as `demo`.
2. Launch a browser, trying in order `chrome`, `msedge`, then Playwright's bundled Chromium.
   If none launches: print each attempt and its error, then
   `Install Google Chrome or Microsoft Edge, or run: npx playwright install chromium`, exit 1.
   The demo is not started.
3. Start the demo instance on a free port.
4. For each entry in the screenshot set (`contracts/screenshot-set.md`), in order: open a page
   with that entry's viewport and theme, run its preparation, wait for its ready selector
   (15 s), write `docs/images/<file>`, print `  wrote docs/images/<file>`.
5. If an entry fails: print `Screenshot <file> failed: <reason>` and exit 1 after cleanup. Files
   already written in this run stay; no partial image is written for the failing entry.
6. Always (success or failure): close the browser and stop the demo.

Exit code 0 only when every entry was written.
