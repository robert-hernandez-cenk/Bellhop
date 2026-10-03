import type {
  AuthentikApplication,
  AuthentikClient,
  AuthentikConsentStage,
  AuthentikFlowStageBinding,
  AuthentikGroup,
  AuthentikOAuth2Provider,
  AuthentikOutpost,
  AuthentikPolicyBinding,
  AuthentikPolicyBindingDetail,
  AuthentikPolicyRef,
  AuthentikProxyProvider,
  AuthentikScopeMapping,
  AuthentikStageRef,
  AuthentikUser,
  CreateUserInput,
  OAuth2ProviderSettings,
  ProxyProviderMode,
  UpdateUserInput,
} from '../../src/lib/authentik-client.ts';

// Mirrors the real client's own model-string constants (authentik-client.ts,
// research.md R4/R7) -- a stage/policy is only "owned" by sync-authentik when
// its meta_model_name matches one of these.
const CONSENT_STAGE_MODEL = 'authentik_stages_consent.consentstage';
const EXPRESSION_POLICY_MODEL = 'authentik_policies_expression.expressionpolicy';

// Deterministic fake credentials/lookups for native OIDC gating (issue #1) --
// a real Authentik instance always has at least the stock self-signed
// certificate and the three managed OpenID scope mappings, so these let an
// ordinary test exercise OIDC-gated sync without seeding anything.
const DEFAULT_SIGNING_KEYS: Record<string, string> = {
  'authentik Self-signed Certificate': 'key-1',
};
export const DEFAULT_SCOPE_MAPPINGS: readonly AuthentikScopeMapping[] = [
  { id: 'scope-openid-1', managed: 'goauthentik.io/providers/oauth2/scope-openid', scopeName: 'openid' },
  { id: 'scope-profile-1', managed: 'goauthentik.io/providers/oauth2/scope-profile', scopeName: 'profile' },
  { id: 'scope-email-1', managed: 'goauthentik.io/providers/oauth2/scope-email', scopeName: 'email' },
];

// The built-ins plus one operator-made (unmanaged) email mapping -- the
// issue #16 case: a custom email mapping attached in place of scope-email-1.
export const CUSTOM_EMAIL_SCOPE_MAPPING_ID = 'scope-email-custom-1';
export const SCOPE_MAPPINGS_WITH_CUSTOM_EMAIL: readonly AuthentikScopeMapping[] = [
  ...DEFAULT_SCOPE_MAPPINGS,
  { id: CUSTOM_EMAIL_SCOPE_MAPPING_ID, scopeName: 'email' },
];

// client_id/client_secret sit outside AuthentikOAuth2Provider itself (the
// real interface deliberately keeps them off that type -- see
// authentik-client.ts) but the fake still has to store them somewhere to
// hand back from getOAuth2Credentials().
interface FakeOAuth2ProviderRecord extends AuthentikOAuth2Provider {
  clientId: string;
  clientSecret: string;
}

export interface FakeAuthentikSeed {
  users?: AuthentikUser[];
  groups?: AuthentikGroup[];
  // `mode` defaults to 'forward_single', the only mode sync-authentik itself
  // creates, so a seed only has to name it to model a hand-made provider.
  proxyProviders?: Array<Omit<AuthentikProxyProvider, 'mode'> & { mode?: ProxyProviderMode }>;
  applications?: AuthentikApplication[];
  outpost?: AuthentikOutpost;
  oauth2Providers?: Array<AuthentikOAuth2Provider & { clientId?: string; clientSecret?: string }>;
  signingKeys?: Record<string, string>;
  scopeMappings?: readonly AuthentikScopeMapping[];
  // Mobile-consent step (issue #22, research.md R4/R7). Seeded objects use
  // the same shape the real AuthentikClient interface hands back, so a test
  // can seed exactly what a prior list/create call would have returned.
  stages?: Array<AuthentikStageRef & { mode?: string }>;
  policies?: AuthentikPolicyRef[];
  flowStageBindings?: AuthentikFlowStageBinding[];
  // `targetId` here is a flow-stage binding's own `id` (its pk) -- the same
  // field AuthentikPolicyBindingDetail.targetId reports back (the live
  // quirk, research.md R4/R7), not the policyBindingModelId used to query
  // for it. Resolved against `flowStageBindings` above at construction time.
  targetPolicyBindings?: Array<{ id: string; targetId: string; policyId: string }>;
  // getDefaultAuthorizationFlowId() returns this when given, else its
  // existing hardcoded 'default-flow'.
  authorizationFlowId?: string;
  // Method names (e.g. 'createExpressionPolicy') that should throw instead
  // of performing their normal in-memory behavior -- for exercising
  // sync-authentik's per-step error handling without contriving real state
  // to trigger a failure.
  failOn?: Set<string>;
}

