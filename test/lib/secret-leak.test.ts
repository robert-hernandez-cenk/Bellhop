import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { stringify } from 'yaml';
import { z } from 'zod';
import { buildApp } from '../../src/web/app.ts';
import { JobStore } from '../../src/web/jobs/job-store.ts';
import { createJobLog } from '../../src/web/jobs/job-log.ts';
import { JobRunner } from '../../src/web/jobs/job-runner.ts';
import { loadInventory, type Inventory } from '../../src/lib/inventory.ts';
import { configValueAt, useConfigStore, writeSecret } from '../../src/lib/config.ts';
import { SECRET_SETTINGS_KEYS, SETTING_DEFS, type SecretSettingKey } from '../../src/lib/settings-defs.ts';
import { runRenderStatusPage } from '../../src/commands/networking/render-status-page.ts';
import { runSetConfig } from '../../src/commands/maintenance/set-config.ts';
import { NETWORKING_OPERATIONS } from '../../src/operations/networking.ts';
import { FakeSSHClient } from '../support/fake-ssh-client.ts';
import { FakeAuthentikClient } from '../support/fake-authentik-client.ts';
import { resetConfigStore, tempConfigStore } from '../support/config-store.ts';
import { setupMcp, waitForFinished } from '../support/mcp-harness.ts';

// Issue #64 US2 (T026): every secret is seeded with a unique marker, then
// every place a value could surface is searched for any of them. A secret is
// write-only: nothing below may ever print, return, or persist one.

const marker = (key: SecretSettingKey, suffix = '') => `leak-marker-${key}${suffix}-7f3a`;
const MARKERS = SECRET_SETTINGS_KEYS.map((key) => marker(key));
const SEEDED = Object.fromEntries(SECRET_SETTINGS_KEYS.map((key) => [key, marker(key)])) as Record<SecretSettingKey, string>;

function assertNoMarker(text: string, where: string, markers: string[] = MARKERS): void {
  for (const m of markers) assert.ok(!text.includes(m), `${m} leaked into ${where}`);
}

