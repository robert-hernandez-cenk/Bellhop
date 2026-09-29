# Research: OIDC mobile-app redirect URIs, mobile consent step, Access tab

All API shapes below were read (GET only) from a live Authentik 2026.8.2 instance on 2026-09-29. Committed fixtures are redacted copies of those responses: same field names, types, nesting and array lengths, example values only (constitution Principle I / III).

## R1. What counts as a valid mobile redirect URI

- **Decision**: A mobile URI is valid when it has no whitespace or control characters, `new URL(value)` parses it, and its scheme (`url.protocol` minus the colon, lower-cased) is not `javascript`, `data`, `file` or `vbscript`. `http`/`https` are allowed: the audiobookshelf-style `https://…/mobile-redirect` page is a mobile hand-off too. One predicate, `isValidMobileRedirectUri`, next to `isAbsoluteHttpUrl` in `src/lib/inventory.ts`, is shared by the zod schema (`OidcMobileRedirectUriSchema`) and the write-time parser (`parseOidcMobileRedirectUris`). The two can't disagree, the same pattern `oidcRedirectUris` uses.
- **Rationale**: WHATWG URL parsing accepts `app.example:///oauth-callback` and `com.example.app:/callback` (both checked in Node 26, which also lower-cases `JavaScript:` to `javascript:` and turns an embedded space into `%20`), and rejects scheme-less strings. The raw-string whitespace check is needed because `new URL` would silently percent-encode an embedded space. The stored string would then never equal what an app sends.
- **Alternatives considered**: A regex for RFC 3986 `scheme ":" hier-part` — rejected, it duplicates what `URL` already does and is easy to get subtly wrong. An allow-list of schemes — rejected, custom schemes are the point of the feature.

## R2. Where the cross-list duplicate rule lives

- **Decision**: In `oidcConfigErrors(entry)` (`src/lib/inventory.ts`), called only from `commitGuestEdit`, and only for an edit that changed either list (`checkCrossListDuplicates`), so a duplicate already saved never blocks an unrelated edit. The message names each duplicated URI. It's not in `validateInventory()` and not in the zod schema.
- **Rationale**: The existing research R7 of spec 002 and CLAUDE.md's rule: write-time OIDC checks never run on load, so a hand-edited row can't make the inventory refuse to load. A duplicate is harmless to the sync anyway: the client set is deduplicated (R3), and a URI in both lists simply gets the consent click.
- **Alternatives considered**: A zod `superRefine` on each entry schema — rejected, it would run on every load.

## R3. The OpenID client's callback set

- **Decision**: Add a new exported `clientRedirectUris(entry)` in `sync-authentik.ts`. It returns `[...web, ...mobile]` deduplicated in first-seen order. `planOidc` and `adopt-oidc-client` pass it to `desiredOAuth2Settings` instead of `entry.oidcRedirectUris`. `CandidateEntry` gains `oidcMobileRedirectUris`. The "missing redirect URIs" skip still tests the web list only (FR-004). `diffOAuth2Settings` is unchanged: it already compares redirect URIs as a set of `(matchingMode, url)`, so a mobile-only change shows as `redirect_uris` drift and a no-op run reports nothing.
- **Rationale**: One function decides the set, so the sync and adoption can't disagree (FR-007).
- **Alternatives considered**: Storing the mobile URIs with a different matching mode — rejected, the issue wants all `strict`.

## R4. Authentik objects and endpoints for the consent step

Live shapes (redacted fixtures under `test/fixtures/authentik/`):

