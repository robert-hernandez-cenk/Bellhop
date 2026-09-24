import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Inventory } from '../../src/lib/inventory.ts';
import {
  runSyncAuthentik,
  formatSyncAuthentik,
  syncAuthentikFailed,
  ownedProviderKind,
  diffOAuth2Settings,
} from '../../src/commands/networking/sync-authentik.ts';
import { authentikConfig } from '../../src/lib/authentik-config.ts';
import { FakeAuthentikClient } from '../support/fake-authentik-client.ts';

const LADDER = authentikConfig().groupLadder; // low -> high
const [OPEN_RUNG, APP_RUNG, USERS_RUNG, ADMIN_RUNG] = LADDER;

const gatedInventory: Inventory = {
  domain: 'example.com',
  hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', authentik: true, ip: '192.168.1.5' }],
  guests: [
    { name: 'sonarr', type: 'lxc', vmid: 120, host: 'pve1', ip: '192.168.1.20', subdomains: ['sonarr'], authGroup: USERS_RUNG },
    { name: 'plex', type: 'lxc', vmid: 121, host: 'pve1', ip: '192.168.1.21', subdomains: ['plex'] },
  ],
};

// Every rung as a real Authentik group, so a test that is not about a
// missing rung never trips over one.
async function seedLadderGroups(authentik: FakeAuthentikClient): Promise<Map<string, string>> {
  const byName = new Map<string, string>();
  for (const rung of LADDER) byName.set(rung, (await authentik.createGroup(rung)).id);
  return byName;
}

function boundGroupNames(authentik: FakeAuthentikClient, targetPk: string, ids: Map<string, string>): string[] {
  const idToName = new Map([...ids].map(([name, id]) => [id, name]));
  return authentik
    .listPolicyBindingsForTest()
    .filter((b) => b.targetId === targetPk && b.groupId !== undefined)
    .map((b) => idToName.get(b.groupId!) ?? b.groupId!)
    .sort();
}

test('runSyncAuthentik dry-run reports what would be created without calling any write methods', async () => {
  const authentik = new FakeAuthentikClient();
  const result = await runSyncAuthentik({}, { authentik, inventory: gatedInventory });
  assert.equal(result.applied, false);
  assert.deepEqual(result.toCreate, ['sonarr']);
  assert.deepEqual(result.toRemove, []);
  assert.deepEqual(await authentik.listApplications(), [], 'dry run must not create anything');
});

test('runSyncAuthentik --apply creates a Provider, Application, policy binding, and adds the provider to the outpost', async () => {
  const authentik = new FakeAuthentikClient();
  const ids = await seedLadderGroups(authentik);
  const result = await runSyncAuthentik({ apply: true }, { authentik, inventory: gatedInventory });
  assert.equal(result.applied, true);
  assert.deepEqual(result.toCreate, ['sonarr']);

  const apps = await authentik.listApplications();
  assert.equal(apps.length, 1);
  assert.equal(apps[0].slug, 'sonarr');
  assert.ok(apps[0].providerId);

  const providers = await authentik.listProxyProviders();
  assert.equal(providers.length, 1);
  assert.equal(providers[0].externalHost, 'https://sonarr.example.com');
  assert.equal(providers[0].id, apps[0].providerId);

  assert.deepEqual(boundGroupNames(authentik, apps[0].pk, ids), [USERS_RUNG, ADMIN_RUNG].sort());

  const outpost = await authentik.getEmbeddedOutpost();
  assert.deepEqual(outpost.providerIds, [providers[0].id]);
});

test('runSyncAuthentik --apply removes the Provider/Application and drops it from the outpost when authGroup is no longer set', async () => {
  const authentik = new FakeAuthentikClient();
  await runSyncAuthentik({ apply: true }, { authentik, inventory: gatedInventory });

  const ungated: Inventory = {
    ...gatedInventory,
    guests: gatedInventory.guests.map((g) => (g.name === 'sonarr' ? { ...g, authGroup: undefined } : g)),
  };
  const result = await runSyncAuthentik({ apply: true }, { authentik, inventory: ungated });
  assert.deepEqual(result.toCreate, []);
  assert.deepEqual(result.toRemove, ['sonarr']);

  assert.deepEqual(await authentik.listApplications(), []);
  assert.deepEqual(await authentik.listProxyProviders(), []);
  assert.deepEqual((await authentik.getEmbeddedOutpost()).providerIds, []);
});

test('runSyncAuthentik leaves an unrelated, hand-created Application untouched', async () => {
  const authentik = new FakeAuthentikClient();
  const dashboardProvider = await authentik.createProxyProvider({
    name: 'homelab.example.com',
    externalHost: 'https://homelab.example.com',
    authorizationFlowId: 'flow-1',
    invalidationFlowId: 'flow-2',
  });
  await authentik.createApplication({ name: 'homelab.example.com', slug: 'homelab', providerId: dashboardProvider.id });

  const result = await runSyncAuthentik({ apply: true }, { authentik, inventory: gatedInventory });
  assert.deepEqual(result.toRemove, [], 'the hand-created homelab app has no matching inventory entry, so it is never a removal candidate');

  const apps = await authentik.listApplications();
  assert.ok(apps.some((a) => a.slug === 'homelab'), 'the hand-created app must still exist');
  assert.ok(apps.some((a) => a.slug === 'sonarr'), 'and the new gated app must also have been created');
});

test('runSyncAuthentik leaves an Application backed by a non-proxy provider alone, even when its slug is an inventory subdomain', async () => {
  // Provider id '99' is deliberately absent from the fake's proxyProviders,
  // which is how a non-proxy (OAuth2/OIDC) backed Application is modeled.
  const authentik = new FakeAuthentikClient({
    applications: [{ id: 'plex', pk: 'pk-plex', name: 'plex', slug: 'plex', providerId: '99' }],
  });
  const result = await runSyncAuthentik({ apply: true }, { authentik, inventory: gatedInventory });
  assert.deepEqual(result.toRemove, [], 'a non-proxy-backed Application is not ours to remove');

  const apps = await authentik.listApplications();
  assert.ok(apps.some((a) => a.slug === 'plex'), 'the OIDC-backed Application must survive');
});

test('runSyncAuthentik leaves an Application with no provider at all alone', async () => {
  const authentik = new FakeAuthentikClient({
    applications: [{ id: 'plex', pk: 'pk-plex', name: 'plex', slug: 'plex' }],
  });
  const result = await runSyncAuthentik({ apply: true }, { authentik, inventory: gatedInventory });
  assert.deepEqual(result.toRemove, []);

  const apps = await authentik.listApplications();
  assert.ok(apps.some((a) => a.slug === 'plex'), 'a provider-less Application must survive');
});

test('the dry run computes toRemove the same way --apply does', async () => {
  const seed = () =>
    new FakeAuthentikClient({
      applications: [{ id: 'plex', pk: 'pk-plex', name: 'plex', slug: 'plex', providerId: '99' }],
    });
  const dry = await runSyncAuthentik({}, { authentik: seed(), inventory: gatedInventory });
  const applied = await runSyncAuthentik({ apply: true }, { authentik: seed(), inventory: gatedInventory });
  assert.deepEqual(dry.toRemove, applied.toRemove, 'preview must not promise a deletion apply will not make');
  assert.deepEqual(dry.toRemove, []);
});

test('runSyncAuthentik --apply makes no Provider/Application/outpost calls when there is nothing to create or remove', async () => {
  const authentik = new FakeAuthentikClient();
  const ungatedInventory: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
    guests: [{ name: 'plex', type: 'lxc', vmid: 121, host: 'pve1', ip: '192.168.1.21', subdomains: ['plex'] }],
  };
  const result = await runSyncAuthentik({ apply: true }, { authentik, inventory: ungatedInventory });
  assert.deepEqual(result.toCreate, []);
  assert.deepEqual(result.toRemove, []);

  assert.deepEqual(await authentik.listProxyProviders(), [], 'no Provider should be created when there is nothing to gate');
  assert.deepEqual(await authentik.listApplications(), [], 'no Application should be created when there is nothing to gate');
});

