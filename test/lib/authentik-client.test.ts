import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { RealAuthentikClient, UnconfiguredAuthentikClient } from '../../src/lib/authentik-client.ts';
import type { AuthentikProxyProvider, AuthentikUser } from '../../src/lib/authentik-client.ts';
import { authentikConfig } from '../../src/lib/authentik-config.ts';
import { FakeAuthentikClient } from '../support/fake-authentik-client.ts';

const UNCONFIGURED_MESSAGE = 'Authentik API not configured (set AUTHENTIK_API_URL and AUTHENTIK_API_TOKEN)';

// Redacted captures from a live Authentik 2026.8.2 instance (issue #22,
// research.md R4) -- see test/fixtures/authentik/ and specs/010-oidc-mobile-
// redirects/research.md for provenance. Every pk/uuid, stage/policy name, and
// expression in these files is a fake/example value; only field names,
// types, nesting, and (mostly) array lengths are real.
const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/authentik');
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf8'));
}

test('UnconfiguredAuthentikClient rejects every method with a clear configuration error', async () => {
  const client = new UnconfiguredAuthentikClient();
  await assert.rejects(client.listUsers(), { message: UNCONFIGURED_MESSAGE });
  await assert.rejects(client.getUser('1'), { message: UNCONFIGURED_MESSAGE });
  await assert.rejects(
    client.createUser({ username: 'a', email: 'a@example.com', groupIds: [] }),
    { message: UNCONFIGURED_MESSAGE }
  );
  await assert.rejects(client.updateUser('1', {}), { message: UNCONFIGURED_MESSAGE });
  await assert.rejects(client.setUserActive('1', true), { message: UNCONFIGURED_MESSAGE });
  await assert.rejects(client.deleteUser('1'), { message: UNCONFIGURED_MESSAGE });
  await assert.rejects(client.getRecoveryLink('1'), { message: UNCONFIGURED_MESSAGE });
  await assert.rejects(client.listGroups(), { message: UNCONFIGURED_MESSAGE });
  await assert.rejects(client.createGroup('g'), { message: UNCONFIGURED_MESSAGE });
  await assert.rejects(client.updateGroup('1', {}), { message: UNCONFIGURED_MESSAGE });
  await assert.rejects(client.deleteGroup('1'), { message: UNCONFIGURED_MESSAGE });
});

test('FakeAuthentikClient creates a user and lists it back', async () => {
  const client = new FakeAuthentikClient();
  const user = await client.createUser({ username: 'alice', email: 'alice@example.com', groupIds: [] });
  assert.equal(user.username, 'alice');
  assert.equal(user.isActive, true);
  assert.deepEqual(await client.listUsers(), [user]);
});

test('FakeAuthentikClient updates, deactivates, and deletes a user', async () => {
  const client = new FakeAuthentikClient();
  const user = await client.createUser({ username: 'alice', email: 'alice@example.com', groupIds: [] });
  const renamed = await client.updateUser(user.id, { email: 'alice2@example.com' });
  assert.equal(renamed.email, 'alice2@example.com');
  const deactivated = await client.setUserActive(user.id, false);
  assert.equal(deactivated.isActive, false);
  await client.deleteUser(user.id);
  assert.deepEqual(await client.listUsers(), []);
});

test('FakeAuthentikClient rejects operations on an unknown user id', async () => {
  const client = new FakeAuthentikClient();
  await assert.rejects(() => client.getUser('missing'), /Unknown user: missing/);
});

test('FakeAuthentikClient creates a group and updates its membership', async () => {
  const client = new FakeAuthentikClient();
  const group = await client.createGroup('admins');
  assert.deepEqual(group.userIds, []);
  const updated = await client.updateGroup(group.id, { userIds: ['1', '2'] });
  assert.deepEqual(updated.userIds, ['1', '2']);
  assert.deepEqual(await client.listGroups(), [updated]);
});

test('FakeAuthentikClient can be seeded with initial users and groups', async () => {
  const seededUser: AuthentikUser = {
    id: '1',
    username: 'seed',
    email: 'seed@example.com',
    isActive: true,
    groupIds: [],
  };
  const client = new FakeAuthentikClient({ users: [seededUser] });
  assert.deepEqual(await client.listUsers(), [seededUser]);
});

test('FakeAuthentikClient advances nextId past seeded numeric ids to avoid collisions', async () => {
  const seededUser: AuthentikUser = {
    id: '1',
    username: 'seed',
    email: 'seed@example.com',
    isActive: true,
    groupIds: [],
  };
  const client = new FakeAuthentikClient({ users: [seededUser] });
  const newUser = await client.createUser({
    username: 'alice',
    email: 'alice@example.com',
    groupIds: [],
  });
  // New user should NOT have id '1' (which is seeded)
  assert.notEqual(newUser.id, '1');
  // Seeded user should still be present and unmodified
  const allUsers = await client.listUsers();
  assert.equal(allUsers.length, 2);
  const seedCheck = allUsers.find((u) => u.id === '1');
  assert.deepEqual(seedCheck, seededUser);
});

