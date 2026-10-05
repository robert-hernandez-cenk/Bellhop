import type {
  AuthentikApplication,
  AuthentikClient,
  AuthentikFlowStageBinding,
  AuthentikGroup,
  AuthentikOAuth2Provider,
  AuthentikPolicyBinding,
  AuthentikPolicyRef,
  AuthentikProxyProvider,
  AuthentikScopeMapping,
  AuthentikStageRef,
  OAuth2ProviderSettings,
} from '../../lib/authentik-client.ts';
import type { Inventory } from '../../lib/inventory.ts';
import { effectiveAuth } from '../../lib/inventory.ts';
import { authentikConfig, rungsAtOrAbove } from '../../lib/authentik-config.ts';
import { publicHostname, requireDomain } from '../../lib/hostname.ts';

export interface SyncAuthentikOptions {
  apply?: boolean;
}

export interface SyncAuthentikDeps {
  authentik: AuthentikClient;
  inventory: Inventory;
  // The post-apply OIDC discovery check's HTTP client (research.md R6).
  // Injectable so tests never reach the network; defaults to global fetch.
  fetchImpl?: typeof fetch;
}

export interface SyncAuthentikResult {
  // All three lists hold bare Application slugs (issue #156) -- the same
  // value this command uses as the Application/Provider display name.
  // They previously held `<slug>.<domain>`, and the type alone does not say
  // which, so callers that render these strings should not re-derive a
  // domain from them.
  toCreate: string[];
  toRemove: string[];
  // Desired entries whose slug is already held in Authentik by an
  // Application this command does not own (not proxy-backed). Creating one
  // would fail Authentik's unique-slug constraint, so it is skipped and
  // reported rather than attempted -- syncProxyLive runs this command on
  // every Dashboard subdomains edit, and an edit elsewhere in the inventory
  // must not fail over a pre-existing clash.
  conflicts: string[];
  // The subset of `conflicts` whose existing, unowned Application is backed
  // by an OAuth2 provider (marked or not -- ownership only requires the
  // meta_publisher marker, so this is broader than "adopted already"). The
  // data-model.md "conflict, adoptable" ownership state: adopt-oidc-client
  // can take it over without rotating its client_id/client_secret. A
  // conflict backed by a proxy provider (handled by the unchanged #154 rule,
  // so never actually a conflict) or by anything else/nothing is never
  // listed here -- formatSyncAuthentik uses this to print a different
  // explanation for the two cases (adopt-oidc-client-adoptable, or
  // resolve-by-hand). Optional so a hand-built result literal (every
  // pre-issue-#1 formatSyncAuthentik test) stays valid; runSyncAuthentik
  // always fills it, with [] when there is nothing adoptable.
  adoptableConflicts?: string[];
  // Ladder rungs some desired entry needs that do not exist in Authentik.
  // Reported, never auto-created: a rung is deliberate operator
  // configuration, and manufacturing an empty group from a typo in
  // AUTHENTIK_GROUP_LADDER would hide the mistake. Bindings for the rungs
  // that do exist are still written.
  missingRungs: string[];
  // Desired entries whose authGroup names a group absent from the ladder.
  // Skipped entirely -- no Application created, no bindings touched. They
  // stay in `desired`, which is what keeps them out of toRemove: a
  // misconfigured authGroup is an operator mistake to report, not a reason
  // to delete a working Application and break the login it currently fronts.
  offLadder: OffLadderEntry[];
  // The policy-binding adds/removes this run would make (dry run) or just
  // made (--apply) -- computed once, up front, and reported identically in
  // both branches (issue #158 fix wave item 1). This is what makes a pure
  // tier change (no Application created or removed) visible in a preview:
  // before this field existed, moving an entry between rungs previewed as
  // "nothing to do" and then silently rewrote bindings on --apply.
  bindingChanges: BindingChange[];
  // Native OIDC gating (issue #1, data-model.md "Sync result additions").
  // Optional in the type only so a hand-built result literal (formatter
  // tests, callers that predate OIDC) stays valid; runSyncAuthentik always
  // fills every one, with [] when there is nothing to report. `toCreate`
  // keeps meaning forward-auth Applications only, so existing callers are
  // unaffected.
  // Slugs getting a new OpenID client and Application.
  oidcToCreate?: string[];
  // Settings drift on an owned OpenID client, fixed in place on apply.
  oidcUpdates?: OidcUpdate[];
  // Owned Applications whose provider is swapped to the other kind, keeping
  // the Application itself (slug, pk, and so its bindings) -- research R5.
  // Not repeated in toCreate/oidcToCreate: no Application is created.
  modeSwitches?: ModeSwitch[];
  // Slugs whose Bellhop-owned OpenID client is deleted this run: an
  // oidc -> forward switch, or an OIDC entry whose gate was cleared (that
  // one also sits in toRemove). Drives the dry-run warning (FR-014).
  oidcDeletions?: string[];
  // OIDC entries left alone this run, and why (controller ruling R-1).
  oidcSkipped?: OidcSkip[];
  // Embedded-outpost membership changes this run makes, reconciled every
  // run rather than only on create/remove: every owned, desired,
  // proxy-backed Application's provider belongs on the outpost, and a
  // retired one does not. So an Application left off it by an earlier run
  // that failed partway is repaired on the next run, and the dry run shows
  // that repair (FR-014). Only providers this command owns are ever added or
  // removed.
  outpostChanges?: OutpostChange[];
  // New forward-auth entries left alone because the provider name they need
  // is taken (planProviderName), and why. No Application is created.
  forwardSkipped?: ForwardSkip[];
  // Apply only: the post-apply discovery check, one per owned OIDC entry.
  discovery?: OidcDiscoveryResult[];
  // The mobile consent step (issue #22, data-model.md "Sync result
  // addition"). Optional in the type like the other OIDC-era fields;
  // runSyncAuthentik always fills it, empty when nothing is wanted.
  mobileConsent?: MobileConsentReport;
  applied: boolean;
}

export interface MobileConsentReport {
  // The mobile URI set in effect (sorted, deduplicated) -- mobileUriSet.
  uris: string[];
  // Planned (dry run) or made (apply). A failed apply lists only the
  // changes that completed before the failure.
  changes: MobileConsentChange[];
  // Human-readable, one per same-named object this command does not own.
  conflicts: string[];
  // A reconcile failure (research R9). Fails an --apply run, never a dry run.
  error?: string;
}

export interface MobileConsentChange {
  object: 'stage' | 'binding' | 'policy' | 'policy-binding';
  action: 'create' | 'update' | 'delete';
  // Drifted Authentik field names, or the URI count for the policy.
  detail?: string;
}

export interface OidcUpdate {
  slug: string;
  // Authentik's own field names (`redirect_uris`, `grant_types`, ...), in
  // the fixed order diffOAuth2Settings emits them.
  changes: string[];
}

// The kind is what the CLI's exit code keys off (syncAuthentikFailed): a
// missing callback URL is one entry's incomplete configuration, while a
// missing signing key or scope mapping is instance-wide misconfiguration
// that blocks every OIDC entry.
// 'provider-name-taken' is also one entry's problem: a provider of either
// kind already holds the name a new provider needs (the slug, or a switch's
// `<slug> (replaced)`), and Authentik rejects a duplicate provider name, so
// creating one is never attempted.
export type OidcSkipKind =
  | 'missing-redirect-uris'
  | 'missing-signing-key'
  | 'missing-scope-mapping'
  | 'provider-name-taken';

export interface OutpostChange {
  slug: string;
  action: 'add' | 'remove';
}

export interface ForwardSkip {
  slug: string;
  kind: 'provider-name-taken';
  reason: string;
}

export interface ModeSwitch {
  slug: string;
  from: 'forward' | 'oidc';
  to: 'forward' | 'oidc';
}

export interface OidcSkip {
  slug: string;
  kind: OidcSkipKind;
  reason: string;
}

export interface OidcDiscoveryResult {
  slug: string;
  // '' only when the issuer itself could not be read from Authentik.
  issuer: string;
  ok: boolean;
  error?: string;
}

export interface OffLadderEntry {
  slug: string;
  authGroup: string;
}

// One planned or executed change to one Application's policy bindings.
// `group` is a name, not an id, to match the level of detail
// `toCreate`/`toRemove`/`offLadder` already report -- bare slugs and
// `{ slug, authGroup }` objects, never raw Authentik ids.
export interface BindingChange {
  slug: string;
  group: string;
  action: 'add' | 'remove';
}

export const OFF_LADDER_EXPLANATION =
  'its authGroup names a group that is not in AUTHENTIK_GROUP_LADDER; the entry was skipped and its Authentik state left untouched';

export const MISSING_RUNG_EXPLANATION =
  'this ladder rung does not exist in Authentik; bindings for it were skipped and it was not created';

// Shared by formatSyncAuthentik and src/web/proxy-sync.ts so the CLI and the
// job log describe a conflict the same way. The two React banners
// deliberately carry their own shorter wording instead -- this string does
// not fit the Advanced modal's narrow value column (see the
// banner-shortening commit).
export const CONFLICT_EXPLANATION =
  'an Application with this slug already exists in Authentik and is not managed by this toolkit (no proxy provider behind it, and not an OpenID client marked as Bellhop\'s); resolve by hand';

// The adoptableConflicts-scoped variant: unlike CONFLICT_EXPLANATION above,
// this conflict has a path forward this toolkit can take (issue #1's
// adopt-oidc-client), so the message points at it instead of "resolve by
// hand". See adoptableConflicts for the exact ownership state this covers.
export const OAUTH2_CONFLICT_EXPLANATION =
  "an OpenID client with this slug already exists in Authentik and is not marked as Bellhop's; run adopt-oidc-client to adopt it";

// The one place a conflict's explanation is chosen (FR-011), shared by
// formatSyncAuthentik, syncProxyLive's job-log warnings, and delete-guest's
// pre-removal sync, so no front end tells an operator to resolve by hand a
// conflict adopt-oidc-client could take over.
export function conflictExplanation(slug: string, result: Pick<SyncAuthentikResult, 'adoptableConflicts'>): string {
  return (result.adoptableConflicts ?? []).includes(slug) ? OAUTH2_CONFLICT_EXPLANATION : CONFLICT_EXPLANATION;
}

// Wording from contracts/interfaces.md's CLI section.
export const OIDC_DELETION_WARNING = "the app's OIDC login stops working until new credentials are entered in it";