export class FakeAuthentikClient implements AuthentikClient {
  private users: Map<string, AuthentikUser>;
  private groups: Map<string, AuthentikGroup>;
  private proxyProviders: Map<string, AuthentikProxyProvider>;
  private applications: Map<string, AuthentikApplication>;
  private outpost: AuthentikOutpost;
  private policyBindings: Array<{ id: string; targetId: string; groupId?: string }> = [];
  private oauth2Providers: Map<string, FakeOAuth2ProviderRecord>;
  private signingKeys: Map<string, string>;
  private scopeMappings: readonly AuthentikScopeMapping[];
  // Mobile-consent step (issue #22). `mode`/`expression` are only ever
  // present on a consent-model stage / expression-model policy respectively,
  // mirroring how the real API's per-type endpoints are the only place those
  // fields are readable/writable at all.
  private stages: Map<string, { id: string; name: string; model: string; mode?: string }>;
  private policies: Map<string, { id: string; name: string; model: string; expression?: string }>;
  private flowStageBindings: Map<string, AuthentikFlowStageBinding>;
  // `flowStageBindingId` is the flow-stage binding's own pk -- stored
  // alongside `policyBindingModelId` (what a real create/list call actually
  // addresses) so listPolicyBindingsForTarget can reproduce the live quirk:
  // queried by policyBindingModelId, but each result's own `targetId`
  // reports the flow-stage binding's pk instead (research.md R4/R7).
  private targetPolicyBindings: Array<{
    id: string;
    policyBindingModelId: string;
    flowStageBindingId: string;
    policyId: string;
  }>;
  private authorizationFlowId: string;
  private failOn: Set<string>;
  private nextId = 1;

  // Incremented on every clearFlowCache() call -- a dedicated counter (issue
  // #22), distinct from `calls` below, so a test asserting "the cache was
  // cleared exactly once" doesn't have to filter/count `calls` entries by
  // string.
  cacheClears = 0;

  // Every mutating call, in call order, for tests that assert "nothing
  // changed" or check that a particular reconcile step actually ran --
  // e.g. 'createOAuth2Provider media', 'updateApplication media',
  // 'deleteProxyProvider 3'. Read-only lookups (getSigningKeyId,
  // listScopeMappings, getOAuth2Credentials, every list*/get*) are not
  // logged, matching this array's purpose of tracking state changes.
  readonly calls: string[] = [];

  constructor(seed: FakeAuthentikSeed = {}) {
    this.users = new Map((seed.users ?? []).map((u) => [u.id, u]));
    this.groups = new Map((seed.groups ?? []).map((g) => [g.id, g]));
    this.proxyProviders = new Map(
      (seed.proxyProviders ?? []).map((p) => [p.id, { ...p, mode: p.mode ?? 'forward_single' }])
    );
    this.applications = new Map((seed.applications ?? []).map((a) => [a.id, a]));
    this.outpost = seed.outpost ?? { id: 'outpost-1', name: 'authentik Embedded Outpost', providerIds: [] };
    this.oauth2Providers = new Map(
      (seed.oauth2Providers ?? []).map((p) => [
        p.id,
        { ...p, clientId: p.clientId ?? `client-${p.id}`, clientSecret: p.clientSecret ?? `secret-${p.id}` },
      ])
    );
    this.signingKeys = new Map(Object.entries(seed.signingKeys ?? DEFAULT_SIGNING_KEYS));
    this.scopeMappings = seed.scopeMappings ?? DEFAULT_SCOPE_MAPPINGS;
    this.stages = new Map((seed.stages ?? []).map((s) => [s.id, { id: s.id, name: s.name, model: s.model, mode: s.mode }]));
    this.policies = new Map(
      (seed.policies ?? []).map((p) => [p.id, { id: p.id, name: p.name, model: p.model, expression: p.expression }])
    );
    this.flowStageBindings = new Map((seed.flowStageBindings ?? []).map((b) => [b.id, { ...b }]));
    this.targetPolicyBindings = (seed.targetPolicyBindings ?? []).map((b) => {
      const binding = this.flowStageBindings.get(b.targetId);
      if (!binding) {
        throw new Error(
          `FakeAuthentikSeed: targetPolicyBindings references unknown flow-stage binding '${b.targetId}'`
        );
      }
      return {
        id: b.id,
        policyBindingModelId: binding.policyBindingModelId,
        flowStageBindingId: b.targetId,
        policyId: b.policyId,
      };
    });
    this.authorizationFlowId = seed.authorizationFlowId ?? 'default-flow';
    this.failOn = seed.failOn ?? new Set();

    // Advance nextId past the highest numeric id in seed data to avoid
    // collisions. An application's own slug-derived id is excluded, matching
    // real Authentik behavior -- but its providerId is not: that value
    // shares the id space this scan protects, and a seeded application's
    // providerId (e.g. '99') could otherwise collide with a later-minted
    // proxy provider id. Same reasoning extends oauth2Providers ids into
    // this scan.
    const allIds = [
      ...(seed.users ?? []).map((u) => u.id),
      ...(seed.groups ?? []).map((g) => g.id),
      ...(seed.proxyProviders ?? []).map((p) => p.id),
      ...(seed.applications ?? []).map((a) => a.providerId).filter((p): p is string => p != null),
      ...(seed.oauth2Providers ?? []).map((p) => p.id),
      ...(seed.stages ?? []).map((s) => s.id),
      ...(seed.policies ?? []).map((p) => p.id),
      ...(seed.flowStageBindings ?? []).flatMap((b) => [b.id, b.policyBindingModelId]),
      ...(seed.targetPolicyBindings ?? []).map((b) => b.id),
    ];
    const numericIds = allIds
      .map((id) => Number.parseInt(id, 10))
      .filter((n) => !Number.isNaN(n));
    if (numericIds.length > 0) {
      this.nextId = Math.max(...numericIds) + 1;
    }
  }

