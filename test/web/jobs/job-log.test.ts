import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createJobLog } from '../../../src/web/jobs/job-log.ts';

test('append writes chunks in order and read returns the concatenation', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'joblog-'));
  const log = createJobLog(dir);
  log.append('2026-07-30_14-23-05', 'line one\n');
  log.append('2026-07-30_14-23-05', 'line two\n');
  assert.equal(log.read('2026-07-30_14-23-05'), 'line one\nline two\n');
  rmSync(dir, { recursive: true, force: true });
});

test('reading a job with no log yet returns an empty string', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'joblog-'));
  const log = createJobLog(dir);
  assert.equal(log.read('2026-07-30_00-00-00'), '');
  rmSync(dir, { recursive: true, force: true });
});

test('path returns the log file location for a job\'s logFile name', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'joblog-'));
  const log = createJobLog(dir);
  assert.equal(log.path('2026-07-30_14-23-05'), path.join(dir, '2026-07-30_14-23-05.log'));
  rmSync(dir, { recursive: true, force: true });
});
