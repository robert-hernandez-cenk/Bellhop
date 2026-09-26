import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicHostname } from '../../src/lib/hostname.ts';

test('publicHostname joins a subdomain label and the domain with a dot', () => {
  assert.equal(publicHostname('app', 'example.com'), 'app.example.com');
});

test('publicHostname works for a different subdomain/domain pair', () => {
  assert.equal(publicHostname('dash', 'example.net'), 'dash.example.net');
});