test('runSyncAuthentik --apply reuses an orphaned Provider (name matches a desired entry, no matching Application) instead of duplicating it', async () => {
  const authentik = new FakeAuthentikClient();
  await seedLadderGroups(authentik);
  // Simulate a prior partial failure: the Provider for 'sonarr' was
  // created, but Application creation never happened (e.g. the process
  // crashed in between). Named by bare slug, the way this command now
  // creates them and the way the live Providers were renamed by hand.
  const orphanedProvider = await authentik.createProxyProvider({
    name: 'sonarr',
    externalHost: 'https://sonarr.example.com',
    authorizationFlowId: 'flow-1',
    invalidationFlowId: 'flow-2',
  });

  const result = await runSyncAuthentik({ apply: true }, { authentik, inventory: gatedInventory });
  assert.deepEqual(result.toCreate, ['sonarr']);

  const providers = await authentik.listProxyProviders();
  assert.equal(providers.length, 1, 'the orphaned provider must be reused, not duplicated');
  assert.equal(providers[0].id, orphanedProvider.id);

  const apps = await authentik.listApplications();
  assert.equal(apps.length, 1);
  assert.equal(apps[0].providerId, orphanedProvider.id);

  assert.equal(
    authentik.listPolicyBindingsForTest().length,
    2,
    'policy bindings must now exist for the healed entry, one per rung at or above its authGroup'
  );

  const outpost = await authentik.getEmbeddedOutpost();
  assert.deepEqual(outpost.providerIds, [orphanedProvider.id], 'the reused provider must be added to the outpost');
});

test('a desired entry whose slug is held by a non-proxy Application is reported as a conflict, not created, and does not block other entries', async () => {
  // 'sonarr' has authGroup: USERS_RUNG set in gatedInventory, but an
  // OIDC-backed Application already holds that slug. Creating a second one
  // would hit Authentik's unique-slug constraint.
  const authentik = new FakeAuthentikClient({
    applications: [{ id: 'sonarr', pk: 'pk-sonarr', name: 'sonarr', slug: 'sonarr', providerId: '99' }],
  });
  const inventory: Inventory = {
    ...gatedInventory,
    guests: [
      ...gatedInventory.guests,
      { name: 'radarr', type: 'lxc', vmid: 122, host: 'pve1', ip: '192.168.1.22', subdomains: ['radarr'], authGroup: USERS_RUNG },
    ],
  };

  const result = await runSyncAuthentik({ apply: true }, { authentik, inventory });
  assert.deepEqual(result.conflicts, ['sonarr']);
  assert.deepEqual(result.toCreate, ['radarr'], 'the conflicting entry must be out of toCreate');

  const apps = await authentik.listApplications();
  assert.equal(apps.filter((a) => a.slug === 'sonarr').length, 1, 'no duplicate sonarr Application');
  assert.equal(apps.find((a) => a.slug === 'sonarr')?.providerId, '99', 'the existing OIDC-backed one is untouched');
  assert.ok(apps.some((a) => a.slug === 'radarr'), 'an unrelated desired entry is still created in the same run');
});

test('a conflict does not suppress an unrelated removal in the same run', async () => {
  // 'sonarr' has authGroup: USERS_RUNG set in gatedInventory, but an
  // OIDC-backed Application already holds that slug -- a conflict. 'plex'
  // is a candidate (has a subdomain) but has no authGroup set, and already
  // has a proxy-backed, toolkit-managed Application -- a removal.
  const plexProvider = { id: '50', name: 'plex', externalHost: 'https://plex.example.com' };
  const authentik = new FakeAuthentikClient({
    proxyProviders: [plexProvider],
    applications: [
      { id: 'sonarr', pk: 'pk-sonarr', name: 'sonarr', slug: 'sonarr', providerId: '99' },
      // Deliberately divergent from the slug: this is what an operator
      // renaming the Application by hand in Authentik's admin UI looks
      // like. toRemove reports the slug, so this name must not appear in
      // the result -- that is what pins `a.slug` over `a.name`.
      { id: 'plex', pk: 'pk-plex', name: 'Plex (renamed in the admin UI)', slug: 'plex', providerId: '50' },
    ],
  });

  const result = await runSyncAuthentik({ apply: true }, { authentik, inventory: gatedInventory });
  assert.deepEqual(result.conflicts, ['sonarr']);
  assert.deepEqual(result.toRemove, ['plex'], 'the conflict must not block the unrelated removal');

  const apps = await authentik.listApplications();
  assert.ok(apps.some((a) => a.slug === 'sonarr'), 'the conflicting OIDC-backed Application is untouched');
  assert.ok(!apps.some((a) => a.slug === 'plex'), 'the removal actually happened against the client');
  assert.deepEqual(await authentik.listProxyProviders(), [], 'the removed Application\'s provider is cleaned up too');
});

test('a conflict is reported identically on a dry run', async () => {
  const authentik = new FakeAuthentikClient({
    applications: [{ id: 'sonarr', pk: 'pk-sonarr', name: 'sonarr', slug: 'sonarr', providerId: '99' }],
  });
  const result = await runSyncAuthentik({}, { authentik, inventory: gatedInventory });
  assert.equal(result.applied, false);
  assert.deepEqual(result.conflicts, ['sonarr']);
  assert.deepEqual(result.toCreate, []);
});

test('formatSyncAuthentik prints a conflicts stanza only when there are conflicts', () => {
  const none = formatSyncAuthentik({
    toCreate: [],
    toRemove: [],
    conflicts: [],
    missingRungs: [],
    offLadder: [],
    bindingChanges: [],
    applied: true,
  });
  assert.doesNotMatch(none, /conflict/i, 'normal output must be unchanged');

  const one = formatSyncAuthentik({
    toCreate: [],
    toRemove: [],
    conflicts: ['wishlist'],
    missingRungs: [],
    offLadder: [],
    bindingChanges: [],
    applied: true,
  });
  assert.match(one, /Applications in conflict: 1/);
  assert.match(one, /! wishlist/);
});

test('formatSyncAuthentik prints a missing-rungs stanza only when there are missing rungs', () => {
  const none = formatSyncAuthentik({
    toCreate: [],
    toRemove: [],
    conflicts: [],
    missingRungs: [],
    offLadder: [],
    bindingChanges: [],
    applied: true,
  });
  assert.doesNotMatch(none, /rung/i, 'normal output must be unchanged');

  const one = formatSyncAuthentik({
    toCreate: [],
    toRemove: [],
    conflicts: [],
    missingRungs: [ADMIN_RUNG],
    offLadder: [],
    bindingChanges: [],
    applied: true,
  });
  assert.match(one, /Ladder rungs missing from Authentik: 1/);
  assert.match(one, new RegExp(`! ${ADMIN_RUNG}`));
});

test('formatSyncAuthentik prints an off-ladder stanza, including the group name, only when there are off-ladder entries', () => {
  const none = formatSyncAuthentik({
    toCreate: [],
    toRemove: [],
    conflicts: [],
    missingRungs: [],
    offLadder: [],
    bindingChanges: [],
    applied: true,
  });
  assert.doesNotMatch(none, /unknown authGroup/i, 'normal output must be unchanged');

  const one = formatSyncAuthentik({
    toCreate: [],
    toRemove: [],
    conflicts: [],
    missingRungs: [],
    offLadder: [{ slug: 'sonarr', authGroup: 'not-a-rung' }],
    bindingChanges: [],
    applied: true,
  });
  assert.match(one, /Entries with an unknown authGroup: 1/);
  assert.match(one, /! sonarr \(not-a-rung\)/);
});

test('formatSyncAuthentik reports counts and names', () => {
  const text = formatSyncAuthentik({
    toCreate: ['sonarr'],
    toRemove: ['old'],
    conflicts: [],
    missingRungs: [],
    offLadder: [],
    bindingChanges: [],
    applied: true,
  });
  assert.match(text, /Applications to create: 1/);
  assert.match(text, /\+ sonarr/);
  assert.match(text, /Applications to remove: 1/);
  assert.match(text, /- old/);
});

test('runSyncAuthentik --apply names the Application and Provider by bare slug, not <slug>.<domain>', async () => {
  const authentik = new FakeAuthentikClient();
  await runSyncAuthentik({ apply: true }, { authentik, inventory: gatedInventory });

  const apps = await authentik.listApplications();
  assert.equal(apps[0].name, 'sonarr', 'the Application display name is the bare slug');
  assert.equal(apps[0].slug, 'sonarr');

  const providers = await authentik.listProxyProviders();
  assert.equal(providers[0].name, 'sonarr', 'the Proxy Provider name is the bare slug too');
  assert.equal(
    providers[0].externalHost,
    'https://sonarr.example.com',
    'externalHost still needs the domain -- it is the URL Authentik matches on'
  );
});

test('runSyncAuthentik --apply binds a new Application to its named rung and every rung above it', async () => {
  const authentik = new FakeAuthentikClient();
  const ids = await seedLadderGroups(authentik);
  await runSyncAuthentik({ apply: true }, { authentik, inventory: gatedInventory });

  const apps = await authentik.listApplications();
  assert.deepEqual(boundGroupNames(authentik, apps[0].pk, ids), [USERS_RUNG, ADMIN_RUNG].sort());
});

