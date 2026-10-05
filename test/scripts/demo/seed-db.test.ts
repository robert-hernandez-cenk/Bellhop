import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadInventory } from '../../../src/lib/inventory.ts';
import { buildDemoInventory } from '../../../scripts/demo/demo-inventory.ts';
import { seedDemoDb } from '../../../scripts/demo/seed-db.ts';

function tempDbPath(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'seed-db-')), 'bellhop.db');
}

test('seedDemoDb writes the demo inventory as a loadable database', () => {
  const dbPath = tempDbPath();
  seedDemoDb(dbPath);
  const loaded = loadInventory(dbPath);
  const demo = buildDemoInventory();
  assert.equal(loaded.domain, demo.domain);
  assert.deepEqual(loaded.hosts.map((h) => h.name).sort(), demo.hosts.map((h) => h.name).sort());
  assert.deepEqual(loaded.guests.map((g) => g.name).sort(), demo.guests.map((g) => g.name).sort());
});

test('seedDemoDb refuses to overwrite an existing database unless forced', () => {
  const dbPath = tempDbPath();
  seedDemoDb(dbPath);
  assert.throws(() => seedDemoDb(dbPath), /already exists.*--force/);
  seedDemoDb(dbPath, { force: true });
  assert.ok(loadInventory(dbPath).hosts.length > 0);
});
