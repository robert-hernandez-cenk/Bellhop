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

// readBytes underlies the foreign-job tailer (src/web/jobs/job-tail.ts,
// issue #6): a non-owning process can't rely on JobRunner's in-memory
// 'chunk' events for a job it doesn't own, so it polls the log file's raw
// bytes from a byte offset instead.
test('readBytes returns the bytes from the given offset', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'joblog-'));
  const log = createJobLog(dir);
  log.append('2026-07-30_14-23-05', 'line one\n');
  log.append('2026-07-30_14-23-05', 'line two\n');
  const all = log.readBytes('2026-07-30_14-23-05', 0);
  assert.equal(all.toString('utf8'), 'line one\nline two\n');
  const rest = log.readBytes('2026-07-30_14-23-05', 'line one\n'.length);
  assert.equal(rest.toString('utf8'), 'line two\n');
  rmSync(dir, { recursive: true, force: true });
});

test('readBytes returns an empty buffer for a missing file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'joblog-'));
  const log = createJobLog(dir);
  const bytes = log.readBytes('2026-07-30_00-00-00', 0);
  assert.equal(bytes.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('readBytes returns an empty buffer for an offset at or past the end of the file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'joblog-'));
  const log = createJobLog(dir);
  log.append('2026-07-30_14-23-05', 'line one\n');
  const atEnd = log.readBytes('2026-07-30_14-23-05', 'line one\n'.length);
  assert.equal(atEnd.length, 0);
  const pastEnd = log.readBytes('2026-07-30_14-23-05', 'line one\n'.length + 100);
  assert.equal(pastEnd.length, 0);
  rmSync(dir, { recursive: true, force: true });
});
