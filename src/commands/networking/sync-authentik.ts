import type {
  AuthentikApplication,
  AuthentikClient,
  AuthentikOAuth2Provider,
  AuthentikPolicyBinding,
  OAuth2ProviderSettings,
} from '../../lib/authentik-client.ts';
import type { Inventory } from '../../lib/inventory.ts';
import { effectiveAuth } from '../../lib/inventory.ts';
import { authentikConfig, rungsAtOrAbove } from '../../lib/authentik-config.ts';

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
  // reported rather than attempted -- syncCaddyLive runs this command on
  // every Dashboard subdomains edit, and an edit elsewhere in the inventory
  // must not fail over a pre-existing clash.
  conflicts: string[];
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
  // OIDC entries left alone this run, and why (controller ruling R-1).
  oidcSkipped?: OidcSkip[];
  // Apply only: the post-apply discovery check, one per owned OIDC entry.
  discovery?: OidcDiscoveryResult[];
  applied: boolean;
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
export type OidcSkipKind = 'missing-redirect-uris' | 'missing-signing-key' | 'missing-scope-mapping';

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

// Shared by formatSyncAuthentik and src/web/caddy-sync.ts so the CLI and the
// job log describe a conflict the same way. The two React banners
// deliberately carry their own shorter wording instead -- this string does
// not fit the Advanced modal's narrow value column (see the
// banner-shortening commit).
export const CONFLICT_EXPLANATION =
  'an Application with this slug already exists in Authentik and is not managed by this toolkit (no proxy provider behind it, and not an OpenID client marked as Bellhop\'s); resolve by hand';

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
];

// Same bound as RealCloudflareClient's per-request timeout, so a stalled
// Authentik cannot hang a Dashboard save that runs this via syncCaddyLive.
const DISCOVERY_TIMEOUT_MS = 10_000;

// `name` is deliberately absent: the Application/Provider display name is
// the slug verbatim (issue #156), so a second field holding the same value
// would just be a chance for the two to drift.
interface CandidateEntry {
  slug: string;
  externalHost: string;
  authGroup?: string;
  authMode?: 'forward' | 'oidc';
  oidcRedirectUris?: string[];
}

