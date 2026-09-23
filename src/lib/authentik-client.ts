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

export interface AuthentikProxyProvider {
  id: string;
  name: string;
  externalHost: string;
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

export interface AuthentikClient {
  // Whether this client instance has a real Authentik API to talk to --
  // every other method call is only meaningful when this is true. Used to
  // gate routes/steps that need the REST API (requireUserDirectory in
  // src/web/auth.ts, syncCaddyLive in src/web/caddy-sync.ts) against the
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
  listApplications(): Promise<AuthentikApplication[]>;
  createApplication(input: { name: string; slug: string; providerId: string }): Promise<AuthentikApplication>;
  deleteApplication(id: string): Promise<void>;
  createPolicyBinding(input: { targetId: string; groupId: string }): Promise<void>;
  listPolicyBindings(): Promise<AuthentikPolicyBinding[]>;
  deletePolicyBinding(id: string): Promise<void>;
  getEmbeddedOutpost(): Promise<AuthentikOutpost>;
  setOutpostProviders(outpostId: string, providerIds: string[]): Promise<void>;
  getDefaultAuthorizationFlowId(): Promise<string>;
  getDefaultInvalidationFlowId(): Promise<string>;
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
}

// Authentik's Application model is keyed by its slug (a CharField primary
// key), not a numeric pk -- unlike users/groups/providers, there is no
// separate integer id to prefer over the slug.
interface RawApplication {
  pk: string;
  slug: string;
  name: string;
  provider?: number | string | null;
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

  async listProxyProviders(): Promise<AuthentikProxyProvider[]> {
    const res = await this.request<{ results: RawProxyProvider[] }>('GET', '/api/v3/providers/proxy/?page_size=500');
    return res.results.map((r) => ({ id: String(r.pk), name: r.name, externalHost: r.external_host }));
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
    return { id: String(raw.pk), name: raw.name, externalHost: raw.external_host };
  }

  async deleteProxyProvider(id: string): Promise<void> {
    await this.request<void>('DELETE', `/api/v3/providers/proxy/${id}/`);
  }

  async listApplications(): Promise<AuthentikApplication[]> {
    const res = await this.request<{ results: RawApplication[] }>('GET', '/api/v3/core/applications/?page_size=500');
    return res.results.map((r) => ({
      id: r.slug,
      pk: r.pk,
      name: r.name,
      slug: r.slug,
      providerId: r.provider != null ? String(r.provider) : undefined,
    }));
  }

  async createApplication(input: { name: string; slug: string; providerId: string }): Promise<AuthentikApplication> {
    const raw = await this.request<RawApplication>('POST', '/api/v3/core/applications/', {
      name: input.name,
      slug: input.slug,
      provider: input.providerId,
    });
    return { id: raw.slug, pk: raw.pk, name: raw.name, slug: raw.slug, providerId: input.providerId };
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
  // holds a few dozen bindings in total, and syncCaddyLive already makes
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
  async listPolicyBindings(): Promise<AuthentikPolicyBinding[]> {
    const res = await this.request<{ count: number; results: RawPolicyBinding[] }>(
      'GET',
      '/api/v3/policies/bindings/?page_size=500'
    );
    if (res.count > res.results.length) {
      throw new Error(
        `Authentik returned ${res.results.length} of ${res.count} policy bindings; pagination is not implemented`
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
  listApplications(): Promise<AuthentikApplication[]> {
    return Promise.reject(new Error(UNCONFIGURED_MESSAGE));
  }
  createApplication(_input: { name: string; slug: string; providerId: string }): Promise<AuthentikApplication> {
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
