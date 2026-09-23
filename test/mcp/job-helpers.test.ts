import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageLog, MAX_LOG_CHUNK } from '../../src/mcp/job-helpers.ts';

const long = 'a'.repeat(45_000) + 'END';

test('pageLog pages forward from 0 when no offset is given', () => {
  const page = pageLog(long, undefined);
  assert.equal(page.log.length, MAX_LOG_CHUNK);
  assert.equal(page.nextOffset, MAX_LOG_CHUNK);
  assert.equal(page.hasMore, true);
});

test('pageLog clamps an offset past the end', () => {
  assert.deepEqual(pageLog('abc', 99), { log: '', nextOffset: 3, hasMore: false });
});

test('pageLog fromTail with no offset returns the last chunk', () => {
  const page = pageLog(long, undefined, true);
  assert.equal(page.log.length, MAX_LOG_CHUNK);
  assert.ok(page.log.endsWith('END'));
  assert.equal(page.nextOffset, long.length);
  assert.equal(page.hasMore, false);
});

test('pageLog fromTail still pages forward when an offset is given', () => {
  const page = pageLog(long, 0, true);
  assert.equal(page.nextOffset, MAX_LOG_CHUNK);
  assert.equal(page.hasMore, true);
});

test('pageLog fromTail on a short log returns all of it', () => {
  assert.deepEqual(pageLog('short', undefined, true), { log: 'short', nextOffset: 5, hasMore: false });
});