  isConfigured(): boolean {
    return true;
  }

  private newId(): string {
    return String(this.nextId++);
  }

  private requireUser(id: string): AuthentikUser {
    const user = this.users.get(id);
    if (!user) throw new Error(`Unknown user: ${id}`);
    return user;
  }

  private requireGroup(id: string): AuthentikGroup {
    const group = this.groups.get(id);
    if (!group) throw new Error(`Unknown group: ${id}`);
    return group;
  }

  private requireProxyProvider(id: string): AuthentikProxyProvider {
    const provider = this.proxyProviders.get(id);
    if (!provider) throw new Error(`Unknown proxy provider: ${id}`);
    return provider;
  }

  // Authentik's Provider.name is unique across every provider kind (proxy,
  // OAuth2, ...), and a duplicate is a 400 on create or rename. Enforced here
  // so a plan that would collide fails in tests instead of only in
  // production (U5 review finding 1, U8 fix round).
  private requireUniqueProviderName(name: string, exceptId?: string): void {
    const taken = [...this.proxyProviders.values(), ...this.oauth2Providers.values()].some(
      (p) => p.name === name && p.id !== exceptId
    );
    if (taken) throw new Error(`Authentik API failed: 400 provider with this name already exists (${name})`);
  }

  private requireApplication(id: string): AuthentikApplication {
    const app = this.applications.get(id);
    if (!app) throw new Error(`Unknown application: ${id}`);
    return app;
  }

  private requireOAuth2Provider(id: string): FakeOAuth2ProviderRecord {
    const provider = this.oauth2Providers.get(id);
    if (!provider) throw new Error(`Unknown OAuth2 provider: ${id}`);
    return provider;
  }

  // Strips clientId/clientSecret before handing a record back through the
  // public AuthentikClient surface -- mirrors AuthentikOAuth2Provider
  // deliberately not carrying them (see authentik-client.ts).
  private toPublicOAuth2Provider(record: FakeOAuth2ProviderRecord): AuthentikOAuth2Provider {
    const { clientId: _clientId, clientSecret: _clientSecret, ...rest } = record;
    return rest;
  }

  // Issue #22: lets a test force a specific method to throw (matched by the
  // interface method's own name), for exercising sync-authentik's per-step
  // error handling -- e.g. a consent-policy create failing -- without having
  // to contrive real state to trigger it.
  private checkFailOn(method: string): void {
    if (this.failOn.has(method)) {
      throw new Error(`FakeAuthentikClient: forced failure for ${method}`);
    }
  }

  private requireStage(id: string): { id: string; name: string; model: string; mode?: string } {
    const stage = this.stages.get(id);
    if (!stage) throw new Error(`Unknown stage: ${id}`);
    return stage;
  }

  // The real API's consent-stage endpoints (get/update/delete) 404 on a pk
  // that exists but names a different stage type, since they're served by a
  // type-specific viewset -- mirrored here rather than only checking
  // presence in the generic `stages` map.
  private requireConsentStage(id: string): { id: string; name: string; model: string; mode?: string } {
    const stage = this.requireStage(id);
    if (stage.model !== CONSENT_STAGE_MODEL) {
      throw new Error(`Stage ${id} is not a consent stage (model: ${stage.model})`);
    }
    return stage;
  }

