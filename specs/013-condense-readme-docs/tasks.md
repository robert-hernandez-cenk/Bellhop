---
description: "Task list for condensing the README into docs/"
---

# Tasks: Condense the README into a docs/ folder

**Input**: Design documents from `specs/013-condense-readme-docs/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/docs-layout.md, contracts/link-check.md, quickstart.md

**Tests**: One test file is requested by the spec (FR-007), plus the update to one existing test (research R5).

All paths are relative to the worktree root. "Content map" means `specs/013-condense-readme-docs/data-model.md`. "Old README" means `git show origin/main:README.md` (58c8b70, 1,166 lines), and the line numbers below refer to it. Move text verbatim; change only the seams allowed by `contracts/docs-layout.md`.

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Setup

- [x] T001 Save the old README for reference: `git show origin/main:README.md > <scratch>/old-readme.md`, outside the repository. Every later task copies from it.

## Phase 2: Foundational (test first)

- [x] T002 Write `test/docs/links.test.ts` per `contracts/link-check.md` and research R1-R3:
  - Collect `README.md` plus every `*.md` under `docs/` (recursive, from the repository root).
  - Assert `README.md` has ≤ 200 lines. On failure, report the count and the limit.
  - Extract inline links outside fenced code blocks (```/~~~) and inline code spans. Skip targets with a URL scheme.
  - Resolve each path relative to the linking file and require that it exists (file or directory).
  - For a `.md` target with an anchor, require a heading whose GitHub slug equals the anchor. Slug rules: lower-case the rendered heading text; strip characters outside `[\p{L}\p{M}\p{N}\p{Pc} -]`; spaces become `-`; duplicates get `-1`, `-2` and so on.
  - Collect every break and fail once with lines of the form `<file>: <target> (missing file | no heading "#x")`.
  - Include small unit tests of the slug function: `nginx driver` → `nginx-driver`; `` `proxyDriver` setting`` → `proxydriver-setting`; `Inventory-wide settings (before your first sync)` → `inventory-wide-settings-before-your-first-sync`; and a duplicate heading → `-1`.

  Run `npm test -- ` scoped to this file (`node --import tsx --test test/docs/links.test.ts`) and confirm it FAILS on the current tree, because the README is over budget.

## Phase 3: User Story 2 - Reference material by topic (P1)

**Goal**: every old README section exists on its docs/ page (content map).
**Independent test**: quickstart.md step 3 (word diff) shows only seam removals.

