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
