import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'src', 'cli.ts');

test('bellhop --help prints the program name and description', () => {
  const output = execFileSync(process.execPath, ['--import', 'tsx', cliPath, '--help'], {
    encoding: 'utf8',
  });
  assert.match(output, /bellhop/);
  assert.match(output, /CLI toolkit for managing a Proxmox homelab cluster over SSH/);
});

test('prune-acme-challenges --help documents the --apply flag', () => {
  const output = execFileSync(process.execPath, ['--import', 'tsx', cliPath, 'prune-acme-challenges', '--help'], {
    encoding: 'utf8',
  });
  assert.match(output, /prune-acme-challenges/);
  assert.match(output, /--apply/);
  assert.match(output, /_acme-challenge/);
});

test('convert-caddyfile --help documents --caddyfile and --apply', () => {
  const output = execFileSync(process.execPath, ['--import', 'tsx', cliPath, 'convert-caddyfile', '--help'], {
    encoding: 'utf8',
  });
  assert.match(output, /convert-caddyfile/);
  assert.match(output, /--caddyfile <path>/);
  assert.match(output, /--apply/);
});

test('set-config --help lists every setting key', async () => {
  const { SETTINGS_KEYS } = await import('../src/lib/inventory.ts');
  const output = execFileSync(process.execPath, ['--import', 'tsx', cliPath, 'set-config', '--help'], {
    encoding: 'utf8',
  });
  // commander wraps long descriptions, so compare on whitespace-collapsed text.
  const flat = output.replace(/\s+/g, ' ');
  for (const key of SETTINGS_KEYS) {
    assert.ok(flat.includes(key), `set-config --help should list ${key}`);
  }
});

test('check-app-updates --help documents --guest and --apply', () => {
  const output = execFileSync(process.execPath, ['--import', 'tsx', cliPath, 'check-app-updates', '--help'], {
    encoding: 'utf8',
  });
  assert.match(output, /check-app-updates/);
  assert.match(output, /--guest <name>/);
  assert.match(output, /--apply/);
});

test('backfill-guest-creators --help documents --map and --apply', () => {
  const output = execFileSync(process.execPath, ['--import', 'tsx', cliPath, 'backfill-guest-creators', '--help'], {
    encoding: 'utf8',
  });
  assert.match(output, /backfill-guest-creators/);
  assert.match(output, /--map <old=new>/);
  assert.match(output, /--apply/);
});

test('backfill-guest-creators fails with the not-configured message when Authentik is unset', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { saveInventory } = await import('../src/lib/inventory.ts');
  const { UNCONFIGURED_MESSAGE } = await import('../src/lib/authentik-client.ts');
  const dir = mkdtempSync(path.join(tmpdir(), 'backfill-cli-'));
  const inventoryFile = path.join(dir, 'bellhop.db');
  saveInventory(inventoryFile, { domain: 'example.com', hosts: [], guests: [] });
  const env: NodeJS.ProcessEnv = { ...process.env, INVENTORY_FILE: inventoryFile, WEB_DATA_DIR: dir };
  delete env.AUTHENTIK_API_URL;
  delete env.AUTHENTIK_API_TOKEN;
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(process.execPath, ['--import', 'tsx', cliPath, 'backfill-guest-creators'], { encoding: 'utf8', env });
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(UNCONFIGURED_MESSAGE) || result.stdout.includes(UNCONFIGURED_MESSAGE));
});

// -- Issue #64 US2: set-config never takes or prints a secret ----------------

async function setConfigCli(args: string[], input: string, seed?: (inventoryFile: string) => void) {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { saveInventory } = await import('../src/lib/inventory.ts');
  const { SETTING_DEFS } = await import('../src/lib/settings-defs.ts');
  const { spawnSync } = await import('node:child_process');
  const dir = mkdtempSync(path.join(tmpdir(), 'set-config-cli-'));
  const inventoryFile = path.join(dir, 'bellhop.db');
  saveInventory(inventoryFile, { domain: 'example.com', hosts: [], guests: [] });
  seed?.(inventoryFile);
  // WEB_DATA_DIR points at the empty temp dir so no data/*.env is loaded, and
  // every setting's variable is removed so nothing pins a key.
  const env: NodeJS.ProcessEnv = { ...process.env, INVENTORY_FILE: inventoryFile, WEB_DATA_DIR: dir };
  for (const def of Object.values(SETTING_DEFS)) delete env[def.envVar];
  // `input` makes standard input a pipe, never a terminal.
  const result = spawnSync(process.execPath, ['--import', 'tsx', cliPath, 'set-config', ...args], { encoding: 'utf8', env, input });
  return { result, inventoryFile, output: `${result.stdout}\n${result.stderr}` };
}

