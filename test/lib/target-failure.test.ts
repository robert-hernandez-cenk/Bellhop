import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  errorMessage,
  exitCodeError,
  formatFailureList,
  formatFailureLines,
} from '../../src/lib/target-failure.ts';

test('errorMessage returns an Error message, or the stringified value for a non-Error throw', () => {
  assert.equal(errorMessage(new Error('connection refused')), 'connection refused');
  assert.equal(errorMessage('plain string'), 'plain string');
});

test('exitCodeError carries trimmed stderr when there is some, and just the exit code otherwise', () => {
  assert.equal(exitCodeError({ stdout: '', stderr: '  no such node\n', code: 2 }).message, 'exit code 2: no such node');
  assert.equal(exitCodeError({ stdout: '', stderr: '', code: 255 }).message, 'exit code 255');
});

test('formatFailureList renders "none" when empty and "target (error)" pairs otherwise', () => {
  assert.equal(formatFailureList([]), 'none');
  assert.equal(
    formatFailureList([
      { target: 'a', error: 'boom' },
      { target: 'b', error: 'bang' },
    ]),
    'a (boom), b (bang)'
  );
});

test('formatFailureLines keeps the one-line "none" form, and lists one indented target per line otherwise', () => {
  assert.deepEqual(formatFailureLines('Failed to connect', []), ['  Failed to connect: none']);
  assert.deepEqual(formatFailureLines('Failed to connect', [{ target: 'pve1', error: 'auth failed' }]), [
    '  Failed to connect:',
    '    pve1: auth failed',
  ]);
});
