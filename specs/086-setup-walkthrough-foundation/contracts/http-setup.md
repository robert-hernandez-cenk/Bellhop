# HTTP contract: setup walkthrough (#86)

Every `/api/setup/*` route except `GET /api/setup/status` requires the `bellhop_setup` cookie while the phase is `pending`:
- no cookie, or a wrong one: `401 { error: 'Setup authorization required -- open the setup address from the service log' }`;
- when the phase is not `pending`: `404 { error: 'Setup is not in progress' }`.

Request bodies are JSON and validated with zod. A failure answers `400 { error }`, naming the field and never echoing a password.

## Gate (all other routes while `pending`)

| Request | Response |
|---|---|
| `/api/*` (not `/api/setup/*`) | `503 { error: 'Setup is in progress -- open the setup address from the service log', setupRequired: true }` |
| `/auth/*` | same 503 |
| `GET /setup?token=<valid>` | `303 Location: /setup`, `Set-Cookie: bellhop_setup=…; HttpOnly; SameSite=Strict; Path=/` |
| `GET /setup?token=<invalid>` | `303 Location: /setup` (no cookie) |
| `GET /setup` | the client app (the page asks `/api/setup/state` and shows "open the setup address" on 401) |
| page `GET`/`HEAD` (no file extension) | `303 Location: /setup` |
| static asset (path with extension) | served |
| WebSocket upgrade `/ws/jobs/:id` | `503`, connection closed |

When the phase is `finished` or `not-applicable`, the gate does nothing and `GET /setup` redirects to `/`.

## Routes

### `GET /api/setup/status` (no cookie needed)
`200 { phase: 'pending' | 'finished' | 'not-applicable' }`

### `GET /api/setup/state`
`200 { completedSteps: StepId[], requiredSteps: StepId[], hosts: HostSummary[], settings: { domain?, dnsServer?, backupStorage?, nfsServer? }, key: { mode: 'generated' | 'file', path, publicKey } | null, storages: string[] }`

- `HostSummary` = `{ name, address, user, port, midScheme?, suggestedMidScheme? }`.
- `storages` lists the storage names discovered on the hosts, as suggestions for `backupStorage`.

### `POST /api/setup/key`
Body `KeyChoice`. `generated`: ensures the generated key exists. `file`: parses the named file (encrypted or unparseable: 400 with the reason).
`200 { mode, path, publicKey, authorizedKeysLine }`

### `POST /api/setup/hosts/install-key`
Body `InstallKeyRequest`. One password connection that ensures the key line is in the user's `authorized_keys`.
`200 { installed: true }`; on failure `502 { error }` (fixed text such as `password login failed for root@192.0.2.10:22 -- check the password, or add the key by hand`).

### `POST /api/setup/hosts/test`
Body `HostEndpoint`. Key-based connection test.
`200 { nodeName, version }`; on failure `502 { error }` (unreachable, port closed, key refused, not a Proxmox node).

### `POST /api/setup/hosts`
Body `HostEndpoint`. Tests the connection, upserts the host under its node name, runs the `sync-inventory` apply, and lists cluster peers.
`200 { host: HostSummary, peers: { name, address, inInventory: boolean }[], syncSummary: string }`. A name collision with a guest or external site gives `409 { error }`.

### `PUT /api/setup/hosts/:name/mid-scheme`
Body `MidSchemeInput`. Saves the host's `midScheme`, and marks step `proxmox` complete when at least one host has one.
`200 { host: HostSummary, completedSteps }`

### `PUT /api/setup/basics`
Body `BasicsInput`. Saves the values through `SettingsSchema` and the inventory save, and marks `basics` complete.
`200 { settings, completedSteps }`

### `POST /api/setup/finish`
A required step incomplete: `409 { error: 'Finish step <id> first' }`. Otherwise it marks setup finished and drops the token.
`200 { redirect: '/' }`, and the response clears the `bellhop_setup` cookie.
