# Research: First-run setup walkthrough foundation (#86)

## R1. Where setup state lives

**Decision**: A new `setup_state` table in `inventory/bellhop.db`, owned by a new `src/lib/setup-state.ts` (single row, `CHECK (id = 1)`): `status` (`pending`/`finished`), `token` (nullable), `completed_steps_json`, `updated_at`. It sits outside `saveInventory`'s delete-and-reinsert list, like `task_schedules` and `app_update_status`, and opens through `openDb` with its own `CREATE TABLE IF NOT EXISTS`.

**Rationale**: It must survive restarts (FR-003) and never be touched by the full-replace save. The inventory's `meta` table is rewritten by every `saveInventory`, so it can't hold this. A separate file under `data/` would split one install's state across two files and make "is this install set up?" depend on which `data/` directory the service is pointed at.

**Alternatives**: `meta` rows (wiped by saves); `data/setup.json` (a second source of truth beside the database that decides whether hosts exist).

## R2. When setup is pending

**Decision**: `setupPhase(inventoryPath, inventory)` returns:
- `pending` when the row says `pending`;
- `finished` when the row says `finished`;
- with no row: `pending` if the inventory has no hosts, otherwise `not-applicable`.

At start-up (`server.ts`), a `pending` phase with no row creates the row (status `pending`, new token). Once a row exists, host count no longer matters, because step 1 adds hosts midway through setup.

