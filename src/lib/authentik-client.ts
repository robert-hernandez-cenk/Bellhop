import type { AuthentikConfig } from './authentik-config.ts';
import { authentikConfig, authentikConfigured } from './authentik-config.ts';

export interface AuthentikUser {
  id: string;
  username: string;
  email: string;
  isActive: boolean;
  groupIds: string[];
}

export interface AuthentikGroup {
  id: string;
  name: string;
  userIds: string[];
}

export interface CreateUserInput {
  username: string;
  email: string;
  groupIds: string[];
}

export interface UpdateUserInput {
  username?: string;
  email?: string;
  groupIds?: string[];
}

// Authentik's own Proxy Provider `mode` values. sync-authentik only ever
// creates 'forward_single', but an owned provider may be a hand-made one in
// any mode (the #154 rule owns a proxy-backed Application by slug alone).
export type ProxyProviderMode = 'proxy' | 'forward_single' | 'forward_domain';

export interface AuthentikProxyProvider {
  id: string;
  name: string;
  externalHost: string;
  mode: ProxyProviderMode;
  // Only meaningful (and required by Authentik) in 'proxy' mode. Undefined
  // for '' or absent, same convention as every other optional string here.
  internalHost?: string;
}

export interface AuthentikApplication {
  id: string;
  // The real Authentik primary key (a UUID) -- required by
  // createPolicyBinding's `target` field, which needs a real pk, not the
  // slug `id`/`slug` represent. Kept distinct from `id` because Authentik's
  // Application ViewSet itself is keyed by slug for URL-path lookups
  // (`lookup_field = "slug"`), so `id`/`slug` stay slug-valued.
  pk: string;
  name: string;
  slug: string;
  providerId?: string;
  // Free-text field, set to 'bellhop' by sync-authentik/adopt-oidc-client to
  // mark an OAuth2-provider-backed Application as Bellhop-owned (R1 in
  // research.md) -- proxy-backed ownership keeps its older slug-plus-
  // proxy-backing rule (issue #154) unchanged. Undefined for '' or absent,
  // same convention as every other optional-string mapping in this file.
  metaPublisher?: string;
}

// An OpenID Connect (OAuth2) provider -- native OIDC gating's counterpart to
// AuthentikProxyProvider, issue #1. Deliberately WITHOUT client_id/
// client_secret: the secret must only ever flow through
// getOAuth2Credentials(), never sit on an object callers might log or cache.
export interface AuthentikOAuth2Provider {
  id: string;
  name: string;
  // Undefined when no Application points at this provider yet, or when
  // Authentik reports it as '' -- same normalization every other optional
  // slug/string field in this file gets.
  assignedApplicationSlug?: string;
  clientType: 'confidential' | 'public';
  grantTypes: string[];
  signingKeyId?: string;
  propertyMappingIds: string[];
  redirectUris: { matchingMode: 'strict' | 'regex'; url: string }[];
}

// The subset of AuthentikOAuth2Provider's fields Bellhop actually sets --
// shared by createOAuth2Provider (plus `name`) and updateOAuth2Provider
// (as a Partial), so create and reconcile-drift (research.md R4) build their
// request bodies from the same shape.
export interface OAuth2ProviderSettings {
  clientType: 'confidential' | 'public';
  grantTypes: string[];
  signingKeyId?: string;
  propertyMappingIds: string[];
  redirectUris: { matchingMode: 'strict' | 'regex'; url: string }[];
  authorizationFlowId: string;
  invalidationFlowId: string;
}

export interface AuthentikOutpost {
  id: string;
  name: string;
  providerIds: string[];
}

export interface AuthentikPolicyBinding {
  id: string;
  targetId: string;
  // Absent for a binding backed by a policy or an individual user rather
  // than a group. sync-authentik only ever reconciles group bindings, so an
  // undefined groupId makes a binding permanently ineligible for removal.
  groupId?: string;
}

// The mobile-consent step's objects (issue #22, research.md R4) -- a stage,
// a policy, a flow-stage binding, and the policy binding that guards it.
// These are looked up by name/target rather than an id persisted anywhere in
// inventory, same rationale as sync-authentik's own Application-by-slug
// lookup: nothing here is ever written back to bellhop.db.
export interface AuthentikStageRef {
  id: string; // pk
  name: string;
  model: string; // meta_model_name, e.g. 'authentik_stages_consent.consentstage'
}

export interface AuthentikConsentStage {
  id: string;
  name: string;
  mode: string;
}

export interface AuthentikPolicyRef {
  id: string; // pk
  name: string;
  model: string; // meta_model_name, e.g. 'authentik_policies_expression.expressionpolicy'
  expression?: string; // present for an expression policy
}

// A scope property mapping (issue #16) -- what an OpenID client's
// `property_mappings` lists. `managed` is set only for one of Authentik's own
// built-in mappings (e.g. `goauthentik.io/providers/oauth2/scope-email`); a
// custom, operator-attached mapping has `managed: null`, which maps to
// `managed` absent here. `scopeName` is what sync-authentik's scope-coverage
// rule (data-model.md) keys off -- several mappings can share one.
export interface AuthentikScopeMapping {
  id: string; // pk
  managed?: string;
  scopeName: string; // scope_name
}

export interface AuthentikFlowStageBinding {
  id: string; // pk
  policyBindingModelId: string; // policybindingmodel_ptr_id -- what a policy binding targets
  flowId: string; // target
  stageId: string; // stage
  order: number;
  evaluateOnPlan: boolean;
  reEvaluatePolicies: boolean;
}

export interface AuthentikPolicyBindingDetail {
  id: string;
  targetId: string;
  policyId?: string; // absent for a group/user binding
}

