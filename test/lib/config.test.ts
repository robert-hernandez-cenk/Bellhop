import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  clearSecret,
  configValue,
  configValueAt,
  effectiveValue,
  invalidateConfigSnapshot,
  setConfigClock,
  storedSecretKeys,
  useConfigStore,
  writeSecret,
} from '../../src/lib/config.ts';
import { loadInventory, saveInventory, type Inventory } from '../../src/lib/inventory.ts';

const BASE: Inventory = {
  domain: 'example.com',
  hosts: [{ name: 'pve1', ssh_target: '192.0.2.10', ssh_user: 'root' }],
  guests: [],
};

function tempDb(extra: Partial<Inventory> = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'bellhop-config-'));
  const dbPath = path.join(dir, 'bellhop.db');
  saveInventory(dbPath, { ...BASE, ...extra });
  return dbPath;
}

// A controllable clock, so the 2-second snapshot TTL is deterministic.
let now = 1_000_000;
function useFakeClock(): void {
  now = 1_000_000;
  setConfigClock(() => now);
}

afterEach(() => {
  useConfigStore(null);
  setConfigClock(null);
  invalidateConfigSnapshot();
});

// Writes a meta row straight into the file, bypassing every in-process
// write path, so only the snapshot TTL (or an explicit invalidation) can
// make it visible -- the same as a write from another process.
function writeMetaBehindTheCachesBack(dbPath: string, key: string, value: string): void {
  const db = new Database(dbPath);
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  db.close();
}

test('effectiveValue: a non-empty env var wins over the stored value', () => {
  assert.deepEqual(effectiveValue('authentikAdminGroup', 'stored-admins', { AUTHENTIK_ADMIN_GROUP: 'env-admins' }), {
    value: 'env-admins',
    source: 'environment',
  });
});

test('effectiveValue: the stored value applies when the env var is unset or empty', () => {
  assert.deepEqual(effectiveValue('authentikAdminGroup', 'stored-admins', {}), {
    value: 'stored-admins',
    source: 'settings',
  });
  assert.deepEqual(effectiveValue('authentikAdminGroup', 'stored-admins', { AUTHENTIK_ADMIN_GROUP: '' }), {
    value: 'stored-admins',
    source: 'settings',
  });
});

test('effectiveValue: neither set means source none with no value', () => {
  assert.deepEqual(effectiveValue('authentikAdminGroup', undefined, { AUTHENTIK_ADMIN_GROUP: '' }), { source: 'none' });
});

test('effectiveValue: a malformed stored value throws naming the key and env var, never the value', () => {
  assert.throws(
    () => effectiveValue('authentikOutpostPort', 'not-a-port-XYZ', {}),
    (err: Error) =>
      err.message.includes('authentikOutpostPort') &&
      err.message.includes('AUTHENTIK_OUTPOST_PORT') &&
      !err.message.includes('not-a-port-XYZ')
  );
  // A valid env value means the malformed stored one is never consulted.
  assert.deepEqual(effectiveValue('authentikOutpostPort', 'not-a-port-XYZ', { AUTHENTIK_OUTPOST_PORT: '9443' }), {
    value: '9443',
    source: 'environment',
  });
});

test('configValue with no store registered reads the environment only', () => {
  useConfigStore(null);
  assert.deepEqual(configValue('authentikApiUrl', { AUTHENTIK_API_URL: 'https://auth.example.com' }), {
    value: 'https://auth.example.com',
    source: 'environment',
  });
  assert.deepEqual(configValue('authentikApiToken', {}), { source: 'none' });
});

test('configValue with a registered store reads meta rows and secret_settings', () => {
  const dbPath = tempDb({ authentikApiUrl: 'https://auth.example.com', webUiAuthMode: 'oidc' });
  writeSecret(dbPath, 'authentikApiToken', 'example-token-abc');
  useConfigStore(dbPath);
  assert.deepEqual(configValue('authentikApiUrl', {}), { value: 'https://auth.example.com', source: 'settings' });
  assert.deepEqual(configValue('webUiAuthMode', {}), { value: 'oidc', source: 'settings' });
  assert.deepEqual(configValue('authentikApiToken', {}), { value: 'example-token-abc', source: 'settings' });
  assert.deepEqual(configValue('npmApiPassword', {}), { source: 'none' });
  // The environment still wins over a stored secret.
  assert.deepEqual(configValue('authentikApiToken', { AUTHENTIK_API_TOKEN: 'env-token' }), {
    value: 'env-token',
    source: 'environment',
  });
});

test('configValueAt reads an explicit store and never mixes it with the registered one', () => {
  const registered = tempDb({ authentikAdminGroup: 'registered-admins' });
  const other = tempDb({ authentikAdminGroup: 'other-admins' });
  useConfigStore(registered);
  assert.equal(configValue('authentikAdminGroup', {}).value, 'registered-admins');
  assert.equal(configValueAt(other, 'authentikAdminGroup', {}).value, 'other-admins');
  assert.equal(configValue('authentikAdminGroup', {}).value, 'registered-admins');
});

test('a malformed stored row throws naming the key and env var but not the value', () => {
  const dbPath = tempDb();
  writeMetaBehindTheCachesBack(dbPath, 'authentikOutpostPort', 'bogus-VALUE-123');
  useConfigStore(dbPath);
  assert.throws(
    () => configValue('authentikOutpostPort', {}),
    (err: Error) =>
      err.message.includes('authentikOutpostPort') &&
      err.message.includes('AUTHENTIK_OUTPOST_PORT') &&
      !err.message.includes('bogus-VALUE-123')
  );
  // Other keys in the same snapshot still read fine.
  assert.deepEqual(configValue('authentikAdminGroup', {}), { source: 'none' });
});

