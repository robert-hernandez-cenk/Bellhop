import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confirmOrDryRun } from '../../src/lib/dry-run.ts';

test('confirmOrDryRun returns true and logs without a DRY RUN prefix when apply is true', () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);
  try {
    const result = confirmOrDryRun('would do the thing', true);
    assert.equal(result, true);
    assert.ok(logs.some((l) => l.includes('would do the thing') && !l.includes('DRY RUN')));
  } finally {
    console.log = originalLog;
  }
});

test('confirmOrDryRun returns false and logs with a DRY RUN prefix when apply is false', () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);
  try {
    const result = confirmOrDryRun('would do the thing', false);
    assert.equal(result, false);
    assert.ok(logs.some((l) => l.includes('[DRY RUN] would do the thing')));
  } finally {
    console.log = originalLog;
  }
});
