import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyGuestEdits, runEditGuest, GuestEditValidationError } from '../../src/operations/edit-guest.ts';
import { FakeSSHClient, defaultResponder } from '../support/fake-ssh-client.ts';
import { UnconfiguredCloudflareClient } from '../../src/lib/cloudflare-client.ts';
import { FakeCloudflareClient, txtRecord } from '../support/fake-cloudflare-client.ts';
import { UnconfiguredAuthentikClient } from '../../src/lib/authentik-client.ts';
import { FakeAuthentikClient } from '../support/fake-authentik-client.ts';
import { loadInventory, saveInventory, type Inventory } from '../../src/lib/inventory.ts';
import type { OperationDeps } from '../../src/operations/types.ts';

const inventory: Inventory = {
  domain: 'example.com',
  hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
  guests: [
    { name: 'caddy-lxc', type: 'lxc', vmid: 4002, host: 'pve1', ip: '192.168.1.2', caddy: true },
    { name: 'app-lxc', type: 'lxc', vmid: 4003, host: 'pve1', ip: '192.168.1.3' },
    { name: 'other-lxc', type: 'lxc', vmid: 4004, host: 'pve1', ip: '192.168.1.4', subdomains: ['taken'] },
  ],
};

function deps(ssh = new FakeSSHClient(defaultResponder)): OperationDeps {
  const inventoryPath = path.join(mkdtempSync(path.join(tmpdir(), 'editguest-')), 'bellhop.db');
  saveInventory(inventoryPath, inventory);
  return { ssh, inventory: loadInventory(inventoryPath), inventoryPath, authentik: new UnconfiguredAuthentikClient(), cloudflare: new UnconfiguredCloudflareClient() };
}

test('applyGuestEdits accepts form strings and typed arrays/numbers alike', () => {
  const current = inventory.guests[1];
  const fromForm = applyGuestEdits(current, { subdomains: 'app; app2', port: '8080' });
  const typed = applyGuestEdits(current, { subdomains: ['app', 'app2'], port: 8080 });
  assert.deepEqual(fromForm.subdomains, ['app', 'app2']);
  assert.equal(fromForm.port, 8080);
  assert.deepEqual(typed, fromForm);
});

test('applyGuestEdits leaves untouched fields alone and clears authGroup on null', () => {
  const updated = applyGuestEdits({ ...inventory.guests[1], authGroup: 'bellhop-users', port: 80 }, { authGroup: null });
  assert.equal(updated.authGroup, undefined);
  assert.equal(updated.port, 80);
});

test('runEditGuest saves, pushes Caddy live, and reports the result', async () => {
  const d = deps();
  const result = await runEditGuest({ name: 'app-lxc', subdomains: ['app'], port: 8080 }, d);
  assert.equal(result.caddySynced, true);
  assert.deepEqual(loadInventory(d.inventoryPath).guests.find((g) => g.name === 'app-lxc')?.subdomains, ['app']);
  assert.deepEqual(d.inventory.guests.find((g) => g.name === 'app-lxc')?.subdomains, ['app']);
});

// runEditGuest is what the MCP server's edit-guest tool calls; this proves
// its OperationDeps.cloudflare actually reaches syncCaddyLive's prune (#162)
// rather than being dropped and silently treated as unconfigured.
test('runEditGuest prunes stale _acme-challenge records through deps.cloudflare', async () => {
  const cloudflare = new FakeCloudflareClient({
    zones: { 'example.com': 'zone-1' },
    records: [txtRecord('old', '_acme-challenge.renamed.example.com', '2020-01-01T00:00:00.000000Z')],
  });
  const d = { ...deps(), cloudflare };
  const result = await runEditGuest({ name: 'app-lxc', subdomains: ['app'], port: 8080 }, d);
  assert.equal(result.caddySynced, true);
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

// runEditGuest's OperationDeps.fetchImpl reaches syncCaddyLive's post-apply
// OIDC discovery check (same plumbing proven for deps.cloudflare above), and
// the result is scoped to the edited guest only, omitted when empty.
test('runEditGuest carries oidcDiscoveryFailures scoped to the edited guest, omitted when empty', async () => {
  const failFetch = (async () => new Response('bad gateway', { status: 502 })) as typeof fetch;
  const d = { ...deps(), authentik: new FakeAuthentikClient(), fetchImpl: failFetch };
  const result = await runEditGuest(
    { name: 'app-lxc', subdomains: ['app'], authGroup: 'bellhop-users', authMode: 'oidc', oidcRedirectUris: ['https://app.example.com/cb'] },
    d
  );
  assert.equal(result.caddySynced, true);
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
  assert.equal(result.caddySynced, true);
  assert.equal('oidcDiscoveryFailures' in result, false);
});