export interface AuthentikClient {
  // Whether this client instance has a real Authentik API to talk to --
  // every other method call is only meaningful when this is true. Used to
  // gate routes/steps that need the REST API (requireUserDirectory in
  // src/web/auth.ts, syncProxyLive in src/web/proxy-sync.ts) against the
  // actual injected client rather than re-reading process.env, so the gate
  // can never disagree with what the client itself will do.
  isConfigured(): boolean;
  listUsers(): Promise<AuthentikUser[]>;
  getUser(id: string): Promise<AuthentikUser>;
  createUser(input: CreateUserInput): Promise<AuthentikUser>;
  updateUser(id: string, input: UpdateUserInput): Promise<AuthentikUser>;
  setUserActive(id: string, isActive: boolean): Promise<AuthentikUser>;
  deleteUser(id: string): Promise<void>;
  getRecoveryLink(id: string): Promise<string>;
  listGroups(): Promise<AuthentikGroup[]>;
  createGroup(name: string): Promise<AuthentikGroup>;
  updateGroup(id: string, input: { name?: string; userIds?: string[] }): Promise<AuthentikGroup>;
  deleteGroup(id: string): Promise<void>;
  listProxyProviders(): Promise<AuthentikProxyProvider[]>;
  createProxyProvider(input: {
    name: string;
    externalHost: string;
    authorizationFlowId: string;
    invalidationFlowId: string;
  }): Promise<AuthentikProxyProvider>;
  deleteProxyProvider(id: string): Promise<void>;
  // Provider names are unique across every provider kind in Authentik, so a
  // mode switch renames the outgoing provider out of the way before creating
  // its replacement under the slug name (sync-authentik). Takes the whole
  // provider rather than its id: Authentik 2026.8 rejects a PATCH carrying
  // only `name` with a 400 ("Internal host cannot be empty when forward auth
  // is disabled", verified live), so the rename re-sends the provider's own
  // current `mode` (plus `internal_host` in 'proxy' mode). A fixed mode
  // would silently convert a hand-made provider in another mode. Never
  // touches any other setting, or credentials.
  renameProxyProvider(provider: AuthentikProxyProvider, name: string): Promise<void>;
  listApplications(): Promise<AuthentikApplication[]>;
  createApplication(input: {
    name: string;
    slug: string;
    providerId: string;
    metaPublisher?: string;
  }): Promise<AuthentikApplication>;
  deleteApplication(id: string): Promise<void>;
  createPolicyBinding(input: { targetId: string; groupId: string }): Promise<void>;
  listPolicyBindings(): Promise<AuthentikPolicyBinding[]>;
  deletePolicyBinding(id: string): Promise<void>;
  getEmbeddedOutpost(): Promise<AuthentikOutpost>;
  setOutpostProviders(outpostId: string, providerIds: string[]): Promise<void>;
  getDefaultAuthorizationFlowId(): Promise<string>;
  getDefaultInvalidationFlowId(): Promise<string>;
  listOAuth2Providers(): Promise<AuthentikOAuth2Provider[]>;
  createOAuth2Provider(input: OAuth2ProviderSettings & { name: string }): Promise<AuthentikOAuth2Provider>;
  updateOAuth2Provider(id: string, input: Partial<OAuth2ProviderSettings>): Promise<void>;
  deleteOAuth2Provider(id: string): Promise<void>;
  // Kept separate from updateOAuth2Provider so OAuth2ProviderSettings (and
  // the drift diff built from it) never grows a name field. See
  // renameProxyProvider.
  renameOAuth2Provider(id: string, name: string): Promise<void>;
  getOAuth2Credentials(id: string): Promise<{ clientId: string; clientSecret: string; issuer: string }>;
  // The issuer URL alone (setup_urls only) -- for callers that need the
  // issuer but must never have the client secret flow through them, e.g.
  // sync-authentik's post-apply discovery check (research.md R6, FR-004).
  getOAuth2Issuer(id: string): Promise<string>;
  updateApplication(slug: string, input: { providerId?: string; metaPublisher?: string }): Promise<void>;
  // Throws naming AUTHENTIK_OIDC_SIGNING_KEY_NAME when no key with that name
  // and a private key exists (research.md R3).
  getSigningKeyId(name: string): Promise<string>;
  // Every scope property mapping on the instance (issue #16) -- callers
  // resolve the built-in ids they need by `managed`, and look up any
  // attached mapping's scope name, from this one listing.
  listScopeMappings(): Promise<AuthentikScopeMapping[]>;

  // Mobile-consent step (issue #22, research.md R4). Stage names are unique
  // across all stage types, so this looks up a stage of any type by name --
  // used to find/own the mobile-consent stage without assuming it's the only
  // consent stage on the instance.
  findStageByName(name: string): Promise<AuthentikStageRef | undefined>;
  getConsentStage(id: string): Promise<AuthentikConsentStage>;
  createConsentStage(input: { name: string; mode: string }): Promise<AuthentikConsentStage>;
  updateConsentStage(id: string, input: { mode: string }): Promise<void>;
  deleteStage(id: string): Promise<void>; // DELETE /api/v3/stages/consent/<id>/
  // The `name` query param on /policies/all/ is ignored by Authentik --
  // callers must not rely on this filtering server-side.
  findPolicyByName(name: string): Promise<AuthentikPolicyRef | undefined>;
  createExpressionPolicy(input: { name: string; expression: string }): Promise<AuthentikPolicyRef>;
  updateExpressionPolicy(id: string, input: { expression: string }): Promise<void>;
  deletePolicy(id: string): Promise<void>; // DELETE /api/v3/policies/expression/<id>/
  listFlowStageBindings(flowId: string): Promise<AuthentikFlowStageBinding[]>;
  createFlowStageBinding(input: {
    flowId: string;
    stageId: string;
    order: number;
    evaluateOnPlan: boolean;
    reEvaluatePolicies: boolean;
  }): Promise<AuthentikFlowStageBinding>;
  updateFlowStageBinding(id: string, input: { evaluateOnPlan: boolean; reEvaluatePolicies: boolean }): Promise<void>;
  deleteFlowStageBinding(id: string): Promise<void>;
  // `?target=<policybindingmodel_ptr_id>` -- filtering by the flow-stage
  // binding's own pk fails ("Select a valid choice") against a live
  // instance. The returned `target` field on each result nonetheless reports
  // the flow-stage binding's own pk (not the policybindingmodel_ptr_id), so
  // `targetId` below maps from that.
  listPolicyBindingsForTarget(targetId: string): Promise<AuthentikPolicyBindingDetail[]>;
  createPolicyToTargetBinding(input: { targetId: string; policyId: string }): Promise<void>;
  // POST /api/v3/flows/instances/cache_clear/ -- run after any change to the
  // binding or the policy so a cached flow plan can't keep serving stale
  // consent behavior (FR-015).
  clearFlowCache(): Promise<void>;
}

interface RawUser {
  pk: number | string;
  username: string;
  email?: string;
  is_active?: boolean;
  groups?: Array<number | string>;
}