test('a malformed stored secret throws without echoing it', () => {
  const dbPath = tempDb();
  writeSecret(dbPath, 'githubApiToken', 'placeholder');
  const db = new Database(dbPath);
  db.prepare("UPDATE secret_settings SET value = 'has SPACE-secret' WHERE key = 'githubApiToken'").run();
  db.close();
  invalidateConfigSnapshot();
  useConfigStore(dbPath);
  assert.throws(
    () => configValue('githubApiToken', {}),
    (err: Error) => err.message.includes('githubApiToken') && err.message.includes('GITHUB_API_TOKEN') && !err.message.includes('SPACE-secret')
  );
});

test('the snapshot is reused within 2 seconds and refreshed after', () => {
  useFakeClock();
  const dbPath = tempDb({ authentikAdminGroup: 'first' });
  useConfigStore(dbPath);
  assert.equal(configValue('authentikAdminGroup', {}).value, 'first');

  writeMetaBehindTheCachesBack(dbPath, 'authentikAdminGroup', 'second');
  now += 1999;
  assert.equal(configValue('authentikAdminGroup', {}).value, 'first', 'still within the TTL');
  now += 2;
  assert.equal(configValue('authentikAdminGroup', {}).value, 'second', 'TTL elapsed');
});

test('invalidateConfigSnapshot forces a fresh read', () => {
  useFakeClock();
  const dbPath = tempDb({ authentikAdminGroup: 'first' });
  useConfigStore(dbPath);
  assert.equal(configValue('authentikAdminGroup', {}).value, 'first');
  writeMetaBehindTheCachesBack(dbPath, 'authentikAdminGroup', 'second');
  invalidateConfigSnapshot();
  assert.equal(configValue('authentikAdminGroup', {}).value, 'second');
});

test('writeSecret, clearSecret and saveInventory each refresh the snapshot in-process', () => {
  useFakeClock();
  const dbPath = tempDb({ authentikAdminGroup: 'first' });
  useConfigStore(dbPath);
  assert.deepEqual(configValue('cloudflareDnsApiToken', {}), { source: 'none' });

  writeSecret(dbPath, 'cloudflareDnsApiToken', 'example-cf-token');
  assert.equal(configValue('cloudflareDnsApiToken', {}).value, 'example-cf-token');

  clearSecret(dbPath, 'cloudflareDnsApiToken');
  assert.deepEqual(configValue('cloudflareDnsApiToken', {}), { source: 'none' });

  saveInventory(dbPath, { ...loadInventory(dbPath), authentikAdminGroup: 'second' });
  assert.equal(configValue('authentikAdminGroup', {}).value, 'second');
});

test('writeSecret rejects an invalid value without echoing it', () => {
  const dbPath = tempDb();
  assert.throws(
    () => writeSecret(dbPath, 'authentikApiToken', 'two WORDS-secret'),
    (err: Error) => err.message.includes('authentikApiToken') && !err.message.includes('WORDS-secret')
  );
  assert.deepEqual([...storedSecretKeys(dbPath)], []);
});

test('secrets never appear on a loaded Inventory', () => {
  const dbPath = tempDb();
  writeSecret(dbPath, 'npmApiPassword', 'example pass');
  const inv = loadInventory(dbPath) as Record<string, unknown>;
  assert.equal(inv.npmApiPassword, undefined);
  // saveInventory's wholesale rewrite leaves the secret table alone.
  saveInventory(dbPath, loadInventory(dbPath));
  assert.deepEqual([...storedSecretKeys(dbPath)], ['npmApiPassword']);
});

test('storedSecretKeys returns key names only', () => {
  const dbPath = tempDb();
  writeSecret(dbPath, 'githubApiToken', 'example-gh-token');
  writeSecret(dbPath, 'npmApiPassword', 'example pass');
  const keys = storedSecretKeys(dbPath);
  assert.deepEqual([...keys].sort(), ['githubApiToken', 'npmApiPassword']);
  assert.ok(![...keys].some((k) => k.includes('example')));
});

test('a database with no secret_settings table reads as nothing stored', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bellhop-config-old-'));
  const dbPath = path.join(dir, 'bellhop.db');
  const db = new Database(dbPath);
  db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('authentikAdminGroup', 'old-admins');");
  db.close();
  useConfigStore(dbPath);
  assert.equal(configValue('authentikAdminGroup', {}).value, 'old-admins');
  assert.deepEqual(configValue('authentikApiToken', {}), { source: 'none' });
  assert.deepEqual([...storedSecretKeys(dbPath)], []);
});

test('no database file means everything is none, and no file is created', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bellhop-config-missing-'));
  const dbPath = path.join(dir, 'bellhop.db');
  useConfigStore(dbPath);
  assert.deepEqual(configValue('authentikApiUrl', {}), { source: 'none' });
  assert.deepEqual(configValue('authentikApiToken', {}), { source: 'none' });
  assert.deepEqual([...storedSecretKeys(dbPath)], []);
  assert.equal(existsSync(dbPath), false);
});

test('a snapshot read with the clock gone backwards counts as expired (final review M14)', () => {
  useFakeClock();
  const dbPath = tempDb({ authentikAdminGroup: 'first' });
  useConfigStore(dbPath);
  assert.equal(configValue('authentikAdminGroup', {}).value, 'first');
  writeMetaBehindTheCachesBack(dbPath, 'authentikAdminGroup', 'second');
  // The wall clock steps back (an NTP correction): the cached copy's age is
  // negative, which must not keep it alive past the TTL indefinitely.
  now -= 60_000;
  assert.equal(configValue('authentikAdminGroup', {}).value, 'second');
});
