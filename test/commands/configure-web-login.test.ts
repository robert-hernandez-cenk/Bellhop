import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadInventory, saveInventory, type Inventory } from '../../src/lib/inventory.ts';
import { configValueAt } from '../../src/lib/config.ts';
import { runConfigureWebLogin, formatConfigureWebLogin } from '../../src/commands/networking/configure-web-login.ts';
import { FakeAuthentikClient } from '../support/fake-authentik-client.ts';
import { UnconfiguredAuthentikClient, UNCONFIGURED_MESSAGE } from '../../src/lib/authentik-client.ts';
import { captureWarnings } from '../support/capture-warnings.ts';

// Bellhop's own entry: OIDC-gated, with the fixed /auth/callback URL.
function inventoryWith(overrides: Partial<Inventory['guests'][number]> = {}): Inventory {
  return {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', authentik: true, ip: '192.0.2.5' }],
    guests: [
      {
        name: 'bellhop',
        type: 'lxc',
        vmid: 130,
        host: 'pve1',
        ip: '192.0.2.30',
        subdomains: ['bellhop'],
        authGroup: 'bellhop-users',
        authMode: 'oidc',
        oidcRedirectUris: ['https://bellhop.example.com/auth/callback'],
        ...overrides,
      },
    ],
  };
}

function tempInventoryPath(inv: Inventory): string {
  const dest = path.join(mkdtempSync(path.join(tmpdir(), 'inventory-')), 'bellhop.db');
  saveInventory(dest, inv);
  return dest;
}

// FakeAuthentikClient's default credentials for provider 50 are
// client-50 / secret-50; the secret must never appear in any output.
function ownedAuthentik(): FakeAuthentikClient {
  return new FakeAuthentikClient({
    applications: [
      { id: 'bellhop', pk: 'pk-bellhop', name: 'bellhop', slug: 'bellhop', providerId: '50', metaPublisher: 'bellhop' },
    ],
    oauth2Providers: [
      {
        id: '50',
        name: 'bellhop',
        assignedApplicationSlug: 'bellhop',
        clientType: 'confidential',
        grantTypes: ['authorization_code', 'refresh_token'],
        signingKeyId: 'key-1',
        propertyMappingIds: ['scope-openid-1', 'scope-profile-1', 'scope-email-1', 'scope-offline-access-1'],
        redirectUris: [{ matchingMode: 'strict', url: 'https://bellhop.example.com/auth/callback' }],
      },
    ],
  });
}

const KEYS = ['webUiOidcIssuer', 'webUiOidcClientId', 'webUiOidcRedirectUri', 'webUiOidcClientSecret'] as const;

function assertNothingStored(inventoryPath: string): void {
  for (const key of KEYS) assert.equal(configValueAt(inventoryPath, key, {}).source, 'none', `${key} must not be stored`);
}

test('dry run prints the three values and a hidden secret, and writes nothing', async () => {
  const inventoryPath = tempInventoryPath(inventoryWith());
  const result = await runConfigureWebLogin(
    'bellhop',
    { apply: false },
    { authentik: ownedAuthentik(), inventory: inventoryWith(), inventoryPath }
  );
  assert.equal(result.applied, false);
  const text = formatConfigureWebLogin(result);
  assert.equal(
    text,
    [
      'Would store web login settings from bellhop (dry run -- pass --apply to write):',
      '  webUiOidcIssuer: https://auth.example.com/application/o/bellhop/',
      '  webUiOidcClientId: client-50',
      '  webUiOidcRedirectUri: https://bellhop.example.com/auth/callback',
      '  webUiOidcClientSecret: (would be set)',
    ].join('\n')
  );
  assert.ok(!text.includes('secret-50'));
  assertNothingStored(inventoryPath);
});

test('--apply stores all four settings, the secret through the secret store, and never prints the secret', async () => {
  const inventoryPath = tempInventoryPath(inventoryWith());
  const result = await runConfigureWebLogin(
    'bellhop',
    { apply: true },
    { authentik: ownedAuthentik(), inventory: inventoryWith(), inventoryPath }
  );
  assert.equal(result.applied, true);

  assert.equal(loadInventory(inventoryPath).webUiOidcIssuer, 'https://auth.example.com/application/o/bellhop/');
  assert.equal(configValueAt(inventoryPath, 'webUiOidcIssuer', {}).value, 'https://auth.example.com/application/o/bellhop/');
  assert.equal(configValueAt(inventoryPath, 'webUiOidcClientId', {}).value, 'client-50');
  assert.equal(configValueAt(inventoryPath, 'webUiOidcRedirectUri', {}).value, 'https://bellhop.example.com/auth/callback');
  assert.equal(configValueAt(inventoryPath, 'webUiOidcClientSecret', {}).value, 'secret-50');

  const text = formatConfigureWebLogin(result);
  assert.ok(!text.includes('secret-50'), 'the client secret is never printed');
  assert.ok(!JSON.stringify(result).includes('secret-50'), 'nor present in the returned result');
  assert.match(text, /^Stored web login settings from bellhop:/);
  assert.match(text, /webUiOidcClientSecret: \(set\)/);
  assert.match(
    text,
    /Next: sign in at https:\/\/bellhop\.example\.com\/auth\/login, then set webUiAuthMode to oidc \(Settings page or bellhop set-config webUiAuthMode oidc --apply\)\./
  );
});