// Wording from contracts/interfaces.md's CLI section.
export const MISSING_REDIRECT_URIS_REASON = 'no callback URL set (set oidcRedirectUris, or Callback URLs on the Dashboard)';

// The `meta_publisher` value that marks an OAuth2-backed Application as
// Bellhop's (research.md R1). Set on create here, and by the adopt action on
// a hand-made one.
export const BELLHOP_META_PUBLISHER = 'bellhop';

// research.md R2. grant_types must be sent explicitly: an API-created
// provider otherwise stores [] and rejects every authorize request.
export const OIDC_GRANT_TYPES = ['authorization_code', 'refresh_token'];
// Looked up by Authentik's stable `managed` identifier, never by display
// name, since names are editable.
export const OIDC_SCOPE_MAPPINGS = [
  'goauthentik.io/providers/oauth2/scope-openid',
  'goauthentik.io/providers/oauth2/scope-profile',
  'goauthentik.io/providers/oauth2/scope-email',
  // #69: Bellhop's own web login requests offline_access and needs the
  // refresh token Authentik only issues when this mapping is attached.
  // Harmless for every other client: a scope applies only when requested.
  'goauthentik.io/providers/oauth2/scope-offline_access',
];

// Authentik's provider names are unique across every provider kind, and
// both providers in a mode switch are named after the slug (issue #156). The
// outgoing one is renamed to `<slug>${REPLACED_PROVIDER_SUFFIX}` first, so its
// replacement can be created under the slug name before the Application is
// repointed -- the Application is never left without a provider.
export const REPLACED_PROVIDER_SUFFIX = ' (replaced)';

// Same bound as RealCloudflareClient's per-request timeout, so a stalled
// Authentik cannot hang a Dashboard save that runs this via syncProxyLive.
const DISCOVERY_TIMEOUT_MS = 10_000;

// Mobile consent step (research.md R4/R5/R7): the fixed names of the two
// Authentik objects this command owns, and the marker that proves a found
// expression policy is this command's to reconcile rather than a hand-made
// same-named one. Stage names are unique across every stage type, so this
// name alone is enough to find it; the policy is additionally checked for
// the marker (R7) since a policy name collision is otherwise silent.
export const MOBILE_CONSENT_STAGE_NAME = 'bellhop-mobile-app-consent';
export const MOBILE_CONSENT_POLICY_NAME = 'bellhop-consent-on-mobile-redirect';
export const MOBILE_CONSENT_MARKER = '# Managed by Bellhop (sync-authentik).';
// meta_model_name values (research R4/R7): what makes a found stage a
// consent stage, and a found policy an expression policy.
const CONSENT_STAGE_MODEL = 'authentik_stages_consent.consentstage';
const EXPRESSION_POLICY_MODEL = 'authentik_policies_expression.expressionpolicy';
const CONSENT_MODE = 'always_require';
// The stock explicit-consent flow's consent binding order. Set on create
// only, so an operator may move it (research R4).
const CONSENT_BINDING_ORDER = 10;
const MOBILE_CONSENT_ERROR_HINT =
  " — check AUTHENTIK_AUTHORIZATION_FLOW_SLUG and the API token's stage/policy/flow permissions (docs/authentik.md \"Authentik API token permissions\")";

// `name` is deliberately absent: the Application/Provider display name is
// the slug verbatim (issue #156), so a second field holding the same value
// would just be a chance for the two to drift.
interface CandidateEntry {
  slug: string;
  externalHost: string;
  authGroup?: string;
  authMode?: 'forward' | 'oidc';
  oidcRedirectUris?: string[];
  oidcMobileRedirectUris?: string[];
}

type SubdomainOwner = {
  authGroup?: string;
  subdomains?: string[];
  authMode?: 'forward' | 'oidc';
  oidcRedirectUris?: string[];
  oidcMobileRedirectUris?: string[];
};

// A "candidate" is any entry with at least one subdomain, regardless of
// whether it currently names an authGroup -- this is what lets a gate being
// cleared on an otherwise-unchanged entry still be recognized as a removal
// target on the next run (its slug is still a candidate, just no longer
// desired). Being a candidate is necessary but NOT sufficient for
// this command to act on an Application: see ownedProviderKind, which
// additionally requires proxy-provider backing (issue #154) or, for an
// OAuth2 provider, the `meta_publisher: bellhop` marker (issue #1, research
// R1), so that a hand-created OAuth2/OIDC Application sharing a slug is
// never touched.
// Renaming an entry's subdomain[0] is NOT covered by any of this: the old
// slug drops out of the candidate set entirely, so the old Provider/
// Application it once owned is never recognized for cleanup and is left for
// the operator to delete by hand in Authentik's admin UI.
function candidateEntries(inventory: Inventory): CandidateEntry[] {
  const owners: SubdomainOwner[] = [...inventory.hosts, ...inventory.guests, ...(inventory.externalSites ?? [])];
  const result: CandidateEntry[] = [];
  for (const owner of owners) {
    const subdomains = owner.subdomains ?? [];
    if (subdomains.length === 0) continue;
    const slug = subdomains[0];
    result.push({
      slug,
      externalHost: `https://${publicHostname(slug, requireDomain(inventory))}`,
      authGroup: owner.authGroup,
      authMode: owner.authMode,
      oidcRedirectUris: owner.oidcRedirectUris,
      oidcMobileRedirectUris: owner.oidcMobileRedirectUris,
    });
  }
  return result;
}

export type OwnedProviderKind = 'proxy' | 'oauth2';

// Whether an Application is Bellhop's, and through which kind of provider
// (data-model.md "Ownership states"). The other half of the rule -- the
// Application's slug must be an inventory candidate slug -- is the caller's:
// runSyncAuthentik checks it against every candidate, and a single-entry
// caller (oidc-credentials, adopt-oidc-client) has the entry's slug by
// construction.
//   - Proxy-backed: owned, marker or not -- the unchanged issue #154 rule,
//     which is what keeps Applications created before the marker existed
//     recognized.
//   - OAuth2-backed: owned only when meta_publisher is 'bellhop'. An
//     unmarked one is a hand-made client (a conflict, adoptable).
//   - Any other provider, or none: never owned.
export function ownedProviderKind(
  application: AuthentikApplication,
  providers: { proxyProviderIds: ReadonlySet<string>; oauth2ProviderIds: ReadonlySet<string> }
): OwnedProviderKind | undefined {
  const providerId = application.providerId;
  if (providerId == null) return undefined;
  if (providers.proxyProviderIds.has(providerId)) return 'proxy';
  if (providers.oauth2ProviderIds.has(providerId) && application.metaPublisher === BELLHOP_META_PUBLISHER) {
    return 'oauth2';
  }
  return undefined;
}

// The OAuth2 settings Bellhop owns on a client (research.md R2), minus the
// two flow ids: those are only sent on create, and AuthentikOAuth2Provider
// does not report them back, so they are not reconciled.
export type DesiredOAuth2Settings = Omit<OAuth2ProviderSettings, 'authorizationFlowId' | 'invalidationFlowId'>;

// FR-007: a Bellhop-owned OpenID client's actual callback list is the
// entry's web list plus its mobile list, deduplicated (first-seen order,
// web first) -- the mobile list is simply more addresses the same client is
// allowed to send a signed-in user back to. Callers that decide whether an
// entry has *any* callback configured at all (the missing-redirect-uris
// skip in planOidc, adopt-oidc-client's own refusal) deliberately keep
// testing `entry.oidcRedirectUris` alone instead (FR-004): the web list
// stays the one that is required, so an entry with only mobile URIs is
// still incomplete.
export function clientRedirectUris(entry: { oidcRedirectUris?: string[]; oidcMobileRedirectUris?: string[] }): string[] {
  return [...new Set([...(entry.oidcRedirectUris ?? []), ...(entry.oidcMobileRedirectUris ?? [])])];
}

// research.md R5: a Python string literal for one URI, built by iterating
// CODE POINTS (`for...of` over a string does this natively -- it never
// splits a surrogate pair), not UTF-16 units. JSON.stringify would emit a
// surrogate pair as two separate \uD8xx\uDCxx escapes, which Python decodes
// back into two lone surrogates rather than the original character, so an
// emoji redirect URI would silently never match. Lowercase hex throughout.
export function pythonStringLiteral(value: string): string {
  let out = '"';
  for (const ch of value) {
    switch (ch) {
      case '\\':
        out += '\\\\';
        continue;
      case '"':
        out += '\\"';
        continue;
      case '\n':
        out += '\\n';
        continue;
      case '\r':
        out += '\\r';
        continue;
      case '\t':
        out += '\\t';
        continue;
    }
    const codePoint = ch.codePointAt(0)!;
    if (codePoint >= 0x20 && codePoint <= 0x7e) {
      out += ch;
    } else if (codePoint <= 0xff) {
      out += `\\x${codePoint.toString(16).padStart(2, '0')}`;
    } else if (codePoint <= 0xffff) {
      out += `\\u${codePoint.toString(16).padStart(4, '0')}`;
    } else {
      out += `\\U${codePoint.toString(16).padStart(8, '0')}`;
    }
  }
  out += '"';
  return out;
}

// research.md R5: the Authentik expression-policy body for the mobile
// consent step. The URIs are sorted so the same set always renders the same
// text -- drift is then a plain string comparison (research.md R8) -- and an
// empty list renders `set()`, since `{}` is a Python dict literal, not an
// empty set. `MOBILE_CONSENT_MARKER` is always the expression's first line,
// which is what `ownedProviderKind`'s policy counterpart (R7) checks to
// decide whether a found policy is this command's to reconcile.
export function renderMobileConsentExpression(uris: string[]): string {
  const sorted = [...uris].sort();
  const setLiteral =
    sorted.length === 0 ? 'set()' : ['{', ...sorted.map((uri) => `    ${pythonStringLiteral(uri)},`), '}'].join('\n');
  return [
    `${MOBILE_CONSENT_MARKER} Changes made here are overwritten.`,
    '# Asks for consent only when the login hands off to a mobile app redirect URI.',
    `MOBILE_REDIRECT_URIS = ${setLiteral}`,
    'params = request.context.get("goauthentik.io/providers/oauth2/params")',
    'return getattr(params, "redirect_uri", None) in MOBILE_REDIRECT_URIS',
  ].join('\n');
}

