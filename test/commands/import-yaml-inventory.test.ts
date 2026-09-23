import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runImportYamlInventory } from '../../src/commands/maintenance/import-yaml-inventory.ts';
import { loadInventory } from '../../src/lib/inventory.ts';

function tempYamlFile(content: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'import-yaml-test-'));
  const dest = path.join(dir, 'hosts.yaml');
  writeFileSync(dest, content, 'utf8');
  return dest;
}

const VALID_YAML = [
  'domain: example.com',
  'hosts:',
  '  - name: pve1',
  '    ssh_target: pve1.local',
  '    ssh_user: root',
  '    role: main',
  'guests:',
  '  - name: media',
  '    type: lxc',
  '    vmid: 105',
  '    host: pve1',
  '',
].join('\n');

test('runImportYamlInventory does not write the db in dry run', async () => {
  const yamlPath = tempYamlFile(VALID_YAML);
  const dbPath = path.join(path.dirname(yamlPath), 'bellhop.db');
  const result = await runImportYamlInventory({ yamlPath, dbPath });
  assert.equal(result.applied, false);
  assert.equal(result.inventory.hosts.length, 1);
  // A fresh path gets an empty schema created (CREATE TABLE IF NOT EXISTS)
  // but no `domain` row, so loadInventory doesn't fail to open the db --
  // it opens fine and then fails InventorySchema's `domain: z.string().min(1)`
  // check, since domainRow is undefined and assembles as `domain: ''`.
  assert.throws(() => loadInventory(dbPath), /domain.*at least 1 character/i);
});

test('runImportYamlInventory writes the db when apply is set', async () => {
  const yamlPath = tempYamlFile(VALID_YAML);
  const dbPath = path.join(path.dirname(yamlPath), 'bellhop.db');
  const result = await runImportYamlInventory({ yamlPath, dbPath, apply: true });
  assert.equal(result.applied, true);

  const reloaded = loadInventory(dbPath);
  assert.equal(reloaded.domain, 'example.com');
  assert.equal(reloaded.hosts.length, 1);
  assert.equal(reloaded.hosts[0].name, 'pve1');
  assert.equal(reloaded.guests.length, 1);
  assert.equal(reloaded.guests[0].name, 'media');
});

test('runImportYamlInventory rejects invalid YAML content', async () => {
  const yamlPath = tempYamlFile('domain: example.com\nhosts:\n  - name: pve1\ / bad yaml\n');
  const dbPath = path.join(path.dirname(yamlPath), 'bellhop.db');
  await assert.rejects(() => runImportYamlInventory({ yamlPath, dbPath }));
});

test('runImportYamlInventory rejects YAML that fails validateInventory', async () => {
  const invalidYaml = [
    'domain: example.com',
    'hosts:',
    '  - name: pve1',
    '    ssh_target: pve1.local',
    '    ssh_user: root',
    'guests:',
    '  - name: orphan',
    '    type: lxc',
    '    vmid: 100',
    '    host: pve-missing',
    '',
  ].join('\n');
  const yamlPath = tempYamlFile(invalidYaml);
  const dbPath = path.join(path.dirname(yamlPath), 'bellhop.db');
  await assert.rejects(
    () => runImportYamlInventory({ yamlPath, dbPath }),
    /guest 'orphan' has host 'pve-missing'/
  );
});