test('runSyncAuthentik --apply adds the newly needed rungs when an existing Application moves down the ladder', async () => {
  const authentik = new FakeAuthentikClient();
  const ids = await seedLadderGroups(authentik);
  await runSyncAuthentik({ apply: true }, { authentik, inventory: gatedInventory });

  const widened: Inventory = {
    ...gatedInventory,
    guests: gatedInventory.guests.map((g) => (g.name === 'sonarr' ? { ...g, authGroup: OPEN_RUNG } : g)),
  };
  await runSyncAuthentik({ apply: true }, { authentik, inventory: widened });

  const apps = await authentik.listApplications();
  assert.deepEqual(boundGroupNames(authentik, apps[0].pk, ids), [...LADDER].sort());
});

test('runSyncAuthentik --apply removes rungs that are no longer wanted when an Application moves up the ladder', async () => {
  const authentik = new FakeAuthentikClient();
  const ids = await seedLadderGroups(authentik);
  const broad: Inventory = {
    ...gatedInventory,
    guests: gatedInventory.guests.map((g) => (g.name === 'sonarr' ? { ...g, authGroup: OPEN_RUNG } : g)),
  };
  await runSyncAuthentik({ apply: true }, { authentik, inventory: broad });
  await runSyncAuthentik({ apply: true }, { authentik, inventory: gatedInventory });

  const apps = await authentik.listApplications();
  assert.deepEqual(boundGroupNames(authentik, apps[0].pk, ids), [USERS_RUNG, ADMIN_RUNG].sort());
});

test('runSyncAuthentik --apply is a no-op on a second run with unchanged inventory', async () => {
  const authentik = new FakeAuthentikClient();
  const ids = await seedLadderGroups(authentik);
  await runSyncAuthentik({ apply: true }, { authentik, inventory: gatedInventory });
  const before = authentik.listPolicyBindingsForTest();
  await runSyncAuthentik({ apply: true }, { authentik, inventory: gatedInventory });
  assert.deepEqual(authentik.listPolicyBindingsForTest(), before);
  const apps = await authentik.listApplications();
  assert.deepEqual(boundGroupNames(authentik, apps[0].pk, ids), [USERS_RUNG, ADMIN_RUNG].sort());
});

test('runSyncAuthentik --apply leaves a binding to a group that is not on the ladder alone', async () => {
  const authentik = new FakeAuthentikClient();
  const ids = await seedLadderGroups(authentik);
  await runSyncAuthentik({ apply: true }, { authentik, inventory: gatedInventory });

  const apps = await authentik.listApplications();
  const stranger = await authentik.createGroup('hand-made-group');
  await authentik.createPolicyBinding({ targetId: apps[0].pk, groupId: stranger.id });

  await runSyncAuthentik({ apply: true }, { authentik, inventory: gatedInventory });

  const bound = authentik.listPolicyBindingsForTest().filter((b) => b.targetId === apps[0].pk);
  assert.equal(bound.some((b) => b.groupId === stranger.id), true, 'a hand-added off-ladder binding must survive');
  assert.equal(bound.length, 3, 'two wanted rungs plus the hand-added binding');
  assert.deepEqual(
    bound.filter((b) => b.groupId !== stranger.id).map((b) => b.groupId).sort(),
    [ids.get(USERS_RUNG)!, ids.get(ADMIN_RUNG)!].sort()
  );
});

test('runSyncAuthentik --apply leaves a policy- or user-backed binding (no groupId) alone', async () => {
  const authentik = new FakeAuthentikClient();
  const ids = await seedLadderGroups(authentik);
  await runSyncAuthentik({ apply: true }, { authentik, inventory: gatedInventory });

  const apps = await authentik.listApplications();
  // FakeAuthentikClient's public createPolicyBinding always requires a
  // groupId, same as the real client -- this seeds a binding the real
  // interface cannot express, to exercise sync-authentik.ts's `if
  // (binding.groupId === undefined) continue;` branch.
  const groupless = authentik.seedPolicyBindingForTest({ targetId: apps[0].pk });

  // Move the entry to a different rung so the reconcile pass actually adds
  // and removes bindings for this Application, not just a no-op scan.
  const widened: Inventory = {
    ...gatedInventory,
    guests: gatedInventory.guests.map((g) => (g.name === 'sonarr' ? { ...g, authGroup: OPEN_RUNG } : g)),
  };
  await runSyncAuthentik({ apply: true }, { authentik, inventory: widened });

  const bound = authentik.listPolicyBindingsForTest().filter((b) => b.targetId === apps[0].pk);
  assert.equal(
    bound.some((b) => b.id === groupless),
    true,
    'a policy- or user-backed binding must never be touched by the reconcile pass'
  );
  assert.deepEqual(
    bound.filter((b) => b.id !== groupless).map((b) => b.groupId).sort(),
    [...LADDER].map((name) => ids.get(name)!).sort(),
    'the ladder rungs themselves must still have been reconciled normally'
  );
});

test('runSyncAuthentik --apply reports a ladder rung missing from Authentik and still binds the rungs that exist', async () => {
  const authentik = new FakeAuthentikClient();
  const usersGroup = await authentik.createGroup(USERS_RUNG);
  // ADMIN_RUNG deliberately absent.
  const result = await runSyncAuthentik({ apply: true }, { authentik, inventory: gatedInventory });

  assert.deepEqual(result.missingRungs, [ADMIN_RUNG]);
  const apps = await authentik.listApplications();
  assert.deepEqual(
    authentik.listPolicyBindingsForTest().filter((b) => b.targetId === apps[0].pk).map((b) => b.groupId),
    [usersGroup.id]
  );
  assert.deepEqual(await authentik.listGroups(), [usersGroup], 'a missing rung is never auto-created');
});

test('runSyncAuthentik skips an entry whose authGroup is not on the ladder and reports it', async () => {
  const authentik = new FakeAuthentikClient();
  await seedLadderGroups(authentik);
  const bad: Inventory = {
    ...gatedInventory,
    guests: gatedInventory.guests.map((g) => (g.name === 'sonarr' ? { ...g, authGroup: 'not-a-rung' } : g)),
  };
  const result = await runSyncAuthentik({ apply: true }, { authentik, inventory: bad });

  assert.deepEqual(result.offLadder, [{ slug: 'sonarr', authGroup: 'not-a-rung' }]);
  assert.deepEqual(result.toCreate, [], 'an off-ladder entry is never created');
  assert.deepEqual(await authentik.listApplications(), []);
});

test('runSyncAuthentik never deletes an existing Application whose authGroup went off-ladder', async () => {
  const authentik = new FakeAuthentikClient();
  await seedLadderGroups(authentik);
  await runSyncAuthentik({ apply: true }, { authentik, inventory: gatedInventory });
  const beforeApps = await authentik.listApplications();
  // OFF_LADDER_EXPLANATION promises "its Authentik state left untouched" --
  // mostly a claim about bindings, so this must be checked too, not just
  // that the Application itself survives.
  const beforeBindings = authentik.listPolicyBindingsForTest();

  const bad: Inventory = {
    ...gatedInventory,
    guests: gatedInventory.guests.map((g) => (g.name === 'sonarr' ? { ...g, authGroup: 'not-a-rung' } : g)),
  };
  const result = await runSyncAuthentik({ apply: true }, { authentik, inventory: bad });

  assert.deepEqual(result.toRemove, [], 'a misconfigured authGroup is reported, not acted on');
  assert.deepEqual(await authentik.listApplications(), beforeApps);
  assert.deepEqual(authentik.listPolicyBindingsForTest(), beforeBindings, 'its bindings must be untouched too');
});