test('UnconfiguredAuthentikClient rejects the new Provider/Application/outpost methods too', async () => {
  const client = new UnconfiguredAuthentikClient();
  await assert.rejects(client.listProxyProviders(), { message: UNCONFIGURED_MESSAGE });
  await assert.rejects(
    client.createProxyProvider({
      name: 'a',
      externalHost: 'https://a.example.com',
      authorizationFlowId: 'f',
      invalidationFlowId: 'g',
    }),
    { message: UNCONFIGURED_MESSAGE }
  );
  await assert.rejects(client.deleteProxyProvider('1'), { message: UNCONFIGURED_MESSAGE });
  await assert.rejects(client.listApplications(), { message: UNCONFIGURED_MESSAGE });
  await assert.rejects(
    client.createApplication({ name: 'a', slug: 'a', providerId: '1' }),
    { message: UNCONFIGURED_MESSAGE }
  );
  await assert.rejects(client.deleteApplication('a'), { message: UNCONFIGURED_MESSAGE });
  await assert.rejects(client.createPolicyBinding({ targetId: 'a', groupId: '1' }), { message: UNCONFIGURED_MESSAGE });
  await assert.rejects(client.listPolicyBindings(), { message: UNCONFIGURED_MESSAGE });
  await assert.rejects(client.deletePolicyBinding('1'), { message: UNCONFIGURED_MESSAGE });
  await assert.rejects(client.getEmbeddedOutpost(), { message: UNCONFIGURED_MESSAGE });
  await assert.rejects(client.setOutpostProviders('1', []), { message: UNCONFIGURED_MESSAGE });
  await assert.rejects(client.getDefaultAuthorizationFlowId(), { message: UNCONFIGURED_MESSAGE });
  await assert.rejects(client.getDefaultInvalidationFlowId(), { message: UNCONFIGURED_MESSAGE });
});

test('FakeAuthentikClient creates a proxy provider and an application bound to it', async () => {
  const client = new FakeAuthentikClient();
  const provider = await client.createProxyProvider({
    name: 'sonarr.example.com',
    externalHost: 'https://sonarr.example.com',
    authorizationFlowId: 'flow-1',
    invalidationFlowId: 'flow-2',
  });
  assert.equal(provider.name, 'sonarr.example.com');
  const app = await client.createApplication({ name: 'sonarr.example.com', slug: 'sonarr', providerId: provider.id });
  assert.equal(app.slug, 'sonarr');
  assert.equal(app.providerId, provider.id);
  assert.deepEqual(await client.listProxyProviders(), [provider]);
  assert.deepEqual(await client.listApplications(), [app]);
});

test('FakeAuthentikClient deletes a proxy provider and an application independently', async () => {
  const client = new FakeAuthentikClient();
  const provider = await client.createProxyProvider({
    name: 'a.example.com',
    externalHost: 'https://a.example.com',
    authorizationFlowId: 'flow-1',
    invalidationFlowId: 'flow-2',
  });
  const app = await client.createApplication({ name: 'a.example.com', slug: 'a', providerId: provider.id });
  await client.deleteApplication(app.id);
  assert.deepEqual(await client.listApplications(), []);
  assert.deepEqual(await client.listProxyProviders(), [provider], 'deleting the application must not delete its provider');
  await client.deleteProxyProvider(provider.id);
  assert.deepEqual(await client.listProxyProviders(), []);
});

test('FakeAuthentikClient records a policy binding and drops it when its application is deleted', async () => {
  const client = new FakeAuthentikClient();
  const app = await client.createApplication({ name: 'a.example.com', slug: 'a', providerId: '1' });
  // Seeded on app.pk, not app.id (the slug) -- production always creates
  // policy bindings with `targetId: application.pk` (sync-authentik.ts), so
  // this is the shape the real cascade-on-delete has to work against.
  await client.createPolicyBinding({ targetId: app.pk, groupId: 'group-1' });
  const bindings = client.listPolicyBindingsForTest();
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].targetId, app.pk);
  assert.equal(bindings[0].groupId, 'group-1');
  assert.ok(bindings[0].id, 'a policy binding must carry an id');
  await client.deleteApplication(app.id);
  assert.deepEqual(client.listPolicyBindingsForTest(), []);
});