test('--apply keeps unrelated stored settings', async () => {
  const inv = { ...inventoryWith(), dnsServer: '10.0.0.53' };
  const inventoryPath = tempInventoryPath(inv);
  await runConfigureWebLogin('bellhop', { apply: true }, { authentik: ownedAuthentik(), inventory: inv, inventoryPath });
  assert.equal(loadInventory(inventoryPath).dnsServer, '10.0.0.53');
});

test('an env-pinned key is stored anyway, with the same warning set-config prints', async () => {
  const inventoryPath = tempInventoryPath(inventoryWith());
  const before = process.env.WEB_UI_OIDC_ISSUER;
  process.env.WEB_UI_OIDC_ISSUER = 'https://pinned.example.com/';
  try {
    const { warnings } = await captureWarnings(() =>
      runConfigureWebLogin(
        'bellhop',
        { apply: true },
        { authentik: ownedAuthentik(), inventory: inventoryWith(), inventoryPath }
      )
    );
    assert.ok(
      warnings.some((w) => w.includes('WEB_UI_OIDC_ISSUER is set in this environment and overrides the stored webUiOidcIssuer')),
      `expected the env-pinned warning, got: ${JSON.stringify(warnings)}`
    );
    assert.ok(!warnings.some((w) => w.includes('secret-50')));
  } finally {
    if (before === undefined) delete process.env.WEB_UI_OIDC_ISSUER;
    else process.env.WEB_UI_OIDC_ISSUER = before;
  }
  assert.equal(loadInventory(inventoryPath).webUiOidcIssuer, 'https://auth.example.com/application/o/bellhop/');
});

test('an unknown entry fails and writes nothing', async () => {
  const inventoryPath = tempInventoryPath(inventoryWith());
  await assert.rejects(
    runConfigureWebLogin('nope', { apply: true }, { authentik: ownedAuthentik(), inventory: inventoryWith(), inventoryPath }),
    /Unknown entry: nope/
  );
  assertNothingStored(inventoryPath);
});

test('an entry that is not OIDC-gated fails and writes nothing', async () => {
  const inv = inventoryWith({ authMode: undefined });
  const inventoryPath = tempInventoryPath(inv);
  await assert.rejects(
    runConfigureWebLogin('bellhop', { apply: true }, { authentik: ownedAuthentik(), inventory: inv, inventoryPath }),
    /is not OIDC-gated/
  );
  assertNothingStored(inventoryPath);
});

test('no client yet names sync-authentik --apply and writes nothing', async () => {
  const inventoryPath = tempInventoryPath(inventoryWith());
  await assert.rejects(
    runConfigureWebLogin(
      'bellhop',
      { apply: true },
      { authentik: new FakeAuthentikClient(), inventory: inventoryWith(), inventoryPath }
    ),
    /sync-authentik --apply/
  );
  assertNothingStored(inventoryPath);
});

test('Authentik unconfigured fails with the unconfigured message and writes nothing', async () => {
  const inventoryPath = tempInventoryPath(inventoryWith());
  await assert.rejects(
    runConfigureWebLogin(
      'bellhop',
      { apply: true },
      { authentik: new UnconfiguredAuthentikClient(), inventory: inventoryWith(), inventoryPath }
    ),
    (err: Error) => err.message === UNCONFIGURED_MESSAGE
  );
  assertNothingStored(inventoryPath);
});

test('no redirect URI ending in /auth/callback fails with the contract message and writes nothing', async () => {
  const inv = inventoryWith({
    oidcRedirectUris: ['https://bellhop.example.com/oauth/callback', 'https://bellhop.example.com/auth/callback/extra'],
  });
  const inventoryPath = tempInventoryPath(inv);
  await assert.rejects(
    runConfigureWebLogin('bellhop', { apply: true }, { authentik: ownedAuthentik(), inventory: inv, inventoryPath }),
    (err: Error) =>
      err.message ===
      'bellhop has no callback URL ending in /auth/callback in oidcRedirectUris -- add https://<host>/auth/callback (Dashboard: Callback URLs), run sync-authentik --apply, then retry'
  );
  assertNothingStored(inventoryPath);
});

test('the redirect URI is picked by exact path, not by position', async () => {
  const inv = inventoryWith({
    oidcRedirectUris: ['https://bellhop.example.com/auth/callback/extra', 'https://bellhop.example.com/auth/callback'],
  });
  const inventoryPath = tempInventoryPath(inv);
  const result = await runConfigureWebLogin(
    'bellhop',
    { apply: false },
    { authentik: ownedAuthentik(), inventory: inv, inventoryPath }
  );
  assert.equal(result.redirectUri, 'https://bellhop.example.com/auth/callback');
});