**Rationale**: An existing deployment upgrading has hosts and no row, so it never sees the walkthrough. A fresh install gets a row at its first start. "Never shown again" (#70) is the persisted `finished`, which wins even if every host is later deleted.

**In-process caching**: `SetupService` (`src/web/setup/service.ts`) loads the phase once at start-up and is the only writer, so it keeps the phase in memory and updates it on finish. No per-request database read.

## R3. Token and browser authorization

**Decision**:
- **Token**: 32 random bytes (`crypto.randomBytes`), base64url. Stored in plain text in `setup_state.token`, consistent with how the settings store keeps secrets (plain text, write-only). It is kept rather than rotated on restart, so a token the installer (#67) printed stays valid.
- **Logging**: `server.ts` logs `Setup is pending: open http://<host>:<port>/setup?token=<token>` on every start while pending. The host part is `localhost`, because the service doesn't know its public address; the log line says to substitute the machine's address.
- **Exchange**: `GET /setup?token=<t>` with a valid token sets the cookie `bellhop_setup=<t>` (HttpOnly, `SameSite=Strict`, `Path=/`, no `Secure`, no `Max-Age`, so it lives for the browser session) and answers `303` to `/setup`. An invalid token answers `303` to `/setup` without a cookie, and the page then shows "open the setup address from the service log".
- **Checks**: `/api/setup/*` requires the cookie, compared with `crypto.timingSafeEqual` over SHA-256 digests (equal length).

**Rationale**: Setup runs over plain HTTP before any proxy or TLS exists (FR-004), so the cookie can't be `Secure`. `SameSite=Strict` plus JSON-only POST bodies block cross-site form posts. Using the token as the cookie value avoids a second session store for a one-time flow.

**Alternatives**: rotating the token per start (breaks the installer-printed URL); a `Bearer` header (the token would sit in client JavaScript memory and be reachable by script).

## R4. Gate while pending

**Decision**: `setupGate(setup)` is the first middleware in `buildApp`, ahead of `/auth` and `requireAuth`. While the phase is `pending`:
- `/api/setup/*`: passed through to the setup router, which checks the cookie itself.
- Any other `/api/*` request: `503 { error: 'Setup is in progress -- open the setup address from the service log', setupRequired: true }`.
- `/auth/*`: the same 503.
- `GET /setup` (with or without `?token`): handled by the setup page route.
- A request for a static asset (path with a file extension, not `/api`/`/auth`): passed through so the client bundle loads.
- Any other page `GET`/`HEAD`: `303` to `/setup`.

The job-log WebSocket upgrade (`attachJobsWebSocket`) refuses with 503 while pending. When the phase is `finished` or `not-applicable`, the gate is a no-op, and `/api/setup/*` answers 404 except `GET /api/setup/status`, which reports the phase.

**Client**: `check()` in `web-client/src/api/client.ts` navigates to `/setup` on a 503 with `setupRequired`. `App.tsx` routes `/setup` to a standalone `SetupPage` outside the sidebar shell.

## R5. Bellhop's own SSH key

**Decision**:
- **Generated key**: generated with `ssh2`'s `utils.generateKeyPairSync('ed25519', { comment: 'bellhop' })` (OpenSSH format). It is written to `<dataDir>/ssh/id_ed25519` (mode 0600 where the OS supports it) and `id_ed25519.pub`, by `src/lib/bellhop-key.ts` (`ensureBellhopKey`, `readBellhopPublicKey`).
- **Host entries**: hosts added by the walkthrough record `ssh_identity_file` as that absolute path.
- **Supplied key**: the operator may name an existing key file instead. It is parsed with `ssh2`'s `utils.parseKey`; an encrypted key, or a file that doesn't parse, is refused with the reason. The public half is derived from the parsed key (`getPublicSSH()`), so no `.pub` file is required.

**Rationale**: `ssh2` is already the only SSH library, and its keygen produces the format `resolvePrivateKey` already reads. A key under `data/` belongs to the Bellhop install and is not the operator's personal `~/.ssh` key, so it can be revoked per install. Recording the path per host keeps the existing `ssh_identity_file` resolution as the only lookup.

**Alternatives**: writing to `~/.ssh/id_ed25519` (could clobber or silently reuse an operator's personal key); storing the private key in the settings store (`Ssh2SSHClient` reads keys from files, so a second path would be needed).

## R6. One-time password connection

**Decision**: `SshTarget` gains an optional `password`. `Ssh2SSHClient.connectConfig` uses `password` (plus `tryKeyboard: true` and a `keyboard-interactive` handler answering every prompt with the password, because many sshd configs only offer keyboard-interactive) when it is set, and no key or agent in that case. Only `src/web/setup/proxmox.ts` builds a target with a password. It is never part of a `HostEntry`, and `hostSshTarget` never sets it.

**Password handling**: the password arrives in one POST body. It is validated by zod (non-empty, no control characters), used for exactly one `exec`, and dropped. Errors are rewritten to fixed text ("password login failed for root@<address>"), so an ssh2 error can never echo it. It is never logged, since the setup routes don't use the job runner.

**Key-install script**: `buildAuthorizedKeysEnsurePresentScript` hardcodes `/root/.ssh`. It gains an optional `sshDir` argument (default `/root/.ssh`, so existing callers are unchanged), and the walkthrough passes `/root/.ssh` for `root` and `/home/<user>/.ssh` otherwise. This targets the `pve` branch, so it runs in the host's login shell, as the existing `sync-ssh-keys` host path does.

## R7. Testing the connection and discovering the cluster

**Decision**:
- **Test**: the connection test runs `hostname && pvesh get /version --output-format json` over the key. A zero exit plus a JSON object with `version` confirms a Proxmox node, and the node name is the `hostname` line.
- **Cluster peers**: `pvesh get /cluster/status --output-format json` lists the cluster. Entries with `type: "node"` other than the local one (`local: 1`) are offered as peers with their `ip`. A standalone node returns only itself, so nothing is offered.
- **Fixtures**: the Proxmox responses for `/cluster/status`, `/nodes/<node>/network` and `/version` must be captured from a live node and redacted (constitution III). That capture needs the operator: reading production hosts is not something the implementing session may do on its own. Implementation pauses for it at the fixture task.

**Alternatives**: `pvecm nodes` (text output, and only on clustered nodes); `corosync.conf` parsing (the wrong layer).

## R8. midScheme suggestion

**Decision**: from the host's `pvesh get /nodes/<node>/network` output, pick the bridge carrying the host's own address (`address`, `cidr`, `gateway`), preferring an active bridge that has a `gateway`. The suggestion is:
- `ipPrefix`: the first three octets of that address plus `.`
- `cidrSuffix`: the bridge's prefix length
- `gateway`: the bridge's gateway
- `vmidBase`: the smallest multiple of 1000 (starting at 1000) not used by another host's `midScheme`

No suggestion is offered when no bridge has an IPv4 address. The values are validated with `MidSchemeSchema` on save. Pure function `suggestMidScheme(network, otherHosts)` in `src/lib/mid-suggest.ts`.

**Rationale**: VMIDs are cluster-wide, so bases need disjoint 2–252 ranges; multiples of 1000 are far apart and easy to read. Proxmox needs VMIDs ≥ 100, so 0 is never suggested.

## R9. Reusing sync-inventory

**Decision**: after a host is saved, the walkthrough runs the existing `sync-inventory` Operation's `apply` (`MAINTENANCE_OPERATIONS['sync-inventory']` in `src/operations/maintenance.ts`) with the shared `inventory`, `inventoryPath` and `ssh`. That apply already reloads settings before saving and refreshes the in-memory copy. Calling the Operation, rather than a copy, keeps FR-012's "the same way `sync-inventory` does". It reconciles every host in inventory, which during setup means only the walkthrough's own hosts.

## R10. Domain as a setting

**Decision**:
- **Schema**: `domain` moves into `SettingsSchema` as an optional DNS name (`^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z][A-Za-z0-9-]{0,62}$`, fixed message "must be a domain name such as example.com"). `InventorySchema` drops its own required `domain`.
- **Load and save**: `loadInventory` reads it through `SETTINGS_KEYS` like any other setting. `saveInventory` writes or deletes it the same way.
- **Validation**: `validateInventory` gains "an entry has subdomains but no domain is set", with the `settingFix('domain', '<domain>')` remedy. That rule refuses clearing the domain through `set-config --unset` or the Settings page while any entry has subdomains, because both save through `saveInventory`.
- **Callers**: each `inventory.domain` reader that needs a value calls `requireDomain(inventory)` (in `src/lib/hostname.ts`), which throws the same remedy when it is unset. The compiler finds every such reader, since the type becomes `string | undefined`.
- **Settings page**: shows `domain` first in its general section, with help text.

**Rationale**: One validation rule shared by set-config, the Settings page and the walkthrough (FR-017, FR-023). A fresh database loads with no domain (FR-024).

## R11. Seed script

**Decision**: `scripts/demo/seed-db.ts <path>` imports the demo inventory from `scripts/demo/demo-inventory.ts` and calls `saveInventory(path, inventory)`, refusing an existing file unless `--force` is given. It is exposed as `npm run demo:seed -- <path>`. CONTRIBUTING and `docs/environment-variables.md` point at it for CLI work against a sample database.

## R12. Step execution model

**Decision**: step actions are synchronous HTTP calls (each lasts seconds: one SSH round trip, or `sync-inventory` over one to three hosts) that return their result directly, not jobs. Each action is idempotent: key install runs the ensure-present script, the host save upserts by node name, sync merges, and settings writes are plain sets.

**Rationale**: The job runner's WebSocket needs a signed-in identity and job ownership; neither exists during setup. #90, which streams `install-app`, is where jobs enter the walkthrough.
