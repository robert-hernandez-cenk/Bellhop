# Implementation Plan: MID suggestions that account for hidden guests

**Branch**: `issue-54-mid-suggestion-hidden-guests` | **Date**: 2026-10-03 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/016-mid-suggestion-hidden-guests/spec.md`

## Summary

The web UI suggests and checks MIDs against the permission-filtered guest list, so a restricted
user is offered MIDs held by guests they can't see (issue #54). Fix: the server publishes, per
host the caller can see, the occupied MID numbers from the unfiltered inventory
(`GET /api/provisioning/used-mids`). The provisioning form's suggestion, migrate-guest's
preferred-MID collision check, and the MID field's collision warning all use that set; the
warning names a guest only if the caller can see it. Separately, `checkVmidAvailable` takes an
optional guest-visibility predicate that the web provisioning routes build per request, so its
"VMID in use" error stops naming hidden guests. CLI and MCP pass no predicate and are unchanged.

## Technical Context

**Language/Version**: TypeScript (Node, strict), React web client (Vite)

**Primary Dependencies**: Express (web API), zod, better-sqlite3 (permission rules)

**Storage**: unchanged; reads inventory and `permission_groups`/`permission_rules`

**Testing**: `node --test` under `test/` (supertest for routes, `FakeSSHClient` for commands, framework-free web-client lib tests in `test/web-client/`)

**Target Platform**: Bellhop web service + browser client

**Project Type**: web service + SPA (one repo; `src/` server, `web-client/` client)

**Performance Goals**: n/a (one small inventory scan per form load)

**Constraints**: no guest name/detail beyond MID numbers may reach a restricted caller (FR-002); CLI/MCP output unchanged (FR-007)

**Scale/Scope**: 1 new route, 1 lib helper, 1 optional arg, 3 client files

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status |
| --- | --- |
| I. No real operational data | Pass: tests and docs use `pve1`, `media`, `192.168.1.x`-style example values only. |
| II. Code quality | Pass: occupied-MID derivation lives once in `src/lib/targets.ts` next to `resolveMid`; the client duplicates only the tiny suggestion loop, as it already does (separate build, no `src/` imports). Web authorization treated as a correctness requirement. |
| III. Testing | Pass: route test (admin vs restricted, hidden host omitted, numbers only), `checkVmidAvailable` tests with/without predicate (FakeSSHClient), operation-level preview test, web-client lib tests for suggestion and warning. Each bug fix has a test that fails today. |
| IV. UX consistency | Pass: dry run unchanged; CLI/MCP/web errors share one function, differing only by the caller's visibility; error still says what to do (choose a different MID). Browser check at desktop + ≤640px for the warning. CLAUDE.md permissions bullet updated. |

No violations; Complexity Tracking not needed. Re-checked after Phase 1: still passes.

## Project Structure

### Documentation (this feature)

```text
specs/016-mid-suggestion-hidden-guests/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── used-mids.md
└── tasks.md             # /speckit-tasks
```

### Source Code (repository root)

```text
src/
├── lib/targets.ts                 # + usedMidsByHost(inventory, hostNames); checkVmidAvailable(..., canSeeGuest?)
├── operations/types.ts            # + OperationDeps.canSeeGuest?
├── commands/provisioning/
│   ├── install-app.ts             # pass deps.canSeeGuest to checkVmidAvailable
│   └── migrate-guest.ts           # same
└── web/routes/provisioning.ts     # + GET /used-mids; deps(req) builds canSeeGuest

web-client/src/
├── lib/mid.ts                     # nextAvailableMid(host, usedMids); midCollisionMessage(...)
├── components/MidInput.tsx        # warning from midCollisionMessage
├── components/FieldInput.tsx      # pass usedMids to MidInput
└── pages/ProvisioningForm.tsx     # load used-mids; suggestion/collision from it

test/
├── lib/targets.test.ts (or existing file)   # usedMidsByHost, checkVmidAvailable predicate
├── web/routes/provisioning.test.ts          # used-mids route; restricted preview error
└── web-client/mid.test.ts                   # suggestion + warning text
```

**Structure Decision**: existing single-repo layout; no new directories besides the spec.
