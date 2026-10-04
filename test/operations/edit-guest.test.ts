import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyGuestEdits, commitGuestEdit, runEditGuest, GuestEditValidationError } from '../../src/operations/edit-guest.ts';
import { FakeSSHClient, defaultResponder } from '../support/fake-ssh-client.ts';
import { UnconfiguredCloudflareClient } from '../../src/lib/cloudflare-client.ts';
import { FakeCloudflareClient, txtRecord } from '../support/fake-cloudflare-client.ts';
import { UnconfiguredAuthentikClient, type AuthentikClient } from '../../src/lib/authentik-client.ts';
import { FakeAuthentikClient } from '../support/fake-authentik-client.ts';
import { loadInventory, saveInventory, type Inventory } from '../../src/lib/inventory.ts';
import type { OperationDeps } from '../../src/operations/types.ts';
import { registerDriverForTests } from '../../src/lib/proxy/index.ts';
import type { ProxyPlan, ReverseProxyDriver } from '../../src/lib/proxy/driver.ts';
import type { ProxyDriverId } from '../../src/lib/proxy/ids.ts';
import { MOBILE_CONSENT_STAGE_NAME } from '../../src/commands/networking/sync-authentik.ts';

const inventory: Inventory = {
  domain: 'example.com',
  hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
  guests: [
    { name: 'caddy-lxc', type: 'lxc', vmid: 4002, host: 'pve1', ip: '192.168.1.2', proxy: true },
    { name: 'app-lxc', type: 'lxc', vmid: 4003, host: 'pve1', ip: '192.168.1.3' },
    { name: 'other-lxc', type: 'lxc', vmid: 4004, host: 'pve1', ip: '192.168.1.4', subdomains: ['taken'] },
  ],
};

function deps(ssh = new FakeSSHClient(defaultResponder)): OperationDeps {
  const inventoryPath = path.join(mkdtempSync(path.join(tmpdir(), 'editguest-')), 'bellhop.db');
  saveInventory(inventoryPath, inventory);
  return { ssh, inventory: loadInventory(inventoryPath), inventoryPath, authentik: new UnconfiguredAuthentikClient(), cloudflare: new UnconfiguredCloudflareClient() };
}

// --- Capability enforcement (issue #10, US3) -------------------------------
//
// A driver that declares no forward-auth support -- exercises FR-012's
// edit-time refusal path. `id` is cast through ProxyDriverId since
// PROXY_DRIVER_IDS only lists the shipped ids (src/lib/proxy/ids.ts);
// same convention as test/lib/proxy/{driver,index}.test.ts's own fakeDriver.
function oidcOnlyDriver(): ReverseProxyDriver {
  return {
    id: 'fake-oidc-only' as ProxyDriverId,
    label: 'Fake',
    capabilities: { authModes: ['oidc'], acmeDns01ViaCloudflare: () => false },
    defaultConfigPath: '/etc/fake/fake.conf',
    statusPage: null,
    async plan(): Promise<ProxyPlan> {
      return { preview: '', payload: undefined };
    },
    async apply(): Promise<void> {},
    async snapshot(): Promise<string> {
      return '';
    },
  };
}

// An inventory with: an Authentik outpost (auth-lxc), an ungated entry with
// no gate yet (sonarr, the one the tests below gate and then reject the
// edit on), an entry that is *already* forward-gated and unrelated to the
// edits under test (gated-other), and an entry with no subdomains at all
// (ungated-app, edited in the "different guest" test). Saved and loaded
// through a real temp bellhop.db exactly like deps() above.
const capabilityInventory: Inventory = {
  domain: 'example.com',
  hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', proxy: true }],
  guests: [
    { name: 'auth-lxc', type: 'lxc', vmid: 130, host: 'pve1', ip: '192.168.1.5', authentik: true },
    { name: 'sonarr', type: 'lxc', vmid: 120, host: 'pve1', ip: '192.168.1.20', subdomains: ['sonarr'] },
    {
      name: 'gated-other',
      type: 'lxc',
      vmid: 121,
      host: 'pve1',
      ip: '192.168.1.21',
      subdomains: ['radarr'],
      authGroup: 'bellhop-users',
    },
    { name: 'ungated-app', type: 'lxc', vmid: 122, host: 'pve1', ip: '192.168.1.22' },
  ],
};

