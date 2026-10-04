import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { invalidateConfigSnapshot, useConfigStore, writeSecret } from '../../src/lib/config.ts';
import { saveInventory, type Inventory } from '../../src/lib/inventory.ts';
import type { SecretSettingKey } from '../../src/lib/settings-defs.ts';

// A temp bellhop.db holding the given stored settings (and secrets),
// registered as the process-wide config store (issue #64). Every test that
// calls this must call resetConfigStore() in an afterEach, or the store
// leaks into whichever test file node runs next in the same process.
export function tempConfigStore(
  settings: Partial<Inventory> = {},
  secrets: Partial<Record<SecretSettingKey, string>> = {}
): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'bellhop-config-store-'));
  const dbPath = path.join(dir, 'bellhop.db');
  saveInventory(dbPath, {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: '192.0.2.10', ssh_user: 'root' }],
    guests: [],
    ...settings,
  });
  for (const [key, value] of Object.entries(secrets) as [SecretSettingKey, string][]) {
    writeSecret(dbPath, key, value);
  }
  useConfigStore(dbPath);
  return dbPath;
}

export function resetConfigStore(): void {
  useConfigStore(null);
  invalidateConfigSnapshot();
}

// Writes a meta row straight into the file, bypassing every in-process write
// path -- the same as a write from another process, or one that skipped
// validation (a malformed stored value).
export function writeMetaRow(dbPath: string, key: string, value: string): void {
  const db = new Database(dbPath);
  try {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  } finally {
    db.close();
  }
}
