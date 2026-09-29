import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessFieldsFor } from '../../web-client/src/lib/oidc.ts';

test('accessFieldsFor(undefined) returns the forward-auth field set', () => {
  assert.deepEqual(accessFieldsFor(undefined), ['authGroup', 'authMode', 'unauthenticatedPaths']);
});

test("accessFieldsFor('forward') returns the forward-auth field set", () => {
  assert.deepEqual(accessFieldsFor('forward'), ['authGroup', 'authMode', 'unauthenticatedPaths']);
});

test("accessFieldsFor('oidc') returns the OIDC field set", () => {
  assert.deepEqual(accessFieldsFor('oidc'), [
    'authGroup',
    'authMode',
    'callbackUrls',
    'mobileRedirectUrls',
    'oidcClient',
  ]);
});