export function desiredOAuth2Settings(
  redirectUris: string[],
  signingKeyId: string,
  propertyMappingIds: string[]
): DesiredOAuth2Settings {
  return {
    clientType: 'confidential',
    grantTypes: [...OIDC_GRANT_TYPES],
    signingKeyId,
    propertyMappingIds: [...propertyMappingIds],
    redirectUris: redirectUris.map((url) => ({ matchingMode: 'strict', url })),
  };
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((v) => right.has(v));
}

// research.md R4: grant types compared as a set, redirect URIs as a set of
// (matching_mode, url). Scope mappings (issue #16; the full rule is
// specs/012-keep-custom-scope-mappings/data-model.md "Scope coverage rule"):
// - Given a scope-name map (owned drift, adoption), a required scope is
//   covered when its desired id is attached, or an attached id has the same
//   known scope name. Only an uncovered scope is drift; the patch keeps
//   every attached id in order and appends the missing built-ins.
// - A desired id absent from the map is covered only by being attached
//   (fail closed).
// - If any attached id is absent from the map, its scope can't be known, so
//   property_mappings is left alone: no drift, no patch.
// - 'exact' (a reused leftover provider, which may be hand-made): exact-set
//   compare, patched to the desired ids, like a new client.
// Returns the drifted Authentik field names, in a fixed order, and a patch
// carrying only those fields. Credentials are not part of
// DesiredOAuth2Settings, so a patch can never rotate client_id/
// client_secret (FR-009). Shared with the adopt action (FR-011a).
export function diffOAuth2Settings(
  current: AuthentikOAuth2Provider,
  desired: DesiredOAuth2Settings,
  scopeMappings: ReadonlyMap<string, string> | 'exact'
): { changes: string[]; patch: Partial<OAuth2ProviderSettings> } {
  const changes: string[] = [];
  const patch: Partial<OAuth2ProviderSettings> = {};
  const uriKey = (r: { matchingMode: string; url: string }) => `${r.matchingMode} ${r.url}`;
  if (!sameSet(current.redirectUris.map(uriKey), desired.redirectUris.map(uriKey))) {
    changes.push('redirect_uris');
    patch.redirectUris = desired.redirectUris;
  }
  if (!sameSet(current.grantTypes, desired.grantTypes)) {
    changes.push('grant_types');
    patch.grantTypes = desired.grantTypes;
  }
  if (scopeMappings === 'exact') {
    if (!sameSet(current.propertyMappingIds, desired.propertyMappingIds)) {
      changes.push('property_mappings');
      patch.propertyMappingIds = [...desired.propertyMappingIds];
    }
  } else if (current.propertyMappingIds.every((id) => scopeMappings.has(id))) {
    const attached = new Set(current.propertyMappingIds);
    const coveredScopeNames = new Set(current.propertyMappingIds.map((id) => scopeMappings.get(id)!));
    const uncoveredDesiredIds = desired.propertyMappingIds.filter((id) => {
      if (attached.has(id)) return false;
      const name = scopeMappings.get(id);
      return name === undefined || !coveredScopeNames.has(name);
    });
    if (uncoveredDesiredIds.length > 0) {
      changes.push('property_mappings');
      patch.propertyMappingIds = [...current.propertyMappingIds, ...uncoveredDesiredIds];
    }
  }
  if (current.signingKeyId !== desired.signingKeyId) {
    changes.push('signing_key');
    patch.signingKeyId = desired.signingKeyId;
  }
  if (current.clientType !== desired.clientType) {
    changes.push('client_type');
    patch.clientType = desired.clientType;
  }
  return { changes, patch };
}