// Builds OperationDeps against a fresh copy of capabilityInventory, loaded
// through loadInventory (which succeeds here -- proxyDriver is unset on
// disk, so it defaults to 'caddy', a schema-valid id -- FR-013), then points
// the in-memory object at the fake driver's id. That id is never persisted:
// PROXY_DRIVER_IDS only lists the shipped ids, so the schema would reject
// any other value on a real load -- this mutation happens strictly after
// loadInventory already returned successfully, which is exactly the
// distinction the brief draws between "a capability mismatch on a valid,
// registered driver" (FR-013's guarantee) and "an id no registered driver
// has" (a separate, schema-level misconfiguration, not tested here).
function capabilityDeps(driver: ReverseProxyDriver): OperationDeps {
  const inventoryPath = path.join(mkdtempSync(path.join(tmpdir(), 'editguest-capability-')), 'bellhop.db');
  saveInventory(inventoryPath, capabilityInventory);
  const loaded = loadInventory(inventoryPath); // must not throw -- FR-013
  loaded.proxyDriver = driver.id;
  return {
    ssh: new FakeSSHClient(defaultResponder),
    inventory: loaded,
    inventoryPath,
    authentik: new UnconfiguredAuthentikClient(),
    cloudflare: new UnconfiguredCloudflareClient(),
  };
}

test('loadInventory still loads an inventory containing a forward-gated entry, regardless of which driver capabilities later apply to it (FR-013)', () => {
  // No throw: loadInventory performs no capability check at all -- the
  // mismatch below is only ever detected by an explicit checkCapabilities
  // call (sync-proxy, commitGuestEdit), never by loading itself.
  const inventoryPath = path.join(mkdtempSync(path.join(tmpdir(), 'editguest-capability-load-')), 'bellhop.db');
  saveInventory(inventoryPath, capabilityInventory);
  const loaded = loadInventory(inventoryPath);
  assert.equal(loaded.guests.find((g) => g.name === 'gated-other')?.authGroup, 'bellhop-users');
  // Pointing the in-memory object at a driver that cannot enforce that
  // gate does not retroactively invalidate the load that already happened.
  loaded.proxyDriver = oidcOnlyDriver().id;
  assert.equal(loaded.proxyDriver, 'fake-oidc-only');
});

test('commitGuestEdit rejects an edit that leaves the edited guest forward-gated when the active driver cannot enforce forward-auth (FR-012), leaving the inventory file unchanged', async () => {
  const driver = oidcOnlyDriver();
  const unregister = registerDriverForTests(driver);
  try {
    const d = capabilityDeps(driver);
    const current = d.inventory.guests.find((g) => g.name === 'sonarr')!;
    const updated = applyGuestEdits(current, { authGroup: 'bellhop-users' });
    await assert.rejects(
      () => commitGuestEdit(d, 'sonarr', updated, false),
      (err: unknown) => {
        assert.ok(err instanceof GuestEditValidationError);
        assert.match(
          (err as Error).message,
          /Entry 'sonarr' uses forward-auth gating, but the 'fake-oidc-only' proxy driver cannot enforce it -- set its authMode to oidc or clear authGroup/
        );
        return true;
      }
    );
    assert.equal(loadInventory(d.inventoryPath).guests.find((g) => g.name === 'sonarr')?.authGroup, undefined);
  } finally {
    unregister();
  }
});

test('commitGuestEdit does not block an edit to a different, ungated guest even though an unrelated entry is forward-gated and the driver cannot enforce it', async () => {
  const driver = oidcOnlyDriver();
  const unregister = registerDriverForTests(driver);
  try {
    const d = capabilityDeps(driver);
    const current = d.inventory.guests.find((g) => g.name === 'ungated-app')!;
    const updated = applyGuestEdits(current, { subdomains: ['ungated'], port: 8080 });
    // Must not throw: the capability mismatch belongs to 'gated-other', an
    // entry this edit never touches. Checked against d.inventory (which
    // commitGuestEdit updates in place after saving) rather than a fresh
    // loadInventory(d.inventoryPath) call -- the saved file's proxyDriver is
    // the test-only fake id at this point (mutated in memory above, then
    // persisted verbatim by saveInventory's `{ ...inventory }` spread), which
    // InventorySchema's real enum would reject on a real reload; that's a
    // property of bypassing the schema this way in a test, not of
    // production behavior, where proxyDriver only ever reaches saveInventory
    // through a schema-validated setter.
    const result = await commitGuestEdit(d, 'ungated-app', updated, true);
    assert.deepEqual(d.inventory.guests.find((g) => g.name === 'ungated-app')?.subdomains, ['ungated']);
    // The unrelated mismatch is still real -- the whole-inventory push-live
    // step (which runs sync-proxy over every entry, 'gated-other' included)
    // legitimately fails on it, reported here as proxySynced: false rather
    // than as a rejection of this edit.
    assert.equal(result.proxySynced, false);
    if (!result.proxySynced) {
      assert.match(
        result.proxyError,
        /Entry 'gated-other' uses forward-auth gating, but the 'fake-oidc-only' proxy driver cannot enforce it/
      );
    }
  } finally {
    unregister();
  }
});