  private requirePolicy(id: string): { id: string; name: string; model: string; expression?: string } {
    const policy = this.policies.get(id);
    if (!policy) throw new Error(`Unknown policy: ${id}`);
    return policy;
  }

  private requireFlowStageBinding(id: string): AuthentikFlowStageBinding {
    const binding = this.flowStageBindings.get(id);
    if (!binding) throw new Error(`Unknown flow-stage binding: ${id}`);
    return binding;
  }

  // Mirrors Authentik's own FK cascade: removing a flow-stage binding takes
  // its policy bindings with it (research.md R4/R7's "Authentik cascades").
  // Used by both the public deleteFlowStageBinding and deleteStage's own
  // cascade -- the latter never logs a separate deleteFlowStageBinding call,
  // since no such API call is actually made when a stage delete cascades in
  // real Authentik.
  private cascadeRemoveFlowStageBinding(id: string): void {
    this.targetPolicyBindings = this.targetPolicyBindings.filter((b) => b.flowStageBindingId !== id);
    this.flowStageBindings.delete(id);
  }

  async listUsers(): Promise<AuthentikUser[]> {
    return [...this.users.values()];
  }

  async getUser(id: string): Promise<AuthentikUser> {
    return this.requireUser(id);
  }

  async createUser(input: CreateUserInput): Promise<AuthentikUser> {
    const user: AuthentikUser = {
      id: this.newId(),
      username: input.username,
      uid: `uid-${input.username}`,
      email: input.email,
      isActive: true,
      groupIds: input.groupIds,
    };
    this.users.set(user.id, user);
    this.calls.push(`createUser ${input.username}`);
    return user;
  }

  async updateUser(id: string, input: UpdateUserInput): Promise<AuthentikUser> {
    const existing = this.requireUser(id);
    const updated: AuthentikUser = {
      ...existing,
      ...(input.username !== undefined ? { username: input.username } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.groupIds !== undefined ? { groupIds: input.groupIds } : {}),
    };
    this.users.set(id, updated);
    this.calls.push(`updateUser ${id}`);
    return updated;
  }

  async setUserActive(id: string, isActive: boolean): Promise<AuthentikUser> {
    const updated = { ...this.requireUser(id), isActive };
    this.users.set(id, updated);
    this.calls.push(`setUserActive ${id} ${isActive}`);
    return updated;
  }

  async deleteUser(id: string): Promise<void> {
    this.requireUser(id);
    this.users.delete(id);
    this.calls.push(`deleteUser ${id}`);
  }

  async getRecoveryLink(id: string): Promise<string> {
    this.requireUser(id);
    return `https://fake-authentik.example.com/recovery/${id}`;
  }

  async listGroups(): Promise<AuthentikGroup[]> {
    return [...this.groups.values()];
  }

  async createGroup(name: string): Promise<AuthentikGroup> {
    const group: AuthentikGroup = { id: this.newId(), name, userIds: [] };
    this.groups.set(group.id, group);
    this.calls.push(`createGroup ${name}`);
    return group;
  }

