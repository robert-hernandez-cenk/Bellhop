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

test('runSetConfig round-trips customScriptsRepo through --apply and --unset', () => {
  const inventoryPath = tempInventoryPath();
  runSetConfig({ key: 'customScriptsRepo', value: 'example-user/ProxmoxVED', apply: true }, { inventoryPath });
  assert.equal(loadInventory(inventoryPath).customScriptsRepo, 'example-user/ProxmoxVED');
  runSetConfig({ key: 'customScriptsRepo', unset: true, apply: true }, { inventoryPath });
  assert.equal(loadInventory(inventoryPath).customScriptsRepo, undefined);
});

test('runSetConfig round-trips customScriptsBranch through --apply and --unset', () => {
  const inventoryPath = tempInventoryPath();
  runSetConfig({ key: 'customScriptsBranch', value: 'my-apps', apply: true }, { inventoryPath });
  assert.equal(loadInventory(inventoryPath).customScriptsBranch, 'my-apps');
  runSetConfig({ key: 'customScriptsBranch', unset: true, apply: true }, { inventoryPath });
  assert.equal(loadInventory(inventoryPath).customScriptsBranch, undefined);
});

test('runSetConfig rejects a customScriptsRepo not shaped like owner/repo', () => {
  const inventoryPath = tempInventoryPath();
  assert.throws(
    () => runSetConfig({ key: 'customScriptsRepo', value: 'not-a-repo', apply: true }, { inventoryPath }),
    /must be owner\/repo/
  );
});

test('runSetConfig rejects a customScriptsBranch that looks like a path traversal', () => {
  const inventoryPath = tempInventoryPath();
  assert.throws(
    () => runSetConfig({ key: 'customScriptsBranch', value: '../x', apply: true }, { inventoryPath }),
    /must be a valid git branch name/
  );
});

test('runSetConfig allows setting only customScriptsRepo without customScriptsBranch', () => {
  // The both-or-neither rule is enforced at the point of use
  // (customScriptSource), not by SettingsSchema -- set-config writes one
  // key at a time, so this must succeed on its own.
  const inventoryPath = tempInventoryPath();
  const result = runSetConfig(
    { key: 'customScriptsRepo', value: 'example-user/ProxmoxVED', apply: true },
    { inventoryPath }
  );
  assert.equal(result.applied, true);
  assert.equal(loadInventory(inventoryPath).customScriptsRepo, 'example-user/ProxmoxVED');
  assert.equal(loadInventory(inventoryPath).customScriptsBranch, undefined);
});