test('commitGuestEdit saves a port-only edit even when route derivation fails for an unrelated entry, reporting the failure as proxySynced:false', async () => {
  const inventoryPath = path.join(mkdtempSync(path.join(tmpdir(), 'editguest-unrelated-route-')), 'bellhop.db');
  saveInventory(inventoryPath, capabilityInventory);
  const loaded = loadInventory(inventoryPath);
  // An exempt-path value route derivation rejects, on an entry this edit
  // never touches. validateInventory() does not check path shapes (the
  // schema does, on load), so this reaches commitGuestEdit the way a
  // hand-edited row would reach sync-proxy.
  loaded.guests.find((g) => g.name === 'gated-other')!.unauthenticatedPaths = ['/api*'];
  const d: OperationDeps = {
    ssh: new FakeSSHClient(defaultResponder),
    inventory: loaded,
    inventoryPath,
    authentik: new UnconfiguredAuthentikClient(),
    cloudflare: new UnconfiguredCloudflareClient(),
  };
  const current = d.inventory.guests.find((g) => g.name === 'sonarr')!;
  const result = await commitGuestEdit(d, 'sonarr', applyGuestEdits(current, { port: 8989 }), false);
  // d.inventory, not a reload: the saved file carries the bad path too,
  // which loadInventory's schema would reject. commitGuestEdit only updates
  // d.inventory after saveInventory returns.
  assert.equal(d.inventory.guests.find((g) => g.name === 'sonarr')?.port, 8989);
  assert.equal(result.proxySynced, false);
  if (!result.proxySynced) {
    assert.match(result.proxyError, /Entry 'gated-other' has an invalid unauthenticatedPaths pattern '\/api\*'/);
  }
});

// --- HAProxy driver (issue #32, US2) -- forward-gated entries refused at edit time ---
//
// The real, registered 'haproxy' driver (capabilities: oidc only) -- no fake
// driver needed. Reuses capabilityInventory's ungated 'sonarr' (subdomains,
// no authGroup) and already forward-gated 'gated-other' (subdomains,
// authGroup set) entries, plus its 'auth-lxc' authentik outpost.

function haproxyCapabilityDeps(authentik: AuthentikClient = new UnconfiguredAuthentikClient()): OperationDeps {
  const inventoryPath = path.join(mkdtempSync(path.join(tmpdir(), 'editguest-haproxy-')), 'bellhop.db');
  saveInventory(inventoryPath, { ...capabilityInventory, proxyDriver: 'haproxy' });
  return {
    ssh: new FakeSSHClient(defaultResponder),
    inventory: loadInventory(inventoryPath),
    inventoryPath,
    authentik,
    cloudflare: new UnconfiguredCloudflareClient(),
  };
}

const HAPROXY_FORWARD_REFUSAL =
  "Entry 'sonarr' uses forward-auth gating, but the 'haproxy' proxy driver cannot enforce it -- set its authMode to oidc or clear authGroup";

test('commitGuestEdit rejects an edit that leaves the guest forward-gated with subdomains under the haproxy driver (US2), leaving the inventory unchanged', async () => {
  const d = haproxyCapabilityDeps();
  const current = d.inventory.guests.find((g) => g.name === 'sonarr')!;
  const updated = applyGuestEdits(current, { authGroup: 'bellhop-users' });
  await assert.rejects(
    () => commitGuestEdit(d, 'sonarr', updated, false),
    (err: unknown) => {
      assert.ok(err instanceof GuestEditValidationError);
      assert.equal((err as Error).message, HAPROXY_FORWARD_REFUSAL);
      return true;
    }
  );
  assert.equal(loadInventory(d.inventoryPath).guests.find((g) => g.name === 'sonarr')?.authGroup, undefined);
});

