import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { webLoginConfig } from '../../../src/web/login/config.ts';
import { resetConfigStore, tempConfigStore } from '../../support/config-store.ts';

afterEach(resetConfigStore);

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
