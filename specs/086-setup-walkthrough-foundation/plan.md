# Implementation Plan: First-run setup walkthrough foundation

**Branch**: `issue-86-setup-walkthrough-foundation` | **Date**: 2026-10-05 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/086-setup-walkthrough-foundation/spec.md`

## Summary

On a fresh install, the web service starts in a *setup pending* phase. It keeps a setup record and a one-time token in a new `setup_state` table, logs the setup address on every start, and gates every other route until setup finishes. The token is exchanged once for an HttpOnly, SameSite=Strict cookie that works over plain HTTP. The walkthrough has three parts:

- **Step 1 (Proxmox)** gives Bellhop its own ed25519 key (`ssh2` keygen, under `data/ssh/`) or uses a supplied key. It installs the key with a one-time password connection (a new `password` option on the one SSH client) or by hand, tests the node, saves the host under its node name, and runs the existing `sync-inventory` Operation. It also lists cluster peers and suggests a `midScheme` from the bridge network.
- **Step 2** saves `domain`, which becomes an ordinary validated setting, plus the optional basics.
- **Finish** marks setup finished and drops the token.

Separately, `import-yaml-inventory` and `hosts.yaml.example` are removed, and a demo seed script replaces them for contributors. Research: [research.md](research.md).

## Technical Context

**Language/Version**: TypeScript (strict) on Node.js (CI matrix as today), run via `tsx`

**Primary Dependencies**: express, better-sqlite3, zod, ssh2 (its `utils.generateKeyPairSync` and `utils.parseKey`), React + react-router (web-client)

**Storage**: `inventory/bellhop.db`, with the new `setup_state` table and `domain` moved into settings (same `meta` row). Key files under `data/ssh/`.

**Testing**: `node --test` via `npm test`; `FakeSSHClient` for every remote call; temp SQLite fixtures; `supertest`-style requests against `buildApp`, as the existing route tests do

**Target Platform**: The Bellhop web service (Windows service or LXC); browsers at desktop and ≤640px

**Project Type**: web service + React client + CLI (single repo)

**Performance Goals**: Each step action completes within the time of its SSH round trips (seconds); no new background work

**Constraints**: Setup runs over plain HTTP before TLS exists; the password is never persisted; POSIX-sh rule unaffected (host-targeted commands only)

**Scale/Scope**: One install, one to a few Proxmox nodes per walkthrough

## Constitution Check

*GATE: checked before Phase 0, re-checked after Phase 1.*

| Principle | Check | Status |
|---|---|---|
| I. No real data | Spec, contracts, fixtures and screenshots use RFC 5737 addresses, `pve1`/`pve2`, `example.com`. The Proxmox fixtures are captured live and redacted, by the operator (R7). | Pass |
| II. Code quality | The password path is added to `Ssh2SSHClient`; remote calls use `runRemote`, or `ssh.exec` with `SshTarget` for a host not yet in inventory (the existing `pve` branch shape). Request bodies use zod. `domain` validation lives in `SettingsSchema`, and the subdomain rule in `validateInventory`. | Pass |
| III. Testing | Every new module and route has `node --test` coverage with `FakeSSHClient` and temp DBs; captured Proxmox fixtures. `Ssh2SSHClient`'s password path is manually verified on a lab node (recorded in the PR). | Pass (manual item recorded) |
| IV. UX consistency | Dry run: setup actions are explicit operator-confirmed steps with the action shown first (the key line, the host to save); there is no CLI equivalent (#70 decision). `domain` is one rule for `set-config` and the Settings page. Mobile verification required. Docs updated in the same change. | Pass |

**Post-design re-check**: no violations; the Complexity Tracking table is empty.

## Project Structure

### Documentation (this feature)

```text
specs/086-setup-walkthrough-foundation/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/http-setup.md
├── checklists/requirements.md
└── tasks.md            (speckit-tasks)
```

### Source Code (repository root)

```text
src/lib/
├── setup-state.ts          # NEW: setup_state table: load/create/completeStep/finish, phase()
├── bellhop-key.ts          # NEW: ensureBellhopKey, keyFromFile, publicKeyLine
├── mid-suggest.ts          # NEW: suggestMidScheme(network, otherHosts)
├── pve-discovery.ts        # NEW: parse /version, /cluster/status, bridge address info
├── ssh-client.ts           # password option in SshTarget/connectConfig
├── authorized-keys.ts      # sshDir argument on buildAuthorizedKeysEnsurePresentScript
├── inventory.ts            # domain -> SettingsSchema; subdomains-need-domain rule
├── hostname.ts             # requireDomain()
└── CLAUDE.md               # setup_state table, domain setting, Bellhop key
src/web/
├── setup/
│   ├── service.ts          # NEW: SetupService (phase cache, token check, finish)
│   ├── gate.ts             # NEW: setupGate middleware + cookie helpers
│   └── proxmox.ts          # NEW: install-key / test / save-host / peers logic
├── routes/setup.ts         # NEW: /setup page route + /api/setup router
├── app.ts                  # mount gate + setup routes first
├── server.ts               # create setup row/token, log the address
├── routes/jobs.ts          # refuse WS upgrade while pending
├── routes/settings.ts      # domain in the settings response
└── CLAUDE.md               # "First-run setup" section
src/commands/maintenance/import-yaml-inventory.ts   # DELETED
src/cli.ts                  # registration removed
web-client/src/
├── pages/SetupPage.tsx     # NEW: step list + panels
├── api/client.ts           # 503 setupRequired -> /setup
├── App.tsx                 # /setup route outside the shell
├── pages/SettingsPage.tsx  # domain field
└── index.css               # setup layout (mobile-first)
scripts/demo/seed-db.ts     # NEW
inventory/hosts.yaml.example  # DELETED
test/lib/{setup-state,bellhop-key,mid-suggest,pve-discovery}.test.ts   # NEW
test/web/setup/{gate,routes}.test.ts                                   # NEW
test/scripts/demo/seed-db.test.ts                                      # NEW
test/fixtures/proxmox/{version,cluster-status,cluster-status-standalone,network}.json  # NEW (captured, redacted)
test/commands/import-yaml-inventory.test.ts   # DELETED
docs: README.md, CONTRIBUTING.md, docs/configuration.md, docs/environment-variables.md,
      docs/reverse-proxy/README.md, CLAUDE.md, src/commands/maintenance/CLAUDE.md
```

**Structure Decision**: The existing single repo (`src/` service and CLI, `web-client/` React, `test/` mirrors `src/`). Setup gets its own `src/web/setup/` directory, beside `src/web/login/`, because it is an auth-adjacent mode of the web service with three cooperating pieces.

## Complexity Tracking

No violations.