test('commitGuestEdit accepts switching the same guest to authMode: oidc under the haproxy driver, given a callback URL', async () => {
  const d = haproxyCapabilityDeps(new FakeAuthentikClient());
  const current = d.inventory.guests.find((g) => g.name === 'sonarr')!;
  const updated = applyGuestEdits(current, {
    authGroup: 'bellhop-users',
    authMode: 'oidc',
    oidcRedirectUris: ['https://web.example.com/callback'],
  });
  const result = await commitGuestEdit(d, 'sonarr', updated, false);
  assert.equal(result.guest.authMode, 'oidc');
  assert.equal(loadInventory(d.inventoryPath).guests.find((g) => g.name === 'sonarr')?.authMode, 'oidc');
});

test('commitGuestEdit accepts clearing authGroup on an already forward-gated guest under the haproxy driver', async () => {
  const d = haproxyCapabilityDeps();
  const current = d.inventory.guests.find((g) => g.name === 'gated-other')!;
  assert.equal(current.authGroup, 'bellhop-users');
  const updated = applyGuestEdits(current, { authGroup: null });
  const result = await commitGuestEdit(d, 'gated-other', updated, false);
  assert.equal(result.guest.authGroup, undefined);
  assert.equal(loadInventory(d.inventoryPath).guests.find((g) => g.name === 'gated-other')?.authGroup, undefined);
});

test('applyGuestEdits accepts form strings and typed arrays/numbers alike', () => {
  const current = inventory.guests[1];
  const fromForm = applyGuestEdits(current, { subdomains: 'app; app2', port: '8080' });
  const typed = applyGuestEdits(current, { subdomains: ['app', 'app2'], port: 8080 });
  assert.deepEqual(fromForm.subdomains, ['app', 'app2']);
  assert.equal(fromForm.port, 8080);
  assert.deepEqual(typed, fromForm);
});

test('applyGuestEdits sets proxyManual from the body', () => {
  const updated = applyGuestEdits(inventory.guests[1], { proxyManual: true });
  assert.equal(updated.proxyManual, true);
});

test('applyGuestEdits ignores the old caddyManual key (no alias)', () => {
  const updated = applyGuestEdits(inventory.guests[1], { caddyManual: true });
  assert.equal(updated.proxyManual, undefined);
  assert.ok(!('caddyManual' in updated));
});

// Issue #58, FR-009/T015/R7: applyGuestEdits only copies the fields it
// names -- 'creator' is deliberately not one of them, so a Dashboard PATCH
// or an MCP edit_guest call can never rewrite who's recorded as a guest's
// creator.
test('applyGuestEdits ignores a creator key, leaving the current creator untouched', () => {
  const current = { ...inventory.guests[1], creator: { username: 'test-user', uid: 'uid-test-user' } };
  const updated = applyGuestEdits(current, { creator: { username: 'other-user' }, port: 8080 });
  assert.deepEqual(updated.creator, { username: 'test-user', uid: 'uid-test-user' });
  assert.equal(updated.port, 8080);
});

test('runEditGuest ignores a creator key in the input, leaving the stored creator unchanged (FR-009)', async () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', proxy: true }],
    guests: [
      {
        name: 'web-lxc',
        type: 'lxc',
        vmid: 4010,
        host: 'pve1',
        ip: '192.168.1.10',
        creator: { username: 'test-user', uid: 'uid-test-user' },
      },
    ],
  };
  const inventoryPath = path.join(mkdtempSync(path.join(tmpdir(), 'editguest-creator-')), 'bellhop.db');
  saveInventory(inventoryPath, inv);
  const d: OperationDeps = {
    ssh: new FakeSSHClient(defaultResponder),
    inventory: loadInventory(inventoryPath),
    inventoryPath,
    authentik: new UnconfiguredAuthentikClient(),
    cloudflare: new UnconfiguredCloudflareClient(),
  };

  const result = await runEditGuest({ name: 'web-lxc', creator: { username: 'other-user' } }, d);
  assert.deepEqual(result.guest.creator, { username: 'test-user', uid: 'uid-test-user' });

  const saved = loadInventory(inventoryPath).guests.find((g) => g.name === 'web-lxc');
  assert.deepEqual(saved?.creator, { username: 'test-user', uid: 'uid-test-user' });
});

test('applyGuestEdits leaves untouched fields alone and clears authGroup on null', () => {
  const updated = applyGuestEdits({ ...inventory.guests[1], authGroup: 'bellhop-users', port: 80 }, { authGroup: null });
  assert.equal(updated.authGroup, undefined);
  assert.equal(updated.port, 80);
});