export async function runSyncAuthentik(
  opts: SyncAuthentikOptions,
  deps: SyncAuthentikDeps
): Promise<SyncAuthentikResult> {
  const ladder = authentikConfig().groupLadder;

  const candidates = candidateEntries(deps.inventory);
  const candidatesBySlug = new Map(candidates.map((c) => [c.slug, c]));
  // Truthy, not just !== undefined -- matches sync-proxy's own `entry.authGroup`
  // gate (the caddy driver's `render()`) so the two commands never disagree
  // about whether an authGroup: '' entry is gated. That value is unreachable
  // through the zod schema but reachable from a hand-built Inventory literal
  // (every test fixture in this repo is one) -- without this, sync-authentik
  // could create an Application that sync-proxy never routes forward_auth to.
  const desired = candidates.filter((c): c is CandidateEntry & { authGroup: string } => Boolean(c.authGroup));

  // Split before anything else. An off-ladder entry is neither created nor
  // reconciled, but it stays in `desired` above so toRemove never claims it.
  const offLadder: OffLadderEntry[] = desired
    .filter((d) => rungsAtOrAbove(ladder, d.authGroup) === null)
    .map((d) => ({ slug: d.slug, authGroup: d.authGroup }));
  const offLadderSlugs = new Set(offLadder.map((o) => o.slug));
  const actionable = desired.filter((d) => !offLadderSlugs.has(d.slug));

  const applications = await deps.authentik.listApplications();
  // Fetched here rather than inside the apply branch so the dry run computes
  // ownership exactly the way --apply does -- before issue #154 the preview
  // would report a deletion that apply then made against an Application this
  // command never created. Reused by the apply steps below.
  const proxyProviders = await deps.authentik.listProxyProviders();
  const proxyProviderIds = new Set(proxyProviders.map((p) => p.id));
  // A mode switch's rename re-sends the outgoing proxy provider's own mode
  // (see AuthentikClient.renameProxyProvider), so it needs the full record.
  const proxyProvidersById = new Map(proxyProviders.map((p) => [p.id, p]));
  // Fetched for the same parity reason, and always -- ownership of an
  // existing OAuth2-backed Application matters even in a run whose
  // inventory has no OIDC entry (a forward entry must not treat one as a
  // conflict).
  const oauth2Providers = await listOAuth2ProvidersForRun(deps.authentik, candidates);
  const oauth2ProvidersById = new Map(oauth2Providers.map((p) => [p.id, p]));
  const ownership = { proxyProviderIds, oauth2ProviderIds: new Set(oauth2ProvidersById.keys()) };
  // Ownership is slug *and* provider backing (ownedProviderKind). Matching on
  // slug alone deleted hand-created Applications backed by an OAuth2/OIDC
  // provider (issue #154), so an OAuth2-backed one is ours only with the
  // meta_publisher marker this command sets (research R1).
  const ownedKindBySlug = new Map<string, OwnedProviderKind>();
  for (const application of applications) {
    if (!candidatesBySlug.has(application.slug)) continue;
    const kind = ownedProviderKind(application, ownership);
    if (kind) ownedKindBySlug.set(application.slug, kind);
  }
  // Every owned Application of either kind: what binding planning and the
  // apply-time binding pass resolve a slug's Application pk through. A mode
  // switch keeps the Application, so its pk -- and every binding on it --
  // stays valid across the swap (research R5).
  const managedBySlug = new Map(
    applications.filter((a) => ownedKindBySlug.has(a.slug)).map((a) => [a.slug, a])
  );

  // A desired entry's slug is a candidate slug by construction, so "not
  // managed but an Application exists" means exactly "that Application is
  // not owned by either rule" -- another provider kind, no provider, or an
  // OAuth2 client without the Bellhop marker.
  const wantedKind = (d: CandidateEntry): OwnedProviderKind => (effectiveAuth(d) === 'oidc' ? 'oauth2' : 'proxy');
  const applicationsBySlug = new Map(applications.map((a) => [a.slug, a]));
  const notYetManaged = actionable.filter((d) => !managedBySlug.has(d.slug));
  const conflicting = notYetManaged.filter((d) => applicationsBySlug.has(d.slug));
  const unclaimed = notYetManaged.filter((d) => !applicationsBySlug.has(d.slug));
  const toCreateCandidates = unclaimed.filter((d) => wantedKind(d) === 'proxy');
  // Every owned Application no longer desired, of either kind. An OAuth2 one
  // is also an OpenID client deletion (FR-012).
  const toRemove = applications.filter(
    (a) => ownedKindBySlug.has(a.slug) && !desired.some((d) => d.slug === a.slug)
  );
  const conflictingSlugs = new Set(conflicting.map((d) => d.slug));
  // adoptableConflicts: OAuth2-backed regardless of marker (a marked one
  // would be `managedBySlug`-owned and therefore never reach `conflicting`
  // at all, so this is effectively "unmarked" in practice) -- the
  // data-model.md "conflict, adoptable" row. Independent of the entry's own
  // wantedKind: even a forward-auth entry blocked by a hand-made OpenID
  // client at its slug has adoption as its path forward (set authMode:
  // 'oidc', then adopt), so the message should say so regardless.
  const adoptableConflicts = conflicting
    .filter((d) => {
      const app = applicationsBySlug.get(d.slug);
      return app?.providerId !== undefined && oauth2ProvidersById.has(app.providerId);
    })
    .map((d) => d.slug);

  // Every OIDC entry this run may create, reconcile, or switch to: not
  // blocked by a conflict. One whose slug holds an owned proxy Application
  // is a forward -> oidc switch; planOidc applies the same skip rules to it
  // as to a fresh create, so a skipped switch is never attempted and the
  // proxy Application stays exactly as it is.
  const oidcEntries = actionable.filter((d) => wantedKind(d) === 'oauth2' && !conflictingSlugs.has(d.slug));
  // Every provider of either kind, and which Application uses it -- the
  // namespace a new provider's name must be free in (names are unique across
  // kinds in Authentik).
  const providerIndex = buildProviderIndex(proxyProviders, oauth2Providers, applications);
  const oidcPlan = await planOidc(
    oidcEntries,
    managedBySlug,
    ownedKindBySlug,
    providerIndex,
    oauth2ProvidersById,
    deps.authentik
  );
  // The other direction: a forward entry whose slug holds an owned OAuth2
  // Application gets a proxy provider in place of its OpenID client.
  const forwardSwitchPlan = planForwardSwitches(
    actionable.filter((d) => wantedKind(d) === 'proxy' && ownedKindBySlug.get(d.slug) === 'oauth2'),
    managedBySlug,
    providerIndex
  );
  // New forward-auth Applications. Their proxy provider's name goes through
  // the same planProviderName check as every other new provider, so a
  // same-named provider of either kind that is in use (or an OAuth2 one at
  // all) skips the entry here rather than failing the whole apply on
  // Authentik's duplicate-name 400. An unused same-named proxy provider is
  // still reused -- the partial-failure self-heal.
  const toCreate: Array<CandidateEntry & { reuseProviderId?: string }> = [];
  const forwardSkipped: ForwardSkip[] = [];
  for (const entry of toCreateCandidates) {
    const naming = planProviderName(entry.slug, 'proxy', undefined, providerIndex);
    if ('skip' in naming) {
      forwardSkipped.push({ slug: entry.slug, kind: 'provider-name-taken', reason: naming.skip });
    } else {
      toCreate.push({ ...entry, ...(naming.reuseId ? { reuseProviderId: naming.reuseId } : {}) });
    }
  }
  const oidcSkipped = [...oidcPlan.skipped, ...forwardSwitchPlan.skipped];
  // A skipped entry with no Application yet gets nothing, bindings
  // included. A skipped entry that is already owned (including a skipped
  // switch, whose Application keeps its current provider) still has its
  // bindings reconciled: they do not depend on the missing setting, and
  // skipping them would leave a raised tier's wider audience in place.
  const oidcSkippedUnowned = oidcSkipped.filter((s) => !managedBySlug.has(s.slug)).map((s) => s.slug);

  const modeSwitches: ModeSwitch[] = [
    ...oidcPlan.creates.filter((c) => c.switchFrom).map((c) => ({ slug: c.slug, from: 'forward' as const, to: 'oidc' as const })),
    ...forwardSwitchPlan.switches.map((s) => ({ slug: s.slug, from: 'oidc' as const, to: 'forward' as const })),
  ];
  const oidcDeletions = [
    ...forwardSwitchPlan.switches.map((s) => s.slug),
    ...toRemove.filter((a) => ownedKindBySlug.get(a.slug) === 'oauth2').map((a) => a.slug),
  ];

  // Outpost membership, reconciled against the live outpost rather than
  // derived from this run's creates alone (see SyncAuthentikResult
  // .outpostChanges). Only proxy providers of Applications this command owns
  // are considered, so a hand-added provider is never removed.
  const outpost = await deps.authentik.getEmbeddedOutpost();
  const onOutpost = new Set(outpost.providerIds);
  const outpostChanges: OutpostChange[] = [];
  // Existing providers to add (repairs); new providers are added in apply as
  // they are created.
  const outpostRepairIds: string[] = [];
  const outpostRemoveIds: string[] = [];
  const switchingToOidc = new Map(
    oidcPlan.creates.filter((c) => c.switchFrom).map((c) => [c.slug, c.switchFrom!.providerId!])
  );
  for (const entry of actionable) {
    // Owned, desired, forward, and staying proxy-backed. A forward -> oidc
    // switch (planned or skipped) is an OIDC entry, so it is not here.
    if (wantedKind(entry) !== 'proxy' || ownedKindBySlug.get(entry.slug) !== 'proxy') continue;
    const providerId = managedBySlug.get(entry.slug)!.providerId!;
    if (!onOutpost.has(providerId)) {
      outpostChanges.push({ slug: entry.slug, action: 'add' });
      outpostRepairIds.push(providerId);
    }
  }
  for (const entry of toCreate) {
    if (!(entry.reuseProviderId && onOutpost.has(entry.reuseProviderId))) {
      outpostChanges.push({ slug: entry.slug, action: 'add' });
    }
  }
  for (const change of forwardSwitchPlan.switches) {
    if (!(change.orphanProxyProviderId && onOutpost.has(change.orphanProxyProviderId))) {
      outpostChanges.push({ slug: change.slug, action: 'add' });
    }
  }
  for (const application of toRemove) {
    if (ownedKindBySlug.get(application.slug) === 'proxy' && onOutpost.has(application.providerId!)) {
      outpostChanges.push({ slug: application.slug, action: 'remove' });
      outpostRemoveIds.push(application.providerId!);
    }
  }
  for (const [slug, providerId] of switchingToOidc) {
    if (onOutpost.has(providerId)) {
      outpostChanges.push({ slug, action: 'remove' });
      outpostRemoveIds.push(providerId);
    }
  }

  // Fetched in the dry run too, so a preview reports a missing rung the same
  // way apply does rather than announcing bindings it could not have made.
  const groups = await deps.authentik.listGroups();
  // Fetched here too (not just inside an apply branch) so a dry run's
  // binding-change preview is computed from the same data --apply would
  // use, matching the `groups`/`proxyProviders` fetches above (issue #158
  // fix wave item 1).
  const bindings = await deps.authentik.listPolicyBindings();
  // A deleted Application's bindings are gone with it (Authentik cascades),
  // so they are left out of the index entirely.
  const { groupIdByName, groupNameById, bindingsByTarget } = indexGroupBindings(
    groups,
    bindings,
    new Set(toRemove.map((a) => a.pk))
  );

  const neededRungs = new Set<string>();
  // The `!` here (and in planBindingChanges below) is safe because
  // `actionable` is `desired` with every off-ladder entry already filtered
  // out above -- rungsAtOrAbove only returns null for a group absent from
  // the ladder, which is exactly what offLadderSlugs excludes.
  for (const entry of actionable) {
    for (const rung of rungsAtOrAbove(ladder, entry.authGroup)!) neededRungs.add(rung);
  }
  // Ladder order, not Set insertion order, so the report reads bottom-up.
  const missingRungs = ladder.filter((rung) => neededRungs.has(rung) && !groupIdByName.has(rung));

  // Computed once and reported identically by both branches -- `--apply`
  // below executes exactly this plan rather than recomputing wantedIds/
  // boundIds itself.
  const bindingPlans = planBindingChanges(
    actionable,
    new Set([...conflictingSlugs, ...oidcSkippedUnowned, ...forwardSkipped.map((s) => s.slug)]),
    managedBySlug,
    bindingsByTarget,
    ladder,
    groupIdByName,
    groupNameById
  );
  const bindingChanges = bindingPlans.flatMap((p) => p.changes);

  const oidcReport = {
    // A forward -> oidc switch gets a new OpenID client but no new
    // Application, so it is reported in modeSwitches instead.
    oidcToCreate: oidcPlan.creates.filter((c) => !c.switchFrom).map((c) => c.slug),
    oidcUpdates: oidcPlan.updates.map((u) => ({ slug: u.slug, changes: u.changes })),
    modeSwitches,
    oidcDeletions,
    oidcSkipped,
    outpostChanges,
    forwardSkipped,
  };

  // The mobile consent step (research R6-R9): planned here so the dry run
  // reports exactly what --apply then executes, and caught on its own so a
  // failure never blocks the Application/client/binding/outpost work or the
  // discovery check (FR-017). Executed after all of that, below.
  const mobileConsent: MobileConsentReport = { uris: mobileUriSet(desired), changes: [], conflicts: [] };
  let mobilePlan: MobileConsentPlan | undefined;
  try {
    mobilePlan = await planMobileConsent(mobileConsent.uris, deps.authentik);
    mobileConsent.changes = mobilePlan.changes;
    mobileConsent.conflicts = mobilePlan.conflicts;
  } catch (err) {
    mobileConsent.error = `${errorMessage(err)}${MOBILE_CONSENT_ERROR_HINT}`;
  }

  if (!opts.apply) {
    return {
      toCreate: toCreate.map((d) => d.slug),
      toRemove: toRemove.map((a) => a.slug),
      conflicts: conflicting.map((d) => d.slug),
      adoptableConflicts,
      missingRungs,
      offLadder,
      bindingChanges,
      ...oidcReport,
      discovery: [],
      mobileConsent,
      applied: false,
    };
  }

  // Shared by the proxy and OAuth2 create paths below, and fetched at most
  // once per run -- only when something is actually created.
  let flowIds: { authorizationFlowId: string; invalidationFlowId: string } | undefined;
  const getFlowIds = async () => {
    flowIds ??= {
      authorizationFlowId: await deps.authentik.getDefaultAuthorizationFlowId(),
      invalidationFlowId: await deps.authentik.getDefaultInvalidationFlowId(),
    };
    return flowIds;
  };

  // Embedded-outpost membership, written once after every repoint so a
  // retiring proxy provider leaves only after its Application has moved off
  // it, and a new one joins only once its Application points at it. Only
  // proxy providers are ever on the outpost: an OAuth2 client is reached by
  // the app itself, not through forward-auth. If a step below throws first,
  // the next run's reconcile (outpostChanges) repairs the membership.
  const outpostAdds: string[] = [...outpostRepairIds];
  // Old providers of switched Applications, deleted only after the
  // Application points at its new provider and the outpost is updated, so
  // no step ever leaves an Application without a working provider.
  const switchedAwayProxyIds: string[] = [];
  const switchedAwayOAuth2Ids: string[] = [];

  // An unused proxy provider already named after the slug (reuseProviderId,
  // from planProviderName) self-heals a prior partial failure (Provider
  // created, then Application creation failed) instead of colliding with it
  // on a duplicate name. The name here is the slug verbatim (#156), the
  // short-name space hand-created Providers also live in; a false match
  // would adopt an unused hand-created proxy Provider onto a new
  // Application, but never one some other Application relies on.
  for (const entry of toCreate) {
    const providerId =
      entry.reuseProviderId ??
      (
        await deps.authentik.createProxyProvider({
          name: entry.slug,
          externalHost: entry.externalHost,
          ...(await getFlowIds()),
        })
      ).id;
    const application = await deps.authentik.createApplication({
      name: entry.slug,
      slug: entry.slug,
      providerId,
    });
    // Deliberately no policy binding here. The reconcile pass below
    // treats a just-created Application and a long-standing one
    // identically -- which is exactly what stops an Application's
    // audience from being frozen at creation time (#158).
    managedBySlug.set(application.slug, application);
    outpostAdds.push(providerId);
  }

  // oidc -> forward (research R5): a proxy provider in, the Application
  // repointed with its Bellhop OAuth2 marker cleared (a proxy-backed
  // Application is owned without it), then onto the outpost below.
  for (const change of forwardSwitchPlan.switches) {
    const outgoingId = change.application.providerId!;
    if (change.renameOutgoing) {
      await deps.authentik.renameOAuth2Provider(outgoingId, `${change.slug}${REPLACED_PROVIDER_SUFFIX}`);
    }
    const providerId =
      change.orphanProxyProviderId ??
      (
        await deps.authentik.createProxyProvider({
          name: change.slug,
          externalHost: change.externalHost,
          ...(await getFlowIds()),
        })
      ).id;
    await deps.authentik.updateApplication(change.slug, { providerId, metaPublisher: '' });
    managedBySlug.set(change.slug, { ...change.application, providerId, metaPublisher: undefined });
    ownedKindBySlug.set(change.slug, 'proxy');
    outpostAdds.push(providerId);
    switchedAwayOAuth2Ids.push(outgoingId);
  }

  // OIDC creates, forward -> oidc switches, and drift fixes.
  for (const create of oidcPlan.creates) {
    if (create.switchFrom && create.renameOutgoing) {
      // Owned as proxy (a forward -> oidc switch), so this lookup always succeeds.
      const outgoing = proxyProvidersById.get(create.switchFrom.providerId!)!;
      await deps.authentik.renameProxyProvider(outgoing, `${create.slug}${REPLACED_PROVIDER_SUFFIX}`);
    }
    let providerId: string;
    if (create.orphan) {
      // Self-heal of a prior partial failure (provider created, Application
      // creation failed), same as the proxy path above -- but only for a
      // provider no Application points at, which planOidc already required,
      // so reuse can never steal a client another Application relies on.
      providerId = create.orphan.id;
      if (create.orphan.changes.length > 0) {
        await deps.authentik.updateOAuth2Provider(providerId, create.orphan.patch);
      }
    } else {
      const provider = await deps.authentik.createOAuth2Provider({
        name: create.slug,
        ...create.settings,
        ...(await getFlowIds()),
      });
      providerId = provider.id;
    }
    if (create.switchFrom) {
      // Same Application, new provider: the pk and its bindings survive.
      await deps.authentik.updateApplication(create.slug, { providerId, metaPublisher: BELLHOP_META_PUBLISHER });
      managedBySlug.set(create.slug, { ...create.switchFrom, providerId, metaPublisher: BELLHOP_META_PUBLISHER });
      switchedAwayProxyIds.push(create.switchFrom.providerId!);
    } else {
      const application = await deps.authentik.createApplication({
        name: create.slug,
        slug: create.slug,
        providerId,
        metaPublisher: BELLHOP_META_PUBLISHER,
      });
      // Bindings come from the shared reconcile pass below, same as a new
      // proxy-backed Application.
      managedBySlug.set(application.slug, application);
    }
    ownedKindBySlug.set(create.slug, 'oauth2');
  }
  for (const update of oidcPlan.updates) {
    await deps.authentik.updateOAuth2Provider(update.providerId, update.patch);
  }

  // Executes the planned outpostChanges against the membership read at
  // planning time -- nothing in this run writes the outpost before here.
  if (outpostChanges.length > 0) {
    const outpostProviderIds = new Set(outpost.providerIds);
    for (const id of outpostAdds) outpostProviderIds.add(id);
    for (const id of outpostRemoveIds) outpostProviderIds.delete(id);
    await deps.authentik.setOutpostProviders(outpost.id, [...outpostProviderIds]);
  }

  for (const application of toRemove) {
    await deps.authentik.deleteApplication(application.id);
    if (!application.providerId) continue;
    if (ownedKindBySlug.get(application.slug) === 'oauth2') {
      await deps.authentik.deleteOAuth2Provider(application.providerId);
    } else {
      await deps.authentik.deleteProxyProvider(application.providerId);
    }
  }
  for (const id of switchedAwayProxyIds) await deps.authentik.deleteProxyProvider(id);
  for (const id of switchedAwayOAuth2Ids) await deps.authentik.deleteOAuth2Provider(id);

  // Deliberately outside every create/remove step above: an entry moving
  // between rungs changes nothing about which Applications exist, and would
  // otherwise be skipped silently. Executes exactly the plan computed above
  // -- `managedBySlug` now also holds anything just created, so a plan
  // entry for a brand-new Application resolves to its real pk here.
  for (const plan of bindingPlans) {
    const application = managedBySlug.get(plan.slug);
    // Absent means this slug was skipped at planning time -- reported, never touched.
    if (!application) continue;
    for (const groupId of plan.addGroupIds) {
      await deps.authentik.createPolicyBinding({ targetId: application.pk, groupId });
    }
    for (const bindingId of plan.removeBindingIds) {
      await deps.authentik.deletePolicyBinding(bindingId);
    }
  }

  // After every other write, so its failure can't block them. A failed apply
  // reports only the changes that completed.
  if (mobilePlan && mobilePlan.changes.length > 0) {
    const made: MobileConsentChange[] = [];
    try {
      await applyMobileConsent(mobilePlan, deps.authentik, made);
    } catch (err) {
      mobileConsent.changes = made;
      mobileConsent.error = `${errorMessage(err)}${MOBILE_CONSENT_ERROR_HINT}`;
    }
  }

  // Every OIDC entry that has a Bellhop-owned OpenID client after this
  // apply -- created, switched to, updated, or unchanged -- so an apply
  // always reports current health, not just what it touched. A skipped
  // forward -> oidc switch is still proxy-backed, so it is not checked. A
  // failure is reported, never rolled back: the client is correct in
  // Authentik, and the usual cause (Authentik unreachable from here, a
  // proxy in front of it) is outside it.
  const fetchImpl = deps.fetchImpl ?? fetch;
  const discovery = await Promise.all(
    oidcEntries
      .filter((d) => ownedKindBySlug.get(d.slug) === 'oauth2')
      .map((d) => managedBySlug.get(d.slug))
      .filter((a): a is AuthentikApplication & { providerId: string } => a?.providerId != null)
      .map((a) => checkOidcDiscovery(a.slug, a.providerId, deps.authentik, fetchImpl))
  );

  return {
    toCreate: toCreate.map((d) => d.slug),
    toRemove: toRemove.map((a) => a.slug),
    conflicts: conflicting.map((d) => d.slug),
    adoptableConflicts,
    missingRungs,
    offLadder,
    bindingChanges,
    ...oidcReport,
    discovery,
    mobileConsent,
    applied: true,
  };
}