test('FakeAuthentikClient has a default embedded outpost and lets its provider list be replaced', async () => {
  const client = new FakeAuthentikClient();
  const outpost = await client.getEmbeddedOutpost();
  assert.deepEqual(outpost.providerIds, []);
  await client.setOutpostProviders(outpost.id, ['1', '2']);
  assert.deepEqual((await client.getEmbeddedOutpost()).providerIds, ['1', '2']);
});

test('FakeAuthentikClient returns a stable default authorization flow id', async () => {
  const client = new FakeAuthentikClient();
  assert.equal(await client.getDefaultAuthorizationFlowId(), 'default-flow');
});

test('FakeAuthentikClient returns a stable default invalidation flow id', async () => {
  const client = new FakeAuthentikClient();
  assert.equal(await client.getDefaultInvalidationFlowId(), 'default-invalidation-flow');
});

test('getOAuth2Issuer: the unconfigured client rejects, the fake returns the per-Application issuer', async () => {
  await assert.rejects(new UnconfiguredAuthentikClient().getOAuth2Issuer('1'), { message: UNCONFIGURED_MESSAGE });

  const client = new FakeAuthentikClient();
  const provider = await client.createOAuth2Provider({
    name: 'media',
    clientType: 'confidential',
    grantTypes: ['authorization_code'],
    propertyMappingIds: [],
    redirectUris: [],
    authorizationFlowId: 'f',
    invalidationFlowId: 'g',
  });
  await client.createApplication({ name: 'media', slug: 'media', providerId: provider.id });
  assert.equal(await client.getOAuth2Issuer(provider.id), 'https://auth.example.com/application/o/media/');
  assert.equal(await client.getOAuth2Issuer(provider.id), (await client.getOAuth2Credentials(provider.id)).issuer);
});

// Authentik provider names are unique across every provider kind (U8 fix
// round) -- the fake enforces it so a plan that would collide fails in tests.
test('FakeAuthentikClient rejects a duplicate provider name across proxy and OAuth2 providers, on create and rename', async () => {
  const oauth2Input = (name: string) => ({
    name,
    clientType: 'confidential' as const,
    grantTypes: ['authorization_code'],
    propertyMappingIds: [],
    redirectUris: [],
    authorizationFlowId: 'f',
    invalidationFlowId: 'g',
  });
  const proxyInput = (name: string) => ({ name, externalHost: 'https://a.example.com', authorizationFlowId: 'f', invalidationFlowId: 'g' });

  const client = new FakeAuthentikClient();
  const proxy = await client.createProxyProvider(proxyInput('media'));
  await assert.rejects(client.createOAuth2Provider(oauth2Input('media')), /name already exists/);
  await assert.rejects(client.createProxyProvider(proxyInput('media')), /name already exists/);
  const oauth2 = await client.createOAuth2Provider(oauth2Input('books'));
  await assert.rejects(client.renameOAuth2Provider(oauth2.id, 'media'), /name already exists/);
  await assert.rejects(client.renameProxyProvider(proxy, 'books'), /name already exists/);

  await client.renameProxyProvider(proxy, 'media (replaced)');
  assert.equal((await client.listProxyProviders())[0].name, 'media (replaced)');
  await client.renameOAuth2Provider(oauth2.id, 'media');
  assert.equal((await client.listOAuth2Providers())[0].name, 'media');
  assert.deepEqual(client.calls.filter((x) => x.startsWith('rename')), [
    `renameProxyProvider ${proxy.id}`,
    `renameOAuth2Provider ${oauth2.id}`,
  ]);
});

test('UnconfiguredAuthentikClient rejects the provider rename methods', async () => {
  const client = new UnconfiguredAuthentikClient();
  await assert.rejects(client.renameProxyProvider({ id: '1', name: 'a', externalHost: 'https://a.example.com', mode: 'forward_single' }, 'a'), { message: UNCONFIGURED_MESSAGE });
  await assert.rejects(client.renameOAuth2Provider('1', 'a'), { message: UNCONFIGURED_MESSAGE });
});