// Upgrade path (issue #8): an operator who skipped the documented upgrade
// step still has an entry gated at a pre-rename default rung name
// ('homelab-users'), with a real proxy-backed Application already created
// under the old default. The current default ladder no longer has that
// name on it, so this must be reported off-ladder and left exactly as it
// was, the same way any other off-ladder entry's existing Application is
// left alone. AUTHENTIK_GROUP_LADDER is saved, deleted, and restored
// around the test (same pattern as
// test/lib/inventory.test.ts's migration tests) so it always exercises
// the real built-in default, regardless of what a developer's shell
// happens to have exported.
test('an entry still on a pre-rename default rung is reported off-ladder and its Application is kept', async () => {
  const previousLadder = process.env.AUTHENTIK_GROUP_LADDER;
  delete process.env.AUTHENTIK_GROUP_LADDER;
  try {
    const authentik = new FakeAuthentikClient();
    const ids = await seedLadderGroups(authentik);
    const provider = await authentik.createProxyProvider({
      name: 'sonarr',
      externalHost: 'https://sonarr.example.com',
      authorizationFlowId: 'flow-1',
      invalidationFlowId: 'flow-2',
    });
    const app = await authentik.createApplication({ name: 'sonarr', slug: 'sonarr', providerId: provider.id });
    authentik.seedPolicyBindingForTest({ targetId: app.pk, groupId: 'pre-rename-homelab-users-group-id' });
    // Also seed a binding to the real authentik Admins rung, so a
    // regression that deletes an off-ladder Application's bindings
    // (rather than leaving all of them alone) would be caught here too.
    const adminGroupId = ids.get(ADMIN_RUNG)!;
    authentik.seedPolicyBindingForTest({ targetId: app.pk, groupId: adminGroupId });

    const beforeApps = await authentik.listApplications();
    const beforeProviders = await authentik.listProxyProviders();
    const beforeBindings = authentik.listPolicyBindingsForTest();

    const preRename: Inventory = {
      ...gatedInventory,
      guests: gatedInventory.guests.map((g) => (g.name === 'sonarr' ? { ...g, authGroup: 'homelab-users' } : g)),
    };
    const result = await runSyncAuthentik({ apply: true }, { authentik, inventory: preRename });

    assert.deepEqual(result.offLadder, [{ slug: 'sonarr', authGroup: 'homelab-users' }]);
    assert.deepEqual(result.toCreate, [], 'an off-ladder entry is never created');
    assert.deepEqual(result.toRemove, [], "an off-ladder entry's existing Application is not a removal candidate");
    assert.deepEqual(await authentik.listApplications(), beforeApps, 'the pre-rename Application must be kept, not deleted');
    assert.deepEqual(await authentik.listProxyProviders(), beforeProviders, 'its Provider must be kept too');
    assert.deepEqual(
      authentik.listPolicyBindingsForTest(),
      beforeBindings,
      'no binding create or delete call is made for it'
    );
    assert.equal(
      authentik.listPolicyBindingsForTest().some((b) => b.targetId === app.pk && b.groupId === adminGroupId),
      true,
      'the real authentik Admins binding on this Application must survive too'
    );
  } finally {
    if (previousLadder === undefined) delete process.env.AUTHENTIK_GROUP_LADDER;
    else process.env.AUTHENTIK_GROUP_LADDER = previousLadder;
  }
});

test('runSyncAuthentik dry-run reports missing rungs and off-ladder entries without writing anything', async () => {
  const authentik = new FakeAuthentikClient();
  await authentik.createGroup(USERS_RUNG);
  const result = await runSyncAuthentik({}, { authentik, inventory: gatedInventory });
  assert.equal(result.applied, false);
  assert.deepEqual(result.toCreate, ['sonarr']);
  assert.deepEqual(result.missingRungs, [ADMIN_RUNG]);
  assert.deepEqual(await authentik.listApplications(), []);
  assert.deepEqual(authentik.listPolicyBindingsForTest(), []);
});

test('runSyncAuthentik treats empty-string authGroup as ungated, matching sync-caddy behavior', async () => {
  const authentik = new FakeAuthentikClient();
  // authGroup: '' is forbidden by the zod schema but reachable via a
  // hand-built fixture, simulating a direct Object.assign bypass.
  // This test guards against the sync-authentik/sync-caddy disagreement
  // where sync-authentik's !== undefined check would create an Application
  // while sync-caddy's truthiness check would never route forward_auth to it.
  const emptyAuthGroupInventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', authentik: true, ip: '192.168.1.5' }],
    guests: [
      { name: 'sonarr', type: 'lxc', vmid: 120, host: 'pve1', ip: '192.168.1.20', subdomains: ['sonarr'], authGroup: '' },
    ],
  } as Inventory;

  const result = await runSyncAuthentik({ apply: true }, { authentik, inventory: emptyAuthGroupInventory });
  assert.deepEqual(result.toCreate, [], 'an empty-string authGroup must not create an Application');
  assert.deepEqual(await authentik.listApplications(), []);
  assert.deepEqual(await authentik.listProxyProviders(), []);
  // The observable that actually discriminates the truthiness check from a
  // `!== undefined` check: under truthiness an authGroup: '' entry is not a
  // candidate for the ladder at all (offLadder stays empty, same as an
  // entry with no authGroup); under `!== undefined` it would enter
  // `desired` and then fail rungsAtOrAbove (since '' is never a ladder
  // rung), landing in offLadder instead. toCreate/toRemove/listApplications
  // are identical either way, so only this assertion can fail the
  // regression.
  assert.deepEqual(
    result.offLadder,
    [],
    'an empty authGroup is ungated, not a misconfigured rung -- it must never appear in offLadder'
  );
});

// A pure tier change moves two already-gated entries in opposite
// directions on the same run -- one widening (an add), one narrowing (a
// remove) -- so it creates and deletes no Applications at all, and is
// exactly the case that used to preview as "nothing to do" (fix wave item
// 1: the dry run never called listPolicyBindings(), so a tier-only change
// was invisible until --apply silently rewrote bindings).
function tierChangeInventory(sonarrGroup: string, radarrGroup: string): Inventory {
  return {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', authentik: true, ip: '192.168.1.5' }],
    guests: [
      { name: 'sonarr', type: 'lxc', vmid: 120, host: 'pve1', ip: '192.168.1.20', subdomains: ['sonarr'], authGroup: sonarrGroup },
      { name: 'radarr', type: 'lxc', vmid: 122, host: 'pve1', ip: '192.168.1.22', subdomains: ['radarr'], authGroup: radarrGroup },
    ],
  };
}

function sortChanges(changes: { slug: string; group: string; action: 'add' | 'remove' }[]) {
  return [...changes].sort((a, b) => (a.slug + a.group + a.action).localeCompare(b.slug + b.group + b.action));
}

const expectedTierChangeBindingChanges = sortChanges([
  { slug: 'sonarr', group: OPEN_RUNG, action: 'add' },
  { slug: 'sonarr', group: APP_RUNG, action: 'add' },
  { slug: 'radarr', group: OPEN_RUNG, action: 'remove' },
  { slug: 'radarr', group: APP_RUNG, action: 'remove' },
]);

test('a dry run over a pure tier change reports the pending binding adds and deletes and writes nothing', async () => {
  const authentik = new FakeAuthentikClient();
  await seedLadderGroups(authentik);
  // sonarr starts at USERS_RUNG (bound to USERS+ADMIN), radarr starts at
  // OPEN_RUNG (bound to all four rungs).
  await runSyncAuthentik({ apply: true }, { authentik, inventory: tierChangeInventory(USERS_RUNG, OPEN_RUNG) });

  // sonarr widens to OPEN_RUNG (gains OPEN/APP); radarr narrows to
  // USERS_RUNG (loses OPEN/APP). Neither Application is created or removed.
  const retiered = tierChangeInventory(OPEN_RUNG, USERS_RUNG);
  const before = authentik.listPolicyBindingsForTest();

  const dry = await runSyncAuthentik({}, { authentik, inventory: retiered });
  assert.equal(dry.applied, false);
  assert.deepEqual(dry.toCreate, [], 'a pure tier change creates nothing');
  assert.deepEqual(dry.toRemove, [], 'a pure tier change removes nothing');
  assert.deepEqual(sortChanges(dry.bindingChanges), expectedTierChangeBindingChanges);
  assert.deepEqual(authentik.listPolicyBindingsForTest(), before, 'a dry run must write nothing');
});

test('--apply over the same pure tier change reports the same binding changes it just executed', async () => {
  const authentik = new FakeAuthentikClient();
  const ids = await seedLadderGroups(authentik);
  await runSyncAuthentik({ apply: true }, { authentik, inventory: tierChangeInventory(USERS_RUNG, OPEN_RUNG) });

  const retiered = tierChangeInventory(OPEN_RUNG, USERS_RUNG);
  const applied = await runSyncAuthentik({ apply: true }, { authentik, inventory: retiered });
  assert.equal(applied.applied, true);
  assert.deepEqual(applied.toCreate, []);
  assert.deepEqual(applied.toRemove, []);
  assert.deepEqual(sortChanges(applied.bindingChanges), expectedTierChangeBindingChanges);

  const apps = await authentik.listApplications();
  const sonarr = apps.find((a) => a.slug === 'sonarr')!;
  const radarr = apps.find((a) => a.slug === 'radarr')!;
  assert.deepEqual(boundGroupNames(authentik, sonarr.pk, ids), [...LADDER].sort(), 'sonarr widened to every rung');
  assert.deepEqual(boundGroupNames(authentik, radarr.pk, ids), [USERS_RUNG, ADMIN_RUNG].sort(), 'radarr narrowed to just its own tier and above');
});

