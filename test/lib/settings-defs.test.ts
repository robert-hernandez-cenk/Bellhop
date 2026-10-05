import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MovedSettingsSchema,
  SecretSettingsSchema,
  SECRET_SETTINGS_KEYS,
  SETTING_DEFS,
} from '../../src/lib/settings-defs.ts';
import { SETTINGS_KEYS, SettingsSchema } from '../../src/lib/inventory.ts';

// data-model.md's table, verbatim: key -> [env var, group, secret].
const EXPECTED: Record<string, [string, string, boolean]> = {
  authentikApiUrl: ['AUTHENTIK_API_URL', 'authentik', false],
  authentikApiToken: ['AUTHENTIK_API_TOKEN', 'authentik', true],
  authentikAdminGroup: ['AUTHENTIK_ADMIN_GROUP', 'authentik', false],
  authentikBuiltinAdminGroup: ['AUTHENTIK_BUILTIN_ADMIN_GROUP', 'authentik', false],
  authentikGroupLadder: ['AUTHENTIK_GROUP_LADDER', 'authentik', false],
  authentikOutpostName: ['AUTHENTIK_OUTPOST_NAME', 'authentik', false],
  authentikOutpostPort: ['AUTHENTIK_OUTPOST_PORT', 'authentik', false],
  authentikAuthorizationFlowSlug: ['AUTHENTIK_AUTHORIZATION_FLOW_SLUG', 'authentik', false],
  authentikInvalidationFlowSlug: ['AUTHENTIK_INVALIDATION_FLOW_SLUG', 'authentik', false],
  authentikOidcSigningKeyName: ['AUTHENTIK_OIDC_SIGNING_KEY_NAME', 'authentik', false],
  webUiAuthMode: ['WEB_UI_AUTH_MODE', 'general', false],
  cloudflareDnsApiToken: ['CLOUDFLARE_DNS_API_TOKEN', 'cloudflare', true],
  // issue #73: these three now sit in the proxy group, not their own --
  // envVar/secret/envFile are unchanged.
  npmApiUrl: ['NPM_API_URL', 'proxy', false],
  npmApiEmail: ['NPM_API_EMAIL', 'proxy', false],
  npmApiPassword: ['NPM_API_PASSWORD', 'proxy', true],
  githubApiToken: ['GITHUB_API_TOKEN', 'github', true],
  // #69: Bellhop's own OIDC web login.
  webUiOidcIssuer: ['WEB_UI_OIDC_ISSUER', 'general', false],
  webUiOidcClientId: ['WEB_UI_OIDC_CLIENT_ID', 'general', false],
  webUiOidcRedirectUri: ['WEB_UI_OIDC_REDIRECT_URI', 'general', false],
  webUiOidcClientSecret: ['WEB_UI_OIDC_CLIENT_SECRET', 'general', true],
  // #65/#66: the HTTP MCP endpoint's API key, on its own MCP tab.
  mcpApiKey: ['MCP_API_KEY', 'mcp', true],
};

// The data/ file each variable lived in before #64 -- named in the Settings
// page's env-pinned refusal. githubApiToken is new and never had one.
function expectedEnvFile(envVar: string): string | undefined {
  if (envVar.startsWith('AUTHENTIK_') || envVar === 'WEB_UI_AUTH_MODE' || envVar.startsWith('WEB_UI_OIDC_')) return 'authentik.env';
  if (envVar === 'CLOUDFLARE_DNS_API_TOKEN') return 'cloudflare-api.env';
  if (envVar.startsWith('NPM_API_')) return 'nginx-proxy-manager.env';
  return undefined;
}

const MOVED_NON_SECRET = Object.keys(EXPECTED).filter((k) => !EXPECTED[k][2]);

test('SETTING_DEFS carries exactly the env var, group, secret flag and env file from data-model.md', () => {
  assert.deepEqual(Object.keys(SETTING_DEFS).sort(), Object.keys(EXPECTED).sort());
  for (const [key, [envVar, group, secret]] of Object.entries(EXPECTED)) {
    const envFile = expectedEnvFile(envVar);
    assert.deepEqual(
      SETTING_DEFS[key as keyof typeof SETTING_DEFS],
      envFile === undefined ? { envVar, group, secret } : { envVar, group, secret, envFile },
      key
    );
  }
});

