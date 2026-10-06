import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { webLoginConfig } from '../../../src/web/login/config.ts';
import { resetConfigStore, tempConfigStore } from '../../support/config-store.ts';
import { resetManagedWebLogin } from '../../../src/web/login/managed.ts';
import { resolveManagedLogin, bellhopInventory, MANAGED_CLIENT_ID, MANAGED_ISSUER, MANAGED_REDIRECT_URI, MANAGED_SECRET } from '../../support/managed-login.ts';

afterEach(() => {
  resetConfigStore();
  resetManagedWebLogin();
});

const ENV = {
  WEB_UI_OIDC_ISSUER: 'https://authentik.example.com/application/o/bellhop/',
  WEB_UI_OIDC_CLIENT_ID: 'example-client-id',
  WEB_UI_OIDC_REDIRECT_URI: 'https://bellhop.example.com/auth/callback',
  WEB_UI_OIDC_CLIENT_SECRET: 'example-token',
};

test('webLoginConfig is configured when all four settings resolve (environment)', () => {
  resetConfigStore();
  assert.deepEqual(webLoginConfig(ENV), {
    configured: true,
    issuer: ENV.WEB_UI_OIDC_ISSUER,
    clientId: 'example-client-id',
    clientSecret: 'example-token',
    redirectUri: ENV.WEB_UI_OIDC_REDIRECT_URI,
  });
});

test('webLoginConfig reads stored settings and the stored secret', () => {
  tempConfigStore(
    {
      webUiOidcIssuer: ENV.WEB_UI_OIDC_ISSUER,
      webUiOidcClientId: 'example-client-id',
      webUiOidcRedirectUri: ENV.WEB_UI_OIDC_REDIRECT_URI,
    },
    { webUiOidcClientSecret: 'stored-example-token' }
  );
  assert.deepEqual(webLoginConfig({}), {
    configured: true,
    issuer: ENV.WEB_UI_OIDC_ISSUER,
    clientId: 'example-client-id',
    clientSecret: 'stored-example-token',
    redirectUri: ENV.WEB_UI_OIDC_REDIRECT_URI,
  });
});

test('webLoginConfig names every missing key, never a value', () => {
  resetConfigStore();
  const result = webLoginConfig({ WEB_UI_OIDC_ISSUER: ENV.WEB_UI_OIDC_ISSUER, WEB_UI_OIDC_CLIENT_SECRET: 'example-token' });
  assert.deepEqual(result, { configured: false, missing: ['webUiOidcClientId', 'webUiOidcRedirectUri'] });
  assert.deepEqual(webLoginConfig({}), {
    configured: false,
    missing: ['webUiOidcIssuer', 'webUiOidcClientId', 'webUiOidcRedirectUri', 'webUiOidcClientSecret'],
  });
});

// configValue validates stored values but passes an environment override
// through as-is, so webLoginConfig checks each env-sourced OIDC value itself.
// The error names the key and its env var, never the value -- the secret's
// value in particular must not reach a log or an HTTP page.
test('webLoginConfig rejects an invalid environment value, naming the key and env var but not the value', () => {
  resetConfigStore();
  const cases: Array<[keyof typeof ENV, string, string]> = [
    ['WEB_UI_OIDC_ISSUER', 'not-a-url-example', 'webUiOidcIssuer'],
    ['WEB_UI_OIDC_REDIRECT_URI', 'https://bellhop.example.com/wrong-path', 'webUiOidcRedirectUri'],
    ['WEB_UI_OIDC_CLIENT_SECRET', 'example token with spaces', 'webUiOidcClientSecret'],
  ];
  for (const [envVar, bad, key] of cases) {
    assert.throws(
      () => webLoginConfig({ ...ENV, [envVar]: bad }),
      (err: Error) => {
        assert.match(err.message, new RegExp(key));
        assert.match(err.message, new RegExp(envVar));
        assert.ok(!err.message.includes(bad), `message leaked the value: ${err.message}`);
        return true;
      }
    );
  }
});

test('webLoginConfig accepts a valid environment value even when another key comes from the store', () => {
  tempConfigStore({ webUiOidcClientId: 'example-client-id' }, { webUiOidcClientSecret: 'stored-example-token' });
  const result = webLoginConfig({
    WEB_UI_OIDC_ISSUER: ENV.WEB_UI_OIDC_ISSUER,
    WEB_UI_OIDC_REDIRECT_URI: ENV.WEB_UI_OIDC_REDIRECT_URI,
  });
  assert.equal(result.configured, true);
});

// issue #85: the flagged guest's client is the fallback when the custom set is not complete.
const MANAGED_CONFIG = {
  configured: true,
  issuer: MANAGED_ISSUER,
  clientId: MANAGED_CLIENT_ID,
  clientSecret: MANAGED_SECRET,
  redirectUri: MANAGED_REDIRECT_URI,
} as const;

test('webLoginConfig falls back to the managed guest when no custom setting is set', async () => {
  resetConfigStore();
  await resolveManagedLogin();
  assert.deepEqual(webLoginConfig({}), MANAGED_CONFIG);
});

test('a complete custom set wins over a resolved managed guest', async () => {
  resetConfigStore();
  await resolveManagedLogin();
  assert.deepEqual(webLoginConfig(ENV), {
    configured: true,
    issuer: ENV.WEB_UI_OIDC_ISSUER,
    clientId: 'example-client-id',
    clientSecret: 'example-token',
    redirectUri: ENV.WEB_UI_OIDC_REDIRECT_URI,
  });
});

test('a partial custom set is not mixed with the managed guest: the managed client is used whole', async () => {
  resetConfigStore();
  await resolveManagedLogin();
  const result = webLoginConfig({ WEB_UI_OIDC_ISSUER: ENV.WEB_UI_OIDC_ISSUER, WEB_UI_OIDC_CLIENT_ID: 'example-client-id' });
  assert.deepEqual(result, MANAGED_CONFIG);
});

test('with neither source usable, webLoginConfig names the missing custom keys', async () => {
  resetConfigStore();
  await resolveManagedLogin(bellhopInventory({ bellhop: undefined }));
  assert.deepEqual(webLoginConfig({}), {
    configured: false,
    missing: ['webUiOidcIssuer', 'webUiOidcClientId', 'webUiOidcRedirectUri', 'webUiOidcClientSecret'],
  });
});

test('an invalid environment value still throws when a managed guest could take over', async () => {
  resetConfigStore();
  await resolveManagedLogin();
  assert.throws(() => webLoginConfig({ ...ENV, WEB_UI_OIDC_REDIRECT_URI: 'not a url' }), /WEB_UI_OIDC_REDIRECT_URI/);
});