test('set-config refuses a secret passed as an argument and stores nothing', async () => {
  const { configValueAt } = await import('../src/lib/config.ts');
  const { result, inventoryFile, output } = await setConfigCli(['githubApiToken', 'example-github-ARG-MARKER', '--apply'], '');
  assert.equal(result.status, 1);
  assert.ok(
    output.includes(
      'githubApiToken is a secret -- pass it on standard input with --stdin (or omit the value to be prompted), never as an argument'
    )
  );
  assert.ok(!output.includes('ARG-MARKER'));
  assert.equal(configValueAt(inventoryFile, 'githubApiToken', {}).value, undefined);
});

test('set-config --stdin --apply stores a secret, prints Set <key> in <path>, never the value', async () => {
  const { configValueAt } = await import('../src/lib/config.ts');
  const { result, inventoryFile, output } = await setConfigCli(
    ['cloudflareDnsApiToken', '--stdin', '--apply'],
    'example-cf-STDIN-MARKER\n'
  );
  assert.equal(result.status, 0, output);
  assert.ok(output.includes(`Set cloudflareDnsApiToken in ${inventoryFile}`));
  assert.ok(!output.includes('STDIN-MARKER'));
  assert.equal(configValueAt(inventoryFile, 'cloudflareDnsApiToken', {}).value, 'example-cf-STDIN-MARKER');
});

test('set-config --stdin dry run prints the hidden line and writes nothing', async () => {
  const { configValueAt } = await import('../src/lib/config.ts');
  const { result, inventoryFile, output } = await setConfigCli(['npmApiPassword', '--stdin'], 'example npm DRY-MARKER\n');
  assert.equal(result.status, 0, output);
  assert.match(output, /Would set npmApiPassword \(value hidden\)/);
  assert.ok(!output.includes('DRY-MARKER'));
  assert.equal(configValueAt(inventoryFile, 'npmApiPassword', {}).value, undefined);
});

test('set-config with no value for a secret and no terminal is refused, naming --stdin', async () => {
  const { result, output } = await setConfigCli(['authentikApiToken', '--apply'], '');
  assert.equal(result.status, 1);
  assert.match(output, /authentikApiToken is a secret and standard input is not a terminal -- pass the value with --stdin/);
});

test('set-config --stdin refuses an empty secret, and --unset clears one', async () => {
  const empty = await setConfigCli(['githubApiToken', '--stdin', '--apply'], '\n');
  assert.equal(empty.result.status, 1);
  assert.match(empty.output, /githubApiToken: no value on standard input -- use --unset to clear it/);

  const { configValueAt, writeSecret } = await import('../src/lib/config.ts');
  const cleared = await setConfigCli(['githubApiToken', '--unset', '--apply'], '', (file) =>
    writeSecret(file, 'githubApiToken', 'example-github-token')
  );
  assert.equal(cleared.result.status, 0, cleared.output);
  assert.ok(cleared.result.stdout.includes(`Cleared githubApiToken in ${cleared.inventoryFile}`));
  assert.equal(configValueAt(cleared.inventoryFile, 'githubApiToken', {}).value, undefined);
});

test('set-config --stdin works for a non-secret key, which is printed as before', async () => {
  const { loadInventory } = await import('../src/lib/inventory.ts');
  const { result, inventoryFile } = await setConfigCli(['dnsServer', '--stdin', '--apply'], '192.0.2.53\n');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`Set dnsServer to 192.0.2.53 in ${inventoryFile}`));
  assert.equal(loadInventory(inventoryFile).dnsServer, '192.0.2.53');
});

test('set-config --help documents --stdin and lists the secret keys', async () => {
  const { SECRET_SETTINGS_KEYS } = await import('../src/lib/settings-defs.ts');
  const output = execFileSync(process.execPath, ['--import', 'tsx', cliPath, 'set-config', '--help'], { encoding: 'utf8' });
  const flat = output.replace(/\s+/g, ' ');
  assert.match(flat, /--stdin/);
  for (const key of SECRET_SETTINGS_KEYS) assert.ok(flat.includes(key), `set-config --help should list ${key}`);
});