// issue #10, US4/T038: a guest edit rejects the same invalid
// unauthenticatedPaths forms the schema rejects (test/lib/inventory.test.ts)
// and parsePathPattern rejects (test/lib/proxy/routes.test.ts) -- all three
// must agree.
test('applyGuestEdits accepts /health and /api/* for unauthenticatedPaths', () => {
  const withHealth = applyGuestEdits(inventory.guests[1], { unauthenticatedPaths: '/health' });
  assert.deepEqual(withHealth.unauthenticatedPaths, ['/health']);
  const withPrefix = applyGuestEdits(inventory.guests[1], { unauthenticatedPaths: '/api/*' });
  assert.deepEqual(withPrefix.unauthenticatedPaths, ['/api/*']);
});

test('applyGuestEdits rejects a star anywhere but a trailing /* for unauthenticatedPaths, naming both accepted forms', () => {
  for (const bad of ['/a*b', '*/x', '/api*', '/*/x', '/a/*/b']) {
    assert.throws(
      () => applyGuestEdits(inventory.guests[1], { unauthenticatedPaths: bad }),
      /must be an exact path \(\/health\) or a prefix ending in \/\* \(\/api\/\*\)/
    );
  }
});

test('runEditGuest saves, pushes the proxy live, and reports the result', async () => {
  const d = deps();
  const result = await runEditGuest({ name: 'app-lxc', subdomains: ['app'], port: 8080 }, d);
  assert.equal(result.proxySynced, true);
  assert.deepEqual(loadInventory(d.inventoryPath).guests.find((g) => g.name === 'app-lxc')?.subdomains, ['app']);
  assert.deepEqual(d.inventory.guests.find((g) => g.name === 'app-lxc')?.subdomains, ['app']);
});

// runEditGuest is what the MCP server's edit-guest tool calls; this proves
// its OperationDeps.cloudflare actually reaches syncProxyLive's prune (#162)
// rather than being dropped and silently treated as unconfigured.
test('runEditGuest prunes stale _acme-challenge records through deps.cloudflare', async () => {
  const cloudflare = new FakeCloudflareClient({
    zones: { 'example.com': 'zone-1' },
    records: [txtRecord('old', '_acme-challenge.renamed.example.com', '2020-01-01T00:00:00.000000Z')],
  });
  const d = { ...deps(), cloudflare };
  const result = await runEditGuest({ name: 'app-lxc', subdomains: ['app'], port: 8080 }, d);
  assert.equal(result.proxySynced, true);
  assert.deepEqual(cloudflare.records, []);
});

test('runEditGuest rejects a duplicate subdomain without saving', async () => {
  const d = deps();
  await assert.rejects(runEditGuest({ name: 'app-lxc', subdomains: 'taken' }, d), GuestEditValidationError);
  assert.equal(loadInventory(d.inventoryPath).guests.find((g) => g.name === 'app-lxc')?.subdomains, undefined);
});

test('runEditGuest reports an unknown guest', async () => {
  await assert.rejects(runEditGuest({ name: 'nope' }, deps()), /Unknown guest: nope/);
});

// Native OIDC gating (issue #1, unit U6): authMode/oidcRedirectUris parsing
// and the write-level "OIDC needs a callback URL" rule.

test('applyGuestEdits parses authMode and oidcRedirectUris from form strings and typed arrays alike', () => {
  const current = inventory.guests[1];
  const fromForm = applyGuestEdits(current, {
    authMode: 'oidc',
    oidcRedirectUris: 'https://app.example.com/cb1; https://app.example.com/cb2',
  });
  const typed = applyGuestEdits(current, {
    authMode: 'oidc',
    oidcRedirectUris: ['https://app.example.com/cb1', 'https://app.example.com/cb2'],
  });
  assert.equal(fromForm.authMode, 'oidc');
  assert.deepEqual(fromForm.oidcRedirectUris, ['https://app.example.com/cb1', 'https://app.example.com/cb2']);
  assert.deepEqual(typed, fromForm);
});

test('applyGuestEdits clears authMode to forward on null/empty', () => {
  const updated = applyGuestEdits({ ...inventory.guests[1], authMode: 'oidc' }, { authMode: null });
  assert.equal(updated.authMode, undefined);
});

test('runEditGuest rejects an OIDC-effective edit with subdomains and no redirect URIs, naming the field', async () => {
  const d = deps();
  await assert.rejects(
    runEditGuest({ name: 'other-lxc', authGroup: 'bellhop-users', authMode: 'oidc' }, d),
    (err: unknown) => err instanceof GuestEditValidationError && /oidcRedirectUris/.test((err as Error).message)
  );
  assert.equal(loadInventory(d.inventoryPath).guests.find((g) => g.name === 'other-lxc')?.authMode, undefined);
});

