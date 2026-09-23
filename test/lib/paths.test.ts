import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { REPO_ROOT, inventoryPath } from '../../src/lib/paths.ts';

test('inventoryPath defaults to inventory/bellhop.db under the repo root', () => {
  const previous = process.env.INVENTORY_FILE;
  delete process.env.INVENTORY_FILE;
  try {
    // Validate that REPO_ROOT resolves to the actual repository root by checking for
    // known marker files. This catches regressions where REPO_ROOT depth is wrong.
    assert.ok(
      existsSync(path.join(REPO_ROOT, 'package.json')),
      `REPO_ROOT ${REPO_ROOT} should contain package.json`
    );
    assert.ok(
      existsSync(path.join(REPO_ROOT, 'src', 'lib', 'paths.ts')),
      `REPO_ROOT ${REPO_ROOT} should contain src/lib/paths.ts`
    );
    assert.equal(inventoryPath(), path.join(REPO_ROOT, 'inventory', 'bellhop.db'));
  } finally {
    if (previous !== undefined) process.env.INVENTORY_FILE = previous;
  }
});

test('inventoryPath honors INVENTORY_FILE', () => {
  const previous = process.env.INVENTORY_FILE;
  process.env.INVENTORY_FILE = '/tmp/custom.db';
  try {
    assert.equal(inventoryPath(), '/tmp/custom.db');
  } finally {
    if (previous === undefined) delete process.env.INVENTORY_FILE;
    else process.env.INVENTORY_FILE = previous;
  }
});