interface RawGroup {
  pk: number | string;
  name: string;
  users?: Array<number | string>;
}

interface RawProxyProvider {
  pk: number | string;
  name: string;
  external_host: string;
  mode: ProxyProviderMode;
  internal_host?: string | null;
}

// Authentik's Application model is keyed by its slug (a CharField primary
// key), not a numeric pk -- unlike users/groups/providers, there is no
// separate integer id to prefer over the slug.
interface RawApplication {
  pk: string;
  slug: string;
  name: string;
  provider?: number | string | null;
  meta_publisher?: string | null;
}

interface RawOAuth2Provider {
  pk: number | string;
  name: string;
  assigned_application_slug?: string | null;
  client_type: 'confidential' | 'public';
  grant_types?: string[];
  client_id?: string;
  client_secret?: string;
  signing_key?: string | null;
  property_mappings?: string[];
  redirect_uris?: Array<{ matching_mode: 'strict' | 'regex'; url: string }>;
}

interface RawOutpost {
  pk: string;
  name: string;
  providers: Array<number | string>;
}

interface RawPolicyBinding {
  pk: number | string;
  target: number | string;
  group?: number | string | null;
}

interface RawFlow {
  pk: string;
  slug: string;
}

interface RawStageRef {
  pk: string;
  name: string;
  meta_model_name: string;
}

interface RawConsentStage {
  pk: string;
  name: string;
  mode: string;
}

interface RawPolicyRef {
  pk: string;
  name: string;
  meta_model_name: string;
  expression?: string;
}

interface RawFlowStageBinding {
  pk: string;
  policybindingmodel_ptr_id: string;
  target: string;
  stage: string;
  order: number;
  evaluate_on_plan: boolean;
  re_evaluate_policies: boolean;
}

interface RawPolicyBindingDetail {
  pk: string;
  target: string;
  policy?: string | null;
}

// The one file that actually talks to a real Authentik instance -- no
// automated test, verified manually against a live Authentik instance,
// same precedent as Ssh2SSHClient in src/lib/ssh-client.ts.
export class RealAuthentikClient implements AuthentikClient {
  constructor(
    private apiUrl: string,
    private apiToken: string,
    private config: AuthentikConfig
  ) {}

  isConfigured(): boolean {
    return true;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.apiUrl.replace(/\/$/, '')}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Authentik API ${method} ${path} failed: ${res.status} ${text}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private toUser(raw: RawUser): AuthentikUser {
    return {
      id: String(raw.pk),
      username: raw.username,
      email: raw.email ?? '',
      isActive: !!raw.is_active,
      groupIds: (raw.groups ?? []).map(String),
    };
  }

  private toGroup(raw: RawGroup): AuthentikGroup {
    return { id: String(raw.pk), name: raw.name, userIds: (raw.users ?? []).map(String) };
  }

  async listUsers(): Promise<AuthentikUser[]> {
    const res = await this.request<{ results: RawUser[] }>('GET', '/api/v3/core/users/?page_size=500');
    return res.results.map((r) => this.toUser(r));
  }

  async getUser(id: string): Promise<AuthentikUser> {
    return this.toUser(await this.request<RawUser>('GET', `/api/v3/core/users/${id}/`));
  }

  async createUser(input: CreateUserInput): Promise<AuthentikUser> {
    return this.toUser(
      await this.request<RawUser>('POST', '/api/v3/core/users/', {
        username: input.username,
        name: input.username,
        email: input.email,
        groups: input.groupIds,
        is_active: true,
      })
    );
  }

  async updateUser(id: string, input: UpdateUserInput): Promise<AuthentikUser> {
    const body: Record<string, unknown> = {};
    if (input.username !== undefined) body.username = input.username;
    if (input.email !== undefined) body.email = input.email;
    if (input.groupIds !== undefined) body.groups = input.groupIds;
    return this.toUser(await this.request<RawUser>('PATCH', `/api/v3/core/users/${id}/`, body));
  }

  async setUserActive(id: string, isActive: boolean): Promise<AuthentikUser> {
    return this.toUser(await this.request<RawUser>('PATCH', `/api/v3/core/users/${id}/`, { is_active: isActive }));
  }

  async deleteUser(id: string): Promise<void> {
    await this.request<void>('DELETE', `/api/v3/core/users/${id}/`);
  }

  async getRecoveryLink(id: string): Promise<string> {
    const raw = await this.request<{ link: string }>('POST', `/api/v3/core/users/${id}/recovery/`);
    return raw.link;
  }

  async listGroups(): Promise<AuthentikGroup[]> {
    const res = await this.request<{ results: RawGroup[] }>('GET', '/api/v3/core/groups/?page_size=500');
    return res.results.map((r) => this.toGroup(r));
  }

  async createGroup(name: string): Promise<AuthentikGroup> {
    return this.toGroup(await this.request<RawGroup>('POST', '/api/v3/core/groups/', { name }));
  }

  async updateGroup(id: string, input: { name?: string; userIds?: string[] }): Promise<AuthentikGroup> {
    const body: Record<string, unknown> = {};
    if (input.name !== undefined) body.name = input.name;
    if (input.userIds !== undefined) body.users = input.userIds;
    return this.toGroup(await this.request<RawGroup>('PATCH', `/api/v3/core/groups/${id}/`, body));
  }

  async deleteGroup(id: string): Promise<void> {
    await this.request<void>('DELETE', `/api/v3/core/groups/${id}/`);
  }

  private toProxyProvider(raw: RawProxyProvider): AuthentikProxyProvider {
    return {
      id: String(raw.pk),
      name: raw.name,
      externalHost: raw.external_host,
      mode: raw.mode,
      internalHost: raw.internal_host ? raw.internal_host : undefined,
    };
  }

  async listProxyProviders(): Promise<AuthentikProxyProvider[]> {
    const res = await this.request<{ results: RawProxyProvider[] }>('GET', '/api/v3/providers/proxy/?page_size=500');
    return res.results.map((r) => this.toProxyProvider(r));
  }

  async createProxyProvider(input: {
    name: string;
    externalHost: string;
    authorizationFlowId: string;
    invalidationFlowId: string;
  }): Promise<AuthentikProxyProvider> {
    const raw = await this.request<RawProxyProvider>('POST', '/api/v3/providers/proxy/', {
      name: input.name,
      mode: 'forward_single',
      external_host: input.externalHost,
      authorization_flow: input.authorizationFlowId,
      invalidation_flow: input.invalidationFlowId,
    });
    return this.toProxyProvider(raw);
  }

