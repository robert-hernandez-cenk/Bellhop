# Implementation Plan: Web UI screenshots from a demo instance

**Branch**: `issue-45-readme-screenshots` | **Date**: 2026-09-29 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/014-web-ui-screenshots/spec.md`

## Summary

Add a demo instance of the real web UI that runs against an invented, example-only homelab
with simulated Proxmox responses (`npm run demo`), a capture script that drives an installed
Chrome/Edge through `playwright-core` to write seven screenshots into `docs/images/`
(`npm run docs:screenshots`), and place those screenshots next to the text they illustrate in
the README and three `docs/` pages. The demo is built on `buildApp()` with injected fakes, so it
never touches the checkout's real inventory, `data/`, or any network host (research R1–R4).

## Technical Context

**Language/Version**: TypeScript (strict), Node.js ≥ 24, run through `tsx`

**Primary Dependencies**: existing Express/`ws`/`better-sqlite3` web stack; new dev dependency
`playwright-core` (no bundled browser)

**Storage**: a temp directory per demo run holding its own `bellhop.db`, `jobs.sqlite3`, and
job logs; removed on stop

**Testing**: Node's built-in test runner (`npm test`); new tests under `test/scripts/demo/`

**Target Platform**: developer machines (Windows, macOS, Linux) with Chrome or Edge installed;
CI runs only the automated tests, never the capture

**Project Type**: CLI + web service (existing); this feature adds two npm scripts and docs

**Performance Goals**: full capture in under two minutes (SC-002)

**Constraints**: offline-capable; example data only (Principle I); screenshots ≤ 3 MB total
(SC-005); README stays within its 200-line budget (`test/docs/links.test.ts`)

**Scale/Scope**: 7 screenshots, 4 Markdown pages, ~6 new source files

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Assessment |
| --- | --- |
| I. No real operational data | Pass. Demo data uses RFC 5737 addresses, `example.com`, `pve1`/`pve2`; a test scans all demo data and seeded logs for non-example IPs/domains (FR-019); images checked by eye before commit. The demo never reads `inventory/bellhop.db` or `data/` (R1). |
| II. Code quality | Pass. Strict TypeScript; `DemoSSHClient` opens no connection, so `Ssh2SSHClient` stays the only SSH opener; the fake catalog response is parsed by the existing zod-free `fetchRepoSlugs` path unchanged. |
| III. Testing standards | Pass. New behavior (demo inventory, fakes, demo server) ships with tests using the built-in runner, a temp directory, no network. The capture script needs a real browser, so it is verified by hand (the quickstart), like other code the constitution allows to be manually verified. CI gates unchanged. |
| IV. UX consistency | Pass. No command behavior changes. Error messages name the fix (`npm run web:build`, `PORT=...`, how to install a browser). Docs updated in the same change (FR-017). Web UI itself is unchanged, so no new desktop/mobile verification of UI code is required, though the phone screenshot is itself a mobile check. |
| Workflow | Pass. Worktree branch, PR to `main`. No single-operator assumption changes. |

Post-design re-check: unchanged — no violations, no Complexity Tracking entries.

## Project Structure

### Documentation (this feature)

```text
specs/014-web-ui-screenshots/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── commands.md
│   └── screenshot-set.md
└── tasks.md             # /speckit-tasks
```

### Source Code (repository root)

```text
scripts/
├── demo/
│   ├── demo-inventory.ts     # buildDemoInventory(): Inventory (fresh each call)
│   ├── demo-ssh.ts           # DemoSSHClient: canned Proxmox responses, no sockets
│   ├── demo-fetch.ts         # demoFetch: fixed app catalog + app scripts, 404 otherwise
│   ├── demo-jobs.ts          # seedDemoJobs(store, log, dbPath): fixed-time finished jobs
│   ├── demo-server.ts        # startDemoServer({ port, serveClient }): { url, close }
│   └── serve.ts              # `npm run demo` entry point
├── screenshots.ts            # SCREENSHOTS: the screenshot definitions (data only)
└── capture-screenshots.ts    # `npm run docs:screenshots` entry point

test/scripts/demo/
├── demo-inventory.test.ts    # validates; example-data guard over all demo data (FR-018/019)
└── demo-server.test.ts       # API calls each screenshotted page makes succeed (FR-020)

docs/images/                  # the seven PNGs
README.md, docs/web-ui.md, docs/authentik.md, docs/reverse-proxy/README.md,
CONTRIBUTING.md, CLAUDE.md, package.json (+2 scripts, +playwright-core)
```

**Structure Decision**: Demo code lives in `scripts/` (already in `tsconfig.json`'s `include`,
alongside `windows-service.ts`), not `src/`, because it is developer tooling that ships no
runtime behavior. Tests mirror it under `test/scripts/demo/`. `demo-server.ts` takes
`serveClient: false` so the API test runs in CI, where `web:build` happens after `npm test`.

## Complexity Tracking

No constitution violations.