// Every OAuth2 provider, for ownership. A forward-only deployment whose API
// token predates OIDC mode may lack OAuth2 read access (docs/authentik.md,
// "Authentik API token permissions"); when no candidate is in OIDC mode, a failed
// listing is treated as "no OAuth2 providers" -- exactly how this command
// behaved before OAuth2 ownership existed: an OAuth2-backed Application at a
// gated slug reads as an unowned conflict and is never touched. With any
// candidate in OIDC mode (gated or not -- a cleared gate still has an owned
// client to delete), ownership of an OpenID client cannot be decided
// without the listing, so the failure propagates.
async function listOAuth2ProvidersForRun(
  authentik: AuthentikClient,
  candidates: CandidateEntry[]
): Promise<AuthentikOAuth2Provider[]> {
  try {
    return await authentik.listOAuth2Providers();
  } catch (err) {
    if (candidates.some((c) => c.authMode === 'oidc')) throw err;
    return [];
  }
}

// research R6: the mobile URIs in effect -- the sorted, deduplicated union of
// every desired (gated) OIDC-mode entry's mobile list, whether or not that
// entry is off-ladder, in conflict, or skipped this run. A URI with no client
// behind it can never be a real login's redirect_uri, and counting it keeps
// the policy stable while the operator fixes the entry.
export function mobileUriSet(
  desired: Array<{ authGroup?: string; authMode?: 'forward' | 'oidc'; oidcMobileRedirectUris?: string[] }>
): string[] {
  const uris = new Set<string>();
  for (const entry of desired) {
    if (effectiveAuth(entry) !== 'oidc') continue;
    for (const uri of entry.oidcMobileRedirectUris ?? []) uris.add(uri);
  }
  return [...uris].sort();
}

// What planMobileConsent found, alongside what it decided. applyMobileConsent
// executes `changes` in order against these, so --apply can never do more or
// less than the dry run reported (FR-016).
interface MobileConsentPlan {
  changes: MobileConsentChange[];
  conflicts: string[];
  flowId?: string;
  expression: string;
  stageId?: string;
  policyId?: string;
  binding?: AuthentikFlowStageBinding;
  policyBindingId?: string;
}

// research R7/R8. Reads the four objects, applies the ownership rules (a
// same-named object this command doesn't own stops the plan outright), and
// lists the creates/updates (something wanted) or deletes (nothing wanted)
// in execution order. With nothing wanted, a failed read is swallowed and
// planned as nothing to do (R9): a token without stage/policy/flow access
// can't have created anything to remove.
async function planMobileConsent(uris: string[], authentik: AuthentikClient): Promise<MobileConsentPlan> {
  const wanted = uris.length > 0;
  const expression = renderMobileConsentExpression(uris);
  const empty: MobileConsentPlan = { changes: [], conflicts: [], expression };

  let stage: AuthentikStageRef | undefined;
  let policy: AuthentikPolicyRef | undefined;
  try {
    // Independent reads, so fetched together; either failing is handled
    // the same way below.
    [stage, policy] = await Promise.all([
      authentik.findStageByName(MOBILE_CONSENT_STAGE_NAME),
      authentik.findPolicyByName(MOBILE_CONSENT_POLICY_NAME),
    ]);
  } catch (err) {
    if (wanted) throw err;
    return empty;
  }

  const conflicts: string[] = [];
  if (stage && stage.model !== CONSENT_STAGE_MODEL) {
    conflicts.push(
      `stage '${MOBILE_CONSENT_STAGE_NAME}' exists but is not a consent stage Bellhop created — rename or delete it in Authentik`
    );
  }
  if (policy && !(policy.model === EXPRESSION_POLICY_MODEL && policy.expression?.startsWith(MOBILE_CONSENT_MARKER))) {
    conflicts.push(
      `policy '${MOBILE_CONSENT_POLICY_NAME}' exists but was not created by Bellhop — rename or delete it in Authentik`
    );
  }
  if (conflicts.length > 0) return { ...empty, conflicts };

  // The flow is only needed to create a binding or to find an existing one,
  // and a binding can only exist while the stage does.
  let flowId: string | undefined;
  let binding: AuthentikFlowStageBinding | undefined;
  let policyBindingId: string | undefined;
  let stageMode: string | undefined;
  try {
    if (wanted || stage) flowId = await authentik.getDefaultAuthorizationFlowId();
    if (stage) {
      // Bindings of this stage on other flows are ignored; with several on
      // this flow, the first is reconciled and the rest left alone.
      binding = (await authentik.listFlowStageBindings(flowId!)).find((b) => b.stageId === stage.id);
      if (wanted) stageMode = (await authentik.getConsentStage(stage.id)).mode;
    }
    if (binding && policy) {
      // Listed by the PolicyBindingModel pk, but each result's targetId
      // reports the binding's own pk (research R4), so either id matches.
      const targetIds = new Set([binding.id, binding.policyBindingModelId]);
      policyBindingId = (await authentik.listPolicyBindingsForTarget(binding.policyBindingModelId)).find(
        (b) => b.policyId === policy.id && targetIds.has(b.targetId)
      )?.id;
    }
  } catch (err) {
    if (wanted) throw err;
    return empty;
  }

  const changes: MobileConsentChange[] = [];
  if (wanted) {
    if (!stage) changes.push({ object: 'stage', action: 'create' });
    else if (stageMode !== CONSENT_MODE) changes.push({ object: 'stage', action: 'update', detail: 'mode' });
    const uriCount = `${uris.length} mobile redirect URI(s)`;
    if (!policy) changes.push({ object: 'policy', action: 'create', detail: uriCount });
    else if (policy.expression !== expression) {
      changes.push({ object: 'policy', action: 'update', detail: `expression (${uriCount})` });
    }
    if (!binding) changes.push({ object: 'binding', action: 'create' });
    else {
      const drift = [
        ...(binding.evaluateOnPlan !== false ? ['evaluate_on_plan'] : []),
        ...(binding.reEvaluatePolicies !== true ? ['re_evaluate_policies'] : []),
      ];
      if (drift.length > 0) changes.push({ object: 'binding', action: 'update', detail: drift.join(', ') });
    }
    if (!policyBindingId) changes.push({ object: 'policy-binding', action: 'create' });
  } else {
    // Only owned objects reach here; deleted in R8's order.
    if (policyBindingId) changes.push({ object: 'policy-binding', action: 'delete' });
    if (binding) changes.push({ object: 'binding', action: 'delete' });
    if (policy) changes.push({ object: 'policy', action: 'delete' });
    if (stage) changes.push({ object: 'stage', action: 'delete' });
  }

  return {
    changes,
    conflicts,
    flowId,
    expression,
    stageId: stage?.id,
    policyId: policy?.id,
    binding,
    policyBindingId,
  };
}

