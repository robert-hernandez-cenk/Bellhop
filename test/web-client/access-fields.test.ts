import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessFieldsFor, needsCallbackUrlsBeforeOidc } from '../../web-client/src/lib/oidc.ts';

const FORWARD = ['authGroup', 'authMode', 'unauthenticatedPaths'];
const OIDC = ['authGroup', 'authMode', 'callbackUrls', 'mobileRedirectUrls', 'oidcClient'];

test('accessFieldsFor on an ungated guest with no authMode returns the forward-auth field set', () => {
  assert.deepEqual(accessFieldsFor({}), FORWARD);
});

test("accessFieldsFor on an ungated 'forward' guest returns the forward-auth field set", () => {
  assert.deepEqual(accessFieldsFor({ authMode: 'forward' }), FORWARD);
});

test("accessFieldsFor on an 'oidc' guest returns the OIDC field set", () => {
  assert.deepEqual(accessFieldsFor({ authMode: 'oidc', authGroup: 'bellhop-admin-family' }), OIDC);
  assert.deepEqual(accessFieldsFor({ authMode: 'oidc' }), OIDC);
});

// F1 (#22 final review): switching a gated guest to OIDC is refused until it
// has a web callback URL, so forward mode must still offer that field then.
test('accessFieldsFor on a gated forward guest with no callback URL adds callback urls', () => {
  const expected = ['authGroup', 'authMode', 'unauthenticatedPaths', 'callbackUrls'];
  assert.deepEqual(accessFieldsFor({ authGroup: 'bellhop-admin-family' }), expected);
  assert.deepEqual(accessFieldsFor({ authGroup: 'bellhop-admin-family', authMode: 'forward', oidcRedirectUris: [] }), expected);
});

test('accessFieldsFor on a gated forward guest that already has a callback URL hides it again', () => {
  assert.deepEqual(
    accessFieldsFor({ authGroup: 'bellhop-admin-family', authMode: 'forward', oidcRedirectUris: ['https://app.example.com/cb'] }),
    FORWARD
  );
});

test('needsCallbackUrlsBeforeOidc is true only for a gated, non-OIDC guest with no callback URL', () => {
  assert.equal(needsCallbackUrlsBeforeOidc({ authGroup: 'bellhop-admin-family' }), true);
  assert.equal(needsCallbackUrlsBeforeOidc({ authGroup: 'bellhop-admin-family', authMode: 'forward' }), true);
  assert.equal(needsCallbackUrlsBeforeOidc({}), false);
  assert.equal(needsCallbackUrlsBeforeOidc({ authGroup: null }), false);
  assert.equal(needsCallbackUrlsBeforeOidc({ authGroup: 'bellhop-admin-family', authMode: 'oidc' }), false);
  assert.equal(
    needsCallbackUrlsBeforeOidc({ authGroup: 'bellhop-admin-family', oidcRedirectUris: ['https://app.example.com/cb'] }),
    false
  );
});
