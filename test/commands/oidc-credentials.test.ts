import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Inventory } from '../../src/lib/inventory.ts';
import { runOidcCredentials, formatOidcCredentials } from '../../src/commands/networking/oidc-credentials.ts';
import { FakeAuthentikClient } from '../support/fake-authentik-client.ts';
import { UnconfiguredAuthentikClient, UNCONFIGURED_MESSAGE } from '../../src/lib/authentik-client.ts';

// Mirrors sync-authentik.test.ts's own oidcInventory helper -- same slug,
// rung, and redirect URI shape, since these tests only care about entry
// resolution and ownership, not sync-authentik's own planning logic.
function oidcInventory(overrides: Partial<Inventory['guests'][number]> = {}): Inventory {
  return {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', ip: '192.0.2.5' }],
    guests: [
      {
        name: 'media',
        type: 'lxc',
        vmid: 130,
        host: 'pve1',
        ip: '192.0.2.30',
        subdomains: ['media'],
        authGroup: 'bellhop-users',
        authMode: 'oidc',
        oidcRedirectUris: ['https://media.example.com/oauth/callback'],
        ...overrides,
      },
    ],
  };
}

// An owned OpenID client for the 'media' slug -- the FakeAuthentikClient
// default clientId/clientSecret ('client-50'/'secret-50') is what the
// "never logged" assertion in the web route test greps for.
function ownedAuthentik(): FakeAuthentikClient {
  return new FakeAuthentikClient({
    applications: [{ id: 'media', pk: 'pk-media', name: 'media', slug: 'media', providerId: '50', metaPublisher: 'bellhop' }],
    oauth2Providers: [
      {
        id: '50',
        name: 'media',
        assignedApplicationSlug: 'media',
        clientType: 'confidential',
        grantTypes: ['authorization_code', 'refresh_token'],
        signingKeyId: 'key-1',
        propertyMappingIds: ['scope-openid-1', 'scope-profile-1', 'scope-email-1'],
        redirectUris: [{ matchingMode: 'strict', url: 'https://media.example.com/oauth/callback' }],
      },
    ],
  });
}

test('runOidcCredentials returns issuer/clientId/clientSecret for an owned client', async () => {
  const authentik = ownedAuthentik();
  const result = await runOidcCredentials('media', { authentik, inventory: oidcInventory() });
  assert.equal(result.issuer, 'https://auth.example.com/application/o/media/');
  assert.equal(result.clientId, 'client-50');
  assert.equal(result.clientSecret, 'secret-50');
});

test('runOidcCredentials throws naming sync-authentik --apply when no owned client exists yet', async () => {
  const authentik = new FakeAuthentikClient();
  await assert.rejects(
    runOidcCredentials('media', { authentik, inventory: oidcInventory() }),
    /sync-authentik --apply/
  );
});

test('runOidcCredentials throws for an unknown entry', async () => {
  const authentik = ownedAuthentik();
  await assert.rejects(
    runOidcCredentials('does-not-exist', { authentik, inventory: oidcInventory() }),
    /Unknown entry: does-not-exist/
  );
});

test('runOidcCredentials throws for an entry that is not OIDC-effective', async () => {
  const authentik = ownedAuthentik();
  // authMode left at its default ('forward') -- effectiveAuth is 'forward',
  // not 'oidc', even though authGroup is set.
  const forward = oidcInventory({ authMode: undefined });
  await assert.rejects(runOidcCredentials('media', { authentik, inventory: forward }), /not OIDC-gated/);

  // authGroup unset entirely -- effectiveAuth is 'ungated' regardless of authMode.
  const ungated = oidcInventory({ authGroup: undefined });
  await assert.rejects(runOidcCredentials('media', { authentik, inventory: ungated }), /not OIDC-gated/);
});

test('runOidcCredentials throws naming adopt-oidc-client for an unowned (conflict) Application', async () => {
  // Same slug, but the Application has no meta_publisher marker -- a
  // hand-created OpenID client, not Bellhop's (research.md R1).
  const authentik = new FakeAuthentikClient({
    applications: [{ id: 'media', pk: 'pk-media', name: 'media', slug: 'media', providerId: '50' }],
    oauth2Providers: [
      {
        id: '50',
        name: 'media',
        assignedApplicationSlug: 'media',
        clientType: 'confidential',
        grantTypes: ['authorization_code'],
        propertyMappingIds: [],
        redirectUris: [],
      },
    ],
  });
  await assert.rejects(
    runOidcCredentials('media', { authentik, inventory: oidcInventory() }),
    /adopt-oidc-client/
  );
});

test('runOidcCredentials says a non-OAuth2-backed conflict is not adoptable, not "run adopt-oidc-client"', async () => {
  // providerId '99' matches neither the fake's (empty) proxyProviders nor
  // oauth2Providers list -- the data-model.md "conflict, not adoptable"
  // ownership state (exists, other-or-none provider).
  const authentik = new FakeAuthentikClient({
    applications: [{ id: 'media', pk: 'pk-media', name: 'media', slug: 'media', providerId: '99' }],
  });
  await assert.rejects(runOidcCredentials('media', { authentik, inventory: oidcInventory() }), (err: Error) => {
    assert.match(err.message, /not adoptable/);
    assert.doesNotMatch(err.message, /adopt-oidc-client/);
    return true;
  });
});

test('runOidcCredentials propagates the unconfigured error', async () => {
  const authentik = new UnconfiguredAuthentikClient();
  await assert.rejects(
    runOidcCredentials('media', { authentik, inventory: oidcInventory() }),
    new RegExp(UNCONFIGURED_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  );
});

test('formatOidcCredentials matches the documented CLI layout', () => {
  const text = formatOidcCredentials({
    issuer: 'https://auth.example.com/application/o/media/',
    clientId: 'client-id-value',
    clientSecret: 'client-secret-value',
  });
  assert.equal(
    text,
    [
      'Issuer:        https://auth.example.com/application/o/media/',
      'Client ID:     client-id-value',
      'Client secret: client-secret-value',
    ].join('\n')
  );
});
