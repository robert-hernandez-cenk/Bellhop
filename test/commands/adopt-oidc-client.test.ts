import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Inventory } from '../../src/lib/inventory.ts';
import { runAdoptOidcClient, formatAdoptOidcClient } from '../../src/commands/networking/adopt-oidc-client.ts';
import { runSyncAuthentik } from '../../src/commands/networking/sync-authentik.ts';
import { authentikConfig } from '../../src/lib/authentik-config.ts';
import { FakeAuthentikClient } from '../support/fake-authentik-client.ts';

const LADDER = authentikConfig().groupLadder; // low -> high
const [, , USERS_RUNG, ADMIN_RUNG] = LADDER;
const OIDC_URIS = ['https://media.example.com/oauth/callback'];

// Mirrors sync-authentik.test.ts's/oidc-credentials.test.ts's own OIDC
// fixture shape.
function oidcInventory(overrides: Partial<Inventory['guests'][number]> = {}): Inventory {
  return {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', authentik: true, ip: '192.0.2.5' }],
    guests: [
      {
        name: 'media',
        type: 'lxc',
        vmid: 130,
        host: 'pve1',
        ip: '192.0.2.30',
        subdomains: ['media'],
        authGroup: USERS_RUNG,
        authMode: 'oidc',
        oidcRedirectUris: OIDC_URIS,
        ...overrides,
      },
    ],
  };
}

async function seedLadderGroups(authentik: FakeAuthentikClient): Promise<Map<string, string>> {
  const byName = new Map<string, string>();
  for (const rung of LADDER) byName.set(rung, (await authentik.createGroup(rung)).id);
  return byName;
}

// A hand-made OpenID client at the 'media' slug: no meta_publisher, and
// deliberately drifted (missing refresh_token grant, no scope mappings) so
// adoption has real settings drift to report/fix, not just meta_publisher.
// Its redirect URI already matches OIDC_URIS[0], so redirect_uris itself is
// clean -- keeps the drift list to exactly the two fields under test.
function handMadeAuthentik(): FakeAuthentikClient {
  return new FakeAuthentikClient({
    applications: [{ id: 'media', pk: 'pk-media', name: 'media', slug: 'media', providerId: '50' }],
    oauth2Providers: [
      {
        id: '50',
        name: 'media',
        assignedApplicationSlug: 'media',
        clientType: 'confidential',
        grantTypes: ['authorization_code'],
        signingKeyId: 'key-1',
        propertyMappingIds: [],
        redirectUris: [{ matchingMode: 'strict', url: OIDC_URIS[0] }],
      },
    ],
  });
}

test('dry run lists meta_publisher, every drifted setting, and every binding change, and mutates nothing', async () => {
  const authentik = handMadeAuthentik();
  await seedLadderGroups(authentik);
  const callsBefore = authentik.calls.length;

  const result = await runAdoptOidcClient({ entry: 'media' }, { authentik, inventory: oidcInventory() });
  assert.equal(result.applied, false);
  assert.equal(result.slug, 'media');
  assert.deepEqual(result.settingsChanges, ['grant_types', 'property_mappings']);
  assert.deepEqual(
    [...result.bindingChanges].sort((a, b) => a.group.localeCompare(b.group)),
    [
      { slug: 'media', group: USERS_RUNG, action: 'add' },
      { slug: 'media', group: ADMIN_RUNG, action: 'add' },
    ].sort((a, b) => a.group.localeCompare(b.group))
  );
  assert.deepEqual(authentik.calls.slice(callsBefore), [], 'a dry run must write nothing');

  const app = (await authentik.listApplications())[0];
  assert.equal(app.metaPublisher, undefined, 'a dry run never sets the marker');
  const provider = (await authentik.listOAuth2Providers())[0];
  assert.deepEqual(provider.grantTypes, ['authorization_code'], 'a dry run never fixes drift');

  const text = formatAdoptOidcClient(result);
  assert.match(text, /meta_publisher -> bellhop/);
  assert.match(text, /~ grant_types/);
  assert.match(text, /~ property_mappings/);
  assert.match(text, /\+ media -> /);
});

test('apply sets meta_publisher, fixes drift, reconciles bindings, and getOAuth2Credentials returns the pre-adoption client id and secret', async () => {
  const authentik = handMadeAuthentik();
  const ids = await seedLadderGroups(authentik);
  const before = await authentik.getOAuth2Credentials('50');

  const result = await runAdoptOidcClient({ entry: 'media', apply: true }, { authentik, inventory: oidcInventory() });
  assert.equal(result.applied, true);
  assert.deepEqual(result.settingsChanges, ['grant_types', 'property_mappings']);

  const app = (await authentik.listApplications())[0];
  assert.equal(app.metaPublisher, 'bellhop');

  const provider = (await authentik.listOAuth2Providers())[0];
  assert.deepEqual(provider.grantTypes, ['authorization_code', 'refresh_token']);
  assert.deepEqual(
    [...provider.propertyMappingIds].sort(),
    ['scope-email-1', 'scope-openid-1', 'scope-profile-1']
  );
  // Never touched: diffOAuth2Settings' patch structurally cannot carry a
  // credential field (FR-009/FR-011).
  const after = await authentik.getOAuth2Credentials('50');
  assert.equal(after.clientId, before.clientId);
  assert.equal(after.clientSecret, before.clientSecret);

  const bound = authentik.listPolicyBindingsForTest().filter((b) => b.targetId === app.pk);
  assert.deepEqual(
    bound.map((b) => b.groupId).sort(),
    [ids.get(USERS_RUNG)!, ids.get(ADMIN_RUNG)!].sort()
  );
});

