import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  loadTaskSchedules,
  recordTaskRun,
  saveTaskSchedule,
  TIME_OF_DAY_ERROR,
  isValidTimeOfDay,
} from '../../src/lib/task-schedules.ts';

function tempDbPath(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'task-schedules-')), 'bellhop.db');
}

const TASKS = [{ id: 'check-app-updates', defaultTime: '04:00' }];

test('a missing row reads as the default time, enabled, never run', () => {
  const dbPath = tempDbPath();
  const schedules = loadTaskSchedules(dbPath, TASKS);
  assert.deepEqual(schedules.get('check-app-updates'), {
    timeOfDay: '04:00',
    enabled: true,
    lastRunStartedAt: null,
    lastJobId: null,
  });
});

test('saveTaskSchedule upserts time_of_day/enabled without touching the run columns', () => {
  const dbPath = tempDbPath();
  recordTaskRun(dbPath, 'check-app-updates', { startedAt: '2026-10-02T04:00:01.000Z', jobId: 7 }, '04:00');
  saveTaskSchedule(dbPath, 'check-app-updates', { timeOfDay: '05:30', enabled: false });
  assert.deepEqual(loadTaskSchedules(dbPath, TASKS).get('check-app-updates'), {
    timeOfDay: '05:30',
    enabled: false,
    lastRunStartedAt: '2026-10-02T04:00:01.000Z',
    lastJobId: 7,
  });
});

test('saveTaskSchedule on a fresh db inserts a row with no run recorded', () => {
  const dbPath = tempDbPath();
  saveTaskSchedule(dbPath, 'check-app-updates', { timeOfDay: '23:59', enabled: true });
  assert.deepEqual(loadTaskSchedules(dbPath, TASKS).get('check-app-updates'), {
    timeOfDay: '23:59',
    enabled: true,
    lastRunStartedAt: null,
    lastJobId: null,
  });
});

test('recordTaskRun upserts the run columns and keeps the schedule', () => {
  const dbPath = tempDbPath();
  saveTaskSchedule(dbPath, 'check-app-updates', { timeOfDay: '06:15', enabled: false });
  recordTaskRun(dbPath, 'check-app-updates', { startedAt: '2026-10-03T06:15:00.000Z', jobId: 42 }, '04:00');
  assert.deepEqual(loadTaskSchedules(dbPath, TASKS).get('check-app-updates'), {
    timeOfDay: '06:15',
    enabled: false,
    lastRunStartedAt: '2026-10-03T06:15:00.000Z',
    lastJobId: 42,
  });
});

test('recordTaskRun with no row yet inserts the default schedule alongside the run', () => {
  const dbPath = tempDbPath();
  recordTaskRun(dbPath, 'check-app-updates', { startedAt: '2026-10-03T04:00:00.000Z', jobId: 1 }, '04:00');
  assert.deepEqual(loadTaskSchedules(dbPath, TASKS).get('check-app-updates'), {
    timeOfDay: '04:00',
    enabled: true,
    lastRunStartedAt: '2026-10-03T04:00:00.000Z',
    lastJobId: 1,
  });
});

test('time_of_day must be HH:MM in 24-hour time', () => {
  for (const ok of ['00:00', '04:00', '09:59', '19:30', '23:59']) assert.equal(isValidTimeOfDay(ok), true, ok);
  for (const bad of ['24:00', '4:00', '04:60', '04:0', 'noon', '', '04:00:00', ' 04:00']) {
    assert.equal(isValidTimeOfDay(bad), false, bad);
  }
  const dbPath = tempDbPath();
  assert.throws(() => saveTaskSchedule(dbPath, 'check-app-updates', { timeOfDay: '24:00', enabled: true }), {
    message: TIME_OF_DAY_ERROR,
  });
  assert.equal(TIME_OF_DAY_ERROR, 'timeOfDay must be HH:MM in 24-hour time, e.g. 04:00');
  // Nothing was saved by the rejected call.
  assert.equal(loadTaskSchedules(dbPath, TASKS).get('check-app-updates')!.timeOfDay, '04:00');
});

test('the database itself rejects a malformed time_of_day', () => {
  const dbPath = tempDbPath();
  loadTaskSchedules(dbPath, TASKS); // creates the table
  const db = new Database(dbPath);
  try {
    assert.throws(() =>
      db.prepare(`INSERT INTO task_schedules (task_id, time_of_day, enabled) VALUES ('check-app-updates', '4am', 1)`).run()
    );
  } finally {
    db.close();
  }
});

test('rows for unknown task ids are ignored on read', () => {
  const dbPath = tempDbPath();
  saveTaskSchedule(dbPath, 'retired-task', { timeOfDay: '01:00', enabled: false });
  const schedules = loadTaskSchedules(dbPath, TASKS);
  assert.deepEqual([...schedules.keys()], ['check-app-updates']);
  assert.equal(schedules.get('check-app-updates')!.timeOfDay, '04:00');
});