// Final-review fix 1: Authentik 2026.8 answers a PATCH carrying only `name`
// with 400 "Internal host cannot be empty when forward auth is disabled"
// (verified live). The fake mirrors that, so a rename has to re-send the
// provider's own mode -- and, in 'proxy' mode, its internal host.
test('FakeAuthentikClient.renameProxyProvider rejects a rename without the provider mode, like Authentik 2026.8', async () => {
  const client = new FakeAuthentikClient({
    proxyProviders: [
      { id: '7', name: 'hand', externalHost: 'https://hand.example.com', mode: 'proxy', internalHost: 'http://192.0.2.10:8080' },
    ],
  });
  const created = await client.createProxyProvider({
    name: 'media',
    externalHost: 'https://media.example.com',
    authorizationFlowId: 'f',
    invalidationFlowId: 'g',
  });
  assert.equal(created.mode, 'forward_single', 'the only mode sync-authentik creates');

  const noMode = { ...created, mode: undefined } as unknown as AuthentikProxyProvider;
  await assert.rejects(client.renameProxyProvider(noMode, 'media (replaced)'), /Internal host cannot be empty/);
  const [hand] = (await client.listProxyProviders()).filter((p) => p.id === '7');
  await assert.rejects(
    client.renameProxyProvider({ ...hand, internalHost: undefined }, 'hand (replaced)'),
    /Internal host cannot be empty/,
    "'proxy' mode needs its internal host re-sent too"
  );

  await client.renameProxyProvider(hand, 'hand (replaced)');
  const renamed = (await client.listProxyProviders()).find((p) => p.id === '7')!;
  assert.equal(renamed.name, 'hand (replaced)');
  assert.equal(renamed.mode, 'proxy', 'the rename keeps the provider in its own mode');
  assert.equal(renamed.internalHost, 'http://192.0.2.10:8080');
  assert.deepEqual(client.proxyProviderRenames, [
    { id: '7', name: 'hand (replaced)', mode: 'proxy', internalHost: 'http://192.0.2.10:8080' },
  ]);
});

// RealAuthentikClient has no live-instance test (same precedent as
// Ssh2SSHClient), but the request bodies it builds and the responses it maps
// are pure functions of global fetch, so these pin them with a stubbed one.
async function withStubbedFetch(
  respond: (url: string, init: RequestInit) => Response,
  fn: (client: RealAuthentikClient, requests: Array<{ url: string; method: string; body: unknown }>) => Promise<void>
): Promise<void> {
  const original = globalThis.fetch;
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    requests.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined });
    return respond(url, init);
  }) as typeof fetch;
  try {
    await fn(new RealAuthentikClient('https://auth.example.com', 'test-token', authentikConfig({})), requests);
  } finally {
    globalThis.fetch = original;
  }
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('RealAuthentikClient maps a proxy provider mode and internal host, and a rename re-sends them', async () => {
  await withStubbedFetch(
    (url) =>
      url.includes('/providers/proxy/?')
        ? json({
            results: [
              { pk: 5, name: 'media', external_host: 'https://media.example.com', mode: 'forward_single', internal_host: '' },
              { pk: 6, name: 'hand', external_host: 'https://hand.example.com', mode: 'proxy', internal_host: 'http://192.0.2.10:8080' },
            ],
          })
        : new Response(null, { status: 204 }),
    async (client, requests) => {
      const [media, hand] = await client.listProxyProviders();
      assert.deepEqual(media, { id: '5', name: 'media', externalHost: 'https://media.example.com', mode: 'forward_single', internalHost: undefined });
      assert.equal(hand.mode, 'proxy');
      assert.equal(hand.internalHost, 'http://192.0.2.10:8080');

      await client.renameProxyProvider(media, 'media (replaced)');
      await client.renameProxyProvider(hand, 'hand (replaced)');
      assert.deepEqual(requests.slice(1), [
        { url: 'https://auth.example.com/api/v3/providers/proxy/5/', method: 'PATCH', body: { name: 'media (replaced)', mode: 'forward_single' } },
        {
          url: 'https://auth.example.com/api/v3/providers/proxy/6/',
          method: 'PATCH',
          body: { name: 'hand (replaced)', mode: 'proxy', internal_host: 'http://192.0.2.10:8080' },
        },
      ]);
    }
  );
});

// Final-review fix 4: a blank secret must never be shown as if it were real.
test('RealAuthentikClient.getOAuth2Credentials throws, naming the provider, when Authentik returns no client_id or client_secret', async () => {
  for (const provider of [{ client_id: 'abc' }, { client_secret: 'shh' }, { client_id: '', client_secret: 'shh' }]) {
    await withStubbedFetch(
      (url) =>
        url.endsWith('/setup_urls/')
          ? json({ issuer: 'https://auth.example.com/application/o/media/' })
          : json({ pk: 9, name: 'media', client_type: 'confidential', ...provider }),
      async (client) => {
        await assert.rejects(client.getOAuth2Credentials('9'), /no client_(id|secret).*OAuth2 provider 9/);
      }
    );
  }
  await withStubbedFetch(
    (url) =>
      url.endsWith('/setup_urls/')
        ? json({ issuer: 'https://auth.example.com/application/o/media/' })
        : json({ pk: 9, name: 'media', client_type: 'confidential', client_id: 'abc', client_secret: 'shh' }),
    async (client) => {
      assert.deepEqual(await client.getOAuth2Credentials('9'), {
        clientId: 'abc',
        clientSecret: 'shh',
        issuer: 'https://auth.example.com/application/o/media/',
      });
    }
  );
});