test('a subsequent runSyncAuthentik treats the adopted client as owned and does nothing further', async () => {
  const authentik = handMadeAuthentik();
  await seedLadderGroups(authentik);
  await runAdoptOidcClient({ entry: 'media', apply: true }, { authentik, inventory: oidcInventory() });

  const callsBefore = authentik.calls.length;
  const okFetch = (async () =>
    new Response(JSON.stringify({ issuer: 'x' }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  const result = await runSyncAuthentik({}, { authentik, inventory: oidcInventory(), fetchImpl: okFetch });
  assert.deepEqual(result.oidcToCreate, []);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.adoptableConflicts, []);
  assert.deepEqual(result.oidcUpdates, [], 'adoption already fixed the drift, so the sync sees no further updates');
  assert.deepEqual(authentik.calls.slice(callsBefore), []);
});

test('refuses an unknown entry', async () => {
  const authentik = handMadeAuthentik();
  await assert.rejects(
    runAdoptOidcClient({ entry: 'does-not-exist' }, { authentik, inventory: oidcInventory() }),
    /Unknown entry: does-not-exist/
  );
});

test('refuses an entry that is not OIDC-effective', async () => {
  const authentik = handMadeAuthentik();
  await assert.rejects(
    runAdoptOidcClient({ entry: 'media' }, { authentik, inventory: oidcInventory({ authMode: undefined }) }),
    /not OIDC-gated/
  );
  await assert.rejects(
    runAdoptOidcClient({ entry: 'media' }, { authentik, inventory: oidcInventory({ authGroup: undefined, authMode: undefined }) }),
    /not OIDC-gated/
  );
});

test('refuses a slug with no Application', async () => {
  const authentik = new FakeAuthentikClient();
  await assert.rejects(
    runAdoptOidcClient({ entry: 'media' }, { authentik, inventory: oidcInventory() }),
    /sync-authentik --apply/
  );
});

test('refuses an already-owned Application (OAuth2-backed and marked)', async () => {
  const authentik = new FakeAuthentikClient({
    applications: [{ id: 'media', pk: 'pk-media', name: 'media', slug: 'media', providerId: '50', metaPublisher: 'bellhop' }],
    oauth2Providers: [
      {
        id: '50',
        name: 'media',
        assignedApplicationSlug: 'media',
        clientType: 'confidential',
        grantTypes: ['authorization_code', 'refresh_token'],
        signingKeyId: 'key-1',
        propertyMappingIds: [],
        redirectUris: [{ matchingMode: 'strict', url: OIDC_URIS[0] }],
      },
    ],
  });
  await assert.rejects(
    runAdoptOidcClient({ entry: 'media' }, { authentik, inventory: oidcInventory() }),
    /already Bellhop-owned/
  );
});

test('refuses an already-owned Application (proxy-backed -- the unchanged #154 rule)', async () => {
  const authentik = new FakeAuthentikClient({
    proxyProviders: [{ id: '50', name: 'media', externalHost: 'https://media.example.com' }],
    applications: [{ id: 'media', pk: 'pk-media', name: 'media', slug: 'media', providerId: '50' }],
  });
  await assert.rejects(
    runAdoptOidcClient({ entry: 'media' }, { authentik, inventory: oidcInventory() }),
    /already Bellhop-owned/
  );
});

test('refuses a non-OAuth2-backed Application', async () => {
  const authentik = new FakeAuthentikClient({
    applications: [{ id: 'media', pk: 'pk-media', name: 'media', slug: 'media', providerId: '99' }],
  });
  await assert.rejects(
    runAdoptOidcClient({ entry: 'media' }, { authentik, inventory: oidcInventory() }),
    /not backed by an OpenID \(OAuth2\) client/
  );
});

test('refuses when there are no callback URLs to adopt with, naming oidcRedirectUris', async () => {
  const authentik = handMadeAuthentik();
  await assert.rejects(
    runAdoptOidcClient({ entry: 'media' }, { authentik, inventory: oidcInventory({ oidcRedirectUris: undefined }) }),
    /oidcRedirectUris/
  );
});

test('refuses naming AUTHENTIK_OIDC_SIGNING_KEY_NAME when the signing key cannot be resolved', async () => {
  const authentik = handMadeAuthentik();
  authentik.getSigningKeyId = async () => {
    throw new Error('no key');
  };
  await assert.rejects(
    runAdoptOidcClient({ entry: 'media' }, { authentik, inventory: oidcInventory() }),
    /AUTHENTIK_OIDC_SIGNING_KEY_NAME/
  );
});

test('formatAdoptOidcClient lists meta_publisher, each drifted setting, and each binding change', () => {
  const text = formatAdoptOidcClient({
    entry: 'media',
    slug: 'media',
    settingsChanges: ['redirect_uris', 'grant_types'],
    bindingChanges: [
      { slug: 'media', group: 'bellhop-users', action: 'add' },
      { slug: 'media', group: 'authentik Admins', action: 'add' },
    ],
    applied: false,
  });
  assert.match(text, /meta_publisher -> bellhop/);
  assert.match(text, /~ redirect_uris/);
  assert.match(text, /~ grant_types/);
  assert.match(text, /\+ media -> bellhop-users/);
  assert.match(text, /\+ media -> authentik Admins/);
});