  async deleteProxyProvider(id: string): Promise<void> {
    await this.request<void>('DELETE', `/api/v3/providers/proxy/${id}/`);
  }

  // See the interface comment: `mode` (and `internal_host` in 'proxy' mode)
  // must ride along, or Authentik 2026.8 rejects the PATCH.
  async renameProxyProvider(provider: AuthentikProxyProvider, name: string): Promise<void> {
    await this.request<void>('PATCH', `/api/v3/providers/proxy/${provider.id}/`, {
      name,
      mode: provider.mode,
      ...(provider.mode === 'proxy' ? { internal_host: provider.internalHost } : {}),
    });
  }

  async listApplications(): Promise<AuthentikApplication[]> {
    const res = await this.request<{ results: RawApplication[] }>('GET', '/api/v3/core/applications/?page_size=500');
    return res.results.map((r) => ({
      id: r.slug,
      pk: r.pk,
      name: r.name,
      slug: r.slug,
      providerId: r.provider != null ? String(r.provider) : undefined,
      metaPublisher: r.meta_publisher ? r.meta_publisher : undefined,
    }));
  }

  async createApplication(input: {
    name: string;
    slug: string;
    providerId: string;
    metaPublisher?: string;
  }): Promise<AuthentikApplication> {
    const body: Record<string, unknown> = { name: input.name, slug: input.slug, provider: input.providerId };
    if (input.metaPublisher !== undefined) body.meta_publisher = input.metaPublisher;
    const raw = await this.request<RawApplication>('POST', '/api/v3/core/applications/', body);
    return {
      id: raw.slug,
      pk: raw.pk,
      name: raw.name,
      slug: raw.slug,
      providerId: input.providerId,
      metaPublisher: input.metaPublisher,
    };
  }

  async deleteApplication(id: string): Promise<void> {
    await this.request<void>('DELETE', `/api/v3/core/applications/${id}/`);
  }

  async createPolicyBinding(input: { targetId: string; groupId: string }): Promise<void> {
    await this.request<void>('POST', '/api/v3/policies/bindings/', {
      target: input.targetId,
      group: input.groupId,
      order: 0,
    });
  }

  // One unfiltered list rather than a per-Application query: this instance
  // holds a few dozen bindings in total, and syncProxyLive already makes
  // several REST calls per Dashboard edit.
  //
  // Unlike every other `?page_size=500` call in this file, a truncated page
  // here is not safe to ignore: sync-authentik's reconcile pass treats a
  // binding it never saw as simply not existing, so a stale binding to a
  // broader rung that fell past page 1 would never be recognized for
  // deletion -- the entry would silently stay more open than inventory
  // says, rather than the usual "missing data reads as inert" failure mode
  // the other list* methods fall into. Cheap to guard against even though
  // this instance's ~25 real bindings are nowhere near the limit today.
  // The count lives under `pagination.count` -- Authentik returns no
  // top-level `count` (verified live 2026-09-29), so a guard reading one
  // never fired (issue #16).
  async listPolicyBindings(): Promise<AuthentikPolicyBinding[]> {
    const res = await this.request<{ pagination: { count: number }; results: RawPolicyBinding[] }>(
      'GET',
      '/api/v3/policies/bindings/?page_size=500'
    );
    if (res.pagination.count > res.results.length) {
      throw new Error(
        `Authentik returned ${res.results.length} of ${res.pagination.count} policy bindings; pagination is not implemented`
      );
    }
    return res.results.map((b) => ({
      id: String(b.pk),
      targetId: String(b.target),
      groupId: b.group == null ? undefined : String(b.group),
    }));
  }

  async deletePolicyBinding(id: string): Promise<void> {
    await this.request<void>('DELETE', `/api/v3/policies/bindings/${id}/`);
  }

  async getEmbeddedOutpost(): Promise<AuthentikOutpost> {
    const res = await this.request<{ results: RawOutpost[] }>('GET', '/api/v3/outposts/instances/?page_size=500');
    const embedded = res.results.find((o) => o.name === this.config.outpostName);
    // No silent fallback to some other outpost -- PATCHing the wrong
    // outpost's provider list would misroute forward-auth for whatever that
    // other outpost actually serves. Fail clearly instead of guessing.
    if (!embedded) {
      throw new Error(
        `No Authentik outpost named '${this.config.outpostName}' found (set AUTHENTIK_OUTPOST_NAME to match your instance)`
      );
    }
    return { id: String(embedded.pk), name: embedded.name, providerIds: (embedded.providers ?? []).map(String) };
  }

  async setOutpostProviders(outpostId: string, providerIds: string[]): Promise<void> {
    await this.request<void>('PATCH', `/api/v3/outposts/instances/${outpostId}/`, {
      providers: providerIds.map(Number),
    });
  }

  async getDefaultAuthorizationFlowId(): Promise<string> {
    const res = await this.request<{ results: RawFlow[] }>(
      'GET',
      `/api/v3/flows/instances/?slug=${encodeURIComponent(this.config.authorizationFlowSlug)}`
    );
    const flow = res.results[0];
    if (!flow) {
      throw new Error(
        `Authentik authorization flow '${this.config.authorizationFlowSlug}' not found ` +
          '(set AUTHENTIK_AUTHORIZATION_FLOW_SLUG to match your instance)'
      );
    }
    return String(flow.pk);
  }

  async getDefaultInvalidationFlowId(): Promise<string> {
    const res = await this.request<{ results: RawFlow[] }>(
      'GET',
      `/api/v3/flows/instances/?slug=${encodeURIComponent(this.config.invalidationFlowSlug)}`
    );
    const flow = res.results[0];
    if (!flow) {
      throw new Error(
        `Authentik invalidation flow '${this.config.invalidationFlowSlug}' not found ` +
          '(set AUTHENTIK_INVALIDATION_FLOW_SLUG to match your instance)'
      );
    }
    return String(flow.pk);
  }