// ---------------------------------------------------------------------------
// Native OIDC gating (issue #1): an entry with authMode 'oidc' gets an
// Authentik OAuth2/OpenID provider and a meta_publisher-marked Application
// instead of a proxy provider on the embedded outpost.
// ---------------------------------------------------------------------------

const OIDC_URIS = ['https://media.example.com/oauth/callback'];
const SCOPE_IDS = ['scope-openid-1', 'scope-profile-1', 'scope-email-1'];

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

// A fetch stand-in that answers every discovery request with a valid
// OpenID configuration and records each requested URL.
function okFetch(requested: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    requested.push(String(input));
    assert.ok(init?.signal instanceof AbortSignal, 'every discovery fetch carries a timeout signal');
    return new Response(JSON.stringify({ issuer: 'x' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

// T009
test('OIDC: dry run reports the client to create and its ladder bindings, and makes no mutating call', async () => {
  const authentik = new FakeAuthentikClient();
  await seedLadderGroups(authentik);
  const callsBefore = authentik.calls.length;

  const result = await runSyncAuthentik({}, { authentik, inventory: oidcInventory(), fetchImpl: okFetch() });
  assert.equal(result.applied, false);
  assert.deepEqual(result.oidcToCreate, ['media']);
  assert.deepEqual(result.toCreate, [], 'toCreate keeps meaning forward-auth Applications');
  assert.deepEqual(result.oidcUpdates, []);
  assert.deepEqual(result.oidcSkipped, []);
  assert.deepEqual(result.discovery, [], 'a dry run never runs the discovery check');
  assert.deepEqual(
    sortChanges(result.bindingChanges),
    sortChanges([
      { slug: 'media', group: USERS_RUNG, action: 'add' },
      { slug: 'media', group: ADMIN_RUNG, action: 'add' },
    ])
  );
  assert.deepEqual(authentik.calls.slice(callsBefore), [], 'a dry run makes no mutating call');
});

test('OIDC: apply creates a confidential OAuth2 provider, a bellhop-marked Application, and ladder bindings, never touching the outpost', async () => {
  const authentik = new FakeAuthentikClient();
  const ids = await seedLadderGroups(authentik);
  const inventory = oidcInventory({
    oidcRedirectUris: ['https://media.example.com/oauth/callback', 'https://media.example.com/alt/callback'],
  });

  const result = await runSyncAuthentik({ apply: true }, { authentik, inventory, fetchImpl: okFetch() });
  assert.equal(result.applied, true);
  assert.deepEqual(result.oidcToCreate, ['media']);
  assert.deepEqual(result.toCreate, []);

  const providers = await authentik.listOAuth2Providers();
  assert.equal(providers.length, 1);
  const provider = providers[0];
  assert.equal(provider.name, 'media');
  assert.equal(provider.clientType, 'confidential');
  assert.deepEqual(provider.grantTypes, ['authorization_code', 'refresh_token']);
  assert.equal(provider.signingKeyId, 'key-1');
  assert.deepEqual([...provider.propertyMappingIds].sort(), [...SCOPE_IDS].sort());
  assert.deepEqual(provider.redirectUris, [
    { matchingMode: 'strict', url: 'https://media.example.com/oauth/callback' },
    { matchingMode: 'strict', url: 'https://media.example.com/alt/callback' },
  ]);
  assert.deepEqual(await authentik.listProxyProviders(), [], 'no proxy provider for an OIDC entry');

  const apps = await authentik.listApplications();
  assert.equal(apps.length, 1);
  assert.equal(apps[0].slug, 'media');
  assert.equal(apps[0].name, 'media');
  assert.equal(apps[0].providerId, provider.id);
  assert.equal(apps[0].metaPublisher, 'bellhop');

  assert.deepEqual((await authentik.getEmbeddedOutpost()).providerIds, [], 'the OAuth2 provider is not added to the outpost');
  assert.ok(!authentik.calls.some((c) => c.startsWith('setOutpostProviders')), 'the outpost is never written for OIDC');
  assert.deepEqual(boundGroupNames(authentik, apps[0].pk, ids), [USERS_RUNG, ADMIN_RUNG].sort());
});

test('OIDC: a second apply is a no-op and the client credentials are unchanged', async () => {
  const authentik = new FakeAuthentikClient();
  await seedLadderGroups(authentik);
  const inventory = oidcInventory();

  await runSyncAuthentik({ apply: true }, { authentik, inventory, fetchImpl: okFetch() });
  const providerId = (await authentik.listOAuth2Providers())[0].id;
  const first = await authentik.getOAuth2Credentials(providerId);
  const callsBefore = authentik.calls.length;

  const second = await runSyncAuthentik({ apply: true }, { authentik, inventory, fetchImpl: okFetch() });
  assert.deepEqual(second.oidcToCreate, []);
  assert.deepEqual(second.oidcUpdates, []);
  assert.deepEqual(second.bindingChanges, []);
  assert.deepEqual(authentik.calls.slice(callsBefore), [], 'nothing is written on an unchanged second run');

  const again = await authentik.getOAuth2Credentials(providerId);
  assert.equal(again.clientId, first.clientId);
  assert.equal(again.clientSecret, first.clientSecret);
});

// T010
test('OIDC: a changed callback URL is reported as a redirect_uris update and PATCHed in place without rotating credentials', async () => {
  const authentik = new FakeAuthentikClient();
  await seedLadderGroups(authentik);
  await runSyncAuthentik({ apply: true }, { authentik, inventory: oidcInventory(), fetchImpl: okFetch() });
  const providerId = (await authentik.listOAuth2Providers())[0].id;
  const before = await authentik.getOAuth2Credentials(providerId);

  const edited = oidcInventory({ oidcRedirectUris: ['https://media.example.com/new/callback'] });
  const callsBeforeDry = authentik.calls.length;
  const dry = await runSyncAuthentik({}, { authentik, inventory: edited, fetchImpl: okFetch() });
  assert.deepEqual(dry.oidcUpdates, [{ slug: 'media', changes: ['redirect_uris'] }]);
  assert.deepEqual(dry.oidcToCreate, []);
  assert.deepEqual(dry.bindingChanges, []);
  assert.deepEqual(authentik.calls.slice(callsBeforeDry), [], 'the dry run writes nothing');

  const callsBeforeApply = authentik.calls.length;
  const applied = await runSyncAuthentik({ apply: true }, { authentik, inventory: edited, fetchImpl: okFetch() });
  assert.deepEqual(applied.oidcUpdates, [{ slug: 'media', changes: ['redirect_uris'] }]);
  assert.deepEqual(authentik.calls.slice(callsBeforeApply), [`updateOAuth2Provider ${providerId}`]);

  const provider = (await authentik.listOAuth2Providers())[0];
  assert.deepEqual(provider.redirectUris, [{ matchingMode: 'strict', url: 'https://media.example.com/new/callback' }]);
  const after = await authentik.getOAuth2Credentials(providerId);
  assert.equal(after.clientId, before.clientId);
  assert.equal(after.clientSecret, before.clientSecret);
});

test('OIDC: the drift PATCH carries only the drifted fields, never credential fields', async () => {
  const authentik = new FakeAuthentikClient();
  await seedLadderGroups(authentik);
  await runSyncAuthentik({ apply: true }, { authentik, inventory: oidcInventory(), fetchImpl: okFetch() });

  const patches: Array<Record<string, unknown>> = [];
  const original = authentik.updateOAuth2Provider.bind(authentik);
  authentik.updateOAuth2Provider = async (id, input) => {
    patches.push({ ...input });
    return original(id, input);
  };
  await runSyncAuthentik(
    { apply: true },
    { authentik, inventory: oidcInventory({ oidcRedirectUris: ['https://media.example.com/new/callback'] }), fetchImpl: okFetch() }
  );
  assert.equal(patches.length, 1);
  assert.deepEqual(Object.keys(patches[0]), ['redirectUris']);
  for (const key of Object.keys(patches[0])) assert.doesNotMatch(key, /client_?(id|secret)/i);
});

test('OIDC: grant-type and scope-mapping drift is reported and fixed; set comparison ignores order', async () => {
  const authentik = new FakeAuthentikClient({
    applications: [
      { id: 'media', pk: 'pk-media', name: 'media', slug: 'media', providerId: '50', metaPublisher: 'bellhop' },
    ],
    oauth2Providers: [
      {
        id: '50',
        name: 'media',
        assignedApplicationSlug: 'media',
        clientType: 'confidential',
        grantTypes: ['refresh_token', 'authorization_code', 'implicit'],
        signingKeyId: 'key-1',
        propertyMappingIds: ['scope-email-1', 'scope-openid-1'],
        redirectUris: [{ matchingMode: 'strict', url: OIDC_URIS[0] }],
      },
    ],
  });
  await seedLadderGroups(authentik);

  const dry = await runSyncAuthentik({}, { authentik, inventory: oidcInventory(), fetchImpl: okFetch() });
  assert.deepEqual(dry.oidcUpdates, [{ slug: 'media', changes: ['grant_types', 'property_mappings'] }]);
  assert.deepEqual(dry.oidcToCreate, []);

  await runSyncAuthentik({ apply: true }, { authentik, inventory: oidcInventory(), fetchImpl: okFetch() });
  const provider = (await authentik.listOAuth2Providers())[0];
  assert.deepEqual(provider.grantTypes, ['authorization_code', 'refresh_token']);
  assert.deepEqual([...provider.propertyMappingIds].sort(), [...SCOPE_IDS].sort());

  const clean = await runSyncAuthentik({}, { authentik, inventory: oidcInventory(), fetchImpl: okFetch() });
  assert.deepEqual(clean.oidcUpdates, [], 'drift is gone after apply');
});

test('OIDC: a redirect URI differing only in matching mode is drift', async () => {
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
        propertyMappingIds: SCOPE_IDS,
        redirectUris: [{ matchingMode: 'regex', url: OIDC_URIS[0] }],
      },
    ],
  });
  await seedLadderGroups(authentik);
  const dry = await runSyncAuthentik({}, { authentik, inventory: oidcInventory(), fetchImpl: okFetch() });
  assert.deepEqual(dry.oidcUpdates, [{ slug: 'media', changes: ['redirect_uris'] }]);
});