// Executes a plan's changes in order, pushing each onto `made` as it
// completes (so a failure partway reports only what happened). Cached flow
// plans are cleared once after any binding or policy change (FR-015) --
// including when a later step failed, since the changes already made are
// live either way.
async function applyMobileConsent(
  plan: MobileConsentPlan,
  authentik: AuthentikClient,
  made: MobileConsentChange[]
): Promise<void> {
  let { stageId, policyId, binding } = plan;
  let failed = true;
  // A binding was created and then deleted again: a flow plan may have been
  // cached in between, so the cache is cleared even if nothing else remains.
  let rolledBack = false;
  try {
    for (const change of plan.changes) {
      const key = `${change.object}:${change.action}`;
      switch (key) {
        case 'stage:create':
          stageId = (await authentik.createConsentStage({ name: MOBILE_CONSENT_STAGE_NAME, mode: CONSENT_MODE })).id;
          break;
        case 'stage:update':
          await authentik.updateConsentStage(stageId!, { mode: CONSENT_MODE });
          break;
        case 'stage:delete':
          await authentik.deleteStage(stageId!);
          break;
        case 'policy:create':
          policyId = (
            await authentik.createExpressionPolicy({ name: MOBILE_CONSENT_POLICY_NAME, expression: plan.expression })
          ).id;
          break;
        case 'policy:update':
          await authentik.updateExpressionPolicy(policyId!, { expression: plan.expression });
          break;
        case 'policy:delete':
          await authentik.deletePolicy(policyId!);
          break;
        case 'binding:create':
          binding = await authentik.createFlowStageBinding({
            flowId: plan.flowId!,
            stageId: stageId!,
            order: CONSENT_BINDING_ORDER,
            evaluateOnPlan: false,
            reEvaluatePolicies: true,
          });
          break;
        case 'binding:update':
          await authentik.updateFlowStageBinding(binding!.id, { evaluateOnPlan: false, reEvaluatePolicies: true });
          break;
        case 'binding:delete':
          await authentik.deleteFlowStageBinding(binding!.id);
          break;
        case 'policy-binding:create':
          try {
            await authentik.createPolicyToTargetBinding({ targetId: binding!.policyBindingModelId, policyId: policyId! });
          } catch (err) {
            // A stage binding with no policy on it runs for every login. If
            // this run created it, take it back out rather than leave
            // consent on every browser sign-in until the next run. A binding
            // that existed before the run is left alone (repair case).
            const created = made.findIndex((c) => c.object === 'binding' && c.action === 'create');
            if (created < 0) throw err;
            try {
              await authentik.deleteFlowStageBinding(binding!.id);
            } catch (rollbackErr) {
              throw new Error(
                `${errorMessage(err)}; removing the new stage binding also failed (${errorMessage(rollbackErr)}), so every login on the flow shows the consent page until the next successful run`
              );
            }
            made.splice(created, 1);
            rolledBack = true;
            throw err;
          }
          break;
        case 'policy-binding:delete':
          await authentik.deletePolicyBinding(plan.policyBindingId!);
          break;
        default:
          throw new Error(`unknown mobile consent change: ${key}`);
      }
      made.push(change);
    }
    failed = false;
  } finally {
    // A stage-only change (a mode repair) needs no clear: the consent stage
    // reads its mode when it executes, not from the cached plan.
    if (rolledBack || made.some((c) => c.object !== 'stage')) {
      try {
        await authentik.clearFlowCache();
      } catch (err) {
        // A failed clear after a failed step must not hide the original error.
        if (!failed) throw err;
      }
    }
  }
}

export type OidcInstanceSettings =
  | {
      ok: true;
      signingKeyId: string;
      scopeMappingIds: string[];
      // issue #16: every listed mapping's id -> scope name, so
      // diffOAuth2Settings can tell whether a required scope is covered by
      // some attached mapping (built-in or custom) rather than requiring the
      // exact built-in id. data-model.md "Scope coverage rule".
      scopeNameById: ReadonlyMap<string, string>;
    }
  | { ok: false; kind: 'missing-signing-key' | 'missing-scope-mapping'; reason: string };

// The instance-wide half of an OpenID client's settings (research R3): the
// signing key named AUTHENTIK_OIDC_SIGNING_KEY_NAME and the managed scope
// mappings. Shared by planOidc (which turns a failure into a skip for every
// OIDC entry, FR-015) and adopt-oidc-client (which throws the same reason),
// so both word a missing key or mapping identically. Never throws.
export async function resolveOidcInstanceSettings(authentik: AuthentikClient): Promise<OidcInstanceSettings> {
  const keyName = authentikConfig().oidcSigningKeyName;
  let signingKeyId: string;
  try {
    signingKeyId = await authentik.getSigningKeyId(keyName);
  } catch (err) {
    return {
      ok: false,
      kind: 'missing-signing-key',
      reason: `could not resolve the OIDC signing key '${keyName}' (AUTHENTIK_OIDC_SIGNING_KEY_NAME): ${errorMessage(err)}`,
    };
  }
  try {
    // One listing (issue #16, research.md R2) supplies both halves: the
    // three built-in ids, resolved by managed id below exactly as
    // getScopeMappingIds used to, and scopeNameById, every listed mapping's
    // id -> scope name -- an id with no managed id (a custom mapping) is
    // simply never a candidate here, but still appears in scopeNameById.
    const mappings = await authentik.listScopeMappings();
    const idByManaged = new Map(
      mappings.filter((m): m is AuthentikScopeMapping & { managed: string } => m.managed != null).map((m) => [m.managed, m.id])
    );
    const scopeMappingIds = OIDC_SCOPE_MAPPINGS.map((managed) => {
      const id = idByManaged.get(managed);
      if (!id) throw new Error(`No Authentik scope property mapping found for managed id '${managed}'`);
      return id;
    });
    const scopeNameById = new Map(mappings.map((m) => [m.id, m.scopeName]));
    return { ok: true, signingKeyId, scopeMappingIds, scopeNameById };
  } catch (err) {
    return { ok: false, kind: 'missing-scope-mapping', reason: `could not resolve the OpenID scope mappings: ${errorMessage(err)}` };
  }
}

export interface GroupBindingIndex {
  groupIdByName: Map<string, string>;
  groupNameById: Map<string, string>;
  // Group-backed bindings only, keyed by target Application pk.
  bindingsByTarget: Map<string, AuthentikPolicyBinding[]>;
}

// The lookups planBindingChanges takes, built once from the raw group and
// binding listings -- shared by runSyncAuthentik and adopt-oidc-client. A
// policy- or user-backed binding is never ours, so it is left out; so is
// any binding on an Application in `excludeTargetPks` (one this run deletes).
export function indexGroupBindings(
  groups: AuthentikGroup[],
  bindings: AuthentikPolicyBinding[],
  excludeTargetPks: ReadonlySet<string> = new Set()
): GroupBindingIndex {
  const bindingsByTarget = new Map<string, AuthentikPolicyBinding[]>();
  for (const binding of bindings) {
    if (binding.groupId === undefined) continue;
    if (excludeTargetPks.has(binding.targetId)) continue;
    const list = bindingsByTarget.get(binding.targetId) ?? [];
    list.push(binding);
    bindingsByTarget.set(binding.targetId, list);
  }
  return {
    groupIdByName: new Map(groups.map((g) => [g.name, g.id])),
    groupNameById: new Map(groups.map((g) => [g.id, g.name])),
    bindingsByTarget,
  };
}

interface OidcCreatePlan {
  slug: string;
  settings: DesiredOAuth2Settings;
  // An existing provider named after the slug with no Application, reused
  // instead of creating a duplicate, plus whatever drift it has.
  orphan?: { id: string; changes: string[]; patch: Partial<OAuth2ProviderSettings> };
  // Set for a forward -> oidc switch: the owned proxy-backed Application
  // that gets repointed at the new client instead of a new Application
  // being created (research R5).
  switchFrom?: AuthentikApplication;
  // The switch's outgoing proxy provider holds the slug name and must be
  // renamed out of the way first (REPLACED_PROVIDER_SUFFIX).
  renameOutgoing?: boolean;
}

interface OidcUpdatePlan {
  slug: string;
  providerId: string;
  changes: string[];
  patch: Partial<OAuth2ProviderSettings>;
}