- [x] T003 [P] [US2] Create `docs/commands.md`: title `# Commands`, one intro sentence, then old README lines 86-312 (Usage body with its Maintenance/Provisioning/Networking parts), headings adjusted per research R7. Seams: "Inventory-wide settings below" → `configuration.md#inventory-wide-settings`; "web UI (see below)" → `web-ui.md`; "OIDC mode below" → `authentik.md#oidc-mode`; "see the cluster note in `CLAUDE.md`" stays as text.
- [x] T004 [P] [US2] Create `docs/reverse-proxy/README.md`: title `# Reverse proxy drivers`, lines 316-389 (overview, No proxy, fileDriver, exempt paths, certificates), then lines 480-503 under `## Upgrading from the Caddy-only version`. Also add a short "Drivers" list linking `caddy.md` and `nginx.md`. Seams: "Inventory-wide settings" → `../configuration.md#inventory-wide-settings`; "nginx driver below" → `nginx.md`.
- [x] T005 [P] [US2] Create `docs/reverse-proxy/nginx.md`: title `# nginx driver`, lines 393-478. Seams: "Inventory-wide settings below" → `../configuration.md#inventory-wide-settings`.
- [x] T006 [P] [US2] Create `docs/reverse-proxy/caddy.md` per research R8: title `# Caddy driver`, then only existing statements, gathered from the old README:
  - It is the default driver (line 318).
  - Its config path is `/etc/caddy/Caddyfile` (line 831).
  - It replaces only the `bellhop-managed` section (lines 363-370, 471-472).
  - It issues certificates through Cloudflare DNS-01 with no extra setup (line 384).
  - The status page follows `statusPagePath` (line 811's example path `/usr/share/caddy/index.html`).
  - `prune-acme-challenges`/`data/cloudflare-api.env` clean up stale challenge records (lines 1083-1091).

  Link back to `README.md` for shared driver behavior.
- [x] T007 [P] [US2] Create `docs/configuration.md`: title `# Configuration`, then:
  - `## Hand-editing the inventory` (lines 49-63).
  - `## Inventory-wide settings (before your first sync)` (lines 67-82).
  - `## Inventory-wide settings` (lines 806-843).
  - `### Custom script repository` (lines 847-944).
  - The derived-values paragraph (lines 946-953).

  Seams: "Reverse proxy drivers above" → `reverse-proxy/README.md`; "Inventory-wide settings below" → the in-page anchor; "`--mid` below" → `commands.md`.
- [x] T008 [P] [US2] Create `docs/environment-variables.md`: title `# Environment variables`, lines 957-1091. Seams: "`audit-nfs-mounts` above" → `commands.md`; "Inventory-wide settings above" → `configuration.md#inventory-wide-settings`; "Web UI above/below" → `web-ui.md`; "OIDC mode above" → `authentik.md#oidc-mode`; "Running without Authentik below" → `authentik.md#running-without-authentik`.
- [x] T009 [P] [US2] Create `docs/web-ui.md`: title `# Web UI`, lines 691-742. Seams: "everything above" → "everything in [Commands](commands.md)"; "Environment variable overrides and Running without Authentik below" → `environment-variables.md` / `authentik.md#running-without-authentik`.
- [x] T010 [P] [US2] Create `docs/mcp-server.md`: title `# MCP server`, lines 746-802.
- [x] T011 [P] [US2] Create `docs/authentik.md`: title `# Authentik`, one intro sentence, then:
  - `## Running without Authentik` (lines 1095-1114).
  - `## OIDC mode` (lines 507-687), keeping its bold paragraph labels, including **Authentik API token permissions**, exactly.

  Seams: "Reverse proxy drivers above" → `reverse-proxy/README.md`; "Access tab below" → the in-page anchor; "Environment variable overrides below" → `environment-variables.md`; "Web UI below" → `web-ui.md`.
- [x] T012 [P] [US2] Create `docs/troubleshooting.md`: title `# Troubleshooting`, `## Validation` (lines 1118-1125), `## Known hardware issues` (lines 1129-1144).

**Checkpoint**: commit `Move README reference material into docs/ (#41, US2)`.

## Phase 4: User Story 1 - Newcomer README (P1)

**Goal**: README ≤ 200 lines per `contracts/docs-layout.md`.
**Independent test**: `wc -l README.md` ≤ 200; the quickstart can be followed on the page.

- [x] T013 [US1] Rewrite `README.md` per `contracts/docs-layout.md`:
  - Intro (lines 1-13), with "Reverse proxy drivers below" becoming a link to `docs/reverse-proxy/`.
  - `## Prerequisites` unchanged.
  - `## Setup` quickstart: npm install/link, workspace note, import the example inventory, a one-line pointer to `docs/configuration.md#hand-editing-the-inventory`, `set-config nfsServer`, `sync-inventory` (dry run, then `--apply`), `web:build`/`web:start`.
  - `## Commands`: a 10-15 row table linking `docs/commands.md`.
  - `## Documentation`: an index of all ten pages plus `CLAUDE.md`.
  - Contributing, Security and License unchanged.
- [x] T014 [US1] Run `node --import tsx --test test/docs/links.test.ts` and fix every reported break until it passes.

**Checkpoint**: commit `Condense README to a quickstart and documentation index (#41, US1)`.

## Phase 5: User Story 3 - Links stay correct (P2)

- [x] T015 [US3] Prove the test catches breakage (quickstart.md step 2): temporarily break one anchor in `docs/configuration.md`, confirm the failure message names the file and anchor, then revert. Commit the test with US1 if not already committed.

## Phase 6: User Story 4 - Pointers updated (P2)

- [x] T016 [US4] In `src/commands/networking/sync-authentik.ts`, change the hint `(README "Authentik API token permissions")` to `(docs/authentik.md "Authentik API token permissions")`. Update the nearby comment (about line 984) the same way. Update the expected string in `test/commands/sync-authentik-mobile-consent.test.ts` (about line 224).
- [x] T017 [P] [US4] Update comments: `src/web/auth.ts` line 46 → `docs/authentik.md`'s "Running without Authentik"; `inventory/hosts.yaml.example` lines 97-98 → `docs/authentik.md`'s "OIDC mode" section.
- [x] T018 [P] [US4] Update `CLAUDE.md`: "see README's "OIDC mode" section" → `docs/authentik.md`; "recorded as known limitations in README" → `docs/configuration.md`; ""Running without Authentik" in `README.md`" → `docs/authentik.md`.
- [x] T019 [P] [US4] Restate the documentation rule as "`README.md` or the relevant `docs/` page" in `CONTRIBUTING.md` (line 136), `.github/pull_request_template.md` (line 18) and `.specify/memory/constitution.md` (line 105). Bump the constitution to Version 1.1.1, Last Amended 2026-09-29 (research R6).
- [x] T020 [US4] Run quickstart.md step 4 (`git grep` for stale README pointers) and fix any remaining hits.

**Checkpoint**: commit `Point README-section references at docs/ pages (#41, US4)`.

## Phase 7: Polish & verification

- [ ] T021 Run quickstart.md step 3 (word diff of the old README against the new files) and confirm every removed fragment is a seam. Restore anything lost.
- [ ] T022 Review the full diff for real operational data (Principle I).
- [ ] T023 Run `npm run typecheck`, `npm test` and `npm run web:build`. All must pass.

## Dependencies

- T002 comes before everything else (test first). T003-T012 are independent and can run in parallel.
- T013 depends on T003-T012 (the index links to them). T014 depends on T013.
- T015 depends on T014. T016-T020 are independent of US1/US2, apart from linking to pages that must exist (T011, T007).
- The Polish phase runs last.

## Parallel example

T003-T012 each write a different new file from the same read-only source, so they can be done in any order or together.

## Implementation strategy

This is a documentation move, so it ships as one PR. The MVP is US2+US1 (pages plus the condensed README) with the passing link test. US4 pointer updates follow in the same branch.