test('OIDC: raising authGroup changes bindings only', async () => {
  const authentik = new FakeAuthentikClient();
  const ids = await seedLadderGroups(authentik);
  await runSyncAuthentik({ apply: true }, { authentik, inventory: oidcInventory(), fetchImpl: okFetch() });

  const raised = oidcInventory({ authGroup: ADMIN_RUNG });
  const result = await runSyncAuthentik({ apply: true }, { authentik, inventory: raised, fetchImpl: okFetch() });
  assert.deepEqual(result.oidcToCreate, []);
  assert.deepEqual(result.oidcUpdates, []);
  assert.deepEqual(result.bindingChanges, [{ slug: 'media', group: USERS_RUNG, action: 'remove' }]);
  const app = (await authentik.listApplications())[0];
  assert.deepEqual(boundGroupNames(authentik, app.pk, ids), [ADMIN_RUNG]);
  assert.ok(!authentik.calls.some((c) => c.startsWith('updateOAuth2Provider')));
});

test('OIDC: apply self-heals by reusing an orphaned OAuth2 provider named after the slug with no Application', async () => {
  const authentik = new FakeAuthentikClient({
    oauth2Providers: [
      {
        id: '60',
        name: 'media',
        clientType: 'confidential',
        grantTypes: ['authorization_code', 'refresh_token'],
        signingKeyId: 'key-1',
        propertyMappingIds: SCOPE_IDS,
        redirectUris: [{ matchingMode: 'strict', url: OIDC_URIS[0] }],
      },
    ],
  });
  await seedLadderGroups(authentik);
  const result = await runSyncAuthentik({ apply: true }, { authentik, inventory: oidcInventory(), fetchImpl: okFetch() });
  assert.deepEqual(result.oidcToCreate, ['media']);
  const providers = await authentik.listOAuth2Providers();
  assert.equal(providers.length, 1, 'the orphan is reused, not duplicated');
  assert.equal(providers[0].id, '60');
  assert.equal((await authentik.listApplications())[0].providerId, '60');
});

test('OIDC: a reused orphan with stale settings is brought to the desired settings', async () => {
  const authentik = new FakeAuthentikClient({
    oauth2Providers: [
      {
        id: '60',
        name: 'media',
        clientType: 'confidential',
        grantTypes: [],
        signingKeyId: 'key-1',
        propertyMappingIds: SCOPE_IDS,
        redirectUris: [{ matchingMode: 'strict', url: 'https://media.example.com/old' }],
      },
    ],
  });
  await seedLadderGroups(authentik);
  await runSyncAuthentik({ apply: true }, { authentik, inventory: oidcInventory(), fetchImpl: okFetch() });
  const provider = (await authentik.listOAuth2Providers())[0];
  assert.equal(provider.id, '60');
  assert.deepEqual(provider.grantTypes, ['authorization_code', 'refresh_token']);
  assert.deepEqual(provider.redirectUris, [{ matchingMode: 'strict', url: OIDC_URIS[0] }]);
});

test('OIDC: an OAuth2 provider named after the slug that already serves another Application is not reused', async () => {
  const authentik = new FakeAuthentikClient({
    applications: [{ id: 'other', pk: 'pk-other', name: 'other', slug: 'other', providerId: '60' }],
    oauth2Providers: [
      {
        id: '60',
        name: 'media',
        assignedApplicationSlug: 'other',
        clientType: 'confidential',
        grantTypes: ['authorization_code'],
        propertyMappingIds: [],
        redirectUris: [],
      },
    ],
  });
  await seedLadderGroups(authentik);
  await runSyncAuthentik({ apply: true }, { authentik, inventory: oidcInventory(), fetchImpl: okFetch() });
  const media = (await authentik.listApplications()).find((a) => a.slug === 'media')!;
  assert.notEqual(media.providerId, '60');
  assert.equal((await authentik.listOAuth2Providers()).length, 2);
});

test('OIDC: an Application at the slug backed by an unmarked OAuth2 provider is a conflict, not touched', async () => {
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
  await seedLadderGroups(authentik);
  const callsBefore = authentik.calls.length;
  const result = await runSyncAuthentik({ apply: true }, { authentik, inventory: oidcInventory(), fetchImpl: okFetch() });
  assert.deepEqual(result.conflicts, ['media']);
  assert.deepEqual(result.oidcToCreate, []);
  assert.deepEqual(result.oidcUpdates, []);
  assert.deepEqual(result.bindingChanges, []);
  assert.deepEqual(result.discovery, [], 'an unowned client is not ours to health-check');
  assert.deepEqual(authentik.calls.slice(callsBefore), []);
});

test('OIDC: a proxy-owned Application for an OIDC entry (a mode switch) is left untouched in this release', async () => {
  const authentik = new FakeAuthentikClient();
  await seedLadderGroups(authentik);
  await runSyncAuthentik({ apply: true }, { authentik, inventory: oidcInventory({ authMode: undefined }) });
  const callsBefore = authentik.calls.length;

  const result = await runSyncAuthentik(
    { apply: true },
    { authentik, inventory: oidcInventory({ authGroup: ADMIN_RUNG }), fetchImpl: okFetch() }
  );
  assert.deepEqual(result.oidcToCreate, []);
  assert.deepEqual(result.oidcUpdates, []);
  assert.deepEqual(result.oidcSkipped, []);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.toRemove, []);
  assert.deepEqual(result.bindingChanges, []);
  assert.deepEqual(result.discovery, []);
  assert.deepEqual(authentik.calls.slice(callsBefore), []);
});

test('OIDC: a forward entry whose slug holds a Bellhop-owned OAuth2 Application is left untouched in this release', async () => {
  const authentik = new FakeAuthentikClient();
  await seedLadderGroups(authentik);
  await runSyncAuthentik({ apply: true }, { authentik, inventory: oidcInventory(), fetchImpl: okFetch() });
  const callsBefore = authentik.calls.length;

  const result = await runSyncAuthentik(
    { apply: true },
    { authentik, inventory: oidcInventory({ authMode: 'forward', authGroup: ADMIN_RUNG }) }
  );
  assert.deepEqual(result.toCreate, []);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.bindingChanges, []);
  assert.deepEqual(authentik.calls.slice(callsBefore), []);
});

test('OIDC: a Bellhop-owned OAuth2 Application whose gate was cleared is left in place and not listed in toRemove', async () => {
  const authentik = new FakeAuthentikClient();
  await seedLadderGroups(authentik);
  await runSyncAuthentik({ apply: true }, { authentik, inventory: oidcInventory(), fetchImpl: okFetch() });
  const callsBefore = authentik.calls.length;

  const result = await runSyncAuthentik({ apply: true }, { authentik, inventory: oidcInventory({ authGroup: undefined }) });
  assert.deepEqual(result.toRemove, []);
  assert.deepEqual(authentik.calls.slice(callsBefore), []);
  assert.equal((await authentik.listApplications()).length, 1);
});