// Every secret's variable removed for the test's duration, so the stored
// value is the effective one and nothing from the developer's shell pins it.
const savedEnv: Record<string, string | undefined> = {};
for (const key of SECRET_SETTINGS_KEYS) savedEnv[SETTING_DEFS[key].envVar] = process.env[SETTING_DEFS[key].envVar];
function clearSecretEnv(): void {
  for (const name of Object.keys(savedEnv)) delete process.env[name];
}
afterEach(() => {
  resetConfigStore();
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

async function captureConsole<T>(fn: () => Promise<T> | T): Promise<{ result: T; output: string }> {
  const lines: string[] = [];
  const { log, error, warn } = console;
  const push = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  console.log = push;
  console.error = push;
  console.warn = push;
  try {
    return { result: await fn(), output: lines.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
    console.warn = warn;
  }
}

const STORE: Partial<Inventory> = {
  statusPagePath: '/usr/share/caddy/index.html',
  hosts: [{ name: 'pve1', ssh_target: '192.0.2.10', ssh_user: 'root', proxy: true }],
};

function seededStore(): string {
  clearSecretEnv();
  const inventoryPath = tempConfigStore(STORE, SEEDED);
  // Sanity: the markers really are stored and effective, so their absence
  // below means nothing printed them, not that nothing was there to print.
  for (const key of SECRET_SETTINGS_KEYS) assert.equal(configValueAt(inventoryPath, key).value, marker(key));
  return inventoryPath;
}

function testApp(inventoryPath: string) {
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  return buildApp({
    inventory: loadInventory(inventoryPath),
    baseSsh: ssh,
    jobStore,
    jobLog,
    jobRunner: new JobRunner(jobStore, jobLog, ssh),
    inventoryPath,
    authentik: new FakeAuthentikClient(),
  });
}

const asAdmin = (req: request.Test) => req.set('x-authentik-username', 'admin').set('x-authentik-groups', 'bellhop-admins');

test('GET and PATCH /api/settings (and GET /api/inventory) never return a secret, nor log one', async () => {
  const inventoryPath = seededStore();
  const app = testApp(inventoryPath);
  const written = SECRET_SETTINGS_KEYS.map((key) => marker(key, '-patched'));

  const { result, output } = await captureConsole(async () => {
    const get = await asAdmin(request(app).get('/api/settings'));
    const patch = await asAdmin(request(app).patch('/api/settings')).send({
      nfsServer: '192.0.2.5',
      ...Object.fromEntries(SECRET_SETTINGS_KEYS.map((key) => [key, marker(key, '-patched')])),
    });
    const rejected = await asAdmin(request(app).patch('/api/settings')).send({ githubApiToken: 'bad value leak-marker-bad-7f3a' });
    const inventory = await asAdmin(request(app).get('/api/inventory'));
    return { get, patch, rejected, inventory };
  });
  assert.equal(result.get.status, 200);
  assert.equal(result.patch.status, 200);
  assert.equal(result.rejected.status, 400);
  assert.equal(result.inventory.status, 200);
  const all = [result.get, result.patch, result.rejected, result.inventory].map((r) => JSON.stringify(r.body)).join('\n');
  assertNoMarker(all, 'an /api response', [...MARKERS, ...written, 'leak-marker-bad-7f3a']);
  assertNoMarker(output, 'console output during a settings write', [...MARKERS, ...written, 'leak-marker-bad-7f3a']);
  // ...and the PATCH really did store them.
  for (const key of SECRET_SETTINGS_KEYS) assert.equal(configValueAt(inventoryPath, key).value, marker(key, '-patched'));
});

test('loadInventory and its YAML snapshot carry no secret', () => {
  const inventoryPath = seededStore();
  const inventory = loadInventory(inventoryPath);
  assertNoMarker(JSON.stringify(inventory), 'loadInventory()');
  assertNoMarker(stringify(inventory), 'the inventory YAML');
});

test('the rendered status page and everything sent over SSH carry no secret', async () => {
  const inventoryPath = seededStore();
  const inventory = loadInventory(inventoryPath);
  const ssh = new FakeSSHClient(() => ({ stdout: 'example deployed proxy config', stderr: '', code: 0 }));
  const { result, output } = await captureConsole(() => runRenderStatusPage({ apply: true }, { ssh, inventory }, stringify(inventory)));
  assert.equal(result.applied, true);
  assertNoMarker(result.html, 'the status page HTML');
  assertNoMarker(JSON.stringify(ssh.history), 'the SSH command history');
  assertNoMarker(output, 'render-status-page output');
});

test('set-config (CLI command layer) never logs or returns a secret it writes', async () => {
  const inventoryPath = seededStore();
  for (const key of SECRET_SETTINGS_KEYS) {
    const value = marker(key, '-cli');
    const dry = await captureConsole(() => runSetConfig({ key, value }, { inventoryPath }));
    const applied = await captureConsole(() => runSetConfig({ key, value, apply: true }, { inventoryPath }));
    const text = [dry.output, applied.output, JSON.stringify(dry.result), JSON.stringify(applied.result)].join('\n');
    assertNoMarker(text, `set-config ${key}`, [...MARKERS, value]);
    assert.equal(configValueAt(inventoryPath, key).value, value);
  }
});

test('the real CLI (--stdin --apply) prints no secret', () => {
  const inventoryPath = seededStore();
  const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'cli.ts');
  const env: NodeJS.ProcessEnv = { ...process.env, INVENTORY_FILE: inventoryPath, WEB_DATA_DIR: path.dirname(inventoryPath) };
  for (const def of Object.values(SETTING_DEFS)) delete env[def.envVar];
  const key: SecretSettingKey = 'authentikApiToken';
  const run = spawnSync(process.execPath, ['--import', 'tsx', cliPath, 'set-config', key, '--stdin', '--apply'], {
    encoding: 'utf8',
    env,
    input: `${marker(key, '-spawn')}\n`,
  });
  assert.equal(run.status, 0, run.stderr);
  assertNoMarker(`${run.stdout}\n${run.stderr}`, 'CLI output', [...MARKERS, marker(key, '-spawn')]);
});

test('MCP: set_config rejects every secret key, and a set-config job records no secret', async () => {
  // The operation's own input shape refuses a secret key outright.
  const shape = z.object(NETWORKING_OPERATIONS['set-config'].shape);
  for (const key of SECRET_SETTINGS_KEYS) assert.equal(shape.safeParse({ key, value: 'example-token' }).success, false);

  clearSecretEnv();
  const h = await setupMcp();
  for (const key of SECRET_SETTINGS_KEYS) writeSecret(h.inventoryPath, key, marker(key));
  useConfigStore(h.inventoryPath);
  const started = JSON.parse(
    (await h.call('set_config', { key: 'dnsServer', value: '192.0.2.53', apply: true })).content[0].text
  ) as { jobId: number };
  await waitForFinished(h.jobStore, started.jobId);
  const job = h.jobStore.get(started.jobId);
  assert.ok(job);
  assert.equal(job.status, 'success');
  assertNoMarker(job.argsJson, "the job's argsJson");
  assertNoMarker(h.jobLog.read(job.logFile), 'the job log');
});

test('importing data/*.env (imported and invalid-value skip paths alike) logs and returns no secret', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { importEnvFiles } = await import('../../src/lib/config-import.ts');
  const { saveInventory } = await import('../../src/lib/inventory.ts');
  const fileBacked = SECRET_SETTINGS_KEYS.filter((key) => SETTING_DEFS[key].envFile !== undefined);
  // A space makes a token invalid; the password schema allows one, so a tab
  // (a control character) makes it invalid instead.
  const invalid = (key: SecretSettingKey) => `${marker(key, '-bad')}${key === 'npmApiPassword' ? '\t' : ' '}x`;

  for (const [label, value] of [['imported', (key: SecretSettingKey) => marker(key, '-file')], ['skipped', invalid]] as const) {
    clearSecretEnv();
    const dir = mkdtempSync(path.join(tmpdir(), 'bellhop-import-leak-'));
    const dataDir = path.join(dir, 'data');
    mkdirSync(dataDir);
    const dbPath = path.join(dir, 'bellhop.db');
    saveInventory(dbPath, { domain: 'example.com', hosts: [], guests: [] });
    const files = new Map<string, string[]>();
    for (const key of fileBacked) {
      const { envVar, envFile } = SETTING_DEFS[key];
      if (!envFile) continue;
      const lines = files.get(envFile) ?? [];
      lines.push(`${envVar}="${value(key)}"`);
      files.set(envFile, lines);
    }
    for (const [name, lines] of files) writeFileSync(path.join(dataDir, name), `${lines.join('\n')}\n`);

    const { result, output } = await captureConsole(() => importEnvFiles(dbPath, dataDir));
    const markers = fileBacked.map(value);
    assertNoMarker(output, `the ${label} path's log output`, markers);
    assertNoMarker(JSON.stringify(result), `the ${label} path's result`, markers);
    if (label === 'imported') {
      assert.deepEqual(result.imported.map((i) => i.key).sort(), [...fileBacked].sort());
      for (const key of fileBacked) assert.equal(configValueAt(dbPath, key, {}).value, marker(key, '-file'));
    } else {
      assert.deepEqual(result.skipped.map((s) => s.key).sort(), [...fileBacked].sort());
      assert.match(output, /WARN/);
    }
  }
});
