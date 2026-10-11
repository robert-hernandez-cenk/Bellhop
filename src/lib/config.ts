import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { openDb } from './sqlite.ts';
import {
  MOVED_SETTINGS_KEYS,
  SECRET_SETTINGS_KEYS,
  SETTING_DEFS,
  settingSchema,
  type ConfigKey,
  type SecretSettingKey,
} from './settings-defs.ts';

// The one accessor every consumer of a moved setting or a secret reads
// through (issue #64, contracts/config-accessor.md). It owns the precedence
// rule -- an environment variable that is set and non-empty, then the
// stored value, then nothing (the consumer applies its own default) -- so
// no other module re-implements it.
//
// Imports only settings-defs.ts and sqlite.ts, never inventory.ts
// (research R2): inventory.ts imports this file, and authentik-config.ts
// will too, so importing inventory.ts here would close a cycle.

export type ConfigSource = 'environment' | 'settings' | 'none';
export interface ConfigValue {
  value?: string;
  source: ConfigSource;
}

// The table secrets live in. Interpolated into inventory.ts's SCHEMA so
// openInventoryDb creates it with everything else; kept here so the one
// writer of the table also owns its shape. saveInventory never touches it.
export const SECRET_SETTINGS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS secret_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

// Opening bellhop.db read-only and reading every row costs ~7 ms (research
// R3), and authentikConfig() runs several times per web request, so the
// stored half is cached briefly. Writes in this process invalidate it at
// once; a write from another process (CLI, MCP) is seen on the web
// service's next request (which invalidates) or within this TTL.
export const CONFIG_SNAPSHOT_TTL_MS = 2000;

interface Snapshot {
  readAt: number;
  stored: Map<string, string>;
}

// Keyed by database path, so configValue (the registered store) and
// configValueAt (an explicit one) can never hand back each other's rows.
const snapshots = new Map<string, Snapshot>();
let registeredPath: string | null = null;
let clock: () => number = Date.now;

// Registers the database configValue reads from -- once per entry point
// (CLI, web service, MCP server). null unregisters it, after which the
// accessor reads the environment only: exactly the pre-#64 behaviour, which
// is what keeps every existing test that passes its own env object
// unchanged.
export function useConfigStore(inventoryPath: string | null): void {
  registeredPath = inventoryPath;
  invalidateConfigSnapshot();
}

// Test hook: a fake clock makes the snapshot TTL deterministic. null
// restores Date.now.
export function setConfigClock(fn: (() => number) | null): void {
  clock = fn ?? Date.now;
}

export function invalidateConfigSnapshot(): void {
  snapshots.clear();
}

// The precedence rule itself, pure. Shared with the #158 and #97 migrations inside
// openInventoryDb, which reads the stored ladder from the database handle it
// already holds and so cannot go through the snapshot. A stored value is
// re-validated before it is used (an env value is the consumer's to check,
// as before #64); the error names the key and its variable, never the
// value, since the value may be a secret.
export function effectiveValue(key: ConfigKey, stored: string | undefined, env: NodeJS.ProcessEnv): ConfigValue {
  const { envVar } = SETTING_DEFS[key];
  const fromEnv = env[envVar];
  if (fromEnv !== undefined && fromEnv !== '') return { value: fromEnv, source: 'environment' };
  if (stored === undefined) return { source: 'none' };
  const result = settingSchema(key).safeParse(stored);
  if (!result.success) {
    const reason = result.error.issues.map((issue) => issue.message).join('; ');
    throw new Error(
      `Stored setting '${key}' is invalid (${reason}) -- fix it with: bellhop set-config ${key} ..., ` +
        `on the web UI's Settings page, or override it with ${envVar}`
    );
  }
  return { value: stored, source: 'settings' };
}

export function configValue(key: ConfigKey, env: NodeJS.ProcessEnv = process.env): ConfigValue {
  if (registeredPath === null) return effectiveValue(key, undefined, env);
  return configValueAt(registeredPath, key, env);
}

export function configValueAt(inventoryPath: string, key: ConfigKey, env: NodeJS.ProcessEnv = process.env): ConfigValue {
  return effectiveValue(key, storedValues(inventoryPath).get(key), env);
}

// Which secrets have a stored value -- for the Settings page's "set"/"not
// set". Deliberately key names only.
export function storedSecretKeys(inventoryPath: string): Set<SecretSettingKey> {
  const stored = storedValues(inventoryPath);
  return new Set(SECRET_SETTINGS_KEYS.filter((key) => stored.has(key)));
}

export function writeSecret(inventoryPath: string, key: SecretSettingKey, value: string): void {
  const result = settingSchema(key).safeParse(value);
  if (!result.success) {
    const reason = result.error.issues.map((issue) => issue.message).join('; ');
    throw new Error(`Invalid value for '${key}': ${reason}`);
  }
  const db = openDb(inventoryPath, SECRET_SETTINGS_TABLE_SQL);
  try {
    db.prepare(
      'INSERT INTO secret_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(key, value);
  } finally {
    db.close();
    invalidateConfigSnapshot();
  }
}

export function clearSecret(inventoryPath: string, key: SecretSettingKey): void {
  // Nothing to clear in a database that doesn't exist, and creating one
  // just to delete nothing from it would be worse than a no-op.
  if (!existsSync(inventoryPath)) return;
  const db = openDb(inventoryPath, SECRET_SETTINGS_TABLE_SQL);
  try {
    db.prepare('DELETE FROM secret_settings WHERE key = ?').run(key);
  } finally {
    db.close();
    invalidateConfigSnapshot();
  }
}

function storedValues(inventoryPath: string): Map<string, string> {
  const now = clock();
  const cached = snapshots.get(inventoryPath);
  // A negative age means the clock went backwards since the read; treat it
  // as expired, or the copy would stay fresh until the clock caught up.
  if (cached) {
    const age = now - cached.readAt;
    if (age >= 0 && age < CONFIG_SNAPSHOT_TTL_MS) return cached.stored;
  }
  const stored = readStored(inventoryPath);
  snapshots.set(inventoryPath, { readAt: now, stored });
  return stored;
}

// One short-lived read-only connection: a long-lived one would hold the
// file open on Windows and break every test's temp-dir cleanup (research
// R3). A missing file reads as nothing stored and is never created, and a
// database from before #64 (no secret_settings table) reads the same way.
function readStored(inventoryPath: string): Map<string, string> {
  const stored = new Map<string, string>();
  if (!existsSync(inventoryPath)) return stored;
  const db = new Database(inventoryPath, { readonly: true, fileMustExist: true });
  try {
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name)
    );
    const moved = new Set<string>(MOVED_SETTINGS_KEYS);
    if (tables.has('meta')) {
      for (const row of db.prepare('SELECT key, value FROM meta').all() as { key: string; value: string }[]) {
        if (moved.has(row.key)) stored.set(row.key, row.value);
      }
    }
    const secret = new Set<string>(SECRET_SETTINGS_KEYS);
    if (tables.has('secret_settings')) {
      for (const row of db.prepare('SELECT key, value FROM secret_settings').all() as { key: string; value: string }[]) {
        if (secret.has(row.key)) stored.set(row.key, row.value);
      }
    }
  } finally {
    db.close();
  }
  return stored;
}
