import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UnconfiguredAuthentikClient } from '../../src/lib/authentik-client.ts';
import type { AuthentikUser } from '../../src/lib/authentik-client.ts';
import { FakeAuthentikClient } from '../support/fake-authentik-client.ts';

const UNCONFIGURED_MESSAGE = 'Authentik API not configured (set AUTHENTIK_API_URL and AUTHENTIK_API_TOKEN)';

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
  await assert.rejects(client.renameProxyProvider(proxy.id, 'books'), /name already exists/);

  await client.renameProxyProvider(proxy.id, 'media (replaced)');
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
  await assert.rejects(client.renameProxyProvider('1', 'a'), { message: UNCONFIGURED_MESSAGE });
  await assert.rejects(client.renameOAuth2Provider('1', 'a'), { message: UNCONFIGURED_MESSAGE });
});
