import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Inventory } from '../../../src/lib/inventory.ts';
import {
  configureManagedWebLogin,
  refreshManagedWebLogin,
  managedWebLogin,
  managedWebLoginProblem,
  resetManagedWebLogin,
} from '../../../src/web/login/managed.ts';
import {
  bellhopInventory as inventoryWith,
  MANAGED_SECRET as SECRET,
  MANAGED_CLIENT_ID,
  MANAGED_ISSUER,
  MANAGED_REDIRECT_URI,
  RotatableAuthentik,
  ownedAuthentik,
} from '../../support/managed-login.ts';
import { captureWarnings } from '../../support/capture-warnings.ts';

function setup(inventory: Inventory, authentik = ownedAuthentik()) {
  const state = { inventory };
  configureManagedWebLogin({ inventory: () => state.inventory, authentik });
  return { state, authentik };
}

beforeEach(() => resetManagedWebLogin());

test('a qualifying flagged guest resolves to that guest\'s OpenID client', async () => {
  setup(inventoryWith());
  await refreshManagedWebLogin();
  assert.deepEqual(managedWebLogin(), {
    entry: 'bellhop-lxc',
    issuer: MANAGED_ISSUER,
    clientId: MANAGED_CLIENT_ID,
    clientSecret: SECRET,
    redirectUri: 'https://bellhop.example.com/auth/callback',
  });
  assert.equal(managedWebLoginProblem(), undefined);
});

test('the callback is the entry\'s URL whose path is exactly /auth/callback', async () => {
  setup(inventoryWith({ oidcRedirectUris: ['https://bellhop.example.com/auth/callback/extra', 'https://bellhop.example.com/auth/callback'] }));
  await refreshManagedWebLogin();
  assert.equal(managedWebLogin()?.redirectUri, 'https://bellhop.example.com/auth/callback');
});

test('nothing resolves, with a fixed reason, when no guest is flagged', async () => {
  setup(inventoryWith({ bellhop: undefined }));
  await refreshManagedWebLogin();
  assert.equal(managedWebLogin(), undefined);
  assert.equal(managedWebLoginProblem(), 'No guest is flagged as Bellhop');
});

test('nothing resolves when the flagged guest is not OIDC-gated', async () => {
  setup(inventoryWith({ authMode: 'forward' }));
  await refreshManagedWebLogin();
  assert.equal(managedWebLogin(), undefined);
  assert.equal(managedWebLoginProblem(), 'bellhop-lxc is not OIDC-gated (set an auth group and OIDC mode)');
});

test('nothing resolves when the flagged guest has no callback ending in /auth/callback', async () => {
  setup(inventoryWith({ oidcRedirectUris: ['https://bellhop.example.com/auth/callback/extra'] }));
  await refreshManagedWebLogin();
  assert.equal(managedWebLogin(), undefined);
  assert.equal(managedWebLoginProblem(), 'bellhop-lxc has no callback URL ending in /auth/callback');
});

test('a callback that is http on a non-loopback host is refused, like the custom redirect URI setting', async () => {
  setup(inventoryWith({ oidcRedirectUris: ['http://bellhop.example.com/auth/callback'] }));
  await refreshManagedWebLogin();
  assert.equal(managedWebLogin(), undefined);
  assert.match(managedWebLoginProblem() ?? '', /^bellhop-lxc's callback URL is not usable: /);
});

test('nothing resolves when the guest has no OpenID client in Authentik yet', async () => {
  setup(inventoryWith(), new RotatableAuthentik());
  await refreshManagedWebLogin();
  assert.equal(managedWebLogin(), undefined);
  assert.match(managedWebLoginProblem() ?? '', /No Bellhop-owned OpenID client exists yet for bellhop-lxc/);
});

test('a rotated secret is picked up by the next refresh, with no restart', async () => {
  const { authentik } = setup(inventoryWith());
  await refreshManagedWebLogin();
  authentik.secret = 'rotated-secret';
  await refreshManagedWebLogin();
  assert.equal(managedWebLogin()?.clientSecret, 'rotated-secret');
});

test('an unreachable Authentik keeps the last good value and says so', async () => {
  const { authentik } = setup(inventoryWith());
  await refreshManagedWebLogin();
  authentik.unreachable = true;
  const { warnings } = await captureWarnings(() => refreshManagedWebLogin());
  assert.equal(managedWebLogin()?.clientSecret, SECRET, 'the last good value stays in use');
  assert.equal(managedWebLoginProblem(), 'Authentik could not be reached');
  assert.ok(
    warnings.some((w) => w.includes('Managed web login for bellhop-lxc could not be refreshed') && w.includes('keeping the last resolved client')),
    'the failure is logged'
  );
});

test('an unreachable Authentik with no earlier value resolves nothing and says why', async () => {
  const { authentik } = setup(inventoryWith());
  authentik.unreachable = true;
  await captureWarnings(() => refreshManagedWebLogin());
  assert.equal(managedWebLogin(), undefined);
  assert.equal(managedWebLoginProblem(), 'Authentik could not be reached');
});

test('un-flagging the guest clears a previously resolved value on the next refresh', async () => {
  const { state } = setup(inventoryWith());
  await refreshManagedWebLogin();
  assert.ok(managedWebLogin());
  state.inventory = inventoryWith({ bellhop: undefined });
  await refreshManagedWebLogin();
  assert.equal(managedWebLogin(), undefined);
});

test('a successful refresh clears an earlier problem', async () => {
  const { authentik } = setup(inventoryWith());
  authentik.unreachable = true;
  await captureWarnings(() => refreshManagedWebLogin());
  authentik.unreachable = false;
  await refreshManagedWebLogin();
  assert.equal(managedWebLoginProblem(), undefined);
  assert.ok(managedWebLogin());
});

test('refresh before the module is configured does nothing and does not throw', async () => {
  await refreshManagedWebLogin();
  assert.equal(managedWebLogin(), undefined);
});

test('concurrent refreshes share one lookup', async () => {
  const { authentik } = setup(inventoryWith());
  let lookups = 0;
  const original = authentik.listApplications.bind(authentik);
  authentik.listApplications = async (...args) => {
    lookups++;
    return original(...args);
  };
  await Promise.all([refreshManagedWebLogin(), refreshManagedWebLogin(), refreshManagedWebLogin()]);
  assert.equal(lookups, 1);
});

test('the secret never appears in a problem text or a log line', async () => {
  const { authentik } = setup(inventoryWith());
  const seen: string[] = [];
  const collect = async () => {
    const { warnings } = await captureWarnings(() => refreshManagedWebLogin());
    seen.push(...warnings, managedWebLoginProblem() ?? '');
  };
  await collect(); // success
  authentik.unreachable = true;
  await collect(); // unreachable with a good value held
  authentik.unreachable = false;
  const state = { oidcRedirectUris: ['https://bellhop.example.com/other'] };
  configureManagedWebLogin({ inventory: () => inventoryWith(state), authentik });
  await collect(); // no callback
  for (const text of seen) assert.ok(!text.includes(SECRET), `leaked the secret: ${text}`);
});