  private toOAuth2Provider(raw: RawOAuth2Provider): AuthentikOAuth2Provider {
    return {
      id: String(raw.pk),
      name: raw.name,
      assignedApplicationSlug: raw.assigned_application_slug ? raw.assigned_application_slug : undefined,
      clientType: raw.client_type,
      grantTypes: raw.grant_types ?? [],
      signingKeyId: raw.signing_key ?? undefined,
      propertyMappingIds: (raw.property_mappings ?? []).map(String),
      redirectUris: (raw.redirect_uris ?? []).map((r) => ({ matchingMode: r.matching_mode, url: r.url })),
    };
  }

  // Same "don't silently ignore a truncated page" guard as listPolicyBindings
  // -- a real deployment has one OAuth2 provider per OIDC-gated app, nowhere
  // near this limit today, but a missed provider here would read as "not
  // owned yet" and sync-authentik would try to create a duplicate.
  //
  // Found in live verification: Authentik 2026.8's `GET /api/v3/providers/oauth2/`
  // also returns every proxy provider (ProxyProvider subclasses
  // OAuth2Provider in Authentik's own model, and `meta_model_name`/
  // `component` on the raw response report the OAuth2 values for all of
  // them, so the list response itself can't tell them apart). Every caller
  // in this codebase (ownedProviderKind, planProviderName, adopt-oidc-client,
  // oidc-credentials) trusts "present in listOAuth2Providers" to mean "is
  // really an OAuth2 provider," so a proxy provider's pk must be excluded
  // here -- the one place that can actually tell, via membership in
  // listProxyProviders -- rather than left for every caller to re-check.
  async listOAuth2Providers(): Promise<AuthentikOAuth2Provider[]> {
    const [res, proxyProviders] = await Promise.all([
      this.request<{ pagination: { count: number }; results: RawOAuth2Provider[] }>(
        'GET',
        '/api/v3/providers/oauth2/?page_size=500'
      ),
      this.listProxyProviders(),
    ]);
    // `pagination.count`, not a top-level `count` (none exists; issue #16).
    if (res.pagination.count > res.results.length) {
      throw new Error(
        `Authentik returned ${res.results.length} of ${res.pagination.count} OAuth2 providers; pagination is not implemented`
      );
    }
    const proxyProviderIds = new Set(proxyProviders.map((p) => p.id));
    return res.results.filter((r) => !proxyProviderIds.has(String(r.pk))).map((r) => this.toOAuth2Provider(r));
  }

  async createOAuth2Provider(input: OAuth2ProviderSettings & { name: string }): Promise<AuthentikOAuth2Provider> {
    const raw = await this.request<RawOAuth2Provider>('POST', '/api/v3/providers/oauth2/', {
      name: input.name,
      client_type: input.clientType,
      grant_types: input.grantTypes,
      signing_key: input.signingKeyId ?? null,
      property_mappings: input.propertyMappingIds,
      redirect_uris: input.redirectUris.map((r) => ({ matching_mode: r.matchingMode, url: r.url })),
      authorization_flow: input.authorizationFlowId,
      invalidation_flow: input.invalidationFlowId,
    });
    return this.toOAuth2Provider(raw);
  }

  // Sends only the fields actually given -- client_id/client_secret are
  // never part of OAuth2ProviderSettings, so they can never be sent here
  // even by mistake, which is what keeps a reconcile-drift PATCH (research.md
  // R4) from ever rotating a client's credentials (FR-009).
  async updateOAuth2Provider(id: string, input: Partial<OAuth2ProviderSettings>): Promise<void> {
    const body: Record<string, unknown> = {};
    if (input.clientType !== undefined) body.client_type = input.clientType;
    if (input.grantTypes !== undefined) body.grant_types = input.grantTypes;
    if (input.signingKeyId !== undefined) body.signing_key = input.signingKeyId;
    if (input.propertyMappingIds !== undefined) body.property_mappings = input.propertyMappingIds;
    if (input.redirectUris !== undefined) {
      body.redirect_uris = input.redirectUris.map((r) => ({ matching_mode: r.matchingMode, url: r.url }));
    }
    if (input.authorizationFlowId !== undefined) body.authorization_flow = input.authorizationFlowId;
    if (input.invalidationFlowId !== undefined) body.invalidation_flow = input.invalidationFlowId;
    await this.request<void>('PATCH', `/api/v3/providers/oauth2/${id}/`, body);
  }

  async deleteOAuth2Provider(id: string): Promise<void> {
    await this.request<void>('DELETE', `/api/v3/providers/oauth2/${id}/`);
  }

  async renameOAuth2Provider(id: string, name: string): Promise<void> {
    await this.request<void>('PATCH', `/api/v3/providers/oauth2/${id}/`, { name });
  }

  // The only place a client secret is ever read -- callers must not cache
  // this beyond the single request that needed it (FR-004).
  async getOAuth2Credentials(id: string): Promise<{ clientId: string; clientSecret: string; issuer: string }> {
    const [provider, setupUrls] = await Promise.all([
      this.request<RawOAuth2Provider>('GET', `/api/v3/providers/oauth2/${id}/`),
      this.request<{ issuer: string }>('GET', `/api/v3/providers/oauth2/${id}/setup_urls/`),
    ]);
    // A blank value would be shown to the operator as if it were the real
    // credential, and pasted into the app as one -- fail naming what is
    // missing instead (e.g. a token that can read the provider but not its
    // secret).
    const missing = [
      ...(provider.client_id ? [] : ['client_id']),
      ...(provider.client_secret ? [] : ['client_secret']),
    ];
    if (missing.length > 0) {
      throw new Error(
        `Authentik returned no ${missing.join(' or ')} for OAuth2 provider ${id}; ` +
          'check that the API token can read OAuth2 provider credentials'
      );
    }
    return {
      clientId: provider.client_id!,
      clientSecret: provider.client_secret!,
      issuer: setupUrls.issuer,
    };
  }

  // Deliberately a separate request from getOAuth2Credentials rather than a
  // subset of it: this path never fetches the single-provider record, so a
  // caller that only needs the issuer (sync-authentik's discovery check)
  // never has a secret handed back to it. It is not a guarantee the secret
  // is never in this process's memory at all: listOAuth2Providers' raw JSON
  // carries client_secret until toOAuth2Provider drops it.
  async getOAuth2Issuer(id: string): Promise<string> {
    const setupUrls = await this.request<{ issuer: string }>('GET', `/api/v3/providers/oauth2/${id}/setup_urls/`);
    return setupUrls.issuer;
  }