test('SETTINGS_KEYS includes the 15 non-secret moved keys and no secret key', () => {
  assert.equal(MOVED_NON_SECRET.length, 15);
  for (const key of MOVED_NON_SECRET) {
    assert.ok((SETTINGS_KEYS as string[]).includes(key), `${key} missing from SETTINGS_KEYS`);
  }
  for (const key of SECRET_SETTINGS_KEYS) {
    assert.ok(!(SETTINGS_KEYS as string[]).includes(key), `${key} must not be a meta setting`);
  }
  assert.deepEqual(Object.keys(MovedSettingsSchema.shape).sort(), MOVED_NON_SECRET.sort());
});

test('SECRET_SETTINGS_KEYS is exactly the six tokens/passwords/keys', () => {
  assert.deepEqual(
    [...SECRET_SETTINGS_KEYS].sort(),
    ['authentikApiToken', 'cloudflareDnsApiToken', 'githubApiToken', 'mcpApiKey', 'npmApiPassword', 'webUiOidcClientSecret']
  );
  assert.deepEqual(Object.keys(SecretSettingsSchema.shape).sort(), [...SECRET_SETTINGS_KEYS].sort());
});

function accepts(schema: typeof SettingsSchema | typeof SecretSettingsSchema, key: string, value: string): boolean {
  return schema.safeParse({ [key]: value }).success;
}

test('http(s) URL rule for authentikApiUrl and npmApiUrl', () => {
  for (const key of ['authentikApiUrl', 'npmApiUrl']) {
    assert.ok(accepts(SettingsSchema, key, 'https://auth.example.com'), key);
    assert.ok(accepts(SettingsSchema, key, 'http://192.0.2.10:81'), key);
    assert.ok(!accepts(SettingsSchema, key, 'ftp://auth.example.com'), key);
    assert.ok(!accepts(SettingsSchema, key, 'not a url'), key);
    assert.ok(!accepts(SettingsSchema, key, ''), key);
  }
});

test('positive integer string rule for authentikOutpostPort', () => {
  assert.ok(accepts(SettingsSchema, 'authentikOutpostPort', '9000'));
  for (const bad of ['0', '-1', '90.5', 'abc', '', ' 9000']) {
    assert.ok(!accepts(SettingsSchema, 'authentikOutpostPort', bad), bad);
  }
});

test('webUiAuthMode accepts exactly oidc | none', () => {
  for (const ok of ['oidc', 'none']) assert.ok(accepts(SettingsSchema, 'webUiAuthMode', ok), ok);
  for (const bad of ['auto', 'authentik', 'Oidc', '']) assert.ok(!accepts(SettingsSchema, 'webUiAuthMode', bad), bad);
  const result = SettingsSchema.safeParse({ webUiAuthMode: 'auto' });
  assert.ok(!result.success);
  assert.deepEqual(result.error.issues.map((i) => i.message), ['must be one of: oidc, none']);
});

test('webUiOidcIssuer is an http(s) URL; webUiOidcClientId is non-empty', () => {
  assert.ok(accepts(SettingsSchema, 'webUiOidcIssuer', 'https://authentik.example.com/application/o/bellhop/'));
  for (const bad of ['ftp://authentik.example.com', 'not a url', '']) {
    assert.ok(!accepts(SettingsSchema, 'webUiOidcIssuer', bad), bad);
  }
  assert.ok(accepts(SettingsSchema, 'webUiOidcClientId', 'example-client-id'));
  assert.ok(!accepts(SettingsSchema, 'webUiOidcClientId', ''));
});

// https:// only, since the sign-in cookies are Secure and a browser drops them
// over plain http everywhere but loopback.
test('webUiOidcRedirectUri is an https URL (http only on loopback) whose path is /auth/callback', () => {
  assert.ok(accepts(SettingsSchema, 'webUiOidcRedirectUri', 'https://bellhop.example.com/auth/callback'));
  for (const loopback of ['http://localhost:3000/auth/callback', 'http://127.0.0.1:3000/auth/callback', 'http://[::1]:3000/auth/callback']) {
    assert.ok(accepts(SettingsSchema, 'webUiOidcRedirectUri', loopback), loopback);
  }
  for (const bad of [
    'https://bellhop.example.com/callback',
    'https://bellhop.example.com/auth/callback/extra',
    'https://bellhop.example.com',
    'ftp://bellhop.example.com/auth/callback',
    'http://192.0.2.10:3000/auth/callback',
    'http://bellhop.example.com/auth/callback',
    'not a url',
    '',
  ]) {
    assert.ok(!accepts(SettingsSchema, 'webUiOidcRedirectUri', bad), bad);
  }
  const result = SettingsSchema.safeParse({ webUiOidcRedirectUri: 'https://bellhop.example.com/x' });
  assert.ok(!result.success);
  assert.deepEqual(result.error.issues.map((i) => i.message), ['must be an https:// URL (http:// only for localhost) whose path is /auth/callback']);
});

