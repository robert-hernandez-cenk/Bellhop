import type { AuthentikApplication, AuthentikClient, AuthentikPolicyBinding } from '../../lib/authentik-client.ts';
import type { Inventory } from '../../lib/inventory.ts';
import { authentikConfig, rungsAtOrAbove } from '../../lib/authentik-config.ts';

export interface SyncAuthentikOptions {
  apply?: boolean;
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
  applied: boolean;
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
  'an Application with this slug already exists in Authentik and is not managed by this toolkit (no proxy provider behind it); resolve by hand';

// `name` is deliberately absent: the Application/Provider display name is
// the slug verbatim (issue #156), so a second field holding the same value
// would just be a chance for the two to drift.
interface CandidateEntry {
  slug: string;
  externalHost: string;
  authGroup?: string;
}

type SubdomainOwner = { authGroup?: string; subdomains?: string[] };

// A "candidate" is any entry with at least one subdomain, regardless of
// whether it currently names an authGroup -- this is what lets a gate being
// cleared on an otherwise-unchanged entry still be recognized as a removal
// target on the next run (its slug is still a candidate, just no longer
// desired). Being a candidate is necessary but NOT sufficient for
// this command to act on an Application: see `managed` in runSyncAuthentik,
// which additionally requires proxy-provider backing so that a hand-created
// OAuth2/OIDC Application sharing a slug is never touched (issue #154).
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
    });
  }
  return result;
}

export async function runSyncAuthentik(
  opts: SyncAuthentikOptions,
  deps: { authentik: AuthentikClient; inventory: Inventory }
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
  // Ownership is slug *and* proxy-provider backing. Matching on slug alone
  // deleted hand-created Applications backed by an OAuth2/OIDC provider
  // (issue #154): a proxy provider is the only kind this command ever
  // creates, so anything else is not ours to touch, whatever its slug.
  const managed = applications.filter(
    (a) => candidatesBySlug.has(a.slug) && a.providerId != null && proxyProviderIds.has(a.providerId)
  );
  const managedBySlug = new Map(managed.map((a) => [a.slug, a]));

  // A desired entry's slug is a candidate slug by construction, so "not
  // managed but an Application exists" means exactly "that Application is
  // not proxy-backed".
  const applicationsBySlug = new Map(applications.map((a) => [a.slug, a]));
  const notYetManaged = actionable.filter((d) => !managedBySlug.has(d.slug));
  const conflicting = notYetManaged.filter((d) => applicationsBySlug.has(d.slug));
  const toCreate = notYetManaged.filter((d) => !applicationsBySlug.has(d.slug));
  const toRemove = managed.filter((a) => !desired.some((d) => d.slug === a.slug));

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
  const conflictingSlugs = new Set(conflicting.map((d) => d.slug));
  // Computed once and reported identically by both branches -- `--apply`
  // below executes exactly this plan rather than recomputing wantedIds/
  // boundIds itself.
  const bindingPlans = planBindingChanges(
    actionable,
    conflictingSlugs,
    managedBySlug,
    bindingsByTarget,
    ladder,
    groupIdByName,
    groupNameById
  );
  const bindingChanges = bindingPlans.flatMap((p) => p.changes);

  if (!opts.apply) {
    return {
      toCreate: toCreate.map((d) => d.slug),
      toRemove: toRemove.map((a) => a.slug),
      conflicts: conflicting.map((d) => d.slug),
      missingRungs,
      offLadder,
      bindingChanges,
      applied: false,
    };
  }

  if (toCreate.length > 0 || toRemove.length > 0) {
    const outpost = await deps.authentik.getEmbeddedOutpost();
    const outpostProviderIds = new Set(outpost.providerIds);

    if (toCreate.length > 0) {
      const authorizationFlowId = await deps.authentik.getDefaultAuthorizationFlowId();
      const invalidationFlowId = await deps.authentik.getDefaultInvalidationFlowId();
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

  // Deliberately outside the create/remove guard above: an entry moving
  // between rungs changes nothing about which Applications exist, and would
  // otherwise be skipped silently. Executes exactly the plan computed above
  // -- `managedBySlug` now also holds anything just created, so a plan
  // entry for a brand-new Application resolves to its real pk here.
  for (const plan of bindingPlans) {
    const application = managedBySlug.get(plan.slug);
    // Absent means this slug is in `conflicting` -- reported, never touched.
    if (!application) continue;
    for (const groupId of plan.addGroupIds) {
      await deps.authentik.createPolicyBinding({ targetId: application.pk, groupId });
    }
    for (const bindingId of plan.removeBindingIds) {
      await deps.authentik.deletePolicyBinding(bindingId);
    }
  }

  return {
    toCreate: toCreate.map((d) => d.slug),
    toRemove: toRemove.map((a) => a.slug),
    conflicts: conflicting.map((d) => d.slug),
    missingRungs,
    offLadder,
    bindingChanges,
    applied: true,
  };
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
  conflictingSlugs: Set<string>,
  managedBySlug: Map<string, AuthentikApplication>,
  bindingsByTarget: Map<string, AuthentikPolicyBinding[]>,
  ladder: string[],
  groupIdByName: Map<string, string>,
  groupNameById: Map<string, string>
): BindingPlan[] {
  const ladderNames = new Set(ladder);
  const plans: BindingPlan[] = [];

  for (const entry of actionable) {
    // Not ours to touch -- an existing, unowned Application already holds
    // this slug (see `conflicting` in runSyncAuthentik).
    if (conflictingSlugs.has(entry.slug)) continue;

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
  return lines.join('\n');
}