| Need | Endpoint | Notes (live) |
|---|---|---|
| Find stage by name, any type | `GET /api/v3/stages/all/?name=<n>` | Name filter **works**; result carries `pk`, `name`, `meta_model_name` (`authentik_stages_consent.consentstage` for a consent stage). Stage names are unique across all stage types. |
| Consent stage detail/create/update/delete | `/api/v3/stages/consent/[<pk>/]` | Fields `mode` (`always_require` / `permanent` / `expiring`), `consent_expire_in`. Create body: `{name, mode: 'always_require'}`. |
| Find policy by name, any type | `GET /api/v3/policies/all/?page_size=500` | The `name` query **is ignored** by this endpoint (returned all 16 policies), so match `name` client-side. An expression policy's result includes its `expression`. |
| Expression policy create/update/delete | `/api/v3/policies/expression/[<pk>/]` | Create body `{name, expression, execution_logging: false}`. |
| Flow pk | existing `getDefaultAuthorizationFlowId()` | Already resolves `AUTHENTIK_AUTHORIZATION_FLOW_SLUG` to its pk. |
| Flow-stage bindings of a flow | `GET /api/v3/flows/bindings/?target=<flowPk>` | `target__slug` is **ignored** (returned bindings of every flow), `target=<pk>` works. Each binding has `pk`, `policybindingmodel_ptr_id`, `target`, `stage`, `order`, `evaluate_on_plan`, `re_evaluate_policies`, `policy_engine_mode`, `invalid_response_action`. |
| Create/update/delete a flow-stage binding | `/api/v3/flows/bindings/[<pk>/]` | Create body `{target, stage, order: 10, evaluate_on_plan: false, re_evaluate_policies: true, policy_engine_mode: 'any', invalid_response_action: 'retry'}`. |
| Policy bindings on a flow-stage binding | `GET /api/v3/policies/bindings/?target=<policybindingmodel_ptr_id>` | Filtering by the binding's own `pk` fails ("Select a valid choice"); by `policybindingmodel_ptr_id` it works. The **returned** `target` field shows the binding's `pk`, though. So match a listed policy binding against **either** id, and create with `target: <policybindingmodel_ptr_id>`: the `PolicyBindingModel` primary key, which is also what Authentik's own admin UI sends. |
| Create a policy binding | `POST /api/v3/policies/bindings/` | `{target, policy, order: 0, enabled: true, negate: false, timeout: 30, failure_result: false}`. `failure_result: false` is what makes a policy exception mean "skip the stage" (FR-010). |
| Clear cached flow plans | `POST /api/v3/flows/instances/cache_clear/` | After any change to the binding or the policy (FR-015). |

- **Decision**: Add these as `AuthentikClient` methods (see `contracts/authentik-client.md`), modelled like the existing ones: `Real` against `fetch`, `Unconfigured` throwing, `FakeAuthentikClient` in-memory.
- **Order**: `10`, matching the stock explicit-consent flow's consent binding. Not reconciled after creation, so an operator may move it.

## R5. Rendering the policy expression

- **Decision**: `renderMobileConsentExpression(uris)` produces:

  ```python
  # Managed by Bellhop (sync-authentik). Changes made here are overwritten.
  # Asks for consent only when the login hands off to a mobile app redirect URI.
  MOBILE_REDIRECT_URIS = {
      "app.example:///oauth-callback",
      "https://books.example.com/auth/openid/mobile-redirect",
  }
  params = request.context.get("goauthentik.io/providers/oauth2/params")
  return getattr(params, "redirect_uri", None) in MOBILE_REDIRECT_URIS
  ```

  The URIs are sorted, so the same set always renders the same text and drift is a plain string comparison. Each URI is written by `pythonStringLiteral`: `"` delimiters; `\\`, `\"`, `\n`, `\r`, `\t` escaped; every other character outside printable ASCII (0x20–0x7E) written as `\xHH`, `\uHHHH`, or `\UHHHHHHHH` for code points above U+FFFF. It iterates code points, not UTF-16 units: `JSON.stringify` would emit a surrogate pair as two `\uD8xx\uDCxx` escapes, which Python decodes to two lone surrogates rather than the original character, so the match would silently fail.
- **Marker**: the first line, `# Managed by Bellhop (sync-authentik).`, is `MOBILE_CONSENT_MARKER`. A policy is Bellhop's only if its expression starts with it (FR-013).
- **Fails closed**: a missing params object gives `None`, which is not in the set, so the policy returns False and the stage is skipped. An exception gives the policy binding's `failure_result: false`, same outcome.
- **Rationale**: an exact-match set literal is the whole behavior. Nothing is heuristic, and the rendered text is reviewable in the dry run.
- **Alternatives considered**: Storing the URIs in a context/attribute object Authentik reads at runtime — rejected, more Authentik objects to own for no gain.

## R6. Which mobile URIs are "in effect"

- **Decision**: The union of `oidcMobileRedirectUris` over `desired` candidates (gated, has subdomains) whose `effectiveAuth` is `'oidc'`, regardless of ladder, conflict or skip state. Deduplicated, sorted.
- **Rationale**: FR-011. Including a skipped or conflicting entry costs nothing: a URI whose client doesn't exist can never be a live login's `redirect_uri`. And it keeps the policy stable while an operator fixes the entry, rather than flapping.

## R7. Ownership and conflicts

- **Stage** `bellhop-mobile-app-consent`: found via `stages/all?name=`. Owned if its `meta_model_name` is the consent-stage model; conflict otherwise.
- **Policy** `bellhop-consent-on-mobile-redirect`: found by name in `policies/all`. Owned if it's an expression policy whose expression starts with the marker; conflict otherwise.
- **Stage binding**: any binding on the configured flow whose `stage` is the owned stage's pk. Bindings of that stage on other flows are ignored. With more than one on the flow, the first is reconciled and the rest are left alone.
- **Policy binding**: a binding whose `policy` is the owned policy's pk and whose target is the stage binding (either id, R4). Other policy bindings on the stage binding (hand-added) are left alone.
- **Conflict handling**: a conflicting stage or policy stops the consent reconcile for that run. Nothing is created, updated or deleted. The conflict names the object and says to rename or delete it in Authentik. It's reported in `mobileConsent.conflicts` and never fails the run (FR-017).