  async updateApplication(slug: string, input: { providerId?: string; metaPublisher?: string }): Promise<void> {
    const body: Record<string, unknown> = {};
    if (input.providerId !== undefined) body.provider = input.providerId;
    if (input.metaPublisher !== undefined) body.meta_publisher = input.metaPublisher;
    await this.request<void>('PATCH', `/api/v3/core/applications/${slug}/`, body);
  }

  async getSigningKeyId(name: string): Promise<string> {
    const res = await this.request<{ results: Array<{ pk: string; name: string }> }>(
      'GET',
      `/api/v3/crypto/certificatekeypairs/?name=${encodeURIComponent(name)}&has_key=true`
    );
    const key = res.results[0];
    if (!key) {
      throw new Error(
        `No Authentik signing key named '${name}' with a private key found ` +
          '(set AUTHENTIK_OIDC_SIGNING_KEY_NAME to match your instance)'
      );
    }
    return key.pk;
  }

  // Fetches every scope property mapping once (issue #16) -- callers resolve
  // the built-in ids they need by `managed`, and look up any attached
  // mapping's scope name, from this one listing, rather than one request per
  // requested id (research.md R2 notes the three managed ids are looked up
  // together on every sync run). Same truncated-page guard as
  // listPolicyBindings/listOAuth2Providers/findPolicyByName: a mapping that
  // fell past page 1 must not read as "missing" and abort an
  // otherwise-healthy sync run. The count lives under `pagination.count`
  // (research.md R1).
  async listScopeMappings(): Promise<AuthentikScopeMapping[]> {
    const res = await this.request<{
      pagination: { count: number };
      results: Array<{ pk: string; managed: string | null; scope_name: string }>;
    }>('GET', '/api/v3/propertymappings/provider/scope/?page_size=500');
    if (res.pagination.count > res.results.length) {
      throw new Error(
        `Authentik returned ${res.results.length} of ${res.pagination.count} scope property mappings; pagination is not implemented`
      );
    }
    return res.results.map((r) => ({
      id: r.pk,
      managed: r.managed ?? undefined,
      scopeName: r.scope_name,
    }));
  }

  private toStageRef(raw: RawStageRef): AuthentikStageRef {
    return { id: String(raw.pk), name: raw.name, model: raw.meta_model_name };
  }

  // Stage names are unique across all stage types on a real instance, but
  // this still filters client-side rather than trusting the single result
  // Authentik's own `?name=` filter returns -- cheap, and consistent with
  // findPolicyByName below, whose equivalent filter is outright ignored.
  async findStageByName(name: string): Promise<AuthentikStageRef | undefined> {
    const res = await this.request<{ results: RawStageRef[] }>(
      'GET',
      `/api/v3/stages/all/?name=${encodeURIComponent(name)}`
    );
    const match = res.results.find((r) => r.name === name);
    return match ? this.toStageRef(match) : undefined;
  }

  private toConsentStage(raw: RawConsentStage): AuthentikConsentStage {
    return { id: String(raw.pk), name: raw.name, mode: raw.mode };
  }

  async getConsentStage(id: string): Promise<AuthentikConsentStage> {
    return this.toConsentStage(await this.request<RawConsentStage>('GET', `/api/v3/stages/consent/${id}/`));
  }

  async createConsentStage(input: { name: string; mode: string }): Promise<AuthentikConsentStage> {
    return this.toConsentStage(
      await this.request<RawConsentStage>('POST', '/api/v3/stages/consent/', { name: input.name, mode: input.mode })
    );
  }

  async updateConsentStage(id: string, input: { mode: string }): Promise<void> {
    await this.request<void>('PATCH', `/api/v3/stages/consent/${id}/`, { mode: input.mode });
  }

  async deleteStage(id: string): Promise<void> {
    await this.request<void>('DELETE', `/api/v3/stages/consent/${id}/`);
  }

  private toPolicyRef(raw: RawPolicyRef): AuthentikPolicyRef {
    return { id: String(raw.pk), name: raw.name, model: raw.meta_model_name, expression: raw.expression };
  }

  // The `name` query param on this endpoint is ignored by Authentik (verified
  // live -- it returned every policy regardless), so this always fetches the
  // full page and matches client-side. Same truncated-page guard as
  // listPolicyBindings/listOAuth2Providers/listScopeMappings: a policy that
  // fell past page 1 must not silently read as "doesn't exist yet." Like all
  // of them, the count lives under `pagination.count` -- Authentik's list
  // endpoints return no top-level `count` (see test/fixtures/authentik/
  // policies-all.json; issue #16, research.md R1).
  async findPolicyByName(name: string): Promise<AuthentikPolicyRef | undefined> {
    const res = await this.request<{ pagination: { count: number }; results: RawPolicyRef[] }>(
      'GET',
      '/api/v3/policies/all/?page_size=500'
    );
    if (res.pagination.count > res.results.length) {
      throw new Error(
        `Authentik returned ${res.results.length} of ${res.pagination.count} policies; pagination is not implemented`
      );
    }
    const match = res.results.find((r) => r.name === name);
    return match ? this.toPolicyRef(match) : undefined;
  }

  async createExpressionPolicy(input: { name: string; expression: string }): Promise<AuthentikPolicyRef> {
    return this.toPolicyRef(
      await this.request<RawPolicyRef>('POST', '/api/v3/policies/expression/', {
        name: input.name,
        expression: input.expression,
        execution_logging: false,
      })
    );
  }

  async updateExpressionPolicy(id: string, input: { expression: string }): Promise<void> {
    await this.request<void>('PATCH', `/api/v3/policies/expression/${id}/`, { expression: input.expression });
  }

  async deletePolicy(id: string): Promise<void> {
    await this.request<void>('DELETE', `/api/v3/policies/expression/${id}/`);
  }

  private toFlowStageBinding(raw: RawFlowStageBinding): AuthentikFlowStageBinding {
    return {
      id: String(raw.pk),
      policyBindingModelId: String(raw.policybindingmodel_ptr_id),
      flowId: String(raw.target),
      stageId: String(raw.stage),
      order: raw.order,
      evaluateOnPlan: raw.evaluate_on_plan,
      reEvaluatePolicies: raw.re_evaluate_policies,
    };
  }