// T044 live-verification fix: Authentik 2026.8's `GET /api/v3/providers/oauth2/`
// returns every proxy provider as well as real OAuth2 providers, because
// ProxyProvider subclasses OAuth2Provider -- meta_model_name/component report
// the OAuth2 values for all of them, so the list response itself can't tell
// the two apart; only membership in `GET /api/v3/providers/proxy/` can.
// listOAuth2Providers must filter out any pk that also shows up there, so
// every other caller (ownedProviderKind, planProviderName, ...) can keep
// trusting "in the OAuth2 list" to mean "really an OAuth2 provider."
test('RealAuthentikClient.listOAuth2Providers excludes a proxy provider pk present in the raw oauth2 response', async () => {
  await withStubbedFetch(
    (url) => {
      if (url.includes('/providers/proxy/?')) {
        return json({ results: [{ pk: 5, name: 'media', external_host: 'https://media.example.com', mode: 'forward_single', internal_host: '' }] });
      }
      if (url.includes('/providers/oauth2/?')) {
        // Authentik includes provider 5 (the proxy provider above) here too,
        // alongside the one genuine OAuth2 provider (pk 9).
        return json({
          count: 2,
          results: [
            { pk: 5, name: 'media', client_type: 'confidential', grant_types: ['authorization_code'] },
            { pk: 9, name: 'books', client_type: 'confidential', grant_types: ['authorization_code'] },
          ],
        });
      }
      return new Response(null, { status: 204 });
    },
    async (client) => {
      const providers = await client.listOAuth2Providers();
      assert.deepEqual(
        providers.map((p) => p.id),
        ['9'],
        'the proxy provider (pk 5) must not be reported as an OAuth2 provider'
      );
    }
  );
});

// --- Scope property mappings (issue #16) -----------------------------------

// The live capture (research.md R1) has no top-level `count` -- only
// `pagination.count` -- and includes a custom (`managed: null`) mapping
// alongside the built-in ones, exactly the case listScopeMappings exists for.
test('RealAuthentikClient.listScopeMappings maps pk -> id, scope_name -> scopeName, and null managed -> managed absent', async () => {
  const propertyMappings = fixture('propertymappings-scope.json');
  await withStubbedFetch(
    (url) =>
      url.includes('/propertymappings/provider/scope/?page_size=100') ? json(propertyMappings) : new Response(null, { status: 204 }),
    async (client, requests) => {
      const mappings = await client.listScopeMappings();
      assert.equal(requests[0]?.url, 'https://auth.example.com/api/v3/propertymappings/provider/scope/?page_size=100');
      assert.equal(mappings.length, 10);
      assert.deepEqual(mappings[2], {
        id: '00000000-0000-4000-8000-000000000042',
        managed: 'goauthentik.io/providers/oauth2/scope-email',
        scopeName: 'email',
      });
      const custom = mappings.find((m) => m.id === '00000000-0000-4000-8000-000000000043');
      assert.deepEqual(custom, {
        id: '00000000-0000-4000-8000-000000000043',
        managed: undefined,
        scopeName: 'email',
      });
    }
  );
});

// Driven from the real fixture shape (pagination.count bumped above the
// result count) rather than a fabricated response -- same rationale as
// findPolicyByName's own truncation test above: the count Authentik actually
// reports lives under pagination.count, and the old guard read a top-level
// `count` that never existed, so it never fired (research.md R1).
test('RealAuthentikClient.listScopeMappings throws when Authentik reports more mappings than the page returned', async () => {
  const propertyMappings = fixture('propertymappings-scope.json') as {
    pagination: Record<string, unknown>;
    results: unknown[];
  };
  const truncated = {
    ...propertyMappings,
    pagination: { ...propertyMappings.pagination, count: propertyMappings.results.length + 1 },
  };
  await withStubbedFetch(
    () => json(truncated),
    async (client) => {
      await assert.rejects(client.listScopeMappings(), /pagination is not implemented/);
    }
  );
});

// --- Mobile-consent step (issue #22, T011) --------------------------------