test('the four tokens must be non-empty with no whitespace', () => {
  for (const key of ['authentikApiToken', 'cloudflareDnsApiToken', 'githubApiToken', 'webUiOidcClientSecret']) {
    assert.ok(accepts(SecretSettingsSchema, key, 'example-token-123'), key);
    for (const bad of ['', 'two words', 'trailing\n', '\ttab']) {
      assert.ok(!accepts(SecretSettingsSchema, key, bad), `${key}: ${JSON.stringify(bad)}`);
    }
  }
});

// #66: a network listener's key must be long enough not to be guessed,
// and a pasted newline must fail here, not later as an opaque 401.
test('mcpApiKey must be at least 32 characters with no whitespace', () => {
  assert.ok(accepts(SecretSettingsSchema, 'mcpApiKey', 'a'.repeat(32)));
  for (const bad of ['', 'a'.repeat(31), `${'a'.repeat(32)} `, `${'a'.repeat(32)}
`]) {
    assert.ok(!accepts(SecretSettingsSchema, 'mcpApiKey', bad), JSON.stringify(bad));
  }
});

test('npmApiPassword must be non-empty with no control characters, but may contain spaces', () => {
  assert.ok(accepts(SecretSettingsSchema, 'npmApiPassword', 'example pass phrase!'));
  for (const bad of ['', 'line\nbreak', 'nul\u0000', 'del\u007f']) {
    assert.ok(!accepts(SecretSettingsSchema, 'npmApiPassword', bad), JSON.stringify(bad));
  }
});

test('the remaining moved keys must be non-empty', () => {
  for (const key of [
    'authentikAdminGroup',
    'authentikBuiltinAdminGroup',
    'authentikGroupLadder',
    'authentikOutpostName',
    'authentikAuthorizationFlowSlug',
    'authentikInvalidationFlowSlug',
    'authentikOidcSigningKeyName',
    'npmApiEmail',
  ]) {
    assert.ok(accepts(SettingsSchema, key, 'example value'), key);
    assert.ok(!accepts(SettingsSchema, key, ''), key);
  }
});

test('a zod failure message never contains the rejected input', () => {
  const marker = 'SECRETMARKER';
  const cases: Array<[typeof SettingsSchema | typeof SecretSettingsSchema, string, string]> = [
    [SettingsSchema, 'authentikApiUrl', `ftp://${marker}.example.com`],
    [SettingsSchema, 'npmApiUrl', `${marker} not a url`],
    [SettingsSchema, 'authentikOutpostPort', `${marker}`],
    [SettingsSchema, 'webUiAuthMode', marker],
    [SecretSettingsSchema, 'authentikApiToken', `${marker} x`],
    [SecretSettingsSchema, 'cloudflareDnsApiToken', `${marker} x`],
    [SecretSettingsSchema, 'githubApiToken', `${marker} x`],
    [SecretSettingsSchema, 'npmApiPassword', `${marker}\n`],
  ];
  for (const [schema, key, value] of cases) {
    const result = schema.safeParse({ [key]: value });
    assert.equal(result.success, false, key);
    if (!result.success) {
      const text = JSON.stringify(result.error.issues);
      assert.ok(!text.includes(marker), `${key} echoed its input: ${text}`);
    }
  }
});

test('authentikGroupLadder must name at least one group, with a fixed message', () => {
  assert.ok(accepts(SettingsSchema, 'authentikGroupLadder', 'example-users, example-admins'));
  assert.ok(accepts(SettingsSchema, 'authentikGroupLadder', ' , example-admins'), 'one non-blank rung is enough');
  for (const bad of [',', ' , ,', '   ']) {
    const result = SettingsSchema.safeParse({ authentikGroupLadder: bad });
    assert.ok(!result.success, JSON.stringify(bad));
    assert.deepEqual(
      result.error.issues.map((i) => i.message),
      ['must name at least one group'],
      JSON.stringify(bad)
    );
  }
});
