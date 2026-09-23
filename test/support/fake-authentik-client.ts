import type {
  AuthentikApplication,
  AuthentikClient,
  AuthentikGroup,
  AuthentikOutpost,
  AuthentikPolicyBinding,
  AuthentikProxyProvider,
  AuthentikUser,
  CreateUserInput,
  UpdateUserInput,
} from '../../src/lib/authentik-client.ts';

export interface FakeAuthentikSeed {
  users?: AuthentikUser[];
  groups?: AuthentikGroup[];
  proxyProviders?: AuthentikProxyProvider[];
  applications?: AuthentikApplication[];
  outpost?: AuthentikOutpost;
}

export class FakeAuthentikClient implements AuthentikClient {
  private users: Map<string, AuthentikUser>;
  private groups: Map<string, AuthentikGroup>;
  private proxyProviders: Map<string, AuthentikProxyProvider>;
  private applications: Map<string, AuthentikApplication>;
  private outpost: AuthentikOutpost;
  private policyBindings: Array<{ id: string; targetId: string; groupId?: string }> = [];
  private nextId = 1;

  constructor(seed: FakeAuthentikSeed = {}) {
    this.users = new Map((seed.users ?? []).map((u) => [u.id, u]));
    this.groups = new Map((seed.groups ?? []).map((g) => [g.id, g]));
    this.proxyProviders = new Map((seed.proxyProviders ?? []).map((p) => [p.id, p]));
    this.applications = new Map((seed.applications ?? []).map((a) => [a.id, a]));
    this.outpost = seed.outpost ?? { id: 'outpost-1', name: 'authentik Embedded Outpost', providerIds: [] };

    // Advance nextId past the highest numeric id in seed data to avoid
    // collisions. An application's own slug-derived id is excluded, matching
    // real Authentik behavior -- but its providerId is not: that value
    // shares the id space this scan protects, and a seeded application's
    // providerId (e.g. '99') could otherwise collide with a later-minted
    // proxy provider id.
    const allIds = [
      ...(seed.users ?? []).map((u) => u.id),
      ...(seed.groups ?? []).map((g) => g.id),
      ...(seed.proxyProviders ?? []).map((p) => p.id),
      ...(seed.applications ?? []).map((a) => a.providerId).filter((p): p is string => p != null),
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

  private requireApplication(id: string): AuthentikApplication {
    const app = this.applications.get(id);
    if (!app) throw new Error(`Unknown application: ${id}`);
    return app;
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
    return updated;
  }

  async setUserActive(id: string, isActive: boolean): Promise<AuthentikUser> {
    const updated = { ...this.requireUser(id), isActive };
    this.users.set(id, updated);
    return updated;
  }

  async deleteUser(id: string): Promise<void> {
    this.requireUser(id);
    this.users.delete(id);
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
    return updated;
  }

  async deleteGroup(id: string): Promise<void> {
    this.requireGroup(id);
    this.groups.delete(id);
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
    const provider: AuthentikProxyProvider = { id: this.newId(), name: input.name, externalHost: input.externalHost };
    this.proxyProviders.set(provider.id, provider);
    return provider;
  }

  async deleteProxyProvider(id: string): Promise<void> {
    this.requireProxyProvider(id);
    this.proxyProviders.delete(id);
  }

  async listApplications(): Promise<AuthentikApplication[]> {
    return [...this.applications.values()];
  }

  async createApplication(input: { name: string; slug: string; providerId: string }): Promise<AuthentikApplication> {
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
    };
    this.applications.set(app.id, app);
    return app;
  }

  async deleteApplication(id: string): Promise<void> {
    const app = this.requireApplication(id);
    this.applications.delete(id);
    // Filtered on the Application's pk, not `id` (its slug) -- production
    // always creates policy bindings with `targetId: application.pk`
    // (sync-authentik.ts), never the slug, so that is what Authentik's own
    // cascade-on-delete keys off of here too.
    this.policyBindings = this.policyBindings.filter((b) => b.targetId !== app.pk);
  }

  async createPolicyBinding(input: { targetId: string; groupId: string }): Promise<void> {
    this.policyBindings.push({ id: this.newId(), targetId: input.targetId, groupId: input.groupId });
  }

  async listPolicyBindings(): Promise<AuthentikPolicyBinding[]> {
    return this.policyBindings.map((b) => ({ id: b.id, targetId: b.targetId, groupId: b.groupId }));
  }

  async deletePolicyBinding(id: string): Promise<void> {
    this.policyBindings = this.policyBindings.filter((b) => b.id !== id);
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
  }

  async getDefaultAuthorizationFlowId(): Promise<string> {
    return 'default-flow';
  }

  async getDefaultInvalidationFlowId(): Promise<string> {
    return 'default-invalidation-flow';
  }
}
