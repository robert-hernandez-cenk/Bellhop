import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHIM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'bellhop.js');

// Issue #67: the LXC container's /usr/local/bin/bellhop wrapper (and any
// `npm link`ed bellhop) runs the shim from wherever the operator is, not the
// repository root.
test('the bellhop shim runs from a directory outside the repository', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'bellhop-shim-'));
  const result = spawnSync(process.execPath, [SHIM, '--help'], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: bellhop/);
});
