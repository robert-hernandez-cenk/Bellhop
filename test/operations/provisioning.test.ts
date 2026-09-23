import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PROVISIONING_OPERATIONS } from '../../src/operations/provisioning.ts';
import { PROVISIONING_COMMANDS } from '../../src/web/commands-meta.ts';
import { parseOperationInput } from '../../src/operations/core.ts';
import { FakeSSHClient, defaultResponder } from '../support/fake-ssh-client.ts';
import { UnconfiguredCloudflareClient } from '../../src/lib/cloudflare-client.ts';
import { FakeAuthentikClient } from '../support/fake-authentik-client.ts';
import { loadInventory, saveInventory, type Inventory } from '../../src/lib/inventory.ts';
import type { OperationDeps } from '../../src/operations/types.ts';
import { withCapturedConsole } from '../../src/web/console-capture.ts';

const inventory: Inventory = {
  domain: 'example.com',
  hosts: [
    {
      name: 'pve1',
      ssh_target: 'pve1.local',
      ssh_user: 'root',
      midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' },
      storages: [
        { name: 'local', type: 'dir', content: ['vztmpl'], active: true },
        { name: 'local-lvm', type: 'lvmthin', content: ['rootdir', 'images'], active: true },
      ],
    },
  ],
  guests: [{ name: 'caddy-lxc', type: 'lxc', vmid: 4002, host: 'pve1', ip: '192.168.1.2', caddy: true }],
};

function deps(): OperationDeps {
  const inventoryPath = path.join(mkdtempSync(path.join(tmpdir(), 'opprov-')), 'bellhop.db');
  saveInventory(inventoryPath, inventory);
  return {
    ssh: new FakeSSHClient(defaultResponder),
    inventory: structuredClone(inventory),
    inventoryPath,
    authentik: new FakeAuthentikClient(), cloudflare: new UnconfiguredCloudflareClient(),
  };
}

test('every web form field for a provisioning command is part of its operation shape', () => {
  for (const cmd of PROVISIONING_COMMANDS) {
    const op = PROVISIONING_OPERATIONS[cmd.id];
    assert.ok(op, `no operation for ${cmd.id}`);
    for (const field of cmd.fields) {
      assert.ok(field.name in op.shape, `${cmd.id}: form field '${field.name}' missing from operation shape`);
    }
  }
});

test('secretFields match the web form fields declared kind secret', () => {
  for (const cmd of PROVISIONING_COMMANDS) {
    const secrets = cmd.fields.filter((f) => f.kind === 'secret').map((f) => f.name).sort();
    assert.deepEqual([...(PROVISIONING_OPERATIONS[cmd.id].secretFields ?? [])].sort(), secrets, cmd.id);
  }
});

test('create-lxc apply records the new guest in inventory', async () => {
  const d = deps();
  const op = PROVISIONING_OPERATIONS['create-lxc'];
  const input = parseOperationInput(op, { host: 'pve1', mid: 5, hostname: 'new-lxc', template: 'debian-12' });
  await op.apply(input, d);
  const saved = loadInventory(d.inventoryPath).guests.find((g) => g.name === 'new-lxc');
  assert.equal(saved?.vmid, 4005);
  assert.equal(saved?.ip, '192.168.1.5');
  assert.ok(d.inventory.guests.some((g) => g.name === 'new-lxc'));
});

// #16: a job can apply long after the in-memory inventory was last loaded
// (queued behind another job, or a minutes-long install). An edit written to
// disk meanwhile must survive the apply's own saveInventory.
test('create-lxc apply does not clobber inventory edits made after deps.inventory was loaded', async () => {
  const d = deps();
  saveInventory(d.inventoryPath, { ...structuredClone(inventory), dnsServer: '192.168.3.53' });
  const op = PROVISIONING_OPERATIONS['create-lxc'];
  // Captured only to keep the create-lxc apply's own log lines out of test output.
  await withCapturedConsole(() =>
    op.apply(parseOperationInput(op, { host: 'pve1', mid: 5, hostname: 'new-lxc', template: 'debian-12' }), d)
  );
  const saved = loadInventory(d.inventoryPath);
  assert.equal(saved.dnsServer, '192.168.3.53');
  assert.ok(saved.guests.some((g) => g.name === 'new-lxc'));
});

test('delete-guest apply refuses the caddy guest', async () => {
  const d = deps();
  const op = PROVISIONING_OPERATIONS['delete-guest'];
  await assert.rejects(op.apply(parseOperationInput(op, { guest: 'caddy-lxc' }), d), /caddy: true/);
});

test('install-app is the only provisioning operation that watches for prompts', () => {
  const watching = Object.values(PROVISIONING_OPERATIONS).filter((op) => op.watchForPrompts).map((op) => op.id);
  assert.deepEqual(watching, ['install-app']);
});
