import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidTimeOfDay, lastRunText, nextRunText, taskStatusLabel } from '../../web-client/src/lib/task-display.ts';

const formatTime = (iso: string) => `formatted(${iso})`;

test('isValidTimeOfDay accepts HH:MM in range', () => {
  assert.equal(isValidTimeOfDay('04:00'), true);
  assert.equal(isValidTimeOfDay('00:00'), true);
  assert.equal(isValidTimeOfDay('23:59'), true);
});

test('isValidTimeOfDay rejects an out-of-range or malformed value', () => {
  assert.equal(isValidTimeOfDay('25:00'), false);
  assert.equal(isValidTimeOfDay('24:00'), false);
  assert.equal(isValidTimeOfDay('4:00'), false);
  assert.equal(isValidTimeOfDay('04:60'), false);
  assert.equal(isValidTimeOfDay('not-a-time'), false);
  assert.equal(isValidTimeOfDay(''), false);
});

test('lastRunText reports never run when null', () => {
  assert.equal(lastRunText(null, formatTime), 'Never run');
});

test('lastRunText formats the started time through the injected formatter', () => {
  const text = lastRunText({ startedAt: '2026-10-03T04:00:05.000Z', jobId: 812, status: 'success' }, formatTime);
  assert.equal(text, 'formatted(2026-10-03T04:00:05.000Z)');
});

test('nextRunText reports disabled when null', () => {
  assert.equal(nextRunText(null, formatTime), 'Disabled');
});

test('nextRunText formats the next slot through the injected formatter', () => {
  assert.equal(nextRunText('2026-10-04T04:00:00.000Z', formatTime), 'formatted(2026-10-04T04:00:00.000Z)');
});

test('taskStatusLabel labels every known job status', () => {
  assert.equal(taskStatusLabel('queued'), 'Queued');
  assert.equal(taskStatusLabel('running'), 'Running');
  assert.equal(taskStatusLabel('awaiting_input'), 'Awaiting input');
  assert.equal(taskStatusLabel('success'), 'Success');
  assert.equal(taskStatusLabel('failed'), 'Failed');
  assert.equal(taskStatusLabel('cancelled'), 'Cancelled');
  assert.equal(taskStatusLabel('interrupted'), 'Interrupted');
});

test('taskStatusLabel labels a null status (the job row no longer exists)', () => {
  assert.equal(taskStatusLabel(null), 'Unknown');
});