test('UnconfiguredAuthentikClient rejects the mobile-consent-step methods too', async () => {
  const client = new UnconfiguredAuthentikClient();
  await assert.rejects(client.findStageByName('a'), { message: UNCONFIGURED_MESSAGE });
  await assert.rejects(client.getConsentStage('1'), { message: UNCONFIGURED_MESSAGE });
  await assert.rejects(client.createConsentStage({ name: 'a', mode: 'always_require' }), {
    message: UNCONFIGURED_MESSAGE,
  });
  await assert.rejects(client.updateConsentStage('1', { mode: 'always_require' }), { message: UNCONFIGURED_MESSAGE });
  await assert.rejects(client.deleteStage('1'), { message: UNCONFIGURED_MESSAGE });
  await assert.rejects(client.findPolicyByName('a'), { message: UNCONFIGURED_MESSAGE });
  await assert.rejects(client.createExpressionPolicy({ name: 'a', expression: 'return True' }), {
    message: UNCONFIGURED_MESSAGE,
  });
  await assert.rejects(client.updateExpressionPolicy('1', { expression: 'return True' }), {
    message: UNCONFIGURED_MESSAGE,
  });
  await assert.rejects(client.deletePolicy('1'), { message: UNCONFIGURED_MESSAGE });
  await assert.rejects(client.listFlowStageBindings('1'), { message: UNCONFIGURED_MESSAGE });
  await assert.rejects(
    client.createFlowStageBinding({ flowId: '1', stageId: '2', order: 10, evaluateOnPlan: false, reEvaluatePolicies: true }),
    { message: UNCONFIGURED_MESSAGE }
  );
  await assert.rejects(client.updateFlowStageBinding('1', { evaluateOnPlan: false, reEvaluatePolicies: true }), {
    message: UNCONFIGURED_MESSAGE,
  });
  await assert.rejects(client.deleteFlowStageBinding('1'), { message: UNCONFIGURED_MESSAGE });
  await assert.rejects(client.listPolicyBindingsForTarget('1'), { message: UNCONFIGURED_MESSAGE });
  await assert.rejects(client.createPolicyToTargetBinding({ targetId: '1', policyId: '2' }), {
    message: UNCONFIGURED_MESSAGE,
  });
  await assert.rejects(client.clearFlowCache(), { message: UNCONFIGURED_MESSAGE });
});

test('RealAuthentikClient.findStageByName maps a matching stage by name, any type, and returns undefined otherwise', async () => {
  const stagesAllByName = fixture('stages-all-by-name.json');
  await withStubbedFetch(
    (url) => (url.includes('/stages/all/?name=') ? json(stagesAllByName) : new Response(null, { status: 204 })),
    async (client, requests) => {
      const stage = await client.findStageByName('example-mobile-consent');
      assert.deepEqual(stage, {
        id: '00000000-0000-4000-8000-000000000003',
        name: 'example-mobile-consent',
        model: 'authentik_stages_consent.consentstage',
      });
      assert.equal(requests[0]?.url, 'https://auth.example.com/api/v3/stages/all/?name=example-mobile-consent');
      assert.equal(requests[0]?.method, 'GET');
    }
  );

  await withStubbedFetch(
    () => json({ results: [] }),
    async (client) => {
      assert.equal(await client.findStageByName('does-not-exist'), undefined);
    }
  );
});

test('RealAuthentikClient consent stage CRUD hits /stages/consent/ with the right bodies and maps the response', async () => {
  const mobileStage = fixture('stages-consent-detail.json'); // 'example-mobile-consent', mode 'always_require'
  const mapped = { id: '00000000-0000-4000-8000-000000000003', name: 'example-mobile-consent', mode: 'always_require' };

  await withStubbedFetch(
    () => json(mobileStage),
    async (client, requests) => {
      assert.deepEqual(await client.getConsentStage('00000000-0000-4000-8000-000000000003'), mapped);
      assert.deepEqual(
        await client.createConsentStage({ name: 'example-mobile-consent', mode: 'always_require' }),
        mapped
      );
      await client.updateConsentStage('00000000-0000-4000-8000-000000000003', { mode: 'always_require' });
      await client.deleteStage('00000000-0000-4000-8000-000000000003');

      assert.deepEqual(requests, [
        { url: 'https://auth.example.com/api/v3/stages/consent/00000000-0000-4000-8000-000000000003/', method: 'GET', body: undefined },
        {
          url: 'https://auth.example.com/api/v3/stages/consent/',
          method: 'POST',
          body: { name: 'example-mobile-consent', mode: 'always_require' },
        },
        {
          url: 'https://auth.example.com/api/v3/stages/consent/00000000-0000-4000-8000-000000000003/',
          method: 'PATCH',
          body: { mode: 'always_require' },
        },
        {
          url: 'https://auth.example.com/api/v3/stages/consent/00000000-0000-4000-8000-000000000003/',
          method: 'DELETE',
          body: undefined,
        },
      ]);
    }
  );
});

