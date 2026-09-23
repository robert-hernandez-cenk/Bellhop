import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadInventory, saveInventory, type Inventory } from '../../src/lib/inventory.ts';
import { runSetConfig } from '../../src/commands/maintenance/set-config.ts';

const FIXTURE: Inventory = {
  domain: 'example.com',
  hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
  guests: [],
};

function tempInventoryPath(inv: Inventory = FIXTURE): string {
  const dest = path.join(mkdtempSync(path.join(tmpdir(), 'inventory-')), 'bellhop.db');
  saveInventory(dest, inv);
  return dest;
}

test('runSetConfig writes a value with --apply', () => {
  const inventoryPath = tempInventoryPath();
  const result = runSetConfig({ key: 'dnsServer', value: '10.0.0.53', apply: true }, { inventoryPath });
  assert.equal(result.applied, true);
  assert.equal(loadInventory(inventoryPath).dnsServer, '10.0.0.53');
});

test('runSetConfig writes nothing on a dry run', () => {
  const inventoryPath = tempInventoryPath();
  const result = runSetConfig({ key: 'dnsServer', value: '10.0.0.53' }, { inventoryPath });
  assert.equal(result.applied, false);
  assert.equal(loadInventory(inventoryPath).dnsServer, undefined);
});

test('runSetConfig --unset clears an existing value', () => {
  const inventoryPath = tempInventoryPath({ ...FIXTURE, dnsServer: '10.0.0.53' });
  runSetConfig({ key: 'dnsServer', unset: true, apply: true }, { inventoryPath });
  assert.equal(loadInventory(inventoryPath).dnsServer, undefined);
});

test('runSetConfig rejects an unknown key', () => {
  const inventoryPath = tempInventoryPath();
  assert.throws(
    () => runSetConfig({ key: 'domain', value: 'other.com', apply: true }, { inventoryPath }),
    /Unknown setting 'domain'/
  );
});

test('runSetConfig rejects a value the schema refuses', () => {
  const inventoryPath = tempInventoryPath();
  assert.throws(
    () => runSetConfig({ key: 'statusPagePath', value: 'relative/path.html', apply: true }, { inventoryPath }),
    /must be an absolute path/
  );
});

test('runSetConfig requires a value when not unsetting', () => {
  const inventoryPath = tempInventoryPath();
  assert.throws(
    () => runSetConfig({ key: 'dnsServer', apply: true }, { inventoryPath }),
    /requires a value/
  );
});