test('runEditGuest accepts an OIDC-effective edit once a redirect URI is set', async () => {
  const d = { ...deps(), authentik: new FakeAuthentikClient() };
  const result = await runEditGuest(
    { name: 'other-lxc', authGroup: 'bellhop-users', authMode: 'oidc', oidcRedirectUris: ['https://taken.example.com/cb'] },
    d
  );
  assert.equal(result.guest.authMode, 'oidc');
  assert.deepEqual(result.guest.oidcRedirectUris, ['https://taken.example.com/cb']);
});

// runEditGuest's OperationDeps.fetchImpl reaches syncProxyLive's post-apply
// OIDC discovery check (same plumbing proven for deps.cloudflare above), and
// the result is scoped to the edited guest only, omitted when empty.
test('runEditGuest carries oidcDiscoveryFailures scoped to the edited guest, omitted when empty', async () => {
  const failFetch = (async () => new Response('bad gateway', { status: 502 })) as typeof fetch;
  const d = { ...deps(), authentik: new FakeAuthentikClient(), fetchImpl: failFetch };
  const result = await runEditGuest(
    { name: 'app-lxc', subdomains: ['app'], authGroup: 'bellhop-users', authMode: 'oidc', oidcRedirectUris: ['https://app.example.com/cb'] },
    d
  );
  assert.equal(result.proxySynced, true);
  assert.ok('oidcDiscoveryFailures' in result);
  assert.deepEqual((result as { oidcDiscoveryFailures?: { slug: string }[] }).oidcDiscoveryFailures?.map((f) => f.slug), ['app']);
});

test('runEditGuest omits oidcDiscoveryFailures when the discovery check passes', async () => {
  const okFetch = (async () => new Response('{}', { status: 200 })) as typeof fetch;
  const d = { ...deps(), authentik: new FakeAuthentikClient(), fetchImpl: okFetch };
  const result = await runEditGuest(
    { name: 'app-lxc', subdomains: ['app'], authGroup: 'bellhop-users', authMode: 'oidc', oidcRedirectUris: ['https://app.example.com/cb'] },
    d
  );
  assert.equal(result.proxySynced, true);
  assert.equal('oidcDiscoveryFailures' in result, false);
});

// T032 (FR-022a, research R8): an edit that takes an entry out of effective
// OIDC gating deletes its OpenID client on the next sync, so it needs an
// explicit confirmation. Decided from the inventory alone.

const OIDC_GUEST = {
  name: 'media-lxc',
  type: 'lxc' as const,
  vmid: 4005,
  host: 'pve1',
  ip: '192.168.1.5',
  subdomains: ['media'],
  authGroup: 'bellhop-users',
  authMode: 'oidc' as const,
  oidcRedirectUris: ['https://media.example.com/cb'],
};

function oidcDeps(): OperationDeps {
  const inventoryPath = path.join(mkdtempSync(path.join(tmpdir(), 'editguest-oidc-')), 'bellhop.db');
  saveInventory(inventoryPath, {
    ...inventory,
    hosts: inventory.hosts.map((h) => ({ ...h, authentik: true, ip: '192.168.1.10' })),
    guests: [...inventory.guests, OIDC_GUEST],
  });
  return {
    ssh: new FakeSSHClient(defaultResponder),
    inventory: loadInventory(inventoryPath),
    inventoryPath,
    authentik: new UnconfiguredAuthentikClient(),
    cloudflare: new UnconfiguredCloudflareClient(),
  };
}

const CONFIRMATION_ERROR =
  "This edit deletes the app's OpenID client, so its OIDC login stops working until new credentials are entered in the app. Resend with confirmOidcClientDeletion: true to confirm.";