interface OidcPlan {
  creates: OidcCreatePlan[];
  updates: OidcUpdatePlan[];
  skipped: OidcSkip[];
}

// The OIDC half of the planning section: computed from data fetched before
// any mutation, reported identically by the dry run and executed as-is by
// --apply. `entries` are OIDC entries that are free (no Application at the
// slug), backed by a Bellhop-owned OAuth2 client, or backed by a
// Bellhop-owned proxy provider (a forward -> oidc switch); conflicts were
// filtered out by the caller.
//
// The signing key and scope mappings are instance-wide, so they are looked
// up once, and only when some entry has callback URLs to act on. Either
// lookup failing skips every such entry with a reason naming what to fix
// (research R3), while forward-auth entries in the same run carry on
// (FR-015) -- which is why this returns skips instead of throwing.
async function planOidc(
  entries: CandidateEntry[],
  managedBySlug: Map<string, AuthentikApplication>,
  ownedKindBySlug: Map<string, OwnedProviderKind>,
  providerIndex: ProviderIndex,
  oauth2ProvidersById: Map<string, AuthentikOAuth2Provider>,
  authentik: AuthentikClient
): Promise<OidcPlan> {
  const plan: OidcPlan = { creates: [], updates: [], skipped: [] };

  const withUris: Array<CandidateEntry & { oidcRedirectUris: string[] }> = [];
  for (const entry of entries) {
    if ((entry.oidcRedirectUris?.length ?? 0) === 0) {
      // Never PATCH an owned client's callbacks down to nothing: an entry
      // that lost its URLs is incomplete configuration, not a request to
      // lock the app's login out.
      plan.skipped.push({ slug: entry.slug, kind: 'missing-redirect-uris', reason: MISSING_REDIRECT_URIS_REASON });
    } else {
      withUris.push(entry as CandidateEntry & { oidcRedirectUris: string[] });
    }
  }
  if (withUris.length === 0) return plan;

  const instance = await resolveOidcInstanceSettings(authentik);
  if (!instance.ok) {
    for (const entry of withUris) plan.skipped.push({ slug: entry.slug, kind: instance.kind, reason: instance.reason });
    return plan;
  }
  const { signingKeyId, scopeMappingIds, scopeNameById } = instance;

  for (const entry of withUris) {
    const settings = desiredOAuth2Settings(clientRedirectUris(entry), signingKeyId, scopeMappingIds);
    const application = managedBySlug.get(entry.slug);
    if (application && ownedKindBySlug.get(entry.slug) === 'oauth2') {
      // Owned as OAuth2, so this lookup always succeeds.
      const provider = oauth2ProvidersById.get(application.providerId!)!;
      const { changes, patch } = diffOAuth2Settings(provider, settings, scopeNameById);
      if (changes.length > 0) plan.updates.push({ slug: entry.slug, providerId: provider.id, changes, patch });
      continue;
    }
    // A new client is needed (a fresh entry, or a forward -> oidc switch).
    const naming = planProviderName(entry.slug, 'oauth2', application?.providerId, providerIndex);
    if ('skip' in naming) {
      plan.skipped.push({ slug: entry.slug, kind: 'provider-name-taken', reason: naming.skip });
      continue;
    }
    const orphan = naming.reuseId ? oauth2ProvidersById.get(naming.reuseId)! : undefined;
    plan.creates.push({
      slug: entry.slug,
      settings,
      // A reused leftover may be hand-made, so it ends exactly like a new
      // client: the three built-in mappings and nothing else (issue #16).
      ...(orphan ? { orphan: { id: orphan.id, ...diffOAuth2Settings(orphan, settings, 'exact') } } : {}),
      ...(application ? { switchFrom: application, renameOutgoing: naming.renameOutgoing } : {}),
    });
  }
  return plan;
}

interface ForwardSwitch {
  slug: string;
  externalHost: string;
  // The owned OAuth2-backed Application, repointed in place.
  application: AuthentikApplication;
  // An existing proxy provider named after the slug that no Application
  // points at, reused instead of creating a duplicate (the same self-heal
  // as the proxy create path).
  orphanProxyProviderId?: string;
  // The outgoing OAuth2 client holds the slug name and must be renamed out
  // of the way first (REPLACED_PROVIDER_SUFFIX).
  renameOutgoing: boolean;
}

// The oidc -> forward half of research R5, planned before any mutation like
// everything else. `entries` are forward entries whose slug holds a
// Bellhop-owned OAuth2 Application. When the name the new proxy provider
// needs is not free (planProviderName), the switch is not attempted: the
// entry is reported and its OpenID client kept.
function planForwardSwitches(
  entries: CandidateEntry[],
  managedBySlug: Map<string, AuthentikApplication>,
  providerIndex: ProviderIndex
): { switches: ForwardSwitch[]; skipped: OidcSkip[] } {
  const switches: ForwardSwitch[] = [];
  const skipped: OidcSkip[] = [];
  for (const entry of entries) {
    const application = managedBySlug.get(entry.slug)!;
    const naming = planProviderName(entry.slug, 'proxy', application.providerId, providerIndex);
    if ('skip' in naming) {
      skipped.push({ slug: entry.slug, kind: 'provider-name-taken', reason: naming.skip });
      continue;
    }
    switches.push({
      slug: entry.slug,
      externalHost: entry.externalHost,
      application,
      renameOutgoing: naming.renameOutgoing,
      ...(naming.reuseId ? { orphanProxyProviderId: naming.reuseId } : {}),
    });
  }
  return { switches, skipped };
}

interface ProviderRef {
  id: string;
  name: string;
  kind: OwnedProviderKind;
}

interface ProviderIndex {
  providers: ProviderRef[];
  // providerId -> slug of the Application using it.
  usedBy: Map<string, string>;
}

function buildProviderIndex(
  proxyProviders: AuthentikProxyProvider[],
  oauth2Providers: AuthentikOAuth2Provider[],
  applications: AuthentikApplication[]
): ProviderIndex {
  const usedBy = new Map<string, string>();
  for (const a of applications) if (a.providerId != null) usedBy.set(a.providerId, a.slug);
  // Authentik's own reverse lookup, for an Application the listing missed.
  for (const p of oauth2Providers) {
    if (p.assignedApplicationSlug !== undefined && !usedBy.has(p.id)) usedBy.set(p.id, p.assignedApplicationSlug);
  }
  return {
    providers: [
      ...proxyProviders.map((p) => ({ id: p.id, name: p.name, kind: 'proxy' as const })),
      ...oauth2Providers.map((p) => ({ id: p.id, name: p.name, kind: 'oauth2' as const })),
    ],
    usedBy,
  };
}

// Where a new provider named after `slug` comes from, decided before any
// mutation so dry run and apply agree. Provider names are unique across every
// kind in Authentik, so:
//   - A switch's outgoing provider (`outgoingId`) that holds the slug name is
//     renamed to `<slug> (replaced)` first; that name must itself be free.
//   - Any *other* provider already holding the slug name blocks the create,
//     except an unused provider of the wanted kind, which is reused (the
//     partial-failure self-heal -- it can never steal a provider some other
//     Application relies on). A provider of the other kind, or one serving
//     another Application, is never touched: the entry is skipped with a
//     reason instead of failing mid-apply on a duplicate name.
function planProviderName(
  slug: string,
  wantKind: OwnedProviderKind,
  outgoingId: string | undefined,
  index: ProviderIndex
): { reuseId?: string; renameOutgoing: boolean } | { skip: string } {
  const outgoing = outgoingId === undefined ? undefined : index.providers.find((p) => p.id === outgoingId);
  const renameOutgoing = outgoing?.name === slug;
  if (renameOutgoing) {
    const replacedName = `${slug}${REPLACED_PROVIDER_SUFFIX}`;
    const holder = index.providers.find((p) => p.name === replacedName && p.id !== outgoingId);
    if (holder) return { skip: providerNameTakenReason(holder, index.usedBy.get(holder.id)) };
  }
  const named = index.providers.find((p) => p.name === slug && p.id !== outgoingId);
  if (!named) return { renameOutgoing };
  const user = index.usedBy.get(named.id);
  if (user !== undefined || named.kind !== wantKind) return { skip: providerNameTakenReason(named, user) };
  return { reuseId: named.id, renameOutgoing };
}

// research.md R6: fetch `<issuer>.well-known/openid-configuration` and
// record whether it answered with JSON. Never throws. The issuer comes from
// the secret-free getOAuth2Issuer, so a client secret never passes through
// this command (FR-004).
async function checkOidcDiscovery(
  slug: string,
  providerId: string,
  authentik: AuthentikClient,
  fetchImpl: typeof fetch
): Promise<OidcDiscoveryResult> {
  let issuer = '';
  try {
    issuer = await authentik.getOAuth2Issuer(providerId);
    const url = `${issuer.endsWith('/') ? issuer : `${issuer}/`}.well-known/openid-configuration`;
    let response: Response;
    try {
      response = await fetchImpl(url, { signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) });
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        return { slug, issuer, ok: false, error: timeoutError(url) };
      }
      throw err;
    }
    if (!response.ok) return { slug, issuer, ok: false, error: `HTTP ${response.status} from ${url}` };
    // A 200 that is not JSON is usually something else answering in
    // Authentik's place (a proxy's error or login page), not a working issuer.
    try {
      await response.json();
    } catch (err) {
      // The timeout signal also covers reading the body, so a stall after
      // the headers lands here -- report it as the timeout it is.
      if (err instanceof Error && err.name === 'TimeoutError') {
        return { slug, issuer, ok: false, error: timeoutError(url) };
      }
      return { slug, issuer, ok: false, error: `${url} did not return a JSON discovery document` };
    }
    return { slug, issuer, ok: true };
  } catch (err) {
    return { slug, issuer, ok: false, error: errorMessage(err) };
  }
}

function timeoutError(url: string): string {
  return `timeout: no response from ${url} within ${DISCOVERY_TIMEOUT_MS / 1000}s`;
}

