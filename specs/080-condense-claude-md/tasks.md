---

description: "Task list for condensing CLAUDE.md"
---

# Tasks: Condense CLAUDE.md

**Input**: Design documents from `specs/080-condense-claude-md/`. These are [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md), [data-model.md](data-model.md), and [quickstart.md](quickstart.md).

**Tests**: none. This is a documentation-only change, so no new tests are written. Verification is the docs link test plus the quickstart checks. The full suite is not run, at the operator's direction.

**Source text**: the original file is at commit `6cd2f90` (`git show 6cd2f90:CLAUDE.md`). All line numbers below refer to it.

**How each nested-file task works**:

- Read the listed original ranges.
- Write the destination file, applying research.md R3: keep every rule, gotcha, rationale, and identifier; drop the history narrative and repetition.
- Add the one-line pointers that data-model.md lists for this destination.
- Open with an `# <Area>` heading and a one-sentence scope line.
- Use example values only.

Shared bullets are split exactly as data-model.md says, so no two tasks write the same text.

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Setup

- [x] T001 Confirm that `git show 6cd2f90:CLAUDE.md | wc -l` prints 4175 and that the worktree's `CLAUDE.md` is unchanged from it. This is the source of truth for every task below.

---

## Phase 2: User Story 2 — Subsystem detail arrives when touched (Priority: P1)

**Goal**: the thirteen nested files exist and hold all subsystem detail.

**Independent Test**: every primary row in the data-model topic map has a heading in its destination file (quickstart step 4).

The nested files are written first, so that nothing is lost when the root file is cut down in Phase 3.

- [x] T002 [P] [US2] Write `src/lib/CLAUDE.md`. Sources:
  - 55-273: inventory schema and cluster note.
  - 274-450: DB read/write, `sortInventoryForFile`, migrations.
  - 451-540: target resolution details, qm envelopes, `Ssh2SSHClient`, phantom-success.
  - 541-561: MID.
  - 562-616: targeting, package managers.
  - 2794-2832: tls-probe.
  - 3002-3070: pve-acl.
  - 3708-3788: Settings store.

  Add pointers to `npm-client.ts`, `script-catalog.ts`, `app-source.ts`, `authentik-client.ts`, and `permissions.ts`. Point the cross-cutting rules back to the root file.
- [x] T003 [P] [US2] Write `src/lib/proxy/CLAUDE.md` from 646-935: the driver interface, `getDriver`/`driverDeps`, the none driver, capability enforcement, and `fileDriver`. Add pointers for `nginx-locations.ts` and for `caddy-json.ts`/`caddy-admin.ts` (detail in the drivers file).
- [x] T004 [P] [US2] Write `src/lib/proxy/drivers/CLAUDE.md` from 936-1579: Caddy, nginx, Nginx Proxy Manager, HAProxy, Traefik, and the Caddy admin API, including `convert-caddyfile`.
- [x] T005 [P] [US2] Write `src/commands/networking/CLAUDE.md`. Sources:
  - 1580-1619 and 1666-1965: the sync-authentik core, OIDC, mode switches, outpost, discovery, mobile consent, API quirks.
  - 2049-2093: OIDC credentials and adoption.
  - 2094-2176: prune-acme-challenges.
  - 2177-2238: render-status-page.

  Add pointers to the WEB tier rules (1620-1665), the OPS confirmation rule, the PROXY `runSyncProxy` behavior, and the DRIVERS `convert-caddyfile`.
- [x] T006 [P] [US2] Write `src/commands/provisioning/CLAUDE.md`. Sources:
  - 2239-2269: attach-nfs-mount.
  - 2321-2339: migrate-nfs-mount, including the `--storage` note.
  - 2340-2412: migrate-guest.
  - 2413-2525: install-app core.
  - The update-app part of 2622-2641.
  - 2642-2690: catalog.
  - The resolution part of 2691-2793 (not the pin-once part).
  - 3949-3982: VPN gateway creds.

  Add pointers to JOBS (prompt relay), LIB (pve-acl, package managers), and OPS (pin-once).
- [x] T007 [P] [US2] Write `src/commands/maintenance/CLAUDE.md`. Sources: 2270-2293 (sync-inventory), 2294-2320 (audit-nfs-mounts), 2898-3001 (check-app-updates), and 3608-3655 (backfill-guest-creators). Add pointers to LIB (update-all targeting, package managers) and TASKS (scheduler).
- [x] T008 [P] [US2] Write `src/operations/CLAUDE.md`. Sources:
  - 3135-3157: the operations layer.
  - The `editDeletesOidcClient`/`commitGuestEdit` part of 1987-2048.
  - The pin-once / `resolvesApp` part of 2761-2793.
  - From 2094-2176, the rule that `cloudflare` is required on `OperationDeps`.
  - From 2981-2992, the post-update-app re-check.
  - From 3002-3070, `OperationDeps.actor`.
