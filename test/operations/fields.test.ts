import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { reqStr, optStr, reqInt, optInt, flag, portStr } from '../../src/operations/fields.ts';

const schema = z.object({
  name: reqStr('Name'),
  note: optStr('Note'),
  mid: reqInt('MID'),
  cores: optInt('Cores'),
  cloudInit: flag('Cloud-init'),
  port: portStr('Port'),
});

test('web form strings and typed values parse to the same result', () => {
  const fromForm = schema.parse({ name: 'a', note: '', mid: '4', cores: '', cloudInit: 'true', port: '8080' });
  const typed = schema.parse({ name: 'a', mid: 4, cloudInit: true, port: 8080 });
  // A blank field parses to an explicit `undefined` value when its key was
  // present in the raw input (Zod's own object-parsing behavior for a known
  // shape key present in the source data, vs. a key never given at all) --
  // behaviorally identical for every reader of the parsed object, since
  // nothing here ever checks `'field' in input` rather than
  // `input.field !== undefined`. Normalize both sides through a JSON
  // round-trip (which drops undefined-valued keys) before comparing, so the
  // assertion reflects that equivalence instead of this incidental
  // key-presence difference.
  const normalize = (v: unknown) => JSON.parse(JSON.stringify(v));
  assert.deepEqual(normalize(fromForm), { name: 'a', mid: 4, cloudInit: true, port: '8080' });
  assert.deepEqual(normalize(typed), normalize(fromForm));
});

test('flag maps the string false to false and blank to undefined', () => {
  assert.equal(schema.parse({ name: 'a', mid: 1, cloudInit: 'false' }).cloudInit, false);
  assert.equal(schema.parse({ name: 'a', mid: 1, cloudInit: '' }).cloudInit, undefined);
});

test('reqInt rejects a blank or non-numeric value', () => {
  assert.equal(schema.safeParse({ name: 'a', mid: '' }).success, false);
  assert.equal(schema.safeParse({ name: 'a', mid: 'x' }).success, false);
});

test('reqStr requires presence but not non-emptiness -- commands keep their own validation', () => {
  assert.equal(schema.safeParse({ mid: 1 }).success, false);
  assert.equal(schema.parse({ name: '', mid: 1 }).name, '');
});

test('absent optional keys stay absent', () => {
  const parsed = schema.parse({ name: 'a', mid: 1 });
  assert.equal('note' in parsed, false);
  assert.equal('cores' in parsed, false);
});

test('portStr rejects a non-whole-number or out-of-range port at parse time', () => {
  const port = z.object({ port: portStr('Port') });
  assert.equal(port.parse({ port: '8080' }).port, '8080');
  assert.equal(port.parse({ port: 65535 }).port, '65535');
  assert.equal(port.parse({ port: '' }).port, undefined);
  for (const bad of ['0', '65536', '80.5', 'abc', '-1', 70000]) {
    const result = port.safeParse({ port: bad });
    assert.equal(result.success, false, `port ${bad} should be rejected`);
    assert.equal(result.error!.issues[0].message, `Invalid port '${bad}' (must be a whole number from 1 to 65535)`);
  }
});