// T011
test('OIDC: an entry with no callback URLs is skipped with a reason naming oidcRedirectUris and nothing is created', async () => {
  const authentik = new FakeAuthentikClient();
  await seedLadderGroups(authentik);
  const inventory = oidcInventory({ oidcRedirectUris: undefined });

  const dry = await runSyncAuthentik({}, { authentik, inventory, fetchImpl: okFetch() });
  assert.equal(dry.oidcSkipped!.length, 1);
  assert.equal(dry.oidcSkipped![0].slug, 'media');
  assert.equal(dry.oidcSkipped![0].kind, 'missing-redirect-uris');
  assert.match(dry.oidcSkipped![0].reason, /oidcRedirectUris/);
  assert.deepEqual(dry.oidcToCreate, []);
  assert.deepEqual(dry.bindingChanges, [], 'no bindings planned for an Application that will not exist');

  const applied = await runSyncAuthentik({ apply: true }, { authentik, inventory, fetchImpl: okFetch() });
  assert.deepEqual(applied.oidcSkipped, dry.oidcSkipped);
  assert.deepEqual(await authentik.listApplications(), []);
  assert.deepEqual(await authentik.listOAuth2Providers(), []);
});

test('OIDC: an owned client whose callback URLs were cleared is skipped (not PATCHed to none) but its bindings still reconcile', async () => {
  const authentik = new FakeAuthentikClient();
  const ids = await seedLadderGroups(authentik);
  await runSyncAuthentik({ apply: true }, { authentik, inventory: oidcInventory(), fetchImpl: okFetch() });

  const result = await runSyncAuthentik(
    { apply: true },
    { authentik, inventory: oidcInventory({ oidcRedirectUris: undefined, authGroup: ADMIN_RUNG }), fetchImpl: okFetch() }
  );
  assert.deepEqual(result.oidcSkipped!.map((s) => s.kind), ['missing-redirect-uris']);
  assert.deepEqual(result.oidcUpdates, []);
  assert.deepEqual(result.bindingChanges, [{ slug: 'media', group: USERS_RUNG, action: 'remove' }]);
  const provider = (await authentik.listOAuth2Providers())[0];
  assert.deepEqual(provider.redirectUris, [{ matchingMode: 'strict', url: OIDC_URIS[0] }], 'the client keeps its callback');
  const app = (await authentik.listApplications())[0];
  assert.deepEqual(boundGroupNames(authentik, app.pk, ids), [ADMIN_RUNG]);
});

test('OIDC: a missing signing key skips every OIDC entry, naming AUTHENTIK_OIDC_SIGNING_KEY_NAME, while forward-auth entries still reconcile', async () => {
  const authentik = new FakeAuthentikClient({ signingKeys: {} });
  await seedLadderGroups(authentik);
  const base = oidcInventory();
  const inventory: Inventory = {
    ...base,
    guests: [
      ...base.guests,
      {
        name: 'books',
        type: 'lxc',
        vmid: 131,
        host: 'pve1',
        ip: '192.0.2.31',
        subdomains: ['books'],
        authGroup: USERS_RUNG,
        authMode: 'oidc',
        oidcRedirectUris: ['https://books.example.com/cb'],
      },
      { name: 'sonarr', type: 'lxc', vmid: 120, host: 'pve1', ip: '192.0.2.20', subdomains: ['sonarr'], authGroup: USERS_RUNG },
    ],
  };
  const result = await runSyncAuthentik({ apply: true }, { authentik, inventory, fetchImpl: okFetch() });
  assert.deepEqual(
    result.oidcSkipped!.map((s) => [s.slug, s.kind]).sort(),
    [
      ['books', 'missing-signing-key'],
      ['media', 'missing-signing-key'],
    ]
  );
  for (const s of result.oidcSkipped!) assert.match(s.reason, /AUTHENTIK_OIDC_SIGNING_KEY_NAME/);
  assert.deepEqual(result.oidcToCreate, []);
  assert.deepEqual(result.toCreate, ['sonarr'], 'the forward-auth entry is still created');
  assert.deepEqual((await authentik.listApplications()).map((a) => a.slug), ['sonarr']);
  assert.deepEqual(await authentik.listOAuth2Providers(), []);
});

test('OIDC: a missing scope mapping skips every OIDC entry with kind missing-scope-mapping', async () => {
  const authentik = new FakeAuthentikClient({
    scopeMappings: {
      'goauthentik.io/providers/oauth2/scope-openid': 'scope-openid-1',
      'goauthentik.io/providers/oauth2/scope-profile': 'scope-profile-1',
    },
  });
  await seedLadderGroups(authentik);
  const result = await runSyncAuthentik({ apply: true }, { authentik, inventory: oidcInventory(), fetchImpl: okFetch() });
  assert.equal(result.oidcSkipped!.length, 1);
  assert.equal(result.oidcSkipped![0].kind, 'missing-scope-mapping');
  assert.match(result.oidcSkipped![0].reason, /scope-email/);
  assert.deepEqual(await authentik.listOAuth2Providers(), []);
});

test('OIDC: authMode oidc without authGroup is inert', async () => {
  const authentik = new FakeAuthentikClient();
  await seedLadderGroups(authentik);
  const callsBefore = authentik.calls.length;
  const result = await runSyncAuthentik(
    { apply: true },
    { authentik, inventory: oidcInventory({ authGroup: undefined }), fetchImpl: okFetch() }
  );
  assert.deepEqual(result.oidcToCreate, []);
  assert.deepEqual(result.oidcUpdates, []);
  assert.deepEqual(result.oidcSkipped, []);
  assert.deepEqual(result.discovery, []);
  assert.deepEqual(result.toCreate, []);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(authentik.calls.slice(callsBefore), []);
});

test('OIDC: a caddyManual OIDC entry is still reconciled', async () => {
  const authentik = new FakeAuthentikClient();
  await seedLadderGroups(authentik);
  const result = await runSyncAuthentik(
    { apply: true },
    { authentik, inventory: oidcInventory({ caddyManual: true }), fetchImpl: okFetch() }
  );
  assert.deepEqual(result.oidcToCreate, ['media']);
  assert.equal((await authentik.listOAuth2Providers()).length, 1);
});

// T012
test('OIDC discovery: apply records ok for a 200 JSON document at <issuer>.well-known/openid-configuration', async () => {
  const authentik = new FakeAuthentikClient();
  await seedLadderGroups(authentik);
  const requested: string[] = [];
  const result = await runSyncAuthentik(
    { apply: true },
    { authentik, inventory: oidcInventory(), fetchImpl: okFetch(requested) }
  );
  assert.deepEqual(result.discovery, [{ slug: 'media', issuer: 'https://auth.example.com/application/o/media/', ok: true }]);
  assert.deepEqual(requested, ['https://auth.example.com/application/o/media/.well-known/openid-configuration']);
});

test('OIDC discovery: an unchanged, already-owned client is checked on every apply', async () => {
  const authentik = new FakeAuthentikClient();
  await seedLadderGroups(authentik);
  await runSyncAuthentik({ apply: true }, { authentik, inventory: oidcInventory(), fetchImpl: okFetch() });
  const second = await runSyncAuthentik({ apply: true }, { authentik, inventory: oidcInventory(), fetchImpl: okFetch() });
  assert.equal(second.discovery!.length, 1);
  assert.equal(second.discovery![0].ok, true);
});

test('OIDC discovery: non-200, a thrown error, a timeout, and a non-JSON body are recorded as failures and nothing is rolled back', async () => {
  const cases: Array<[string, typeof fetch, RegExp]> = [
    ['non-200', (async () => new Response('nope', { status: 404 })) as typeof fetch, /404/],
    [
      'throw',
      (async () => {
        throw new Error('connect ECONNREFUSED 192.0.2.9:443');
      }) as typeof fetch,
      /ECONNREFUSED/,
    ],
    [
      'timeout',
      (async () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      }) as typeof fetch,
      /timeout/i,
    ],
    ['non-JSON 200', (async () => new Response('<html></html>', { status: 200 })) as typeof fetch, /JSON/],
  ];
  for (const [label, fetchImpl, pattern] of cases) {
    const authentik = new FakeAuthentikClient();
    await seedLadderGroups(authentik);
    const result = await runSyncAuthentik({ apply: true }, { authentik, inventory: oidcInventory(), fetchImpl });
    assert.equal(result.discovery!.length, 1, label);
    const entry = result.discovery![0];
    assert.equal(entry.ok, false, label);
    assert.equal(entry.issuer, 'https://auth.example.com/application/o/media/', label);
    assert.match(entry.error ?? '', pattern, label);
    assert.equal((await authentik.listApplications()).length, 1, `${label}: the Application is kept`);
    assert.equal((await authentik.listOAuth2Providers()).length, 1, `${label}: the provider is kept`);
    assert.ok(!authentik.calls.some((c) => c.startsWith('delete')), `${label}: nothing is rolled back`);
  }
});

