import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { promptHidden, readAllStdin } from '../../src/lib/secret-input.ts';

function sink() {
  const out = new PassThrough();
  let text = '';
  out.on('data', (chunk) => (text += chunk.toString()));
  return { out, text: () => text };
}

test('promptHidden shows the question, returns the typed line, and never echoes it', async () => {
  const input = new PassThrough();
  const output = sink();
  const answer = promptHidden('Value for githubApiToken: ', input, output.out);
  input.write('example-token-ECHO-MARKER\n');
  assert.equal(await answer, 'example-token-ECHO-MARKER');
  await new Promise((resolve) => setImmediate(resolve));
  // readline's terminal mode adds cursor-control sequences around the question.
  const shown = output.text().replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
  assert.equal(shown, 'Value for githubApiToken: \n');
  assert.ok(!output.text().includes('ECHO-MARKER'));
});

test('readAllStdin reads the whole stream', async () => {
  const input = new PassThrough();
  const text = readAllStdin(input);
  input.write('example-');
  input.end('token\n');
  assert.equal(await text, 'example-token\n');
});

test('promptHidden rejects when the input ends before a line is entered (final review M10)', async () => {
  const input = new PassThrough();
  const output = sink();
  const answer = promptHidden('Value for githubApiToken: ', input, output.out);
  input.end();
  await assert.rejects(answer, (err: Error) => err.message === 'Cancelled -- nothing was written');
});
