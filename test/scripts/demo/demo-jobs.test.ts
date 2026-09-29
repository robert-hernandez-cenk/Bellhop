import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JobStore } from '../../../src/web/jobs/job-store.ts';
import { createJobLog } from '../../../src/web/jobs/job-log.ts';
import { seedDemoJobs, DEMO_JOB_LOGS } from '../../../scripts/demo/demo-jobs.ts';

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'bellhop-demo-jobs-'));
}

test('seedDemoJobs creates the four expected jobs with the expected statuses', () => {
  const dir = tempDir();
  const dbPath = path.join(dir, 'jobs.sqlite3');
  const store = new JobStore(dbPath);
  const jobLog = createJobLog(path.join(dir, 'job-logs'));
  try {
    seedDemoJobs(store, jobLog, dbPath, 'web');
    const jobs = store.list();
    assert.equal(jobs.length, 4);

    const byCommand = new Map(jobs.map((j) => [j.command, j]));
    assert.ok(byCommand.has('install-app'), 'expected an install-app job');
    assert.ok(byCommand.has('update-all'), 'expected an update-all job');
    assert.ok(byCommand.has('sync-inventory'), 'expected a sync-inventory job');
    assert.ok(byCommand.has('update-app'), 'expected an update-app job');

    assert.equal(byCommand.get('install-app')!.status, 'success');
    assert.equal(byCommand.get('update-all')!.status, 'success');
    assert.equal(byCommand.get('sync-inventory')!.status, 'success');
    assert.equal(byCommand.get('update-app')!.status, 'failed');

    for (const job of jobs) {
      assert.equal(job.triggeredByUsername, 'admin', `job ${job.command} triggeredByUsername`);
      assert.equal(job.owner, 'web');
    }
  } finally {
    store.close();
  }
});

test('seedDemoJobs writes fixed ISO timestamps on one date, a few minutes apart', () => {
  const dir = tempDir();
  const dbPath = path.join(dir, 'jobs.sqlite3');
  const store = new JobStore(dbPath);
  const jobLog = createJobLog(path.join(dir, 'job-logs'));
  try {
    seedDemoJobs(store, jobLog, dbPath, 'web');
    const jobs = store.list();

    const dates = new Set<string>();
    for (const job of jobs) {
      assert.ok(job.startedAt, `job ${job.command} has no startedAt`);
      assert.ok(job.finishedAt, `job ${job.command} has no finishedAt`);
      // ISO 8601, same shape new Date().toISOString() produces.
      assert.match(job.startedAt!, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      assert.match(job.finishedAt!, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      dates.add(job.startedAt!.slice(0, 10));
      assert.ok(Date.parse(job.finishedAt!) >= Date.parse(job.startedAt!), `job ${job.command} finished before it started`);
    }
    assert.equal(dates.size, 1, 'expected every seeded job on the same fixed date');

    // Distinct, increasing start times a few minutes apart -- never a
    // fresh Date.now() call, which would make this test flaky.
    const startedMs = jobs.map((j) => Date.parse(j.startedAt!)).sort((a, b) => a - b);
    for (let i = 1; i < startedMs.length; i++) {
      const gapMinutes = (startedMs[i] - startedMs[i - 1]) / 60000;
      assert.ok(gapMinutes >= 1, `expected seeded jobs a few minutes apart, got a ${gapMinutes}-minute gap`);
    }
  } finally {
    store.close();
  }
});

test('seedDemoJobs writes a plausible, demo-only log for every job', () => {
  const dir = tempDir();
  const dbPath = path.join(dir, 'jobs.sqlite3');
  const store = new JobStore(dbPath);
  const jobLog = createJobLog(path.join(dir, 'job-logs'));
  try {
    seedDemoJobs(store, jobLog, dbPath, 'web');
    const jobs = store.list();
    for (const job of jobs) {
      const log = jobLog.read(job.logFile);
      assert.ok(log.length > 0, `job ${job.command} has an empty log`);
      const lineCount = log.trim().split('\n').length;
      assert.ok(lineCount >= 15 && lineCount <= 40, `job ${job.command} log has ${lineCount} lines, expected 15-40`);
    }
  } finally {
    store.close();
  }
});

test('exported log fixtures are non-empty and within the 15-40 line budget', () => {
  const names = Object.keys(DEMO_JOB_LOGS);
  assert.equal(names.length, 4);
  for (const name of names) {
    const log = DEMO_JOB_LOGS[name as keyof typeof DEMO_JOB_LOGS];
    const lineCount = log.trim().split('\n').length;
    assert.ok(lineCount >= 15 && lineCount <= 40, `${name} log has ${lineCount} lines, expected 15-40`);
  }
});
