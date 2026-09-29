# Data model: Web UI screenshots from a demo instance

No persistent data model changes. The demo builds these in memory and in a temp directory on
every start.

## Demo inventory (`scripts/demo/demo-inventory.ts`)

A function returning a fresh `Inventory` (the existing zod-validated type from
`src/lib/inventory.ts`) each time it is called, so one demo run's edits can never leak into the
next.

- `domain`: `example.com`
- Settings: `backupStorage: 'nas-backup'`,
  `dnsServer: 198.51.100.53`, `nfsServer: 198.51.100.50`.
- Hosts (2): `pve1` and `pve2`, `ssh_user: root`, `ssh_target` in `192.0.2.0/24`; each with a
  `midScheme` (`vmidBase` 1000/2000, `ipPrefix` `198.51.100.`/`203.0.113.`, a gateway in the same
  range), one or two `bridges`, and `storages` covering `vztmpl`, `rootdir`, `images`, and one
  `nfs` backup storage.
- Guests (9–10) across both hosts, both `lxc` and at least one `vm`, IPs from each host's range.
  Coverage the screenshots need:
  - one guest with `proxy: true` (the reverse proxy, e.g. `proxy`, app `caddy`),
  - one guest with `authentik: true` (e.g. `auth`),
  - several with `subdomains` and a `port`, some with more than one subdomain,
  - `authGroup` set on some, at two or more different ladder rungs,
  - exactly one guest with `authMode: 'oidc'`, `authGroup` set, and `oidcRedirectUris` (the
    Access tab screenshot),
  - several with `app` set (drives the Update page's app-update icon),
  - one with `unauthenticatedPaths` (e.g. `/api/*`).
- Status (from `DemoSSHClient`, not stored in inventory): most guests `running`, one or two
  `stopped`.

Validation: must pass `validateInventory` (the load path runs it), checked by a test.

## Seeded job

Created in the demo's own jobs database; fields as `JobStore` already defines them.

| Field | Values |
| --- | --- |
| command | `install-app`, `update-all`, `sync-inventory`, `update-app` |
| status | `success` for three, `failed` for one |
| target | a demo guest or host name, or none for fleet-wide jobs |
| triggered_by_username | `admin` |
| created/started/finished | fixed ISO timestamps on one fixed date, a few minutes apart |
| log | 15–40 lines of plausible output using only demo names and addresses |

## Screenshot definition (`scripts/screenshots.ts`)

```text
{ file, path, viewport: 'desktop' | 'phone', theme: 'light' | 'dark',
  ready: selector, prepare?: (page) => interaction, target?: selector }
```

- `file`: stable name under `docs/images/` (FR-013).
- `path`: route to open (`/`, `/update`, `/jobs/<id>`, ...).
- `ready`: a selector that exists only after the page's data has loaded; capture fails naming
  `file` if it does not appear.
- `prepare`: optional interaction (type into the App field, open a guest's Advanced modal and
  pick the Access tab).
- `target`: optional element to capture instead of the viewport (a modal, a settings section).

The list itself is data, kept separate from the capture loop, so adding a shot is one entry.
The full set is in `contracts/screenshot-set.md`.
