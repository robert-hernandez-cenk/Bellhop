import type {
  AuthentikApplication,
  AuthentikClient,
  AuthentikGroup,
  AuthentikOAuth2Provider,
  AuthentikOutpost,
  AuthentikPolicyBinding,
  AuthentikProxyProvider,
  AuthentikUser,
  CreateUserInput,
  OAuth2ProviderSettings,
  UpdateUserInput,
} from '../../src/lib/authentik-client.ts';

// Deterministic fake credentials/lookups for native OIDC gating (issue #1) --
// a real Authentik instance always has at least the stock self-signed
// certificate and the three managed OpenID scope mappings, so these let an
// ordinary test exercise OIDC-gated sync without seeding anything.
const DEFAULT_SIGNING_KEYS: Record<string, string> = {
  'authentik Self-signed Certificate': 'key-1',
};
const DEFAULT_SCOPE_MAPPINGS: Record<string, string> = {
  'goauthentik.io/providers/oauth2/scope-openid': 'scope-openid-1',
  'goauthentik.io/providers/oauth2/scope-profile': 'scope-profile-1',
  'goauthentik.io/providers/oauth2/scope-email': 'scope-email-1',
};

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
  proxyProviders?: AuthentikProxyProvider[];
  applications?: AuthentikApplication[];
  outpost?: AuthentikOutpost;
  oauth2Providers?: Array<AuthentikOAuth2Provider & { clientId?: string; clientSecret?: string }>;
  signingKeys?: Record<string, string>;
  scopeMappings?: Record<string, string>;
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
  private scopeMappings: Map<string, string>;
  private nextId = 1;

  // Every mutating call, in call order, for tests that assert "nothing
  // changed" or check that a particular reconcile step actually ran --
  // e.g. 'createOAuth2Provider media', 'updateApplication media',
  // 'deleteProxyProvider 3'. Read-only lookups (getSigningKeyId,
  // getScopeMappingIds, getOAuth2Credentials, every list*/get*) are not
  // logged, matching this array's purpose of tracking state changes.
  readonly calls: string[] = [];

  constructor(seed: FakeAuthentikSeed = {}) {
    this.users = new Map((seed.users ?? []).map((u) => [u.id, u]));
    this.groups = new Map((seed.groups ?? []).map((g) => [g.id, g]));
    this.proxyProviders = new Map((seed.proxyProviders ?? []).map((p) => [p.id, p]));
    this.applications = new Map((seed.applications ?? []).map((a) => [a.id, a]));
    this.outpost = seed.outpost ?? { id: 'outpost-1', name: 'authentik Embedded Outpost', providerIds: [] };
    this.oauth2Providers = new Map(
      (seed.oauth2Providers ?? []).map((p) => [
        p.id,
        { ...p, clientId: p.clientId ?? `client-${p.id}`, clientSecret: p.clientSecret ?? `secret-${p.id}` },
      ])
    );
    this.signingKeys = new Map(Object.entries(seed.signingKeys ?? DEFAULT_SIGNING_KEYS));
    this.scopeMappings = new Map(Object.entries(seed.scopeMappings ?? DEFAULT_SCOPE_MAPPINGS));

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
    const provider: AuthentikProxyProvider = { id: this.newId(), name: input.name, externalHost: input.externalHost };
    this.proxyProviders.set(provider.id, provider);
    this.calls.push(`createProxyProvider ${input.name}`);
    return provider;
  }

  async deleteProxyProvider(id: string): Promise<void> {
    this.requireProxyProvider(id);
    this.proxyProviders.delete(id);
    this.calls.push(`deleteProxyProvider ${id}`);
  }

  async renameProxyProvider(id: string, name: string): Promise<void> {
    const existing = this.requireProxyProvider(id);
    this.requireUniqueProviderName(name, id);
    this.proxyProviders.set(id, { ...existing, name });
    this.calls.push(`renameProxyProvider ${id}`);
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

  async deletePolicyBinding(id: string): Promise<void> {
    this.policyBindings = this.policyBindings.filter((b) => b.id !== id);
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
    return 'default-flow';
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

  async getScopeMappingIds(managed: string[]): Promise<string[]> {
    return managed.map((m) => {
      const id = this.scopeMappings.get(m);
      if (!id) throw new Error(`No Authentik scope property mapping found for managed id '${m}'`);
      return id;
    });
  }
}