for (const [label, edit] of [
  ['switching to forward-auth', { authMode: 'forward' }],
  ['clearing authMode', { authMode: null }],
  ['clearing authGroup', { authGroup: null }],
] as const) {
  test(`runEditGuest: ${label} on an OIDC-effective entry needs confirmOidcClientDeletion: true`, async () => {
    for (const confirm of [undefined, false]) {
      const d = oidcDeps();
      await assert.rejects(
        runEditGuest({ name: 'media-lxc', ...edit, ...(confirm === undefined ? {} : { confirmOidcClientDeletion: confirm }) }, d),
        (err: unknown) => err instanceof GuestEditValidationError && (err as Error).message === CONFIRMATION_ERROR
      );
      const saved = loadInventory(d.inventoryPath).guests.find((g) => g.name === 'media-lxc')!;
      assert.equal(saved.authMode, 'oidc', 'nothing is saved without confirmation');
      assert.equal(saved.authGroup, 'bellhop-users');
    }

    const d = oidcDeps();
    const result = await runEditGuest({ name: 'media-lxc', ...edit, confirmOidcClientDeletion: true }, d);
    assert.equal('confirmOidcClientDeletion' in result.guest, false, 'the flag is not an inventory field');
    const saved = loadInventory(d.inventoryPath).guests.find((g) => g.name === 'media-lxc')!;
    assert.equal('confirmOidcClientDeletion' in saved, false);
    assert.notEqual(saved.authMode === 'oidc' && Boolean(saved.authGroup), true, 'the entry left OIDC gating');
  });
}

test('runEditGuest: edits that keep or enter OIDC gating never need confirmOidcClientDeletion', async () => {
  // A port change and a tier change on an OIDC entry stay OIDC.
  await runEditGuest({ name: 'media-lxc', port: 8080 }, oidcDeps());
  await runEditGuest({ name: 'media-lxc', authGroup: 'bellhop-app-users' }, oidcDeps());
  await runEditGuest({ name: 'media-lxc', oidcRedirectUris: ['https://media.example.com/cb2'] }, oidcDeps());
  // Entering OIDC, and forward/ungated edits, never delete an OpenID client.
  await runEditGuest(
    { name: 'app-lxc', subdomains: ['app'], authGroup: 'bellhop-users', authMode: 'oidc', oidcRedirectUris: ['https://app.example.com/cb'] },
    oidcDeps()
  );
  await runEditGuest({ name: 'app-lxc', subdomains: ['app'], authGroup: 'bellhop-users' }, oidcDeps());
  // Mode 'oidc' without a tier was never OIDC-effective, so clearing it needs nothing.
  const d = oidcDeps();
  await runEditGuest({ name: 'media-lxc', authGroup: null, confirmOidcClientDeletion: true }, d);
  await runEditGuest({ name: 'media-lxc', authMode: null }, d);
});

// T005 (issue #22): oidcMobileRedirectUris wired through applyGuestEdits and
// commitGuestEdit's oidcConfigErrors cross-list check, mirroring the
// authMode/oidcRedirectUris tests above.

test('applyGuestEdits parses oidcMobileRedirectUris from a form string and a typed array alike', () => {
  const current = inventory.guests[1];
  const fromForm = applyGuestEdits(current, {
    oidcMobileRedirectUris: 'com.example.app://callback1; com.example.app://callback2',
  });
  const typed = applyGuestEdits(current, {
    oidcMobileRedirectUris: ['com.example.app://callback1', 'com.example.app://callback2'],
  });
  assert.deepEqual(fromForm.oidcMobileRedirectUris, ['com.example.app://callback1', 'com.example.app://callback2']);
  assert.deepEqual(typed, fromForm);
});

test('applyGuestEdits rejects a javascript: oidcMobileRedirectUris entry, naming it', () => {
  const current = inventory.guests[1];
  assert.throws(() => applyGuestEdits(current, { oidcMobileRedirectUris: 'javascript:alert(1)' }), /javascript:alert\(1\)/);
});

test('applyGuestEdits clears oidcMobileRedirectUris on an empty string', () => {
  const updated = applyGuestEdits(
    { ...inventory.guests[1], oidcMobileRedirectUris: ['com.example.app://cb'] },
    { oidcMobileRedirectUris: '' }
  );
  assert.equal(updated.oidcMobileRedirectUris, undefined);
});

test('runEditGuest rejects a mobile redirect URI that duplicates a web callback URL, naming the field', async () => {
  const d = deps();
  await assert.rejects(
    runEditGuest(
      {
        name: 'other-lxc',
        authGroup: 'bellhop-users',
        authMode: 'oidc',
        oidcRedirectUris: ['https://taken.example.com/cb'],
        oidcMobileRedirectUris: ['https://taken.example.com/cb'],
      },
      d
    ),
    (err: unknown) => err instanceof GuestEditValidationError && /oidcMobileRedirectUris/.test((err as Error).message)
  );
  assert.equal(loadInventory(d.inventoryPath).guests.find((g) => g.name === 'other-lxc')?.oidcMobileRedirectUris, undefined);
});

