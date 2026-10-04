import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { importEnvFiles } from '../../src/lib/config-import.ts';
import { configValueAt, invalidateConfigSnapshot, useConfigStore, writeSecret } from '../../src/lib/config.ts';
import { loadInventory, saveInventory } from '../../src/lib/inventory.ts';

// Issue #64 US4 (T034): the one-time import of data/*.env into the settings
// store. Every directory below is a mkdtempSync one holding example values,
// so nothing here ever reads the real data/ directory.

afterEach(() => {
  useConfigStore(null);
  invalidateConfigSnapshot();
});

function setup(files: Record<string, string>, withDb = true): { dbPath: string; dataDir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'bellhop-config-import-'));
  const dataDir = path.join(dir, 'data');
  const dbPath = path.join(dir, 'bellhop.db');
  mkdirSync(dataDir);
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dataDir, name), body);
  if (withDb) saveInventory(dbPath, { domain: 'example.com', hosts: [], guests: [] });
  return { dbPath, dataDir };
}

async function capture<T>(fn: () => T): Promise<{ result: T; output: string }> {
  const lines: string[] = [];
  const { log, error } = console;
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  console.error = console.log;
  try {
    return { result: fn(), output: lines.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
  }
}

const AUTHENTIK_ENV = [
  'AUTHENTIK_API_URL=https://auth.example.com',
  'AUTHENTIK_API_TOKEN=example-authentik-token',
  'AUTHENTIK_ADMIN_GROUP=example-admins',
  'WEB_UI_AUTH_MODE=authentik',
  '',
].join('\n');

test('imports non-secret keys to meta, secrets to secret_settings, WEB_UI_AUTH_MODE to webUiAuthMode', async () => {
  const { dbPath, dataDir } = setup({
    'authentik.env': AUTHENTIK_ENV,
    'cloudflare-api.env': 'CLOUDFLARE_DNS_API_TOKEN=example-cloudflare-token\n',
    'nginx-proxy-manager.env': 'NPM_API_EMAIL=admin@example.com\nNPM_API_PASSWORD=example npm password\n',
  });
  const { result } = await capture(() => importEnvFiles(dbPath, dataDir));
  const keys = result.imported.map((i) => i.key).sort();
  assert.deepEqual(keys, [
    'authentikAdminGroup',
    'authentikApiToken',
    'authentikApiUrl',
    'cloudflareDnsApiToken',
    'npmApiEmail',
    'npmApiPassword',
    'webUiAuthMode',
  ]);
  assert.deepEqual(
    result.imported.find((i) => i.key === 'webUiAuthMode'),
    { key: 'webUiAuthMode', variable: 'WEB_UI_AUTH_MODE', file: 'authentik.env' }
  );
  assert.deepEqual(result.skipped, []);
  const inv = loadInventory(dbPath);
  assert.equal(inv.authentikApiUrl, 'https://auth.example.com');
  assert.equal(inv.authentikAdminGroup, 'example-admins');
  assert.equal(inv.webUiAuthMode, 'authentik');
  assert.equal(inv.npmApiEmail, 'admin@example.com');
  // Secrets are never on Inventory, only in secret_settings. The cast only
  // widens the type so a key Inventory deliberately lacks can be indexed.
  assert.equal((inv as Record<string, unknown>).authentikApiToken, undefined);
  assert.equal(configValueAt(dbPath, 'authentikApiToken', {}).value, 'example-authentik-token');
  assert.equal(configValueAt(dbPath, 'cloudflareDnsApiToken', {}).value, 'example-cloudflare-token');
  assert.equal(configValueAt(dbPath, 'npmApiPassword', {}).value, 'example npm password');
});

test('a stored value is never overwritten, and a second run imports nothing', async () => {
  const { dbPath, dataDir } = setup({ 'authentik.env': AUTHENTIK_ENV });
  saveInventory(dbPath, { domain: 'example.com', hosts: [], guests: [], authentikAdminGroup: 'stored-admins' });
  writeSecret(dbPath, 'authentikApiToken', 'stored-token');
  const first = await capture(() => importEnvFiles(dbPath, dataDir));
  assert.deepEqual(first.result.imported.map((i) => i.key).sort(), ['authentikApiUrl', 'webUiAuthMode']);
  assert.equal(loadInventory(dbPath).authentikAdminGroup, 'stored-admins');
  assert.equal(configValueAt(dbPath, 'authentikApiToken', {}).value, 'stored-token');

  const second = await capture(() => importEnvFiles(dbPath, dataDir));
  assert.deepEqual(second.result, { imported: [], skipped: [] });
  assert.equal(second.output, '');
});

test('the files are byte-identical afterwards', async () => {
  const { dbPath, dataDir } = setup({ 'authentik.env': AUTHENTIK_ENV });
  const file = path.join(dataDir, 'authentik.env');
  const before = readFileSync(file);
  await capture(() => importEnvFiles(dbPath, dataDir));
  assert.ok(readFileSync(file).equals(before));
});

test('logs name the variable, file and key, never a value', async () => {
  const { dbPath, dataDir } = setup({ 'authentik.env': AUTHENTIK_ENV });
  const { output } = await capture(() => importEnvFiles(dbPath, dataDir));
  assert.match(output, /Imported AUTHENTIK_API_TOKEN from data\/authentik\.env as setting authentikApiToken/);
  assert.match(output, /Imported AUTHENTIK_ADMIN_GROUP from data\/authentik\.env as setting authentikAdminGroup/);
  for (const value of ['example-authentik-token', 'example-admins', 'https://auth.example.com']) {
    assert.ok(!output.includes(value), `${value} leaked into the log`);
  }
});

test('an invalid value is skipped with a warning naming the key, never the value', async () => {
  const { dbPath, dataDir } = setup({
    'authentik.env': 'AUTHENTIK_OUTPOST_PORT=not-a-port-MARKER\nAUTHENTIK_API_TOKEN=has space-MARKER\nAUTHENTIK_ADMIN_GROUP=example-admins\n',
  });
  const { result, output } = await capture(() => importEnvFiles(dbPath, dataDir));
  assert.deepEqual(result.imported.map((i) => i.key), ['authentikAdminGroup']);
  assert.deepEqual(result.skipped.map((s) => s.key).sort(), ['authentikApiToken', 'authentikOutpostPort']);
  for (const s of result.skipped) assert.ok(s.reason.includes(s.key));
  assert.match(output, /WARN.*authentikOutpostPort/);
  assert.ok(!output.includes('MARKER'));
  assert.ok(!JSON.stringify(result).includes('MARKER'));
  assert.equal(loadInventory(dbPath).authentikOutpostPort, undefined);
  assert.equal(configValueAt(dbPath, 'authentikApiToken', {}).value, undefined);
});

test('an empty value is not imported', async () => {
  const { dbPath, dataDir } = setup({ 'authentik.env': 'AUTHENTIK_ADMIN_GROUP=\n' });
  const { result } = await capture(() => importEnvFiles(dbPath, dataDir));
  assert.deepEqual(result, { imported: [], skipped: [] });
});

test('no database file: nothing imported and no file created', async () => {
  const { dbPath, dataDir } = setup({ 'authentik.env': AUTHENTIK_ENV }, false);
  const { result } = await capture(() => importEnvFiles(dbPath, dataDir));
  assert.deepEqual(result, { imported: [], skipped: [] });
  assert.equal(existsSync(dbPath), false);
});

test('missing files are skipped silently', async () => {
  const { dbPath, dataDir } = setup({});
  const { result, output } = await capture(() => importEnvFiles(dbPath, dataDir));
  assert.deepEqual(result, { imported: [], skipped: [] });
  assert.equal(output, '');
});

test('real process.env values are not imported', async () => {
  // A real file candidate, so the import actually runs and writes: the
  // stored value must be the file's, never the environment's, and a
  // variable set only in the environment must not be stored at all.
  const { dbPath, dataDir } = setup({ 'authentik.env': 'AUTHENTIK_ADMIN_GROUP=example-file-admins\n' });
  const saved = { group: process.env.AUTHENTIK_ADMIN_GROUP, outpost: process.env.AUTHENTIK_OUTPOST_NAME };
  process.env.AUTHENTIK_ADMIN_GROUP = 'example-env-admins';
  process.env.AUTHENTIK_OUTPOST_NAME = 'example env-only outpost';
  try {
    const { result } = await capture(() => importEnvFiles(dbPath, dataDir));
    assert.deepEqual(result.imported.map((i) => i.key), ['authentikAdminGroup']);
    assert.equal(configValueAt(dbPath, 'authentikAdminGroup', {}).value, 'example-file-admins');
    assert.equal(configValueAt(dbPath, 'authentikOutpostName', {}).value, undefined);
  } finally {
    if (saved.group === undefined) delete process.env.AUTHENTIK_ADMIN_GROUP;
    else process.env.AUTHENTIK_ADMIN_GROUP = saved.group;
    if (saved.outpost === undefined) delete process.env.AUTHENTIK_OUTPOST_NAME;
    else process.env.AUTHENTIK_OUTPOST_NAME = saved.outpost;
  }
});

test('an env override does not hide that nothing is stored: the file value is still imported', async () => {
  const { dbPath, dataDir } = setup({ 'authentik.env': 'AUTHENTIK_ADMIN_GROUP=example-admins\n' });
  const saved = process.env.AUTHENTIK_ADMIN_GROUP;
  process.env.AUTHENTIK_ADMIN_GROUP = 'example-admins';
  try {
    const { result } = await capture(() => importEnvFiles(dbPath, dataDir));
    assert.deepEqual(result.imported.map((i) => i.key), ['authentikAdminGroup']);
  } finally {
    if (saved === undefined) delete process.env.AUTHENTIK_ADMIN_GROUP;
    else process.env.AUTHENTIK_ADMIN_GROUP = saved;
  }
});

test('an imported value is visible to the registered store at once', async () => {
  const { dbPath, dataDir } = setup({ 'authentik.env': 'AUTHENTIK_ADMIN_GROUP=example-admins\n' });
  useConfigStore(dbPath);
  // Prime the snapshot so a stale read would show up.
  assert.equal(configValueAt(dbPath, 'authentikAdminGroup', {}).value, undefined);
  await capture(() => importEnvFiles(dbPath, dataDir));
  assert.equal(configValueAt(dbPath, 'authentikAdminGroup', {}).value, 'example-admins');
});