  async updateGroup(id: string, input: { name?: string; userIds?: string[] }): Promise<AuthentikGroup> {
    const existing = this.requireGroup(id);
    const updated: AuthentikGroup = {
      ...existing,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.userIds !== undefined ? { userIds: input.userIds } : {}),
    };
    this.groups.set(id, updated);
    this.calls.push(`updateGroup ${id}`);
    return updated;
  }

  async deleteGroup(id: string): Promise<void> {
    this.requireGroup(id);
    this.groups.delete(id);
    this.calls.push(`deleteGroup ${id}`);
  }

  async listProxyProviders(): Promise<AuthentikProxyProvider[]> {
    return [...this.proxyProviders.values()];
  }

  async createProxyProvider(input: {
    name: string;
    externalHost: string;
    authorizationFlowId: string;
    invalidationFlowId: string;
  }): Promise<AuthentikProxyProvider> {
    this.requireUniqueProviderName(input.name);
    const provider: AuthentikProxyProvider = {
      id: this.newId(),
      name: input.name,
      externalHost: input.externalHost,
      mode: 'forward_single',
    };
    this.proxyProviders.set(provider.id, provider);
    this.calls.push(`createProxyProvider ${input.name}`);
    return provider;
  }

  async deleteProxyProvider(id: string): Promise<void> {
    this.requireProxyProvider(id);
    this.proxyProviders.delete(id);
    this.calls.push(`deleteProxyProvider ${id}`);
  }

  // Every renameProxyProvider PATCH body as the real client would send it
  // (name, mode, internal_host), for tests that pin what a rename carries.
  readonly proxyProviderRenames: Array<{ id: string; name: string; mode: string; internalHost?: string }> = [];

  // Mirrors Authentik 2026.8's own validation of the PATCH the real client
  // sends: without `mode` (and, in 'proxy' mode, `internal_host`) it is a
  // 400, verified live. The mode sent is applied, as Authentik applies it --
  // so a caller that sent the wrong mode would visibly convert the provider.
  async renameProxyProvider(provider: AuthentikProxyProvider, name: string): Promise<void> {
    const existing = this.requireProxyProvider(provider.id);
    if (!provider.mode || (provider.mode === 'proxy' && !provider.internalHost)) {
      throw new Error(
        `Authentik API PATCH /api/v3/providers/proxy/${provider.id}/ failed: 400 ` +
          '{"internal_host":["Internal host cannot be empty when forward auth is disabled."]}'
      );
    }
    this.requireUniqueProviderName(name, provider.id);
    this.proxyProviders.set(provider.id, {
      ...existing,
      name,
      mode: provider.mode,
      ...(provider.mode === 'proxy' ? { internalHost: provider.internalHost } : {}),
    });
    this.proxyProviderRenames.push({
      id: provider.id,
      name,
      mode: provider.mode,
      ...(provider.mode === 'proxy' ? { internalHost: provider.internalHost } : {}),
    });
    this.calls.push(`renameProxyProvider ${provider.id}`);
  }

  async listApplications(): Promise<AuthentikApplication[]> {
    return [...this.applications.values()];
  }

  async createApplication(input: {
    name: string;
    slug: string;
    providerId: string;
    metaPublisher?: string;
  }): Promise<AuthentikApplication> {
    // pk is a synthetic id here, distinct from the slug-derived `id`/`slug`
    // -- a real Authentik pk is an unrelated UUID, not derived from the
    // slug, so this.newId() (the same counter used for users/groups/
    // providers) models that "unrelated identifier" shape.
    const app: AuthentikApplication = {
      id: input.slug,
      pk: this.newId(),
      name: input.name,
      slug: input.slug,
      providerId: input.providerId,
      metaPublisher: input.metaPublisher,
    };
    this.applications.set(app.id, app);
    this.calls.push(`createApplication ${input.slug}`);
    this.syncAssignedApplicationSlug(input.providerId, input.slug);
    return app;
  }

  async deleteApplication(id: string): Promise<void> {
    const app = this.requireApplication(id);
    this.applications.delete(id);
    this.calls.push(`deleteApplication ${id}`);
    // Filtered on the Application's pk, not `id` (its slug) -- production
    // always creates policy bindings with `targetId: application.pk`
    // (sync-authentik.ts), never the slug, so that is what Authentik's own
    // cascade-on-delete keys off of here too.
    this.policyBindings = this.policyBindings.filter((b) => b.targetId !== app.pk);
    if (app.providerId !== undefined) this.syncAssignedApplicationSlug(app.providerId, undefined);
  }

  // Keeps AuthentikOAuth2Provider.assignedApplicationSlug consistent with
  // whichever Application currently points at that provider -- called from
  // createApplication/updateApplication/deleteApplication, mirroring how a
  // real Authentik Application's `provider` foreign key drives the
  // provider's own reverse-lookup field.
  private syncAssignedApplicationSlug(providerId: string, slug: string | undefined): void {
    const provider = this.oauth2Providers.get(providerId);
    if (provider) this.oauth2Providers.set(providerId, { ...provider, assignedApplicationSlug: slug });
  }

  async updateApplication(slug: string, input: { providerId?: string; metaPublisher?: string }): Promise<void> {
    const existing = this.requireApplication(slug);
    const oldProviderId = existing.providerId;
    const updated: AuthentikApplication = {
      ...existing,
      ...(input.providerId !== undefined ? { providerId: input.providerId } : {}),
      ...(input.metaPublisher !== undefined ? { metaPublisher: input.metaPublisher } : {}),
    };
    this.applications.set(slug, updated);
    this.calls.push(`updateApplication ${slug}`);
    if (input.providerId !== undefined && input.providerId !== oldProviderId) {
      if (oldProviderId !== undefined) this.syncAssignedApplicationSlug(oldProviderId, undefined);
      this.syncAssignedApplicationSlug(input.providerId, updated.slug);
    }
  }

  async createPolicyBinding(input: { targetId: string; groupId: string }): Promise<void> {
    this.policyBindings.push({ id: this.newId(), targetId: input.targetId, groupId: input.groupId });
    this.calls.push(`createPolicyBinding ${input.targetId} ${input.groupId}`);
  }

  async listPolicyBindings(): Promise<AuthentikPolicyBinding[]> {
    return this.policyBindings.map((b) => ({ id: b.id, targetId: b.targetId, groupId: b.groupId }));
  }

  // One endpoint (DELETE /api/v3/policies/bindings/<id>/) serves every kind
  // of policy binding, so this also removes a policy-to-flow-stage-binding
  // one -- how sync-authentik deletes the mobile-consent policy binding.
  async deletePolicyBinding(id: string): Promise<void> {
    this.checkFailOn('deletePolicyBinding');
    this.policyBindings = this.policyBindings.filter((b) => b.id !== id);
    this.targetPolicyBindings = this.targetPolicyBindings.filter((b) => b.id !== id);
    this.calls.push(`deletePolicyBinding ${id}`);
  }

  // Test-only accessor -- not part of the AuthentikClient interface, since
  // no production code needs to read policy bindings back.
  listPolicyBindingsForTest(): Array<{ id: string; targetId: string; groupId?: string }> {
    return [...this.policyBindings];
  }

  // Test-only seeder -- models a policy- or user-backed binding, which
  // `createPolicyBinding` (part of the public AuthentikClient interface,
  // deliberately left unchanged) cannot express: the real client always
  // supplies a groupId. Used to put a group-less binding in front of
  // runSyncAuthentik's reconcile pass, the one thing that keeps such a
  // binding out of it entirely (sync-authentik.ts's `if (binding.groupId
  // === undefined) continue;`).
  seedPolicyBindingForTest(input: { targetId: string; groupId?: string }): string {
    const id = this.newId();
    this.policyBindings.push({ id, targetId: input.targetId, groupId: input.groupId });
    return id;
  }

  async getEmbeddedOutpost(): Promise<AuthentikOutpost> {
    return this.outpost;
  }

  async setOutpostProviders(outpostId: string, providerIds: string[]): Promise<void> {
    if (outpostId !== this.outpost.id) throw new Error(`Unknown outpost: ${outpostId}`);
    this.outpost = { ...this.outpost, providerIds };
    this.calls.push(`setOutpostProviders ${outpostId}`);
  }

  async getDefaultAuthorizationFlowId(): Promise<string> {
    this.checkFailOn('getDefaultAuthorizationFlowId');
    return this.authorizationFlowId;
  }

  async getDefaultInvalidationFlowId(): Promise<string> {
    return 'default-invalidation-flow';
  }

  async listOAuth2Providers(): Promise<AuthentikOAuth2Provider[]> {
    return [...this.oauth2Providers.values()].map((p) => this.toPublicOAuth2Provider(p));
  }

  async createOAuth2Provider(input: OAuth2ProviderSettings & { name: string }): Promise<AuthentikOAuth2Provider> {
    this.requireUniqueProviderName(input.name);
    const id = this.newId();
    const record: FakeOAuth2ProviderRecord = {
      id,
      name: input.name,
      assignedApplicationSlug: undefined,
      clientType: input.clientType,
      grantTypes: input.grantTypes,
      signingKeyId: input.signingKeyId,
      propertyMappingIds: input.propertyMappingIds,
      redirectUris: input.redirectUris,
      clientId: `client-${id}`,
      clientSecret: `secret-${id}`,
    };
    this.oauth2Providers.set(id, record);
    this.calls.push(`createOAuth2Provider ${input.name}`);
    return this.toPublicOAuth2Provider(record);
  }

  async updateOAuth2Provider(id: string, input: Partial<OAuth2ProviderSettings>): Promise<void> {
    const existing = this.requireOAuth2Provider(id);
    const updated: FakeOAuth2ProviderRecord = {
      ...existing,
      ...(input.clientType !== undefined ? { clientType: input.clientType } : {}),
      ...(input.grantTypes !== undefined ? { grantTypes: input.grantTypes } : {}),
      ...(input.signingKeyId !== undefined ? { signingKeyId: input.signingKeyId } : {}),
      ...(input.propertyMappingIds !== undefined ? { propertyMappingIds: input.propertyMappingIds } : {}),
      ...(input.redirectUris !== undefined ? { redirectUris: input.redirectUris } : {}),
    };
    this.oauth2Providers.set(id, updated);
    this.calls.push(`updateOAuth2Provider ${id}`);
  }

  async deleteOAuth2Provider(id: string): Promise<void> {
    this.requireOAuth2Provider(id);
    this.oauth2Providers.delete(id);
    this.calls.push(`deleteOAuth2Provider ${id}`);
  }

  async renameOAuth2Provider(id: string, name: string): Promise<void> {
    const existing = this.requireOAuth2Provider(id);
    this.requireUniqueProviderName(name, id);
    this.oauth2Providers.set(id, { ...existing, name });
    this.calls.push(`renameOAuth2Provider ${id}`);
  }

  async getOAuth2Credentials(id: string): Promise<{ clientId: string; clientSecret: string; issuer: string }> {
    const provider = this.requireOAuth2Provider(id);
    return {
      clientId: provider.clientId,
      clientSecret: provider.clientSecret,
      issuer: this.issuerFor(provider),
    };
  }

  async getOAuth2Issuer(id: string): Promise<string> {
    return this.issuerFor(this.requireOAuth2Provider(id));
  }

  // Same shape as a real Authentik issuer: per-Application, trailing slash.
  private issuerFor(provider: FakeOAuth2ProviderRecord): string {
    return `https://auth.example.com/application/o/${provider.assignedApplicationSlug ?? provider.id}/`;
  }

  async getSigningKeyId(name: string): Promise<string> {
    const id = this.signingKeys.get(name);
    if (!id) {
      throw new Error(
        `No Authentik signing key named '${name}' with a private key found ` +
          '(set AUTHENTIK_OIDC_SIGNING_KEY_NAME to match your instance)'
      );
    }
    return id;
  }

  async listScopeMappings(): Promise<AuthentikScopeMapping[]> {
    return [...this.scopeMappings];
  }

  // Mobile-consent step (issue #22, research.md R4/R7): in-memory behavior
  // matching the real endpoints' documented quirks -- see the class-field
  // comments above for the storage shape and cascade rules.
  async findStageByName(name: string): Promise<AuthentikStageRef | undefined> {
    this.checkFailOn('findStageByName');
    const match = [...this.stages.values()].find((s) => s.name === name);
    return match ? { id: match.id, name: match.name, model: match.model } : undefined;
  }

  async getConsentStage(id: string): Promise<AuthentikConsentStage> {
    this.checkFailOn('getConsentStage');
    const stage = this.requireConsentStage(id);
    return { id: stage.id, name: stage.name, mode: stage.mode ?? 'always_require' };
  }

  async createConsentStage(input: { name: string; mode: string }): Promise<AuthentikConsentStage> {
    this.checkFailOn('createConsentStage');
    const id = this.newId();
    this.stages.set(id, { id, name: input.name, model: CONSENT_STAGE_MODEL, mode: input.mode });
    this.calls.push(`createConsentStage ${input.name}`);
    return { id, name: input.name, mode: input.mode };
  }

  async updateConsentStage(id: string, input: { mode: string }): Promise<void> {
    this.checkFailOn('updateConsentStage');
    const stage = this.requireConsentStage(id);
    this.stages.set(id, { ...stage, mode: input.mode });
    this.calls.push(`updateConsentStage ${id}`);
  }

  async deleteStage(id: string): Promise<void> {
    this.checkFailOn('deleteStage');
    this.requireConsentStage(id);
    for (const binding of [...this.flowStageBindings.values()].filter((b) => b.stageId === id)) {
      this.cascadeRemoveFlowStageBinding(binding.id);
    }
    this.stages.delete(id);
    this.calls.push(`deleteStage ${id}`);
  }

  async findPolicyByName(name: string): Promise<AuthentikPolicyRef | undefined> {
    this.checkFailOn('findPolicyByName');
    const match = [...this.policies.values()].find((p) => p.name === name);
    return match ? { id: match.id, name: match.name, model: match.model, expression: match.expression } : undefined;
  }

  async createExpressionPolicy(input: { name: string; expression: string }): Promise<AuthentikPolicyRef> {
    this.checkFailOn('createExpressionPolicy');
    const id = this.newId();
    this.policies.set(id, { id, name: input.name, model: EXPRESSION_POLICY_MODEL, expression: input.expression });
    this.calls.push(`createExpressionPolicy ${input.name}`);
    return { id, name: input.name, model: EXPRESSION_POLICY_MODEL, expression: input.expression };
  }

  async updateExpressionPolicy(id: string, input: { expression: string }): Promise<void> {
    this.checkFailOn('updateExpressionPolicy');
    const policy = this.requirePolicy(id);
    this.policies.set(id, { ...policy, expression: input.expression });
    this.calls.push(`updateExpressionPolicy ${id}`);
  }

  async deletePolicy(id: string): Promise<void> {
    this.checkFailOn('deletePolicy');
    this.requirePolicy(id);
    this.policies.delete(id);
    this.calls.push(`deletePolicy ${id}`);
  }

  async listFlowStageBindings(flowId: string): Promise<AuthentikFlowStageBinding[]> {
    this.checkFailOn('listFlowStageBindings');
    return [...this.flowStageBindings.values()].filter((b) => b.flowId === flowId);
  }

  async createFlowStageBinding(input: {
    flowId: string;
    stageId: string;
    order: number;
    evaluateOnPlan: boolean;
    reEvaluatePolicies: boolean;
  }): Promise<AuthentikFlowStageBinding> {
    this.checkFailOn('createFlowStageBinding');
    const binding: AuthentikFlowStageBinding = {
      id: this.newId(),
      // Distinct from `id` -- a real flow-stage binding's pk and its
      // policybindingmodel_ptr_id are two different columns (research.md R4).
      policyBindingModelId: this.newId(),
      flowId: input.flowId,
      stageId: input.stageId,
      order: input.order,
      evaluateOnPlan: input.evaluateOnPlan,
      reEvaluatePolicies: input.reEvaluatePolicies,
    };
    this.flowStageBindings.set(binding.id, binding);
    this.calls.push(`createFlowStageBinding ${input.flowId} ${input.stageId}`);
    return binding;
  }

  async updateFlowStageBinding(
    id: string,
    input: { evaluateOnPlan: boolean; reEvaluatePolicies: boolean }
  ): Promise<void> {
    this.checkFailOn('updateFlowStageBinding');
    const binding = this.requireFlowStageBinding(id);
    this.flowStageBindings.set(id, {
      ...binding,
      evaluateOnPlan: input.evaluateOnPlan,
      reEvaluatePolicies: input.reEvaluatePolicies,
    });
    this.calls.push(`updateFlowStageBinding ${id}`);
  }

  async deleteFlowStageBinding(id: string): Promise<void> {
    this.checkFailOn('deleteFlowStageBinding');
    this.requireFlowStageBinding(id);
    this.cascadeRemoveFlowStageBinding(id);
    this.calls.push(`deleteFlowStageBinding ${id}`);
  }

  // The live quirk (research.md R4/R7): queried by the flow-stage binding's
  // policyBindingModelId, but each returned detail's own targetId reports
  // the flow-stage binding's pk instead -- mirrored exactly here rather than
  // "fixed", since production code (and its tests) depend on this shape.
  async listPolicyBindingsForTarget(targetId: string): Promise<AuthentikPolicyBindingDetail[]> {
    this.checkFailOn('listPolicyBindingsForTarget');
    return this.targetPolicyBindings
      .filter((b) => b.policyBindingModelId === targetId)
      .map((b) => ({ id: b.id, targetId: b.flowStageBindingId, policyId: b.policyId }));
  }

  // `input.targetId` here is a policyBindingModelId (what production code
  // actually addresses this create call with -- see the interface's own
  // comment), not the flow-stage binding's own id.
  async createPolicyToTargetBinding(input: { targetId: string; policyId: string }): Promise<void> {
    this.checkFailOn('createPolicyToTargetBinding');
    const binding = [...this.flowStageBindings.values()].find((b) => b.policyBindingModelId === input.targetId);
    if (!binding) {
      throw new Error(`Unknown policy binding model: ${input.targetId}`);
    }
    this.targetPolicyBindings.push({
      id: this.newId(),
      policyBindingModelId: input.targetId,
      flowStageBindingId: binding.id,
      policyId: input.policyId,
    });
    this.calls.push(`createPolicyToTargetBinding ${input.targetId} ${input.policyId}`);
  }

  async clearFlowCache(): Promise<void> {
    this.checkFailOn('clearFlowCache');
    this.cacheClears++;
    this.calls.push('clearFlowCache');
  }

  // Test-only accessors -- not part of the AuthentikClient interface, same
  // precedent as listPolicyBindingsForTest above.
  listStagesForTest(): Array<{ id: string; name: string; model: string; mode?: string }> {
    return [...this.stages.values()];
  }

  listPoliciesForTest(): Array<{ id: string; name: string; model: string; expression?: string }> {
    return [...this.policies.values()];
  }

  listFlowStageBindingsForTest(): AuthentikFlowStageBinding[] {
    return [...this.flowStageBindings.values()];
  }

  listTargetPolicyBindingsForTest(): Array<{ id: string; targetId: string; policyId: string }> {
    return this.targetPolicyBindings.map((b) => ({ id: b.id, targetId: b.flowStageBindingId, policyId: b.policyId }));
  }
}