// The live "all" listing mixes policy types (expression, event_matcher,
// password, ...) -- findPolicyByName's mapping must hold both ways: an
// expression policy carries `expression`, and a non-expression policy
// carries `model` alone with `expression: undefined` rather than throwing
// or dropping the match.
test('RealAuthentikClient.findPolicyByName matches client-side (the server-side name filter is ignored) and maps both an expression and a non-expression policy', async () => {
  const policiesAll = fixture('policies-all.json');
  await withStubbedFetch(
    (url) => (url.includes('/policies/all/?page_size=500') ? json(policiesAll) : new Response(null, { status: 204 })),
    async (client, requests) => {
      const policy = await client.findPolicyByName('example-consent-policy');
      assert.deepEqual(policy, {
        id: '00000000-0000-4000-8000-000000000009',
        name: 'example-consent-policy',
        model: 'authentik_policies_expression.expressionpolicy',
        expression: '# Example: gate a stage on a condition.\nreturn True',
      });
      assert.equal(requests[0]?.url, 'https://auth.example.com/api/v3/policies/all/?page_size=500');

      const nonExpression = await client.findPolicyByName('example-event-matcher-policy');
      assert.deepEqual(nonExpression, {
        id: '00000000-0000-4000-8000-00000000000c',
        name: 'example-event-matcher-policy',
        model: 'authentik_policies_event_matcher.eventmatcherpolicy',
        expression: undefined,
      });

      assert.equal(await client.findPolicyByName('does-not-exist'), undefined);
    }
  );
});

// Driven from the real policies-all.json shape (pagination.count bumped
// above the result count) rather than a fabricated response -- the count
// Authentik actually reports lives under `pagination.count`, never a
// top-level `count`, so a stubbed `{ count, results }` shape would never
// occur against a real instance and would prove nothing about this guard.
test('RealAuthentikClient.findPolicyByName throws when Authentik reports more policies than the page returned', async () => {
  const policiesAll = fixture('policies-all.json') as {
    pagination: Record<string, unknown>;
    results: unknown[];
  };
  const truncated = {
    ...policiesAll,
    pagination: { ...policiesAll.pagination, count: policiesAll.results.length + 1 },
  };
  await withStubbedFetch(
    () => json(truncated),
    async (client) => {
      await assert.rejects(client.findPolicyByName('anything'), /pagination is not implemented/);
    }
  );
});

test('RealAuthentikClient expression policy CRUD hits /policies/expression/ with the right bodies and maps the response', async () => {
  const policiesAll = fixture('policies-all.json') as { results: Array<Record<string, unknown>> };
  const policy = policiesAll.results[0]!; // 'example-consent-policy'
  const mapped = {
    id: '00000000-0000-4000-8000-000000000009',
    name: 'example-consent-policy',
    model: 'authentik_policies_expression.expressionpolicy',
    expression: '# Example: gate a stage on a condition.\nreturn True',
  };

  await withStubbedFetch(
    () => json(policy),
    async (client, requests) => {
      assert.deepEqual(
        await client.createExpressionPolicy({ name: 'example-consent-policy', expression: mapped.expression }),
        mapped
      );
      await client.updateExpressionPolicy('00000000-0000-4000-8000-000000000009', { expression: 'return False' });
      await client.deletePolicy('00000000-0000-4000-8000-000000000009');

      assert.deepEqual(requests, [
        {
          url: 'https://auth.example.com/api/v3/policies/expression/',
          method: 'POST',
          body: { name: 'example-consent-policy', expression: mapped.expression, execution_logging: false },
        },
        {
          url: 'https://auth.example.com/api/v3/policies/expression/00000000-0000-4000-8000-000000000009/',
          method: 'PATCH',
          body: { expression: 'return False' },
        },
        {
          url: 'https://auth.example.com/api/v3/policies/expression/00000000-0000-4000-8000-000000000009/',
          method: 'DELETE',
          body: undefined,
        },
      ]);
    }
  );
});

test('RealAuthentikClient.listFlowStageBindings maps a target-filtered flow-stage-binding list', async () => {
  const bindings = fixture('flows-bindings-by-target.json');
  await withStubbedFetch(
    (url) => (url.includes('/flows/bindings/?target=') ? json(bindings) : new Response(null, { status: 204 })),
    async (client, requests) => {
      const result = await client.listFlowStageBindings('00000000-0000-4000-8000-000000000001');
      assert.deepEqual(result, [
        {
          id: '00000000-0000-4000-8000-000000000007',
          policyBindingModelId: '00000000-0000-4000-8000-000000000008',
          flowId: '00000000-0000-4000-8000-000000000001',
          stageId: '00000000-0000-4000-8000-000000000003',
          order: 10,
          evaluateOnPlan: false,
          reEvaluatePolicies: true,
        },
      ]);
      assert.equal(
        requests[0]?.url,
        'https://auth.example.com/api/v3/flows/bindings/?target=00000000-0000-4000-8000-000000000001&page_size=500'
      );
    }
  );
});

