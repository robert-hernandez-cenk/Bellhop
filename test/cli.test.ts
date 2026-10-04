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
