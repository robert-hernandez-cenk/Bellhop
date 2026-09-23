import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withCapturedConsole } from '../../src/web/console-capture.ts';

test('captures console.log/console.error output and restores the originals', async () => {
  const origLog = console.log;
  const { text, result } = await withCapturedConsole(async () => {
    console.log('hello');
    console.error('warn: careful');
    return 42;
  });
  assert.equal(text, 'hello\nwarn: careful');
  assert.equal(result, 42);
  assert.equal(console.log, origLog);
});

test('calls onLine synchronously as each line is captured', async () => {
  const seen: string[] = [];
  await withCapturedConsole(async () => {
    console.log('one');
    console.log('two');
  }, (line) => seen.push(line));
  assert.deepEqual(seen, ['one', 'two']);
});

test('two concurrent calls never interleave — each only sees its own lines', async () => {
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const runA = withCapturedConsole(async () => {
    console.log('A1');
    await delay(20);
    console.log('A2');
  });
  const runB = withCapturedConsole(async () => {
    console.log('B1');
  });
  const [a, b] = await Promise.all([runA, runB]);
  assert.equal(a.text, 'A1\nA2');
  assert.equal(b.text, 'B1');
});
