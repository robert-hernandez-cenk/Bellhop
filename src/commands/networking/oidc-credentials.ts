import type { AuthentikApplication, AuthentikClient } from '../../lib/authentik-client.ts';
import type { Inventory } from '../../lib/inventory.ts';
import { effectiveAuth } from '../../lib/inventory.ts';
import { ownedProviderKind } from './sync-authentik.ts';

// The two error kinds this command's own logic can detect before ever
// calling Authentik -- everything else (unconfigured, a network failure, any
// other Authentik error) is left as a plain Error and propagated verbatim
// (contracts/interfaces.md's web route ruling: 503 comes from
// `!authentik.isConfigured()`, checked by the caller, not from inspecting a
// thrown error's shape; anything else that reaches the caller is a 502).
export type OidcCredentialsErrorCode = 'unknown-entry' | 'not-oidc';

export class OidcCredentialsError extends Error {
  constructor(
    public readonly code: OidcCredentialsErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'OidcCredentialsError';
  }
}

export interface OidcCredentialsDeps {
  authentik: AuthentikClient;
  inventory: Inventory;
}

export interface OidcCredentialsResult {
  issuer: string;
  clientId: string;
  clientSecret: string;
}

// Same shape candidateEntries (sync-authentik.ts) reads from -- deliberately
// not importing that function itself, since it only returns *gated*
// candidates and this command needs to distinguish "unknown entry" from "not
// gated" with two different error messages.
interface LookupEntry {
  name: string;
  authGroup?: string;
  authMode?: 'forward' | 'oidc';
  subdomains?: string[];
}

// Entry lookup searches hosts, guests, external sites by name (controller
// ruling) -- the same three arrays candidateEntries iterates, just kept
// separate so a name collision across types still resolves to *some* entry
// consistently (hosts first, matching this file's own read order elsewhere).
function findEntry(inventory: Inventory, name: string): LookupEntry | undefined {
  return (
    inventory.hosts.find((h) => h.name === name) ??
    inventory.guests.find((g) => g.name === name) ??
    (inventory.externalSites ?? []).find((s) => s.name === name)
  );
}

// Reads an OIDC-gated entry's live client_id/client_secret/issuer straight
// from Authentik (FR-019/FR-019a) -- never Bellhop's own storage, since
// nothing in inventory/bellhop.db holds the secret at all (getOAuth2Credentials
// is the only place it is ever read, per authentik-client.ts). Reuses
// ownedProviderKind (sync-authentik.ts) for the ownership check rather than
// duplicating it, so this command and sync-authentik can never disagree
// about which Application is Bellhop's.
export async function runOidcCredentials(entryName: string, deps: OidcCredentialsDeps): Promise<OidcCredentialsResult> {
  const entry = findEntry(deps.inventory, entryName);
  if (!entry) {
    throw new OidcCredentialsError('unknown-entry', `Unknown entry: ${entryName}`);
  }
  if (effectiveAuth(entry) !== 'oidc') {
    throw new OidcCredentialsError(
      'not-oidc',
      `${entryName} is not OIDC-gated (set authGroup and authMode: 'oidc' first)`
    );
  }
  // effectiveAuth only requires authGroup+authMode; a hand-edited row could
  // still have no subdomains (oidcConfigErrors only runs at write time, see
  // inventory.ts). Without a slug there is no Application to look up.
  const slug = entry.subdomains?.[0];
  if (!slug) {
    throw new OidcCredentialsError('not-oidc', `${entryName} has no subdomains configured; nothing to look up`);
  }

  // Not gated behind isConfigured() first: an unconfigured client's list*
  // calls reject with UNCONFIGURED_MESSAGE, which is exactly what should
  // propagate here (the web route's own `!authentik.isConfigured()` check
  // is what turns that into a 503; this function has no opinion on status
  // codes).
  const [applications, proxyProviders, oauth2Providers] = await Promise.all([
    deps.authentik.listApplications(),
    deps.authentik.listProxyProviders(),
    deps.authentik.listOAuth2Providers(),
  ]);

  const application = applications.find((a) => a.slug === slug);
  if (!application) {
    throw new OidcCredentialsError(
      'not-oidc',
      `No Bellhop-owned OpenID client exists yet for ${entryName} (slug '${slug}'); run sync-authentik --apply first`
    );
  }

  const ownership = {
    proxyProviderIds: new Set(proxyProviders.map((p) => p.id)),
    oauth2ProviderIds: new Set(oauth2Providers.map((p) => p.id)),
  };
  const kind = ownedProviderKind(application, ownership);
  if (kind !== 'oauth2') {
    throw new OidcCredentialsError('not-oidc', conflictMessage(entryName, slug, application, kind));
  }

  // Always set once kind === 'oauth2' -- ownedProviderKind requires a
  // providerId present in oauth2ProviderIds to return that kind at all.
  // Any failure here (network, a non-2xx from Authentik) propagates as-is --
  // the web route's catch-all maps it to 502 once isConfigured() has already
  // ruled out 503.
  return deps.authentik.getOAuth2Credentials(application.providerId!);
}

export interface OidcClientInfo {
  issuer: string;
  clientId: string;
}

// The MCP-safe half of runOidcCredentials (FR-019b): every lookup/ownership
// check is identical, but the secret is dropped before this function ever
// returns, rather than trusting each MCP call site to remember to omit it
// from the JSON it serializes. get_oidc_client (build-server.ts) calls only
// this, never runOidcCredentials -- so a client secret never sits in a local
// anywhere in the MCP layer's own code, only inside runOidcCredentials'
// single return expression for the one await it takes to get here.
export async function runOidcClientInfo(entryName: string, deps: OidcCredentialsDeps): Promise<OidcClientInfo> {
  const { issuer, clientId } = await runOidcCredentials(entryName, deps);
  return { issuer, clientId };
}

function conflictMessage(
  entryName: string,
  slug: string,
  application: AuthentikApplication,
  kind: 'proxy' | undefined
): string {
  if (kind === 'proxy') {
    return (
      `${entryName}'s Authentik Application (slug '${slug}') is currently a forward-auth Proxy Provider, ` +
      "not an OpenID client; run sync-authentik --apply after setting authMode: 'oidc'"
    );
  }
  return (
    `${entryName}'s Authentik Application (slug '${slug}') exists but is not a Bellhop-owned OpenID client; ` +
    'run adopt-oidc-client to adopt it'
  );
}

// Layout from contracts/interfaces.md's CLI section -- columns aligned so
// values start at the same character position.
export function formatOidcCredentials(result: OidcCredentialsResult): string {
  return [`Issuer:        ${result.issuer}`, `Client ID:     ${result.clientId}`, `Client secret: ${result.clientSecret}`].join(
    '\n'
  );
}
