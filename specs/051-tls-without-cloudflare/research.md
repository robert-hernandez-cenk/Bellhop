# Research: TLS Without Cloudflare (issue #51)

All Caddy behaviour below was observed with a real Caddy **v2.10.2** (the
official Windows release, no extra modules), run locally against example data
only. The adapter captures are committed as
`test/fixtures/caddy/tls-{letsencrypt,internal,files}-adapted.json`; the
`cloudflare` capture already exists as `characterization-adapted.json`
(issue #26, built with `caddy-dns/cloudflare`).

## R1 — What Caddy's adapter produces per mode

The input was the file-based driver's characterization block
(`EXPECTED_LINES` in `test/lib/proxy/drivers/caddy.test.ts`, markers removed),
with every `tls { dns cloudflare … }` clause replaced by the mode's clause, then
`caddy adapt --adapter caddyfile --pretty`.

| Mode | Caddyfile clause per site | Adapter output besides routes |
|---|---|---|
| `cloudflare` | `tls { dns cloudflare {env.CLOUDFLARE_API_TOKEN}` / `resolvers 1.1.1.1 8.8.8.8 }` | one automation policy, ACME issuer with the Cloudflare DNS challenge (unchanged from #26) |
| `letsencrypt` | none | **no `tls` app at all**; server is just `{listen: [":443"], routes}` |
| `internal` | `tls internal` | one automation policy `{subjects: [every host], issuers: [{module: "internal"}]}` |
| `files` | `tls <cert> <key>` | `apps.tls.certificates.load_files: [{certificate, key, tags: ["cert0"]}]` and, on the server, `tls_connection_policies: [{match: {sni: [every host]}, certificate_selection: {any_tag: ["cert0"]}}, {}]` |

Routes are byte-identical in every mode (verified `letsencrypt` vs `files`), so
only TLS objects vary. The trailing `{}` connection policy is a catch-all the
adapter always appends once any connection policy exists; without it, a
handshake whose SNI matches no policy is refused.

**Decision**: `renderRoute` stays mode-independent; a new mode-aware renderer
produces the TLS objects, pinned by parity tests against these fixtures with
only Bellhop's `@id`s and tag name differing.

## R2 — Ownership tags on the new object kinds

Verified live: a configuration with `@id` on a `load_files` entry and on both
connection policies loads, serves the loaded certificate for a matching SNI,
and `GET /id/<id>` returns the tagged object.

**Decision**: Bellhop's objects are
- automation policy `bellhop-tls` (existing id; `cloudflare` and `internal`),
- `load_files` entry `bellhop-tls-files` with certificate tag `bellhop-cert`
  (in place of the adapter's `cert0`),
- connection policy `bellhop-tls-connection` (SNI-matched, selects
  `bellhop-cert`),
- catch-all connection policy `bellhop-tls-default` (`{}` plus the id).

**Alternatives considered**: keeping the adapter's `cert0` tag — rejected, since
an operator's own `tls cert key` site would also produce `cert0` and Bellhop's
policy would then select the operator's certificate.

## R3 — Reconciling the new objects

`planCaddyConfig` already strips every Bellhop-tagged route/policy and prepends
the desired ones. The same rule extends to the new objects:

- `load_files`: strip `bellhop-` entries, prepend the desired one (order is
  irrelevant to Caddy); prune `certificates.load_files`/`certificates` when left
  empty, as the policy path prunes `automation`.
- Connection policies live on the **same server** Bellhop's routes go to
  (`targetServer`). Strip `bellhop-` policies from every server; on the target
  server prepend `bellhop-tls-connection`, and append `bellhop-tls-default` only
  when no untagged policy without a `match` remains on that server (an operator
  catch-all already does the job, and two catch-alls would be redundant). A
  server whose list becomes empty loses the `tls_connection_policies` key.
- Nothing is written when no route is kept, in any mode (same as today's
  policy).

Switching modes is just this rebuild (spec FR-006); no migration code.

## R4 — Conflicts by mode

Today an untagged route or an untagged automation policy naming a Bellhop
hostname makes that route a conflict. An automation policy only collides with
Bellhop when Bellhop writes one itself.

**Decision**: untagged automation policies claim hostnames only in `cloudflare`
and `internal` modes. In `letsencrypt` and `files`, an operator policy naming a
Bellhop host is intended to apply (the spec's catch-all edge case, extended to
subject-specific policies). Untagged connection policies and `load_files` never
claim hostnames: Bellhop's SNI policy is prepended, so it wins first-match.
Untagged routes remain conflicts in every mode.

## R5 — Failure paths (spec FR-013)

Verified live:
- `caddy validate` of the `files` Caddyfile with missing paths exits 1 with
  `loading certificates: open /etc/letsencrypt/live/example.com/fullchain.pem:
  …` — the file driver's existing trap restores the backup and reports it.
- `PATCH /config/` naming a missing certificate file returns **500**
  (`loading new config: … loading certificates: open …`) and the previous
  configuration keeps serving — `writeCaddyConfig`'s existing non-2xx path
  reports it.
- `internal` and `letsencrypt` Caddyfiles validate (exit 0) on a stock build.
- The `cloudflare` clause on a stock build fails adapt with
  `module not registered: dns.providers.cloudflare`.

**Decision**: no advance checks; nothing new to handle.

## R6 — Quoting certificate paths in the Caddyfile

`SettingsSchema` only requires `proxyTlsCertificate`/`proxyTlsKey` to start with
`/`, so a path could contain a space. **Decision**: emit the path bare when it
contains no whitespace or `"`; otherwise as a Caddyfile double-quoted token with
`\` and `"` backslash-escaped. Default certbot paths never need quoting, so
parity fixtures are unaffected.

## R7 — Where the mode lives

**Decision**: `ProxyContext` gains `caddyTls: CaddyTlsMode`, resolved by
`buildProxyContext` (unset → `cloudflare`), the same "always present" precedent
as `certResolver` and `tls`. One exported `caddyTlsMode(inventory)` resolves it
for both `buildProxyContext` and the capability function.

## R8 — The Cloudflare-prune signal becomes a function

**Decision**: `DriverCapabilities.acmeDns01ViaCloudflare` changes type from
`boolean` to `(inventory: Inventory) => boolean`. Caddy drivers return
`caddyTlsMode(inventory) === 'cloudflare'`; Traefik returns
`(proxyCertResolver ?? default) !== 'none'`; every other driver `() => false`.
`pruneAcmeChallengesLive` calls it with the live inventory.

**Alternatives considered**: `boolean | (inventory) => boolean` — rejected; two
shapes for one field means every reader branches, and Bellhop is pre-release so
a breaking contract change is fine. A separate method beside the capabilities
object — rejected; it's still a capability, and keeping it there leaves
`checkCapabilities`'s neighbour unchanged.

## R9 — Traefik's reserved `none`

`proxyCertResolver`'s regex already admits `none`. **Decision**: an exported
`NO_CERT_RESOLVER = 'none'` constant; each of the three router sites renders
`tls: {}` when `ctx.certResolver === NO_CERT_RESOLVER`. Traefik serves its
default certificate or matching ones from its file provider for a router with
`tls: {}`. The API check is unaffected (it checks router status only).

## R10 — Nginx Proxy Manager and custom certificates

The captured live NPM 2.16 fixture `test/fixtures/nginx-proxy-manager/
certificates-list.json` holds an uploaded custom certificate: `provider:
"other"`, `domain_names` taken from the certificate's names, and a real
`expires_on`. `chooseCertificate` picks any unexpired certificate covering every
route hostname regardless of provider, so an uploaded self-signed certificate
covering the hosts (a wildcard works) is reused and no Let's Encrypt request is
made. A route with no covering certificate gets an HTTP-01 request (NPM's
default, `dns_challenge` not sent). **Decision**: documentation only.

## R11 — Settings page

The Settings response gains `caddyTlsModes` (the enum, in order) and
`defaultCaddyTls` (`cloudflare`) so the client never hardcodes them; each
driver's info gains `usesCaddyTls`. `proxyFieldView` takes the selected Caddy
TLS mode (unsaved draft, else default) and returns `showCaddyTlsField`, with
`showTlsFields` now `usesSharedCertificate || (usesCaddyTls && mode === 'files')`.
The dropdown renders like `proxyDriver`'s, default suffixed `" (default)"`.

The Settings screenshot `docs/images/settings-proxy-driver.png` shows a Caddy
driver, so it gains the new dropdown and is regenerated with `npm run
docs:screenshots`.