type SubdomainOwner = {
  authGroup?: string;
  subdomains?: string[];
  authMode?: 'forward' | 'oidc';
  oidcRedirectUris?: string[];
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
      externalHost: `https://${slug}.${inventory.domain}`,
      authGroup: owner.authGroup,
      authMode: owner.authMode,
      oidcRedirectUris: owner.oidcRedirectUris,
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

// research.md R4: grant types and scope mappings compared as sets, redirect
// URIs as a set of (matching_mode, url). Returns the Authentik field name of
// every drifted setting, in a fixed order, and a patch carrying only those
// fields. Credentials are not part of DesiredOAuth2Settings, so a patch
// built here can never rotate client_id/client_secret (FR-009). Shared with
// the adopt action, whose preview must show exactly this diff (FR-011a).
export function diffOAuth2Settings(
  current: AuthentikOAuth2Provider,
  desired: DesiredOAuth2Settings
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
  if (!sameSet(current.propertyMappingIds, desired.propertyMappingIds)) {
    changes.push('property_mappings');
    patch.propertyMappingIds = desired.propertyMappingIds;
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
  // Truthy, not just !== undefined -- matches sync-caddy's own `entry.authGroup`
  // gate (buildCaddyBlock) so the two commands never disagree about whether
  // an authGroup: '' entry is gated. That value is unreachable through the
  // zod schema but reachable from a hand-built Inventory literal (every test
  // fixture in this repo is one) -- without this, sync-authentik could create
  // an Application that sync-caddy never routes forward_auth to.
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
  // `managed` exactly the way --apply does -- before issue #154 the preview
  // would report a deletion that apply then made against an Application this
  // command never created. Reused by both apply branches below.
  const proxyProviders = await deps.authentik.listProxyProviders();
  const proxyProviderIds = new Set(proxyProviders.map((p) => p.id));
  // Fetched for the same parity reason, and always -- ownership of an
  // existing OAuth2-backed Application matters even in a run whose
  // inventory has no OIDC entry (a forward entry must not treat one as a
  // conflict).
  const oauth2Providers = await deps.authentik.listOAuth2Providers();
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
  // `managed` keeps its pre-OIDC meaning -- proxy-owned only -- because it
  // drives toRemove and the proxy/outpost cleanup below. Deleting an owned
  // OAuth2 Application whose gate was cleared is later work (T031/T033,
  // oidcDeletions); until then such an Application is left in place.
  const managed = applications.filter((a) => ownedKindBySlug.get(a.slug) === 'proxy');
  // Every owned Application of either kind: what binding planning and the
  // apply-time binding pass resolve a slug's Application pk through.
  const managedBySlug = new Map(
    applications.filter((a) => ownedKindBySlug.has(a.slug)).map((a) => [a.slug, a])
  );

  // An entry whose slug holds an owned Application of the *other* provider
  // kind is a mode switch (forward <-> oidc, research R5). Swapping the
  // provider is later work (T031); until then the entry is left completely
  // untouched -- no create, no settings reconcile, no binding changes, and
  // nothing reported -- so a half-implemented swap can never run.
  const wantedKind = (d: CandidateEntry): OwnedProviderKind => (effectiveAuth(d) === 'oidc' ? 'oauth2' : 'proxy');
  const modeSwitchDeferred = new Set(
    actionable
      .filter((d) => {
        const owned = ownedKindBySlug.get(d.slug);
        return owned !== undefined && owned !== wantedKind(d);
      })
      .map((d) => d.slug)
  );

  // A desired entry's slug is a candidate slug by construction, so "not
  // managed but an Application exists" means exactly "that Application is
  // not owned by either rule" -- another provider kind, no provider, or an
  // OAuth2 client without the Bellhop marker.
  const applicationsBySlug = new Map(applications.map((a) => [a.slug, a]));
  const notYetManaged = actionable.filter((d) => !managedBySlug.has(d.slug));
  const conflicting = notYetManaged.filter((d) => applicationsBySlug.has(d.slug));
  const unclaimed = notYetManaged.filter((d) => !applicationsBySlug.has(d.slug));
  const toCreate = unclaimed.filter((d) => wantedKind(d) === 'proxy');
  const toRemove = managed.filter((a) => !desired.some((d) => d.slug === a.slug));
  const conflictingSlugs = new Set(conflicting.map((d) => d.slug));

  // Every OIDC entry this run may create or reconcile: not blocked by a
  // conflict and not a deferred mode switch.
  const oidcEntries = actionable.filter(
    (d) => wantedKind(d) === 'oauth2' && !conflictingSlugs.has(d.slug) && !modeSwitchDeferred.has(d.slug)
  );
  const oidcPlan = await planOidc(oidcEntries, managedBySlug, oauth2Providers, oauth2ProvidersById, deps.authentik);
  // A skipped entry with no Application yet gets nothing, bindings
  // included. A skipped entry that is already owned still has its bindings
  // reconciled: they do not depend on the missing setting, and skipping
  // them would leave a raised tier's wider audience in place.
  const oidcSkippedUnowned = oidcPlan.skipped.filter((s) => !managedBySlug.has(s.slug)).map((s) => s.slug);

  // Fetched in the dry run too, so a preview reports a missing rung the same
  // way apply does rather than announcing bindings it could not have made.
  const groups = await deps.authentik.listGroups();
  const groupIdByName = new Map(groups.map((g) => [g.name, g.id]));
  const groupNameById = new Map(groups.map((g) => [g.id, g.name]));

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

  // Fetched here too (not just inside an apply branch) so a dry run's
  // binding-change preview is computed from the same data --apply would
  // use, matching the `groups`/`proxyProviders` fetches above (issue #158
  // fix wave item 1).
  const bindings = await deps.authentik.listPolicyBindings();
  const removedApplicationPks = new Set(toRemove.map((a) => a.pk));
  const bindingsByTarget = new Map<string, AuthentikPolicyBinding[]>();
  for (const binding of bindings) {
    // A policy- or user-backed binding is never ours; a deleted
    // Application's bindings are gone with it (Authentik cascades).
    if (binding.groupId === undefined) continue;
    if (removedApplicationPks.has(binding.targetId)) continue;
    const list = bindingsByTarget.get(binding.targetId) ?? [];
    list.push(binding);
    bindingsByTarget.set(binding.targetId, list);
  }
  // Computed once and reported identically by both branches -- `--apply`
  // below executes exactly this plan rather than recomputing wantedIds/
  // boundIds itself.
  const bindingPlans = planBindingChanges(
    actionable,
    new Set([...conflictingSlugs, ...modeSwitchDeferred, ...oidcSkippedUnowned]),
    managedBySlug,
    bindingsByTarget,
    ladder,
    groupIdByName,
    groupNameById
  );
  const bindingChanges = bindingPlans.flatMap((p) => p.changes);

  const oidcReport = {
    oidcToCreate: oidcPlan.creates.map((c) => c.slug),
    oidcUpdates: oidcPlan.updates.map((u) => ({ slug: u.slug, changes: u.changes })),
    oidcSkipped: oidcPlan.skipped,
  };

  if (!opts.apply) {
    return {
      toCreate: toCreate.map((d) => d.slug),
      toRemove: toRemove.map((a) => a.slug),
      conflicts: conflicting.map((d) => d.slug),
      missingRungs,
      offLadder,
      bindingChanges,
      ...oidcReport,
      discovery: [],
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

  if (toCreate.length > 0 || toRemove.length > 0) {
    const outpost = await deps.authentik.getEmbeddedOutpost();
    const outpostProviderIds = new Set(outpost.providerIds);

    if (toCreate.length > 0) {
      const { authorizationFlowId, invalidationFlowId } = await getFlowIds();
      // Look up existing Providers by name before creating one -- self-heals
      // a prior partial failure (Provider created, then Application creation
      // failed) by reusing the orphaned Provider instead of colliding with
      // it on a duplicate name.
      // The name here is the slug verbatim (#156), so this lookup's
      // namespace is now the short-name space hand-created Providers also
      // live in -- ownership everywhere else keys on slug plus
      // proxy-provider backing (#154), never on name. A false match would
      // adopt a hand-created Provider onto a new Application and delete it
      // on a later gate change; unlikely, since it needs a name collision on
      // a Provider whose Application slug differs, but this is the one place
      // where that is possible.
      for (const entry of toCreate) {
        let provider = proxyProviders.find((p) => p.name === entry.slug);
        if (!provider) {
          provider = await deps.authentik.createProxyProvider({
            name: entry.slug,
            externalHost: entry.externalHost,
            authorizationFlowId,
            invalidationFlowId,
          });
        }
        const application = await deps.authentik.createApplication({
          name: entry.slug,
          slug: entry.slug,
          providerId: provider.id,
        });
        // Deliberately no policy binding here. The reconcile pass below
        // treats a just-created Application and a long-standing one
        // identically -- which is exactly what stops an Application's
        // audience from being frozen at creation time (#158).
        managedBySlug.set(application.slug, application);
        outpostProviderIds.add(provider.id);
      }
    }

    if (toRemove.length > 0) {
      for (const application of toRemove) {
        await deps.authentik.deleteApplication(application.id);
        // Both this and the `provider` lookup below are always satisfied for
        // anything in toRemove -- `managed` already required a providerId
        // present in proxyProviderIds. Kept as cheap invariant guards rather
        // than removed, so this loop stays correct if `managed` ever loosens.
        if (application.providerId) {
          outpostProviderIds.delete(application.providerId);
          const provider = proxyProviders.find((p) => p.id === application.providerId);
          if (provider) await deps.authentik.deleteProxyProvider(provider.id);
        }
      }
    }

    await deps.authentik.setOutpostProviders(outpost.id, [...outpostProviderIds]);
  }

  // OIDC creates and drift fixes. Never touches the embedded outpost: an
  // OAuth2 client is reached by the app itself, not through forward-auth.
  for (const create of oidcPlan.creates) {
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
  for (const update of oidcPlan.updates) {
    await deps.authentik.updateOAuth2Provider(update.providerId, update.patch);
  }

  // Deliberately outside the create/remove guard above: an entry moving
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

  // Every OIDC entry that has a Bellhop-owned OpenID client after this
  // apply -- created, updated, or unchanged -- so an apply always reports
  // current health, not just what it touched. A failure is reported, never
  // rolled back: the client is correct in Authentik, and the usual cause
  // (Authentik unreachable from here, a proxy in front of it) is outside it.
  const fetchImpl = deps.fetchImpl ?? fetch;
  const discovery = await Promise.all(
    oidcEntries
      .map((d) => managedBySlug.get(d.slug))
      .filter((a): a is AuthentikApplication & { providerId: string } => a?.providerId != null)
      .map((a) => checkOidcDiscovery(a.slug, a.providerId, deps.authentik, fetchImpl))
  );

  return {
    toCreate: toCreate.map((d) => d.slug),
    toRemove: toRemove.map((a) => a.slug),
    conflicts: conflicting.map((d) => d.slug),
    missingRungs,
    offLadder,
    bindingChanges,
    ...oidcReport,
    discovery,
    applied: true,
  };
}

interface OidcCreatePlan {
  slug: string;
  settings: DesiredOAuth2Settings;
  // An existing provider named after the slug with no Application, reused
  // instead of creating a duplicate, plus whatever drift it has.
  orphan?: { id: string; changes: string[]; patch: Partial<OAuth2ProviderSettings> };
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
// --apply. `entries` are OIDC entries that are either free (no Application
// at the slug) or backed by a Bellhop-owned OAuth2 client; conflicts and
// deferred mode switches were filtered out by the caller.
//
// The signing key and scope mappings are instance-wide, so they are looked
// up once, and only when some entry has callback URLs to act on. Either
// lookup failing skips every such entry with a reason naming what to fix
// (research R3), while forward-auth entries in the same run carry on
// (FR-015) -- which is why this returns skips instead of throwing.
async function planOidc(
  entries: CandidateEntry[],
  managedBySlug: Map<string, AuthentikApplication>,
  oauth2Providers: AuthentikOAuth2Provider[],
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

  const keyName = authentikConfig().oidcSigningKeyName;
  let signingKeyId: string;
  try {
    signingKeyId = await authentik.getSigningKeyId(keyName);
  } catch (err) {
    const reason = `could not resolve the OIDC signing key '${keyName}' (AUTHENTIK_OIDC_SIGNING_KEY_NAME): ${errorMessage(err)}`;
    for (const entry of withUris) plan.skipped.push({ slug: entry.slug, kind: 'missing-signing-key', reason });
    return plan;
  }
  let scopeMappingIds: string[];
  try {
    scopeMappingIds = await authentik.getScopeMappingIds(OIDC_SCOPE_MAPPINGS);
  } catch (err) {
    const reason = `could not resolve the OpenID scope mappings: ${errorMessage(err)}`;
    for (const entry of withUris) plan.skipped.push({ slug: entry.slug, kind: 'missing-scope-mapping', reason });
    return plan;
  }

  for (const entry of withUris) {
    const settings = desiredOAuth2Settings(entry.oidcRedirectUris, signingKeyId, scopeMappingIds);
    const application = managedBySlug.get(entry.slug);
    if (application) {
      // Owned as OAuth2 (the caller removed mode switches), so this lookup
      // always succeeds.
      const provider = oauth2ProvidersById.get(application.providerId!)!;
      const { changes, patch } = diffOAuth2Settings(provider, settings);
      if (changes.length > 0) plan.updates.push({ slug: entry.slug, providerId: provider.id, changes, patch });
      continue;
    }
    // Same name-based self-heal as the proxy path, restricted to a provider
    // with no assigned Application so it can never adopt a client some other
    // Application is using.
    const orphan = oauth2Providers.find((p) => p.name === entry.slug && p.assignedApplicationSlug === undefined);
    plan.creates.push({
      slug: entry.slug,
      settings,
      ...(orphan ? { orphan: { id: orphan.id, ...diffOAuth2Settings(orphan, settings) } } : {}),
    });
  }
  return plan;
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
        return { slug, issuer, ok: false, error: `timeout: no response from ${url} within ${DISCOVERY_TIMEOUT_MS / 1000}s` };
      }
      throw err;
    }
    if (!response.ok) return { slug, issuer, ok: false, error: `HTTP ${response.status} from ${url}` };
    // A 200 that is not JSON is usually something else answering in
    // Authentik's place (a proxy's error or login page), not a working issuer.
    try {
      await response.json();
    } catch {
      return { slug, issuer, ok: false, error: `${url} did not return a JSON discovery document` };
    }
    return { slug, issuer, ok: true };
  } catch (err) {
    return { slug, issuer, ok: false, error: errorMessage(err) };
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Whether a sync-authentik run should fail the CLI (contracts/interfaces.md):
// only on --apply, and only for a failed discovery check or instance-wide
// misconfiguration (a missing signing key or scope mapping). A missing
// callback URL is one entry's incomplete setup and a dry run only previews,
// so neither fails the run.
export function syncAuthentikFailed(result: SyncAuthentikResult): boolean {
  if (!result.applied) return false;
  return (
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
function planBindingChanges(
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
    // holds this slug (`conflicting`), the entry is a deferred mode switch,
    // or it is an OIDC entry skipped before its Application was ever created
    // (see runSyncAuthentik).
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
  // Printed only when non-empty, so ordinary output is unchanged.
  if (result.conflicts.length > 0) {
    lines.push(`Applications in conflict: ${result.conflicts.length}`);
    for (const name of result.conflicts) lines.push(`  ! ${name} — ${CONFLICT_EXPLANATION}`);
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
  const oidcSkipped = result.oidcSkipped ?? [];
  if (oidcSkipped.length > 0) {
    lines.push(`OIDC entries skipped: ${oidcSkipped.length}`);
    for (const skip of oidcSkipped) lines.push(`  ! ${skip.slug} — ${skip.reason}`);
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
