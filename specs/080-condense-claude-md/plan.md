# Implementation Plan: Condense CLAUDE.md

**Branch**: `issue-80-condense-claude-md` | **Date**: 2026-10-05 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/080-condense-claude-md/spec.md`

## Summary

Split the 4,175-line root `CLAUDE.md` into two layers:

- A root orientation file of at most about 250 lines, loaded on every session. It holds the commands, the testing conventions, a map of the nested files, the cross-cutting rules, the project philosophy, the workflow conventions, and the Windows notes.
- Thirteen nested `CLAUDE.md` files placed in the source directories they describe. Claude Code loads each one when it reads a file in that directory.

Moved text is tightened as it moves (see [research.md](research.md) R3). [data-model.md](data-model.md) maps every original topic to its destination.

## Technical Context

**Language/Version**: Markdown only. No code changes.

**Primary Dependencies**: Claude Code's nested-`CLAUDE.md` loading behavior (research R1).

**Storage**: N/A

**Testing**: `test/docs/links.test.ts`, run on its own. The operator directed that the full suite is not run for this documentation-only change.

**Target Platform**: Claude Code sessions in this repository.

**Project Type**: Documentation restructuring.

**Performance Goals**: The always-loaded file shrinks from 286 KB to roughly 15–20 KB.

**Constraints**:

- Root file at most about 250 lines.
- Total size at least 30% smaller.
- No dropped rule.
- Example data only.

**Scale/Scope**: 1 root file rewritten, 13 nested files created, and 2 user-doc references updated.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status |
|---|---|
| I. No real operational data | Pass. Moved text already uses example values. The rewrite introduces no new values. |
| II. Code quality | Pass. No code changes. The bash-exception rule ("recorded in `CLAUDE.md`") stays true, because the exception list stays in the root file. |
| III. Testing | Pass. No behavior change, so no new tests are needed. The docs link test covers the markdown. |
| IV. UX / docs consistency | Pass. `CONTRIBUTING.md`, the PR template, and the constitution say "update `CLAUDE.md`". Research R5 explains how that phrase now means the root file and the nested files together, and the root file says so explicitly. |
| Governance: runtime guidance | Pass. `CLAUDE.md` (root plus nested files) stays consistent with the constitution. No amendment is needed. |

Post-design re-check: the result is unchanged.

## Project Structure

### Documentation (this feature)

```text
specs/080-condense-claude-md/
├── spec.md
├── plan.md          # this file
├── research.md      # decisions R1-R6
├── data-model.md    # destination files + topic map
├── quickstart.md    # verification steps
└── tasks.md
```

### Source Code (repository root)

```text
CLAUDE.md                                   # root orientation (<= ~250 lines)
src/lib/CLAUDE.md                           # inventory model + DB, targets, MID, SSH, settings store, pve-acl, tls-probe, package managers
src/lib/proxy/CLAUDE.md                     # driver interface, routes/context, capabilities, none driver, fileDriver
src/lib/proxy/drivers/CLAUDE.md             # caddy, caddy-api, nginx, NPM, HAProxy, Traefik
src/commands/networking/CLAUDE.md           # sync-authentik (incl. OIDC, mobile consent), oidc-credentials/adopt, prune-acme, render-status-page
src/commands/provisioning/CLAUDE.md         # install-app/update-app + custom script source + catalog, create-lxc keys, NFS attach/migrate, migrate-guest, VPN gateway creds
src/commands/maintenance/CLAUDE.md          # sync-inventory, audit-nfs-mounts, check-app-updates, backfill-guest-creators
src/operations/CLAUDE.md                    # shared operations layer, commitGuestEdit rules, resolvesApp
src/web/CLAUDE.md                           # auth, users/groups, permissions + creator access, impersonation, inventory reload, syncProxyLive, settings API, provisioning-route upsert, TLS probe call sites
src/web/jobs/CLAUDE.md                      # prompt relay/detection, cross-process job control, job attribution
src/web/tasks/CLAUDE.md                     # scheduler framework
src/mcp/CLAUDE.md                           # MCP server
web-client/CLAUDE.md                        # responsive/theming, FieldHelp, Settings page UI, Advanced modal tabs, whoami/sidebar
```

Also touched: `README.md` (its description of `CLAUDE.md`) and `docs/commands.md` (two "see `CLAUDE.md`" pointers, made specific).

## Complexity Tracking

No constitution violations.