function providerNameTakenReason(provider: ProviderRef, applicationSlug: string | undefined): string {
  const kind = provider.kind === 'oauth2' ? 'an OAuth2' : 'a proxy';
  const use = applicationSlug === undefined ? 'no Application uses it' : `it serves the Application '${applicationSlug}'`;
  return `${kind} provider named '${provider.name}' already exists (${use}); Authentik provider names are unique, so rename or delete that provider in Authentik`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Whether a sync-authentik run should fail the CLI (contracts/interfaces.md):
// only on --apply, and only for a failed discovery check or instance-wide
// misconfiguration (a missing signing key or scope mapping). A missing
// callback URL is one entry's incomplete setup and a dry run only previews,
// so neither fails the run. A mobile consent-step failure fails it too
// (research R9); a consent-step conflict alone does not.
export function syncAuthentikFailed(result: SyncAuthentikResult): boolean {
  if (!result.applied) return false;
  return (
    Boolean(result.mobileConsent?.error) ||
    (result.discovery ?? []).some((d) => !d.ok) ||
    (result.oidcSkipped ?? []).some((s) => s.kind === 'missing-signing-key' || s.kind === 'missing-scope-mapping')
  );
}

interface BindingPlan {
  slug: string;
  addGroupIds: string[];
  removeBindingIds: string[];
  changes: BindingChange[];
}

// The add/remove diff for every actionable entry's policy bindings, computed
// once from data fetched before any mutation happens -- shared by the dry
// run (which only reports `changes`) and --apply (which also executes
// `addGroupIds`/`removeBindingIds`). An entry not yet backed by a managed
// Application (still in toCreate at the time this runs) has no bindings to
// read, so its plan is "add every wanted rung, remove nothing" either way --
// identical whether the Application already exists or is about to be
// created with a clean slate.
// Exported for adopt-oidc-client.ts (issue #1, U9): adoption reconciles one
// entry's bindings exactly the way a sync run would, so it reuses this
// rather than a second copy of the add/remove diff logic.
export function planBindingChanges(
  actionable: Array<CandidateEntry & { authGroup: string }>,
  skipSlugs: Set<string>,
  managedBySlug: Map<string, AuthentikApplication>,
  bindingsByTarget: Map<string, AuthentikPolicyBinding[]>,
  ladder: string[],
  groupIdByName: Map<string, string>,
  groupNameById: Map<string, string>
): BindingPlan[] {
  const ladderNames = new Set(ladder);
  const plans: BindingPlan[] = [];

  for (const entry of actionable) {
    // Not ours to touch this run: an existing, unowned Application already
    // holds this slug (`conflicting`), or it is an OIDC-related entry skipped
    // before its Application was ever created (see runSyncAuthentik).
    if (skipSlugs.has(entry.slug)) continue;

    const application = managedBySlug.get(entry.slug);
    const current = application ? (bindingsByTarget.get(application.pk) ?? []) : [];
    const boundIds = new Set(current.map((b) => b.groupId!));
    // Safe non-null assertion: see the identical comment on the
    // `neededRungs` loop in runSyncAuthentik -- `actionable` never contains
    // an off-ladder entry.
    const wantedNames = rungsAtOrAbove(ladder, entry.authGroup)!;
    const wantedIds = new Set(
      wantedNames.map((rung) => groupIdByName.get(rung)).filter((id): id is string => id !== undefined)
    );

    const addGroupIds: string[] = [];
    const removeBindingIds: string[] = [];
    const changes: BindingChange[] = [];

    for (const groupId of wantedIds) {
      if (!boundIds.has(groupId)) {
        addGroupIds.push(groupId);
        changes.push({ slug: entry.slug, group: groupNameById.get(groupId)!, action: 'add' });
      }
    }
    for (const binding of current) {
      const groupName = groupNameById.get(binding.groupId!);
      // Only a binding to a group on the ladder is ours to remove. A
      // hand-added binding to an unrelated group survives -- the same narrow
      // ownership as the provider-kind check in #154.
      if (groupName !== undefined && ladderNames.has(groupName) && !wantedIds.has(binding.groupId!)) {
        removeBindingIds.push(binding.id);
        changes.push({ slug: entry.slug, group: groupName, action: 'remove' });
      }
    }

    if (changes.length > 0) plans.push({ slug: entry.slug, addGroupIds, removeBindingIds, changes });
  }

  return plans;
}

export function formatSyncAuthentik(result: SyncAuthentikResult): string {
  const lines: string[] = [];
  lines.push(`Applications to create: ${result.toCreate.length}`);
  for (const name of result.toCreate) lines.push(`  + ${name}`);
  lines.push(`Applications to remove: ${result.toRemove.length}`);
  for (const name of result.toRemove) lines.push(`  - ${name}`);
  // Each OIDC section is printed only when non-empty, so output for an
  // inventory with no OIDC entries is byte-identical to before issue #1.
  const oidcToCreate = result.oidcToCreate ?? [];
  if (oidcToCreate.length > 0) {
    lines.push(`OpenID clients to create: ${oidcToCreate.length}`);
    for (const slug of oidcToCreate) lines.push(`  + ${slug}`);
  }
  const oidcUpdates = result.oidcUpdates ?? [];
  if (oidcUpdates.length > 0) {
    lines.push(`OpenID client settings to update: ${oidcUpdates.length}`);
    for (const update of oidcUpdates) lines.push(`  ~ ${update.slug}: ${update.changes.join(', ')}`);
  }
  const modeSwitches = result.modeSwitches ?? [];
  if (modeSwitches.length > 0) {
    lines.push(`Auth mode switches: ${modeSwitches.length}`);
    for (const change of modeSwitches) lines.push(`  ~ ${change.slug}: ${change.from} -> ${change.to}`);
  }
  // The FR-014 warning: deleting an OpenID client breaks the app's
  // configured login, so the preview says so before apply does it.
  const oidcDeletions = result.oidcDeletions ?? [];
  if (oidcDeletions.length > 0) {
    lines.push(`OpenID clients to delete: ${oidcDeletions.length}`);
    for (const slug of oidcDeletions) lines.push(`  - ${slug} — ${OIDC_DELETION_WARNING}`);
  }
  // Printed only when non-empty, so ordinary output is unchanged. Covers a
  // pure tier change too -- one that creates and deletes no Applications
  // but still moves an entry's binding set, which would otherwise preview
  // as "nothing to do".
  if (result.bindingChanges.length > 0) {
    lines.push(`Policy bindings to change: ${result.bindingChanges.length}`);
    for (const change of result.bindingChanges) {
      const symbol = change.action === 'add' ? '+' : '-';
      lines.push(`  ${symbol} ${change.slug} -> ${change.group}`);
    }
  }
  const outpostChanges = result.outpostChanges ?? [];
  if (outpostChanges.length > 0) {
    lines.push(`Outpost changes: ${outpostChanges.length}`);
    for (const change of outpostChanges) lines.push(`  ${change.action === 'add' ? '+' : '-'} ${change.slug}`);
  }
  // Printed only when non-empty, so ordinary output is unchanged.
  if (result.conflicts.length > 0) {
    lines.push(`Applications in conflict: ${result.conflicts.length}`);
    for (const name of result.conflicts) lines.push(`  ! ${name} — ${conflictExplanation(name, result)}`);
  }
  if (result.offLadder.length > 0) {
    lines.push(`Entries with an unknown authGroup: ${result.offLadder.length}`);
    for (const entry of result.offLadder) {
      lines.push(`  ! ${entry.slug} (${entry.authGroup}) — ${OFF_LADDER_EXPLANATION}`);
    }
  }
  if (result.missingRungs.length > 0) {
    lines.push(`Ladder rungs missing from Authentik: ${result.missingRungs.length}`);
    for (const rung of result.missingRungs) lines.push(`  ! ${rung} — ${MISSING_RUNG_EXPLANATION}`);
  }
  const forwardSkipped = result.forwardSkipped ?? [];
  if (forwardSkipped.length > 0) {
    lines.push(`Forward-auth entries skipped: ${forwardSkipped.length}`);
    for (const skip of forwardSkipped) lines.push(`  ! ${skip.slug} — ${skip.reason}`);
  }
  const oidcSkipped = result.oidcSkipped ?? [];
  if (oidcSkipped.length > 0) {
    lines.push(`OIDC entries skipped: ${oidcSkipped.length}`);
    for (const skip of oidcSkipped) lines.push(`  ! ${skip.slug} — ${skip.reason}`);
  }
  // Mobile consent-step sections (issue #22, contracts/interfaces.md §2):
  // printed only when non-empty, so a result with no mobile URIs and
  // nothing to remove -- absent or empty `mobileConsent` alike -- formats
  // byte-identically to before this feature (FR-016). Placed after every
  // other reconcile section but before discovery, which stays last.
  const mobileConsent = result.mobileConsent;
  if (mobileConsent) {
    if (mobileConsent.changes.length > 0) {
      lines.push(
        `Mobile consent step: ${mobileConsent.changes.length} change(s) for ${mobileConsent.uris.length} mobile redirect URI(s)`
      );
      for (const change of mobileConsent.changes) lines.push(formatMobileConsentChange(change));
    }
    if (mobileConsent.conflicts.length > 0) {
      lines.push(`Mobile consent conflicts: ${mobileConsent.conflicts.length}`);
      for (const conflict of mobileConsent.conflicts) lines.push(`  ! ${conflict}`);
    }
    if (mobileConsent.error) lines.push(`Mobile consent step failed: ${mobileConsent.error}`);
  }
  const discovery = result.discovery ?? [];
  if (discovery.length > 0) {
    lines.push(`OIDC discovery: ${discovery.length}`);
    for (const check of discovery) {
      lines.push(check.ok ? `  ✓ ${check.slug} ${check.issuer}` : `  ✗ ${check.slug} ${check.issuer} — ${check.error}`);
    }
  }
  return lines.join('\n');
}

// The human-readable name for a mobile consent-step object (contracts/
// interfaces.md §2): the stage/policy names Bellhop owns are fixed
// constants, the binding names the configured authorization flow it's
// attached to, and the policy-binding has no name of its own to add.
function mobileConsentObjectLabel(object: MobileConsentChange['object']): string {
  switch (object) {
    case 'stage':
      return `stage ${MOBILE_CONSENT_STAGE_NAME}`;
    case 'policy':
      return `policy ${MOBILE_CONSENT_POLICY_NAME}`;
    case 'binding':
      return `binding on ${authentikConfig().authorizationFlowSlug}`;
    case 'policy-binding':
      return 'policy-binding';
  }
}

function formatMobileConsentChange(change: MobileConsentChange): string {
  const label = mobileConsentObjectLabel(change.object);
  if (change.action === 'create') return `  + ${label}`;
  if (change.action === 'delete') return `  - ${label}`;
  return `  ~ ${label}: ${change.detail ?? ''}`;
}
