# HTTP contract: setup walkthrough, proxy step (#87)

Extends [`specs/086-setup-walkthrough-foundation/contracts/http-setup.md`](../../086-setup-walkthrough-foundation/contracts/http-setup.md). The same gate applies: each route needs the `bellhop_setup` cookie while the phase is `pending` (`401` without it, `404 { error: 'Setup is not in progress' }` otherwise). Bodies are JSON validated with zod; a failure is `400 { error }` naming the field and never echoing a value.

`GET /api/setup/state` gains `'proxy'` in `requiredSteps` (after `basics`) and in `completedSteps` when done. `POST /api/setup/finish` answers `409 { error: 'Finish step "Reverse proxy" first' }` while it is incomplete.

## `GET /api/setup/proxy`

`200 ProxyStepState` (see [data-model.md](../data-model.md)). Secrets appear only as booleans.

## `PUT /api/setup/proxy`

Body `ProxyChoice`. Validates everything first, then writes in one pass: the inventory (settings and proxy flag), then each secret that has a non-empty value. Nothing is written if validation fails.

| Status | When |
|---|---|
| `200 { state: ProxyStepState }` | saved (also when nothing changed). `state.complete` is `true` right after saving `none`, and `false` after saving any other changed choice |
| `400 { error }` | a field fails its `SettingsSchema`/secret rule, a required value is missing (`entry` for a managing driver; the Cloudflare token under DNS-01 with none stored. Certificate and key paths are never required: they default from `domain`), or the entry is not a host or guest in inventory |
| `400 { error }` | the effective `tlsSource` is not supported by the driver: the `checkTlsSource` message, with the supported list |
| `400 { error }` | a key in the body is pinned by an environment variable: names the variable and file, telling the operator to unset it and restart the service |

## `POST /api/setup/proxy/check`

No body. Runs against the stored choice (save first). Requires a managing driver (`none` answers `400 { error: "No proxy needs no check" }`).

| Status | When |
|---|---|
| `200 ProxyCheckResult` with `ok: true` | the driver check passed. The step is marked complete only when `previewError` is absent; with `previewError` the response is still `200` and the step stays incomplete |
| `502 { error }` | the check failed (entry unreachable, config missing, validation failed, API unreachable, sign-in refused). The text names the entry or the setting to change and never contains a secret |
| `400 { error }` | no proxy entry is chosen yet |

The check and the dry run issue no write, backup, restore or reload to the proxy; they read through `runRemote`, the admin API read path, or the NPM client's reads.

## Messages (examples, `example.com` values only)

- `proxy entry 'proxy-lxc' could not be reached: <reason>`
- `Caddyfile not found at /etc/caddy/Caddyfile on 'proxy-lxc' -- set the Proxy config path (bellhop set-config proxyConfigPath <path> --apply)`
- `nginx -t failed on 'proxy-lxc': <proxy output>`
- `Traefik API at http://192.0.2.30:8080 answered HTTP 404`
- `Nginx Proxy Manager at http://192.0.2.30:81 refused the sign-in -- check npmApiEmail and npmApiPassword`
- `tlsSource 'internal' is not supported by the 'nginx' proxy driver (it supports: ...) -- ...`
