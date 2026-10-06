import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessFieldsFor, needsCallbackUrlsBeforeOidc } from '../../web-client/src/lib/oidc.ts';

const FORWARD = ['authGroup', 'authMode', 'unauthenticatedPaths'];
const OIDC = ['authGroup', 'authMode', 'callbackUrls', 'mobileRedirectUrls', 'oidcClient', 'bellhop'];

test('accessFieldsFor on an ungated guest with no authMode returns the forward-auth field set', () => {
  assert.deepEqual(accessFieldsFor({}), FORWARD);
});

test("accessFieldsFor on an ungated 'forward' guest returns the forward-auth field set", () => {
  assert.deepEqual(accessFieldsFor({ authMode: 'forward' }), FORWARD);
});

test("accessFieldsFor on an 'oidc' guest returns the OIDC field set", () => {
  assert.deepEqual(accessFieldsFor({ authMode: 'oidc', authGroup: 'bellhop-users' }), OIDC);
  assert.deepEqual(accessFieldsFor({ authMode: 'oidc' }), OIDC);
});

// F1 (#22 final review): switching a gated guest to OIDC is refused until it
// has a web callback URL, so forward mode must still offer that field then.
test('accessFieldsFor on a gated forward guest with no callback URL adds callback urls', () => {
  const expected = ['authGroup', 'authMode', 'unauthenticatedPaths', 'callbackUrls'];
  assert.deepEqual(accessFieldsFor({ authGroup: 'bellhop-users' }), expected);
  assert.deepEqual(accessFieldsFor({ authGroup: 'bellhop-users', authMode: 'forward', oidcRedirectUris: [] }), expected);
});

test('accessFieldsFor on a gated forward guest that already has a callback URL hides it again', () => {
  assert.deepEqual(
    accessFieldsFor({ authGroup: 'bellhop-users', authMode: 'forward', oidcRedirectUris: ['https://app.example.com/cb'] }),
    FORWARD
  );
});

test('needsCallbackUrlsBeforeOidc is true only for a gated, non-OIDC guest with no callback URL', () => {
  assert.equal(needsCallbackUrlsBeforeOidc({ authGroup: 'bellhop-users' }), true);
  assert.equal(needsCallbackUrlsBeforeOidc({ authGroup: 'bellhop-users', authMode: 'forward' }), true);
  assert.equal(needsCallbackUrlsBeforeOidc({}), false);
  assert.equal(needsCallbackUrlsBeforeOidc({ authGroup: null }), false);
  assert.equal(needsCallbackUrlsBeforeOidc({ authGroup: 'bellhop-users', authMode: 'oidc' }), false);
  assert.equal(
    needsCallbackUrlsBeforeOidc({ authGroup: 'bellhop-users', oidcRedirectUris: ['https://app.example.com/cb'] }),
    false
  );
});

// issue #85: the "this is Bellhop" row. Only an OIDC guest can usefully be
// Bellhop, but a guest already flagged keeps the row in any mode so the flag
// can still be cleared.
test('accessFieldsFor offers the bellhop row to an OIDC guest, and to a flagged forward guest so it can be cleared', () => {
  assert.ok(accessFieldsFor({ authMode: 'oidc', authGroup: 'bellhop-users' }).includes('bellhop'));
  assert.ok(!accessFieldsFor({ authMode: 'forward' }).includes('bellhop'));
  assert.ok(!accessFieldsFor({}).includes('bellhop'));
  assert.deepEqual(accessFieldsFor({ authMode: 'forward', bellhop: true }), [...FORWARD, 'bellhop']);
  assert.deepEqual(accessFieldsFor({ bellhop: true, authGroup: 'bellhop-users', oidcRedirectUris: ['https://bellhop.example.com/auth/callback'] }), [...FORWARD, 'bellhop']);
});