- [x] T009 [P] [US2] Write `src/web/CLAUDE.md`. Sources:
  - 1620-1665: tier raise/lower and the unauthenticatedPaths add rule.
  - The `syncProxyLive` part of 1966-1986.
  - The `oidcEditChangeError` part of 1987-2048.
  - The route-upsert part of 2622-2641.
  - The call sites in 2794-2832.
  - 3114-3134: inventory reload.
  - 3293-3394: Web UI authentication.
  - 3395-3491: users and groups.
  - 3492-3607: permissions and creator access.
  - 3656-3707: impersonation.
  - The API part of 3789-3948: the Settings page.
  - The `/api/app-updates` part of 2964-2980.

  Add pointers to `src/web/routes/oidc.ts` (NET), JOBS, and TASKS.
- [x] T010 [P] [US2] Write `src/web/jobs/CLAUDE.md`. Sources: 2526-2621 (prompt relay, detection tiers, OutputActivity, pre-scan) and 3209-3247 (cross-process job watching and control), plus job attribution columns from 3656-3707.
- [x] T011 [P] [US2] Write `src/web/tasks/CLAUDE.md` from 2833-2897, the scheduler framework and tasks route. Point to MAINT for check-app-updates.
- [x] T012 [P] [US2] Write `src/mcp/CLAUDE.md` from 3158-3208 and 3248-3292. Add pointers to JOBS (cross-process control) and NET (`oidc-credentials`).
- [x] T013 [P] [US2] Write `web-client/CLAUDE.md`. Sources:
  - 3071-3113: responsive layout, theming, FieldHelp.
  - The dropdown part of 1966-1986.
  - The Advanced modal tabs, `accessFieldsFor`, and banners from 1987-2048.
  - The UI part of 3789-3948: the Settings page dropdowns, `proxyFieldView`, tabs.
  - The whoami/Sidebar/admin-nav material from 3395-3491 and 3656-3707.
  - The `prompt-banner.ts` part of 2526-2621.
  - The select-storage field kind from 2413-2525.

**Checkpoint**: every topic-map row except the ROOT rows has a home.

---

## Phase 3: User Story 1 — Short always-loaded root file (Priority: P1)

**Goal**: the root `CLAUDE.md` is at most about 250 lines.

**Independent Test**: quickstart steps 1 and 5. The root file alone states every FR-003 rule.

- [x] T014 [US1] Rewrite `CLAUDE.md` with these sections:
  - Opening lines that say "CLAUDE.md" means this file plus the nested files, and that a change updates whichever file describes it (research R5).
  - Commands and testing (1-49).
  - An architecture map with one paragraph per area, naming each nested file.
  - Cross-cutting rules:
    - `runRemote`/`Ssh2SSHClient` are the only remote path;
    - guest commands are POSIX sh, with the exceptions;
    - Dry-run convention (617-645);
    - `saveInventory` is a full replace and sorted;
    - secrets never leave the store;
    - web UI authorization rigor;
    - single-operator assumptions are recorded;
    - example data only.
  - Project philosophy (3983-4001).
  - Workflow conventions (4002-4154).
  - Windows development notes (4155-4175).
- [x] T015 [US1] Update the `CLAUDE.md` description in `README.md` (line 145) and the two "see `CLAUDE.md`" pointers in `docs/commands.md` (lines 57 and 182) so they name the right nested file. Add "(the root file or the nested one for that directory)" to `CONTRIBUTING.md` line 155.

**Checkpoint**: root file size target met.

---

## Phase 4: User Story 3 — Nothing true is lost (Priority: P2)

**Goal**: an independent review confirms that no rule was dropped.

**Independent Test**: quickstart step 7.

- [ ] T016 [US3] Independent review. For each destination, a reviewer that did not write it compares the original ranges against the new text and lists every dropped rule, gotcha, identifier, or rationale. Each finding is restored in its destination file.
- [ ] T017 [US3] Citation check: every name in data-model.md's "Citation names to preserve" table resolves with `grep -r --include=CLAUDE.md` (quickstart step 5).

---

## Phase 5: Polish & Verification

- [ ] T018 Run quickstart steps 1-3: root line count, total bytes at most 200,305, and every destination file exists.
- [ ] T019 Run `node --import tsx --test test/docs/links.test.ts` (quickstart step 6).
- [ ] T020 Confirm that no code or tests changed (quickstart step 8).

---

## Dependencies

- T001 comes before everything else.
- T002-T013 are independent of each other ([P]).
- T014 depends on T002-T013, so the root is cut down only after every nested file exists.
- T015 depends on T014.
- T016-T017 depend on T014.
- T018-T020 depend on T016.

## Parallel example

T002 through T013 can be dispatched together, one subagent per file. Each one reads only its own ranges.

## Implementation strategy

There is one deliverable, and it is committed per phase:

1. Phase 2 (nested files).
2. Phase 3 (root and references).
3. Phase 4 review fixes.
4. Verification.

The MVP is Phases 2 and 3 together. Cutting the root without the nested files would lose content.
