import type { AuthentikApplication, AuthentikClient, AuthentikPolicyBinding } from '../../lib/authentik-client.ts';
import type { Inventory } from '../../lib/inventory.ts';
import { effectiveAuth } from '../../lib/inventory.ts';
import { authentikConfig, rungsAtOrAbove } from '../../lib/authentik-config.ts';
import {
  BELLHOP_META_PUBLISHER,
  MISSING_REDIRECT_URIS_REASON,
  OIDC_SCOPE_MAPPINGS,
  desiredOAuth2Settings,
  diffOAuth2Settings,
  ownedProviderKind,
  planBindingChanges,
  type BindingChange,
} from './sync-authentik.ts';
import { findEntry } from './oidc-credentials.ts';

export interface AdoptOidcClientOptions {
  entry: string;
  apply?: boolean;
}

export interface AdoptOidcClientDeps {
  authentik: AuthentikClient;
  inventory: Inventory;
}

export interface AdoptOidcClientResult {
  entry: string;
  slug: string;
  // Every drifted OAuth2 setting fixed in place (diffOAuth2Settings' fixed
  // field-name order) -- empty when the hand-made client already matches
  // Bellhop's desired settings and only meta_publisher needs setting.
  // Never includes a credential field: diffOAuth2Settings' patch can't
  // carry one (FR-009/FR-011), so adoption can never rotate client_id/
  // client_secret either.
  settingsChanges: string[];
  // The ladder-bindings reconcile for this one entry, same shape/order as
  // sync-authentik's own (planBindingChanges, reused directly).
  bindingChanges: BindingChange[];
  applied: boolean;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Adopts a hand-made Authentik OpenID client -- an OAuth2-backed Application
// at an OIDC-effective entry's slug with no meta_publisher marker, the
// "conflict, adoptable" ownership state in data-model.md -- as
// Bellhop-managed, so a subsequent sync-authentik treats it exactly like one
// it created itself. Adoption is three steps, the same three
// runSyncAuthentik itself performs for an owned OIDC entry, just against one
// entry instead of every candidate: set meta_publisher, PATCH whatever
// settings have drifted from Bellhop's desired shape (never a credential
// field -- diffOAuth2Settings' patch structurally cannot carry one), and
// reconcile ladder bindings. client_id/client_secret are never read or sent
// here at all (FR-004/FR-011).
export async function runAdoptOidcClient(
  opts: AdoptOidcClientOptions,
  deps: AdoptOidcClientDeps
): Promise<AdoptOidcClientResult> {
  const entry = findEntry(deps.inventory, opts.entry);
  if (!entry) {
    throw new Error(`Unknown entry: ${opts.entry}`);
  }
  if (effectiveAuth(entry) !== 'oidc') {
    throw new Error(`${opts.entry} is not OIDC-gated (set authGroup and authMode: 'oidc' first)`);
  }
  // effectiveAuth only requires authGroup+authMode; a hand-edited row could
  // still have no subdomains. Without a slug there is no Application to
  // adopt -- same guard as oidc-credentials.ts's own lookup.
  const slug = entry.subdomains?.[0];
  if (!slug) {
    throw new Error(`${opts.entry} has no subdomains configured; nothing to adopt`);
  }

  const [applications, proxyProviders, oauth2Providers] = await Promise.all([
    deps.authentik.listApplications(),
    deps.authentik.listProxyProviders(),
    deps.authentik.listOAuth2Providers(),
  ]);

  const application = applications.find((a) => a.slug === slug);
  if (!application) {
    throw new Error(
      `No Application exists yet at slug '${slug}' for ${opts.entry}; run sync-authentik --apply to create one instead`
    );
  }

  const ownership = {
    proxyProviderIds: new Set(proxyProviders.map((p) => p.id)),
    oauth2ProviderIds: new Set(oauth2Providers.map((p) => p.id)),
  };
  // ownedProviderKind returns 'proxy' regardless of marker (the unchanged
  // #154 rule) and 'oauth2' only when already meta_publisher: 'bellhop' --
  // either way there is nothing for this command to adopt.
  const kind = ownedProviderKind(application, ownership);
  if (kind !== undefined) {
    throw new Error(`${opts.entry}'s Application (slug '${slug}') is already Bellhop-owned; nothing to adopt`);
  }
  if (application.providerId === undefined || !ownership.oauth2ProviderIds.has(application.providerId)) {
    throw new Error(
      `${opts.entry}'s Application (slug '${slug}') is not backed by an OpenID (OAuth2) client; ` +
        'it is not adoptable -- resolve by hand'
    );
  }
  // Always found: ownership.oauth2ProviderIds is built from this exact list.
  const provider = oauth2Providers.find((p) => p.id === application.providerId)!;

  const redirectUris = entry.oidcRedirectUris ?? [];
  if (redirectUris.length === 0) {
    throw new Error(`${opts.entry}: ${MISSING_REDIRECT_URIS_REASON}`);
  }

  const keyName = authentikConfig().oidcSigningKeyName;
  let signingKeyId: string;
  try {
    signingKeyId = await deps.authentik.getSigningKeyId(keyName);
  } catch (err) {
    throw new Error(
      `could not resolve the OIDC signing key '${keyName}' (AUTHENTIK_OIDC_SIGNING_KEY_NAME): ${errorMessage(err)}`
    );
  }
  let scopeMappingIds: string[];
  try {
    scopeMappingIds = await deps.authentik.getScopeMappingIds(OIDC_SCOPE_MAPPINGS);
  } catch (err) {
    throw new Error(`could not resolve the OpenID scope mappings: ${errorMessage(err)}`);
  }

  const desired = desiredOAuth2Settings(redirectUris, signingKeyId, scopeMappingIds);
  const { changes, patch } = diffOAuth2Settings(provider, desired);

  // Safe non-null assertion: effectiveAuth() only returns 'oidc' when
  // authGroup is set.
  const authGroup = entry.authGroup!;
  const ladder = authentikConfig().groupLadder;
  if (rungsAtOrAbove(ladder, authGroup) === null) {
    throw new Error(`${opts.entry}'s authGroup '${authGroup}' is not in AUTHENTIK_GROUP_LADDER`);
  }

  const [groups, bindings] = await Promise.all([deps.authentik.listGroups(), deps.authentik.listPolicyBindings()]);
  const groupIdByName = new Map(groups.map((g) => [g.name, g.id]));
  const groupNameById = new Map(groups.map((g) => [g.id, g.name]));
  const bindingsByTarget = new Map<string, AuthentikPolicyBinding[]>();
  for (const binding of bindings) {
    if (binding.groupId === undefined) continue;
    const list = bindingsByTarget.get(binding.targetId) ?? [];
    list.push(binding);
    bindingsByTarget.set(binding.targetId, list);
  }
  // A single-entry candidate list, matching planBindingChanges' own input
  // shape (sync-authentik.ts's CandidateEntry) structurally -- this command
  // never needs the type itself, only this one call.
  const candidate = {
    slug,
    externalHost: `https://${slug}.${deps.inventory.domain}`,
    authGroup,
    authMode: entry.authMode,
    oidcRedirectUris: entry.oidcRedirectUris,
  };
  const managedBySlug = new Map<string, AuthentikApplication>([[slug, application]]);
  const [plan] = planBindingChanges([candidate], new Set(), managedBySlug, bindingsByTarget, ladder, groupIdByName, groupNameById);
  const bindingChanges = plan?.changes ?? [];

  if (opts.apply) {
    await deps.authentik.updateApplication(slug, { metaPublisher: BELLHOP_META_PUBLISHER });
    if (changes.length > 0) {
      await deps.authentik.updateOAuth2Provider(application.providerId, patch);
    }
    if (plan) {
      for (const groupId of plan.addGroupIds) {
        await deps.authentik.createPolicyBinding({ targetId: application.pk, groupId });
      }
      for (const bindingId of plan.removeBindingIds) {
        await deps.authentik.deletePolicyBinding(bindingId);
      }
    }
  }

  return {
    entry: opts.entry,
    slug,
    settingsChanges: changes,
    bindingChanges,
    applied: Boolean(opts.apply),
  };
}

// Layout mirrors formatSyncAuthentik's own OpenID-settings/binding-change
// stanzas (sync-authentik.ts) so the two commands' CLI output reads
// consistently.
export function formatAdoptOidcClient(result: AdoptOidcClientResult): string {
  const lines: string[] = [];
  lines.push(`Adopting ${result.slug} as a Bellhop-managed OpenID client:`);
  lines.push('  ~ meta_publisher -> bellhop');
  for (const change of result.settingsChanges) lines.push(`  ~ ${change}`);
  for (const change of result.bindingChanges) {
    const symbol = change.action === 'add' ? '+' : '-';
    lines.push(`  ${symbol} ${change.slug} -> ${change.group}`);
  }
  return lines.join('\n');
}