  // `target__slug` is ignored by Authentik (verified live); `target=<pk>`
  // works, so this is always addressed by flow pk.
  async listFlowStageBindings(flowId: string): Promise<AuthentikFlowStageBinding[]> {
    const res = await this.request<{ results: RawFlowStageBinding[] }>(
      'GET',
      `/api/v3/flows/bindings/?target=${encodeURIComponent(flowId)}&page_size=500`
    );
    return res.results.map((r) => this.toFlowStageBinding(r));
  }

  async createFlowStageBinding(input: {
    flowId: string;
    stageId: string;
    order: number;
    evaluateOnPlan: boolean;
    reEvaluatePolicies: boolean;
  }): Promise<AuthentikFlowStageBinding> {
    return this.toFlowStageBinding(
      await this.request<RawFlowStageBinding>('POST', '/api/v3/flows/bindings/', {
        target: input.flowId,
        stage: input.stageId,
        order: input.order,
        evaluate_on_plan: input.evaluateOnPlan,
        re_evaluate_policies: input.reEvaluatePolicies,
        policy_engine_mode: 'any',
        invalid_response_action: 'retry',
      })
    );
  }

  async updateFlowStageBinding(id: string, input: { evaluateOnPlan: boolean; reEvaluatePolicies: boolean }): Promise<void> {
    await this.request<void>('PATCH', `/api/v3/flows/bindings/${id}/`, {
      evaluate_on_plan: input.evaluateOnPlan,
      re_evaluate_policies: input.reEvaluatePolicies,
    });
  }

  async deleteFlowStageBinding(id: string): Promise<void> {
    await this.request<void>('DELETE', `/api/v3/flows/bindings/${id}/`);
  }

  // Filtering by the flow-stage binding's own pk fails ("Select a valid
  // choice") against a live instance; `?target=<policybindingmodel_ptr_id>`
  // works. The response's own `target` field nonetheless reports the
  // flow-stage binding's pk (not the policybindingmodel_ptr_id used to query
  // it), so `targetId` below maps straight from that raw field.
  async listPolicyBindingsForTarget(targetId: string): Promise<AuthentikPolicyBindingDetail[]> {
    const res = await this.request<{ results: RawPolicyBindingDetail[] }>(
      'GET',
      `/api/v3/policies/bindings/?target=${encodeURIComponent(targetId)}&page_size=500`
    );
    return res.results.map((r) => ({
      id: String(r.pk),
      targetId: String(r.target),
      policyId: r.policy == null ? undefined : String(r.policy),
    }));
  }

  async createPolicyToTargetBinding(input: { targetId: string; policyId: string }): Promise<void> {
    await this.request<void>('POST', '/api/v3/policies/bindings/', {
      target: input.targetId,
      policy: input.policyId,
      order: 0,
      enabled: true,
      negate: false,
      timeout: 30,
      failure_result: false,
    });
  }

  async clearFlowCache(): Promise<void> {
    await this.request<void>('POST', '/api/v3/flows/instances/cache_clear/');
  }
}

export const UNCONFIGURED_MESSAGE = 'Authentik API not configured (set AUTHENTIK_API_URL and AUTHENTIK_API_TOKEN)';