test('runEditGuest accepts a distinct oidcMobileRedirectUris list alongside oidcRedirectUris', async () => {
  const d = { ...deps(), authentik: new FakeAuthentikClient() };
  const result = await runEditGuest(
    {
      name: 'other-lxc',
      authGroup: 'bellhop-users',
      authMode: 'oidc',
      oidcRedirectUris: ['https://taken.example.com/cb'],
      oidcMobileRedirectUris: ['com.example.app://callback'],
    },
    d
  );
  assert.deepEqual(result.guest.oidcMobileRedirectUris, ['com.example.app://callback']);
});

// Final review F3 (#22): the mobile consent step's conflicts/errors are
// instance-wide, but the admin who just saved a mobile redirect URI needs to
// see them -- the Dashboard PATCH runs outside any job, so a logWarn alone
// never reaches them. Echoed only when this edit changed the mobile list.

const FOREIGN_CONSENT_STAGE = { id: '600', name: MOBILE_CONSENT_STAGE_NAME, model: 'authentik_stages_prompt.promptstage' };
const FOREIGN_STAGE_CONFLICT = `stage '${MOBILE_CONSENT_STAGE_NAME}' exists but is not a consent stage Bellhop created — rename or delete it in Authentik`;

test('runEditGuest echoes mobile consent problems when the edit changed oidcMobileRedirectUris', async () => {
  const d = { ...oidcDeps(), authentik: new FakeAuthentikClient({ stages: [FOREIGN_CONSENT_STAGE] }) };
  const result = await runEditGuest({ name: 'media-lxc', oidcMobileRedirectUris: ['app.example:///oauth-callback'] }, d);
  assert.equal(result.proxySynced, true);
  assert.deepEqual((result as { mobileConsentProblems?: string[] }).mobileConsentProblems, [FOREIGN_STAGE_CONFLICT]);
});

test('runEditGuest omits mobile consent problems when the edit did not change oidcMobileRedirectUris', async () => {
  const base = oidcDeps();
  const stored = base.inventory.guests.map((g) =>
    g.name === 'media-lxc' ? { ...g, oidcMobileRedirectUris: ['app.example:///oauth-callback'] } : g
  );
  saveInventory(base.inventoryPath, { ...base.inventory, guests: stored });
  const d = {
    ...base,
    inventory: loadInventory(base.inventoryPath),
    authentik: new FakeAuthentikClient({ stages: [FOREIGN_CONSENT_STAGE] }),
  };
  // Resending the same list counts as unchanged too.
  for (const edit of [{ port: 8080 }, { oidcMobileRedirectUris: ['app.example:///oauth-callback'] }]) {
    const result = await runEditGuest({ name: 'media-lxc', ...edit }, d);
    assert.equal(result.proxySynced, true);
    assert.equal('mobileConsentProblems' in result, false);
  }
});

// Final review F10 (#22): a web/mobile duplicate already in the database
// must not block an unrelated later edit; only an edit touching either list
// is refused over it.

function duplicateDeps(): OperationDeps {
  const base = oidcDeps();
  const stored = base.inventory.guests.map((g) =>
    g.name === 'media-lxc' ? { ...g, oidcMobileRedirectUris: ['https://media.example.com/cb'] } : g
  );
  saveInventory(base.inventoryPath, { ...base.inventory, guests: stored });
  return { ...base, inventory: loadInventory(base.inventoryPath) };
}

test('runEditGuest saves a port edit on an entry with a stored web/mobile duplicate', async () => {
  const d = duplicateDeps();
  const result = await runEditGuest({ name: 'media-lxc', port: 8080 }, d);
  assert.equal(result.guest.port, 8080);
  assert.equal(loadInventory(d.inventoryPath).guests.find((g) => g.name === 'media-lxc')?.port, 8080);
});

test('runEditGuest still refuses an edit to either list that leaves a web/mobile duplicate', async () => {
  for (const edit of [
    { oidcRedirectUris: ['https://media.example.com/cb', 'https://media.example.com/cb2'] },
    { oidcMobileRedirectUris: ['https://media.example.com/cb', 'app.example:///oauth-callback'] },
  ]) {
    await assert.rejects(
      runEditGuest({ name: 'media-lxc', ...edit }, duplicateDeps()),
      (err: unknown) => err instanceof GuestEditValidationError && /oidcMobileRedirectUris/.test((err as Error).message)
    );
  }
});