test('OIDC discovery: an issuer lookup failure is recorded, not thrown', async () => {
  const authentik = new FakeAuthentikClient();
  await seedLadderGroups(authentik);
  authentik.getOAuth2Issuer = async () => {
    throw new Error('Authentik API GET setup_urls failed: 500');
  };
  const result = await runSyncAuthentik({ apply: true }, { authentik, inventory: oidcInventory(), fetchImpl: okFetch() });
  assert.equal(result.discovery![0].ok, false);
  assert.match(result.discovery![0].error ?? '', /setup_urls/);
});

test('OIDC discovery: an issuer without a trailing slash still resolves to <issuer>/.well-known/openid-configuration', async () => {
  const authentik = new FakeAuthentikClient();
  await seedLadderGroups(authentik);
  authentik.getOAuth2Issuer = async () => 'https://auth.example.com/application/o/media';
  const requested: string[] = [];
  await runSyncAuthentik({ apply: true }, { authentik, inventory: oidcInventory(), fetchImpl: okFetch(requested) });
  assert.deepEqual(requested, ['https://auth.example.com/application/o/media/.well-known/openid-configuration']);
});

test('OIDC discovery: the check never reads client credentials', async () => {
  const authentik = new FakeAuthentikClient();
  await seedLadderGroups(authentik);
  authentik.getOAuth2Credentials = async () => {
    throw new Error('sync-authentik must not read the client secret');
  };
  const result = await runSyncAuthentik({ apply: true }, { authentik, inventory: oidcInventory(), fetchImpl: okFetch() });
  assert.equal(result.discovery![0].ok, true);
});

test('OIDC discovery: a dry run records no discovery entries and never fetches', async () => {
  const authentik = new FakeAuthentikClient();
  await seedLadderGroups(authentik);
  await runSyncAuthentik({ apply: true }, { authentik, inventory: oidcInventory(), fetchImpl: okFetch() });
  const requested: string[] = [];
  const dry = await runSyncAuthentik({}, { authentik, inventory: oidcInventory(), fetchImpl: okFetch(requested) });
  assert.deepEqual(dry.discovery, []);
  assert.deepEqual(requested, []);
});

test('formatSyncAuthentik prints each OIDC section only when non-empty', () => {
  const base = {
    toCreate: [],
    toRemove: [],
    conflicts: [],
    missingRungs: [],
    offLadder: [],
    bindingChanges: [],
    applied: true,
  };
  const none = formatSyncAuthentik({ ...base, oidcToCreate: [], oidcUpdates: [], oidcSkipped: [], discovery: [] });
  assert.doesNotMatch(none, /OpenID|OIDC/, 'ordinary output is unchanged');
  assert.equal(none, formatSyncAuthentik(base), 'absent and empty OIDC fields print identically');

  const full = formatSyncAuthentik({
    ...base,
    oidcToCreate: ['media'],
    oidcUpdates: [{ slug: 'books', changes: ['redirect_uris', 'grant_types'] }],
    oidcSkipped: [{ slug: 'notes', kind: 'missing-redirect-uris', reason: 'no callback URL set' }],
    discovery: [
      { slug: 'media', issuer: 'https://auth.example.com/application/o/media/', ok: true },
      { slug: 'books', issuer: 'https://auth.example.com/application/o/books/', ok: false, error: 'HTTP 502' },
    ],
  });
  assert.match(full, /OpenID clients to create: 1\n {2}\+ media/);
  assert.match(full, /OpenID client settings to update: 1\n {2}~ books: redirect_uris, grant_types/);
  assert.match(full, /OIDC entries skipped: 1\n {2}! notes — no callback URL set/);
  assert.match(
    full,
    /OIDC discovery: 2\n {2}✓ media https:\/\/auth\.example\.com\/application\/o\/media\/\n {2}✗ books https:\/\/auth\.example\.com\/application\/o\/books\/ — HTTP 502/
  );
});

test('the missing-callback skip reason matches the CLI contract wording', async () => {
  const authentik = new FakeAuthentikClient();
  await seedLadderGroups(authentik);
  const dry = await runSyncAuthentik({}, { authentik, inventory: oidcInventory({ oidcRedirectUris: undefined }) });
  assert.equal(
    dry.oidcSkipped![0].reason,
    'no callback URL set (set oidcRedirectUris, or Callback URLs on the Dashboard)'
  );
});

// T016
test('syncAuthentikFailed: apply fails on a failed discovery or a signing-key/scope-mapping skip; dry run and callback skips never fail', () => {
  const base = {
    toCreate: [],
    toRemove: [],
    conflicts: [],
    missingRungs: [],
    offLadder: [],
    bindingChanges: [],
  };
  const skip = (kind: 'missing-redirect-uris' | 'missing-signing-key' | 'missing-scope-mapping') => ({
    ...base,
    oidcSkipped: [{ slug: 'media', kind, reason: 'x' }],
  });
  assert.equal(syncAuthentikFailed({ ...base, applied: true }), false);
  assert.equal(syncAuthentikFailed({ ...skip('missing-redirect-uris'), applied: true }), false);
  assert.equal(syncAuthentikFailed({ ...skip('missing-signing-key'), applied: true }), true);
  assert.equal(syncAuthentikFailed({ ...skip('missing-scope-mapping'), applied: true }), true);
  assert.equal(syncAuthentikFailed({ ...skip('missing-signing-key'), applied: false }), false, 'a dry run never fails on a skip');
  assert.equal(
    syncAuthentikFailed({ ...base, applied: true, discovery: [{ slug: 'media', issuer: 'i', ok: false, error: 'e' }] }),
    true
  );
  assert.equal(syncAuthentikFailed({ ...base, applied: true, discovery: [{ slug: 'media', issuer: 'i', ok: true }] }), false);
});

test('ownedProviderKind: proxy backing is owned regardless of marker; OAuth2 backing only with meta_publisher bellhop', () => {
  const sets = { proxyProviderIds: new Set(['1']), oauth2ProviderIds: new Set(['2']) };
  const app = (providerId: string | undefined, metaPublisher?: string) => ({
    id: 's',
    pk: 'p',
    name: 's',
    slug: 's',
    providerId,
    metaPublisher,
  });
  assert.equal(ownedProviderKind(app('1'), sets), 'proxy');
  assert.equal(ownedProviderKind(app('1', 'someone'), sets), 'proxy');
  assert.equal(ownedProviderKind(app('2', 'bellhop'), sets), 'oauth2');
  assert.equal(ownedProviderKind(app('2'), sets), undefined);
  assert.equal(ownedProviderKind(app('2', 'other'), sets), undefined);
  assert.equal(ownedProviderKind(app('3', 'bellhop'), sets), undefined);
  assert.equal(ownedProviderKind(app(undefined, 'bellhop'), sets), undefined);
});

test('diffOAuth2Settings: reports each drifted field and a patch holding only those fields', () => {
  const desired = {
    clientType: 'confidential' as const,
    grantTypes: ['authorization_code', 'refresh_token'],
    signingKeyId: 'key-1',
    propertyMappingIds: SCOPE_IDS,
    redirectUris: [{ matchingMode: 'strict' as const, url: OIDC_URIS[0] }],
  };
  const same = diffOAuth2Settings(
    {
      id: '1',
      name: 'media',
      ...desired,
      grantTypes: ['refresh_token', 'authorization_code'],
      propertyMappingIds: [...SCOPE_IDS].reverse(),
    },
    desired
  );
  assert.deepEqual(same, { changes: [], patch: {} });

  const drifted = diffOAuth2Settings(
    { id: '1', name: 'media', clientType: 'public', grantTypes: [], signingKeyId: undefined, propertyMappingIds: [], redirectUris: [] },
    desired
  );
  assert.deepEqual(drifted.changes, ['redirect_uris', 'grant_types', 'property_mappings', 'signing_key', 'client_type']);
  assert.deepEqual(drifted.patch, desired);
});