// Null-object fallback used when AUTHENTIK_API_URL/AUTHENTIK_API_TOKEN
// aren't set -- routes always get a real AuthentikClient instance to call,
// and every call fails the same clear way instead of needing a null check
// at every call site.
export class UnconfiguredAuthentikClient implements AuthentikClient {
  isConfigured(): boolean {
    return false;
  }
  listUsers(): Promise<AuthentikUser[]> {
    return Promise.reject(new Error(UNCONFIGURED_MESSAGE));
  }
  getUser(_id: string): Promise<AuthentikUser> {
    return Promise.reject(new Error(UNCONFIGURED_MESSAGE));
  }
  createUser(_input: CreateUserInput): Promise<AuthentikUser> {
    return Promise.reject(new Error(UNCONFIGURED_MESSAGE));
  }
  updateUser(_id: string, _input: UpdateUserInput): Promise<AuthentikUser> {
    return Promise.reject(new Error(UNCONFIGURED_MESSAGE));
  }
  setUserActive(_id: string, _isActive: boolean): Promise<AuthentikUser> {
    return Promise.reject(new Error(UNCONFIGURED_MESSAGE));
  }
  deleteUser(_id: string): Promise<void> {
    return Promise.reject(new Error(UNCONFIGURED_MESSAGE));
  }
  getRecoveryLink(_id: string): Promise<string> {
    return Promise.reject(new Error(UNCONFIGURED_MESSAGE));
  }
  listGroups(): Promise<AuthentikGroup[]> {
    return Promise.reject(new Error(UNCONFIGURED_MESSAGE));
  }
  createGroup(_name: string): Promise<AuthentikGroup> {
    return Promise.reject(new Error(UNCONFIGURED_MESSAGE));
  }
  updateGroup(_id: string, _input: { name?: string; userIds?: string[] }): Promise<AuthentikGroup> {
    return Promise.reject(new Error(UNCONFIGURED_MESSAGE));
  }
  deleteGroup(_id: string): Promise<void> {
    return Promise.reject(new Error(UNCONFIGURED_MESSAGE));
  }
  listProxyProviders(): Promise<AuthentikProxyProvider[]> {
    return Promise.reject(new Error(UNCONFIGURED_MESSAGE));
  }
  createProxyProvider(_input: {
    name: string;
    externalHost: string;
    authorizationFlowId: string;
    invalidationFlowId: string;
  }): Promise<AuthentikProxyProvider> {
    return Promise.reject(new Error(UNCONFIGURED_MESSAGE));
  }
  deleteProxyProvider(_id: string): Promise<void> {
    return Promise.reject(new Error(UNCONFIGURED_MESSAGE));
  }
  renameProxyProvider(_provider: AuthentikProxyProvider, _name: string): Promise<void> {
    return Promise.reject(new Error(UNCONFIGURED_MESSAGE));
  }
  listApplications(): Promise<AuthentikApplication[]> {
    return Promise.reject(new Error(UNCONFIGURED_MESSAGE));
  }
  createApplication(_input: {
    name: string;
    slug: string;
    providerId: string;
    metaPublisher?: string;
  }): Promise<AuthentikApplication> {
    return Promise.reject(new Error(UNCONFIGURED_MESSAGE));
  }
  deleteApplication(_id: string): Promise<void> {
    return Promise.reject(new Error(UNCONFIGURED_MESSAGE));
  }
  createPolicyBinding(_input: { targetId: string; groupId: string }): Promise<void> {
    return Promise.reject(new Error(UNCONFIGURED_MESSAGE));
  }
  listPolicyBindings(): Promise<AuthentikPolicyBinding[]> {
    return Promise.reject(new Error(UNCONFIGURED_MESSAGE));
  }
  deletePolicyBinding(_id: string): Promise<void> {
    return Promise.reject(new Error(UNCONFIGURED_MESSAGE));
  }
  getEmbeddedOutpost(): Promise<AuthentikOutpost> {
    return Promise.reject(new Error(UNCONFIGURED_MESSAGE));
  }
  setOutpostProviders(_outpostId: string, _providerIds: string[]): Promise<void> {
    return Promise.reject(new Error(UNCONFIGURED_MESSAGE));
  }
  getDefaultAuthorizationFlowId(): Promise<string> {
    return Promise.reject(new Error(UNCONFIGURED_MESSAGE));
  }
  getDefaultInvalidationFlowId(): Promise<string> {
    return Promise.reject(new Error(UNCONFIGURED_MESSAGE));
  }
  listOAuth2Providers(): Promise<AuthentikOAuth2Provider[]> {
    return Promise.reject(new Error(UNCONFIGURED_MESSAGE));
  }
  createOAuth2Provider(_input: OAuth2ProviderSettings & { name: string }): Promise<AuthentikOAuth2Provider> {
    return Promise.reject(new Error(UNCONFIGURED_MESSAGE));
  }
  updateOAuth2Provider(_id: string, _input: Partial<OAuth2ProviderSettings>): Promise<void> {
    return Promise.reject(new Error(UNCONFIGURED_MESSAGE));
  }
  deleteOAuth2Provider(_id: string): Promise<void> {
    return Promise.reject(new Error(UNCONFIGURED_MESSAGE));
  }
  renameOAuth2Provider(_id: string, _name: string): Promise<void> {
    return Promise.reject(new Error(UNCONFIGURED_MESSAGE));
  }
  getOAuth2Credentials(_id: string): Promise<{ clientId: string; clientSecret: string; issuer: string }> {
    return Promise.reject(new Error(UNCONFIGURED_MESSAGE));
  }
  getOAuth2Issuer(_id: string): Promise<string> {
    return Promise.reject(new Error(UNCONFIGURED_MESSAGE));
  }
  updateApplication(_slug: string, _input: { providerId?: string; metaPublisher?: string }): Promise<void> {
    return Promise.reject(new Error(UNCONFIGURED_MESSAGE));
  }
  getSigningKeyId(_name: string): Promise<string> {
    return Promise.reject(new Error(UNCONFIGURED_MESSAGE));
  }
  listScopeMappings(): Promise<AuthentikScopeMapping[]> {
    return Promise.reject(new Error(UNCONFIGURED_MESSAGE));
  }
  findStageByName(_name: string): Promise<AuthentikStageRef | undefined> {
    return Promise.reject(new Error(UNCONFIGURED_MESSAGE));
  }
  getConsentStage(_id: string): Promise<AuthentikConsentStage> {
    return Promise.reject(new Error(UNCONFIGURED_MESSAGE));
  }
  createConsentStage(_input: { name: string; mode: string }): Promise<AuthentikConsentStage> {
    return Promise.reject(new Error(UNCONFIGURED_MESSAGE));
  }
  updateConsentStage(_id: string, _input: { mode: string }): Promise<void> {
    return Promise.reject(new Error(UNCONFIGURED_MESSAGE));
  }
  deleteStage(_id: string): Promise<void> {
    return Promise.reject(new Error(UNCONFIGURED_MESSAGE));
  }
  findPolicyByName(_name: string): Promise<AuthentikPolicyRef | undefined> {
    return Promise.reject(new Error(UNCONFIGURED_MESSAGE));
  }
  createExpressionPolicy(_input: { name: string; expression: string }): Promise<AuthentikPolicyRef> {
    return Promise.reject(new Error(UNCONFIGURED_MESSAGE));
  }
  updateExpressionPolicy(_id: string, _input: { expression: string }): Promise<void> {
    return Promise.reject(new Error(UNCONFIGURED_MESSAGE));
  }
  deletePolicy(_id: string): Promise<void> {
    return Promise.reject(new Error(UNCONFIGURED_MESSAGE));
  }
  listFlowStageBindings(_flowId: string): Promise<AuthentikFlowStageBinding[]> {
    return Promise.reject(new Error(UNCONFIGURED_MESSAGE));
  }
  createFlowStageBinding(_input: {
    flowId: string;
    stageId: string;
    order: number;
    evaluateOnPlan: boolean;
    reEvaluatePolicies: boolean;
  }): Promise<AuthentikFlowStageBinding> {
    return Promise.reject(new Error(UNCONFIGURED_MESSAGE));
  }
  updateFlowStageBinding(_id: string, _input: { evaluateOnPlan: boolean; reEvaluatePolicies: boolean }): Promise<void> {
    return Promise.reject(new Error(UNCONFIGURED_MESSAGE));
  }
  deleteFlowStageBinding(_id: string): Promise<void> {
    return Promise.reject(new Error(UNCONFIGURED_MESSAGE));
  }
  listPolicyBindingsForTarget(_targetId: string): Promise<AuthentikPolicyBindingDetail[]> {
    return Promise.reject(new Error(UNCONFIGURED_MESSAGE));
  }
  createPolicyToTargetBinding(_input: { targetId: string; policyId: string }): Promise<void> {
    return Promise.reject(new Error(UNCONFIGURED_MESSAGE));
  }
  clearFlowCache(): Promise<void> {
    return Promise.reject(new Error(UNCONFIGURED_MESSAGE));
  }
}

// Delegates the configured/not-configured decision to authentikConfigured()
// so it lives in exactly one place (mirrors src/cli.ts's own buildAuthentikClient()).
// The non-null assertions below are safe because authentikConfigured()
// already checked both vars against the same process.env this file reads.
// Shared by src/web/server.ts and src/mcp/server.ts.
export function buildAuthentikClient(): AuthentikClient {
  if (!authentikConfigured()) return new UnconfiguredAuthentikClient();
  return new RealAuthentikClient(process.env.AUTHENTIK_API_URL!, process.env.AUTHENTIK_API_TOKEN!, authentikConfig());
}