test('RealAuthentikClient.createFlowStageBinding sends the fixed policy_engine_mode/invalid_response_action, and update/delete hit the right URLs', async () => {
  const bindings = fixture('flows-bindings-by-target.json') as { results: Array<Record<string, unknown>> };
  const binding = bindings.results[0]!;
  const mapped = {
    id: '00000000-0000-4000-8000-000000000007',
    policyBindingModelId: '00000000-0000-4000-8000-000000000008',
    flowId: '00000000-0000-4000-8000-000000000001',
    stageId: '00000000-0000-4000-8000-000000000003',
    order: 10,
    evaluateOnPlan: false,
    reEvaluatePolicies: true,
  };

  await withStubbedFetch(
    () => json(binding),
    async (client, requests) => {
      assert.deepEqual(
        await client.createFlowStageBinding({
          flowId: '00000000-0000-4000-8000-000000000001',
          stageId: '00000000-0000-4000-8000-000000000003',
          order: 10,
          evaluateOnPlan: false,
          reEvaluatePolicies: true,
        }),
        mapped
      );
      await client.updateFlowStageBinding('00000000-0000-4000-8000-000000000007', {
        evaluateOnPlan: false,
        reEvaluatePolicies: true,
      });
      await client.deleteFlowStageBinding('00000000-0000-4000-8000-000000000007');

      assert.deepEqual(requests, [
        {
          url: 'https://auth.example.com/api/v3/flows/bindings/',
          method: 'POST',
          body: {
            target: '00000000-0000-4000-8000-000000000001',
            stage: '00000000-0000-4000-8000-000000000003',
            order: 10,
            evaluate_on_plan: false,
            re_evaluate_policies: true,
            policy_engine_mode: 'any',
            invalid_response_action: 'retry',
          },
        },
        {
          url: 'https://auth.example.com/api/v3/flows/bindings/00000000-0000-4000-8000-000000000007/',
          method: 'PATCH',
          body: { evaluate_on_plan: false, re_evaluate_policies: true },
        },
        {
          url: 'https://auth.example.com/api/v3/flows/bindings/00000000-0000-4000-8000-000000000007/',
          method: 'DELETE',
          body: undefined,
        },
      ]);
    }
  );
});

// The live quirk R4 calls out: filtering by the flow-stage binding's own pk
// fails against a real instance, so the query uses policybindingmodel_ptr_id
// -- but the response's own `target` field reports the flow-stage binding's
// pk, not the policybindingmodel_ptr_id used to query it. targetId must
// reflect the *response's* target field, not the value queried with.
test('RealAuthentikClient.listPolicyBindingsForTarget maps the flow-stage binding pk (not the policybindingmodel_ptr_id queried with) to targetId', async () => {
  const bindings = fixture('policies-bindings-by-target.json');
  await withStubbedFetch(
    (url) => (url.includes('/policies/bindings/?target=') ? json(bindings) : new Response(null, { status: 204 })),
    async (client, requests) => {
      // Queried by the flow-stage binding's policybindingmodel_ptr_id...
      const result = await client.listPolicyBindingsForTarget('00000000-0000-4000-8000-000000000008');
      // ...but the mapped targetId is the flow-stage binding's own pk, which
      // is what the response's `target` field actually carries.
      assert.deepEqual(result, [
        {
          id: '00000000-0000-4000-8000-00000000000b',
          targetId: '00000000-0000-4000-8000-000000000007',
          policyId: '00000000-0000-4000-8000-000000000009',
        },
      ]);
      assert.equal(
        requests[0]?.url,
        'https://auth.example.com/api/v3/policies/bindings/?target=00000000-0000-4000-8000-000000000008&page_size=500'
      );
    }
  );
});

test('RealAuthentikClient.createPolicyToTargetBinding sends the fixed policy-binding defaults', async () => {
  await withStubbedFetch(
    () => new Response(null, { status: 204 }),
    async (client, requests) => {
      await client.createPolicyToTargetBinding({
        targetId: '00000000-0000-4000-8000-000000000007',
        policyId: '00000000-0000-4000-8000-000000000009',
      });
      assert.deepEqual(requests, [
        {
          url: 'https://auth.example.com/api/v3/policies/bindings/',
          method: 'POST',
          body: {
            target: '00000000-0000-4000-8000-000000000007',
            policy: '00000000-0000-4000-8000-000000000009',
            order: 0,
            enabled: true,
            negate: false,
            timeout: 30,
            failure_result: false,
          },
        },
      ]);
    }
  );
});

test('RealAuthentikClient.clearFlowCache POSTs to the cache_clear endpoint', async () => {
  await withStubbedFetch(
    () => new Response(null, { status: 204 }),
    async (client, requests) => {
      await client.clearFlowCache();
      assert.deepEqual(requests, [
        { url: 'https://auth.example.com/api/v3/flows/instances/cache_clear/', method: 'POST', body: undefined },
      ]);
    }
  );
});
