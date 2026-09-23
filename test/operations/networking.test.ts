import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NETWORKING_OPERATIONS } from '../../src/operations/networking.ts';
import { OPERATIONS, MCP_OPERATIONS } from '../../src/operations/index.ts';
import { parseOperationInput } from '../../src/operations/core.ts';
import { FakeSSHClient, defaultResponder } from '../support/fake-ssh-client.ts';
import { UnconfiguredCloudflareClient } from '../../src/lib/cloudflare-client.ts';
import { FakeAuthentikClient } from '../support/fake-authentik-client.ts';
import { loadInventory, saveInventory, type Inventory } from '../../src/lib/inventory.ts';
import type { OperationDeps } from '../../src/operations/types.ts';

const inventory: Inventory = {
  domain: 'example.com',
  hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
  guests: [],
};

function deps(): OperationDeps {
  const inventoryPath = path.join(mkdtempSync(path.join(tmpdir(), 'opnet-')), 'bellhop.db');
  saveInventory(inventoryPath, inventory);
  return {
    ssh: new FakeSSHClient(defaultResponder),
    inventory: loadInventory(inventoryPath),
    inventoryPath,
    authentik: new FakeAuthentikClient(), cloudflare: new UnconfiguredCloudflareClient(),
  };
}

test('set-config preview does not write; apply writes and refreshes the in-memory inventory', async () => {
  const d = deps();
  const op = NETWORKING_OPERATIONS['set-config'];
  const input = parseOperationInput(op, { key: 'dnsServer', value: '192.168.3.53' });
  assert.match(await op.preview(input, d), /Would set dnsServer to 192\.168\.3\.53/);
  assert.equal(loadInventory(d.inventoryPath).dnsServer, undefined);
  await op.apply(input, d);
  assert.equal(loadInventory(d.inventoryPath).dnsServer, '192.168.3.53');
  assert.equal(d.inventory.dnsServer, '192.168.3.53');
});

test('set-config rejects an unknown key at parse time', () => {
  assert.throws(() => parseOperationInput(NETWORKING_OPERATIONS['set-config'], { key: 'bogus', value: 'x' }), /key/);
});

test('operation ids are unique and migrate-nfs-mount is excluded from MCP', () => {
  const ids = OPERATIONS.map((o) => o.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes('migrate-nfs-mount'));
  assert.ok(!MCP_OPERATIONS.some((o) => o.id === 'migrate-nfs-mount'));
  assert.equal(MCP_OPERATIONS.length, OPERATIONS.length - 1);
});
