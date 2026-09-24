import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authentikConfig, authentikConfigured, rungsAtOrAbove } from '../../src/lib/authentik-config.ts';

test('authentikConfig defaults to the values this toolkit hardcoded before issue #123', () => {
  const config = authentikConfig({});
  assert.equal(config.adminGroup, 'bellhop-admins');
  assert.equal(config.builtinAdminGroup, 'authentik Admins');
  assert.equal(config.outpostName, 'authentik Embedded Outpost');
  assert.equal(config.outpostPort, 9000);
  assert.equal(config.authorizationFlowSlug, 'default-provider-authorization-implicit-consent');
  assert.equal(config.invalidationFlowSlug, 'default-invalidation-flow');
  assert.equal(config.oidcSigningKeyName, 'authentik Self-signed Certificate');
});

test('authentikConfig honors every override', () => {
  const config = authentikConfig({
    AUTHENTIK_ADMIN_GROUP: 'my-admins',
    AUTHENTIK_BUILTIN_ADMIN_GROUP: 'superusers',
    AUTHENTIK_OUTPOST_NAME: 'my outpost',
    AUTHENTIK_OUTPOST_PORT: '9100',
    AUTHENTIK_AUTHORIZATION_FLOW_SLUG: 'my-auth-flow',
    AUTHENTIK_INVALIDATION_FLOW_SLUG: 'my-invalidation-flow',
    AUTHENTIK_OIDC_SIGNING_KEY_NAME: 'my-signing-key',
  });
  assert.equal(config.adminGroup, 'my-admins');
  assert.equal(config.builtinAdminGroup, 'superusers');
  assert.equal(config.outpostName, 'my outpost');
  assert.equal(config.outpostPort, 9100);
  assert.equal(config.authorizationFlowSlug, 'my-auth-flow');
  assert.equal(config.invalidationFlowSlug, 'my-invalidation-flow');
  assert.equal(config.oidcSigningKeyName, 'my-signing-key');
});

test('authentikConfig treats an empty string as unset', () => {
  const config = authentikConfig({
    AUTHENTIK_ADMIN_GROUP: '',
    AUTHENTIK_OUTPOST_PORT: '',
    AUTHENTIK_OIDC_SIGNING_KEY_NAME: '',
  });
  assert.equal(config.adminGroup, 'bellhop-admins');
  assert.equal(config.outpostPort, 9000);
  assert.equal(config.oidcSigningKeyName, 'authentik Self-signed Certificate');
});

test('authentikConfig rejects a non-numeric outpost port, naming the variable', () => {
  assert.throws(
    () => authentikConfig({ AUTHENTIK_OUTPOST_PORT: 'nine-thousand' }),
    /AUTHENTIK_OUTPOST_PORT must be a positive integer, got: nine-thousand/
  );
});

test('authentikConfig rejects a zero outpost port', () => {
  assert.throws(() => authentikConfig({ AUTHENTIK_OUTPOST_PORT: '0' }), /must be a positive integer/);
});

test('authentikConfigured requires both the API url and the token', () => {
  assert.equal(authentikConfigured({}), false);
  assert.equal(authentikConfigured({ AUTHENTIK_API_URL: 'https://auth.example.com' }), false);
  assert.equal(authentikConfigured({ AUTHENTIK_API_TOKEN: 'secret' }), false);
  assert.equal(authentikConfigured({ AUTHENTIK_API_URL: 'https://auth.example.com', AUTHENTIK_API_TOKEN: 'secret' }), true);
});

test('authentikConfigured treats an empty string as unset', () => {
  assert.equal(authentikConfigured({ AUTHENTIK_API_URL: '', AUTHENTIK_API_TOKEN: 'secret' }), false);
});

test('authentikConfig defaults groupLadder to the four-rung bellhop ladder', () => {
  assert.deepEqual(authentikConfig({}).groupLadder, [
    'bellhop-app-users-open',
    'bellhop-app-users',
    'bellhop-users',
    'authentik Admins',
  ]);
});

test('authentikConfig honors an explicit pre-rename ladder unchanged (documented upgrade path)', () => {
  const config = authentikConfig({
    AUTHENTIK_GROUP_LADDER: 'homelab-app-users-open,homelab-app-users,homelab-users,authentik Admins',
  });
  assert.deepEqual(config.groupLadder, [
    'homelab-app-users-open',
    'homelab-app-users',
    'homelab-users',
    'authentik Admins',
  ]);
});

test('authentikConfig parses AUTHENTIK_GROUP_LADDER, trimming and preserving order', () => {
  const config = authentikConfig({ AUTHENTIK_GROUP_LADDER: ' low , mid ,high ' });
  assert.deepEqual(config.groupLadder, ['low', 'mid', 'high']);
});

test('authentikConfig drops empty ladder entries and collapses duplicates to their first position', () => {
  const config = authentikConfig({ AUTHENTIK_GROUP_LADDER: 'low,,mid,low,high,' });
  assert.deepEqual(config.groupLadder, ['low', 'mid', 'high']);
});

test('authentikConfig falls back to the default ladder when AUTHENTIK_GROUP_LADDER is empty', () => {
  assert.deepEqual(authentikConfig({ AUTHENTIK_GROUP_LADDER: '' }).groupLadder, authentikConfig({}).groupLadder);
});

test('rungsAtOrAbove returns the named rung and every rung above it', () => {
  assert.deepEqual(rungsAtOrAbove(['low', 'mid', 'high'], 'mid'), ['mid', 'high']);
  assert.deepEqual(rungsAtOrAbove(['low', 'mid', 'high'], 'low'), ['low', 'mid', 'high']);
  assert.deepEqual(rungsAtOrAbove(['low', 'mid', 'high'], 'high'), ['high']);
});

test('rungsAtOrAbove returns null for a group that is not on the ladder', () => {
  assert.equal(rungsAtOrAbove(['low', 'mid', 'high'], 'nope'), null);
});