## R8. Reconcile algorithm

Given `wanted = uris.length > 0`:

- **Want, nothing exists**: create the stage, then the policy, then the stage binding, then the policy binding, then clear the cache.
- **Want, some exists** (a partial earlier failure, or drift): create what's missing, and PATCH drift. Drift is the stage `mode` ≠ `always_require`, the binding `evaluate_on_plan` ≠ false or `re_evaluate_policies` ≠ true, and the policy `expression` ≠ rendered. Clear the cache if the binding or policy changed.
- **Don't want**: delete only owned objects, in the order policy binding → stage binding → policy → stage, then clear the cache if a binding was deleted.
- **Dry run**: the same plan, reported, not executed. `changes` entries look like `{ object: 'stage'|'binding'|'policy'|'policy-binding', action: 'create'|'update'|'delete', detail? }`. The detail is the drifted field names, or for the policy, the URI set.

## R9. Failure isolation and permissions

- **Decision**: The consent reconcile runs after every other step of `runSyncAuthentik` (after the group-binding pass, before discovery), inside its own `try/catch`. On a thrown error it records `mobileConsent.error` (the message plus "check AUTHENTIK_AUTHORIZATION_FLOW_SLUG and the API token's stage/policy/flow permissions — README 'Authentik API token permissions'"), and the run carries on. `syncAuthentikFailed` becomes true when `applied && mobileConsent?.error`. A conflict alone doesn't make it true.
- **Nothing wanted**: when no mobile URIs are in effect, a failure while *reading* (listing stages/policies/bindings, resolving the flow) is swallowed and reported as nothing to do. This mirrors `listOAuth2ProvidersForRun`. A deployment whose token predates this feature, and which uses no mobile URIs, never sees a new error or a non-zero exit. The trade-off: owned leftovers from an earlier run with an under-permissioned token wouldn't be cleaned up, which is acceptable because that combination can't have created them.
- **Rationale**: FR-017, and the existing FR-015 "one entry's problem never blocks others" pattern.

## R10. Surfacing in the Dashboard push-live step

- **Decision**: `syncProxyLive` logs `mobileConsent.conflicts` and `mobileConsent.error` with `logWarn`, the same as other instance-wide conditions (`missingRungs`), and also returns them as `SyncProxyLiveResult.authentikMobileConsentProblems` (conflicts first, then the error). `commitGuestEdit` echoes that list as `mobileConsentProblems` only when the edit changed the guest's `oidcMobileRedirectUris` (FR-018), and the Dashboard renders it as a warning banner under the mobile redirect URL field. The MCP `edit_guest` tool returns the same result.
- **Rationale**: The Dashboard's guest PATCH runs `syncProxyLive` outside any job, so a `logWarn` alone reaches only the service's stderr; the admin who just saved a mobile URI would never learn the consent step didn't follow. Scoping the echo to edits of that list keeps an instance-wide problem from showing on every unrelated save.

## R11. Access tab

- **Decision**: `AdvancedGuestModal` gets a two-button tab strip (`role="tablist"`, `aria-selected`) and renders one panel at a time; General is the default. Which Access fields show is decided by a framework-free helper, `accessFieldsFor(guest)` in `web-client/src/lib/oidc.ts` (tested with plain `node --test`, like `admin-nav.ts`). It reads the entry's *saved* `authMode ?? 'forward'`, since each field saves independently. One exception: a gated forward-mode guest with no web callback URL also gets the callback URL field, noted "Needed before switching auth mode to OIDC.", since the switch is refused until one exists (`accessFieldsFor(guest)` takes the guest for this). Hidden fields are simply not rendered, so their values are untouched. The new `EditableOidcMobileRedirectUris` lives beside `EditableOidcRedirectUris` in `EditableAuthMode.tsx` and reuses its save and admin handling, with the one help line under it. The existing `OidcCredentials` row keeps its `isOidcEffective` condition inside the OIDC set.
- **Rationale**: Showing by saved mode matches how every field in this dialog works: each saves on its own, and the mode dropdown's save triggers `onSaved`, which refreshes the guest.
- **Alternatives considered**: A separate Access modal — rejected by the issue.

## R12. Admin gate for the mobile list

- **Decision**: `oidcEditChangeError` in `src/web/routes/dashboard.ts` also compares `oidcMobileRedirectUris` (order-sensitive, like the web list). The route's trigger condition includes `'oidcMobileRedirectUris' in req.body`. The message becomes "…auth mode or callback/redirect URLs".
- **Rationale**: FR-006. The mobile list decides where a completed login is sent, the same blast radius as the web list.
