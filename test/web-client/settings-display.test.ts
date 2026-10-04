import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  proxyHostText,
  LAN_GATEWAYS_EMPTY_TEXT,
  proxyDriverOptions,
  proxyFieldView,
  caddyTlsOptions,
  SETTINGS_TABS,
  fieldsForTab,
  fieldState,
  effectiveWebUiAuthMode,
  needsConfirmation,
  confirmationMessage,
  secretStatusText,
  storedCopyText,
  mergeSettingsResponse,
} from '../../web-client/src/lib/settings-display.ts';
import { SETTINGS_KEYS } from '../../src/lib/inventory.ts';
import type { SettingsResponse } from '../../web-client/src/api/types.ts';
import { SECRET_SETTINGS_KEYS } from '../../src/lib/settings-defs.ts';

test('proxyHostText returns "<name> (<ip>)" for a set proxy entry', () => {
  assert.equal(proxyHostText({ name: 'proxy', ip: '10.0.0.2' }), 'proxy (10.0.0.2)');
});

test('proxyHostText explains the empty state for null', () => {
  assert.equal(proxyHostText(null), 'not set — no inventory entry has proxy: true with an IP yet');
});

test('LAN_GATEWAYS_EMPTY_TEXT explains the empty state', () => {
  assert.equal(LAN_GATEWAYS_EMPTY_TEXT, 'LAN gateways: none yet — no host has a midScheme');
});

test('proxyDriverOptions suffixes only the default driver label with " (default)"', () => {
  const drivers = [
    { id: 'caddy', label: 'Caddy', defaultConfigPath: '/etc/caddy/Caddyfile', suggestedStatusPagePath: '/usr/share/caddy/index.html', managesProxy: true, usesSharedCertificate: false, usesCertResolver: false, usesApiUrl: false, usesCaddyTls: true, usesNpmApi: false, configPathNote: null },
    { id: 'none', label: 'No proxy', defaultConfigPath: null, suggestedStatusPagePath: null, managesProxy: false, usesSharedCertificate: false, usesCertResolver: false, usesApiUrl: false, usesCaddyTls: false, usesNpmApi: false, configPathNote: null },
  ];
  assert.deepEqual(proxyDriverOptions(drivers, 'caddy'), [
    { value: 'caddy', label: 'Caddy (default)' },
    { value: 'none', label: 'No proxy' },
  ]);
});

test('proxyDriverOptions preserves driver order and suffixes whichever id is the default', () => {
  const drivers = [
    { id: 'caddy', label: 'Caddy', defaultConfigPath: '/etc/caddy/Caddyfile', suggestedStatusPagePath: '/usr/share/caddy/index.html', managesProxy: true, usesSharedCertificate: false, usesCertResolver: false, usesApiUrl: false, usesCaddyTls: true, usesNpmApi: false, configPathNote: null },
    { id: 'none', label: 'No proxy', defaultConfigPath: null, suggestedStatusPagePath: null, managesProxy: false, usesSharedCertificate: false, usesCertResolver: false, usesApiUrl: false, usesCaddyTls: false, usesNpmApi: false, configPathNote: null },
  ];
  assert.deepEqual(proxyDriverOptions(drivers, 'none'), [
    { value: 'caddy', label: 'Caddy' },
    { value: 'none', label: 'No proxy (default)' },
  ]);
});

const DRIVERS = [
  { id: 'caddy', label: 'Caddy', defaultConfigPath: '/etc/caddy/Caddyfile', suggestedStatusPagePath: '/usr/share/caddy/index.html', managesProxy: true, usesSharedCertificate: false, usesCertResolver: false, usesApiUrl: false, usesCaddyTls: true, usesNpmApi: false, configPathNote: null },
  { id: 'none', label: 'No proxy', defaultConfigPath: null, suggestedStatusPagePath: null, managesProxy: false, usesSharedCertificate: false, usesCertResolver: false, usesApiUrl: false, usesCaddyTls: false, usesNpmApi: false, configPathNote: null },
];

test('proxyFieldView shows both fields with Caddy-specific placeholders/help when Caddy is selected', () => {
  const view = proxyFieldView('caddy', DRIVERS, 'cloudflare');
  assert.equal(view.showConfigPath, true);
  assert.equal(view.configPathPlaceholder, '/etc/caddy/Caddyfile');
  assert.match(view.configPathHelp ?? '', /Caddy/);
  assert.match(view.configPathHelp ?? '', /\/etc\/caddy\/Caddyfile/);
  assert.equal(view.showStatusPagePath, true);
  assert.equal(view.statusPagePlaceholder, '/usr/share/caddy/index.html');
});

test('proxyFieldView hides both fields when "no proxy" is selected', () => {
  const view = proxyFieldView('none', DRIVERS, 'cloudflare');
  assert.equal(view.showConfigPath, false);
  assert.equal(view.showStatusPagePath, false);
});

test('proxyFieldView hides both fields for an unknown driver id', () => {
  const view = proxyFieldView('unknown-provider', DRIVERS, 'cloudflare');
  assert.equal(view.showConfigPath, false);
  assert.equal(view.showStatusPagePath, false);
  assert.equal(view.showTlsFields, false);
});

// issue #30 x #33: nginx's entry exactly as GET /api/settings serves it.
const NGINX = {
  id: 'nginx',
  label: 'nginx',
  defaultConfigPath: '/etc/nginx/conf.d/bellhop.conf',
  suggestedStatusPagePath: '/var/www/html/index.html',
  managesProxy: true,
  usesSharedCertificate: true,
  usesCertResolver: false,
  usesApiUrl: false,
  usesCaddyTls: false, usesNpmApi: false,
  configPathNote: "nginx replaces this whole file on every apply, and refuses to replace a file it didn't generate.",
};

test('proxyFieldView for nginx shows the config path (nginx default, whole-file note), the status page, and the TLS fields', () => {
  const view = proxyFieldView('nginx', [...DRIVERS, NGINX], 'cloudflare');
  assert.equal(view.showConfigPath, true);
  assert.equal(view.configPathPlaceholder, '/etc/nginx/conf.d/bellhop.conf');
  assert.match(view.configPathHelp ?? '', /\/etc\/nginx\/conf\.d\/bellhop\.conf/);
  assert.match(view.configPathHelp ?? '', /replaces this whole file/);
  assert.match(view.configPathHelp ?? '', /refuses to replace a file it didn't generate/);
  assert.equal(view.showStatusPagePath, true);
  assert.equal(view.statusPagePlaceholder, '/var/www/html/index.html');
  assert.equal(view.showTlsFields, true);
});

// issue #32: HAProxy's entry exactly as GET /api/settings serves it -- a
// file driver with no status page and no shared certificate.
const HAPROXY = {
  id: 'haproxy',
  label: 'HAProxy',
  defaultConfigPath: '/etc/haproxy/bellhop.cfg',
  suggestedStatusPagePath: null,
  managesProxy: true,
  usesSharedCertificate: false,
  usesCertResolver: false,
  usesApiUrl: false,
  usesCaddyTls: false, usesNpmApi: false,
  configPathNote:
    "HAProxy replaces this whole file and writes bellhop.map beside it on every apply, and refuses to replace a file it didn't generate.",
};

test('proxyFieldView for HAProxy shows the config path (HAProxy default, map-file note) and hides the status page and TLS fields', () => {
  const view = proxyFieldView('haproxy', [...DRIVERS, NGINX, HAPROXY], 'cloudflare');
  assert.equal(view.showConfigPath, true);
  assert.equal(view.configPathPlaceholder, '/etc/haproxy/bellhop.cfg');
  assert.match(view.configPathHelp ?? '', /\/etc\/haproxy\/bellhop\.cfg/);
  assert.match(view.configPathHelp ?? '', /writes bellhop\.map beside it/);
  assert.match(view.configPathHelp ?? '', /refuses to replace a file it didn't generate/);
  assert.equal(view.showStatusPagePath, false);
  assert.equal(view.showTlsFields, false);
});

test('proxyFieldView hides the TLS fields for Caddy and for no proxy', () => {
  assert.equal(proxyFieldView('caddy', DRIVERS, 'cloudflare').showTlsFields, false);
  assert.equal(proxyFieldView('none', DRIVERS, 'cloudflare').showTlsFields, false);
});

test('proxyFieldView appends a driver-supplied configPathNote to the config path help', () => {
  const drivers = [{ ...DRIVERS[0], configPathNote: 'Only a section is replaced.' }];
  assert.equal(
    proxyFieldView('caddy', drivers, 'cloudflare').configPathHelp,
    "Overrides the Caddy driver's default config path (/etc/caddy/Caddyfile). Unset: that default. Only a section is replaced.",
  );
});

// issue #31 (T005): a managed driver with no config file at all (e.g. Nginx
// Proxy Manager, which is REST-managed) hides the config path field
// entirely rather than showing it as "required" -- there is no default
// config-path state left to show for a managed driver with
// defaultConfigPath: null; only a driver that manages no proxy used to hide
// it. Paired with no suggested status page path and no shared certificate,
// all three fields are hidden.
test('proxyFieldView hides all three fields for a managed driver with no config file, no status page, and no shared certificate', () => {
  const drivers = [{ id: 'nodefault', label: 'No Default', defaultConfigPath: null, suggestedStatusPagePath: null, managesProxy: true, usesSharedCertificate: false, usesCertResolver: false, usesApiUrl: false, usesCaddyTls: false, usesNpmApi: false, configPathNote: null }];
  const view = proxyFieldView('nodefault', drivers, 'cloudflare');
  assert.equal(view.showConfigPath, false);
  assert.equal(view.configPathHelp, undefined, 'no "required" help text is shown once the field itself is hidden');
  assert.equal(view.showStatusPagePath, false);
  assert.equal(view.showTlsFields, false);
});

test('proxyFieldView hides the config path field for a driver that manages no proxy, even if it reports a default path', () => {
  const drivers = [{ id: 'odd', label: 'Odd', defaultConfigPath: '/etc/odd.conf', suggestedStatusPagePath: '/var/www/index.html', managesProxy: false, usesSharedCertificate: false, usesCertResolver: false, usesApiUrl: false, usesCaddyTls: false, usesNpmApi: false, configPathNote: null }];
  const view = proxyFieldView('odd', drivers, 'cloudflare');
  assert.equal(view.showConfigPath, false);
  assert.equal(view.showStatusPagePath, false);
});

// issue #26: the admin-API Caddy driver writes no file, so the config path
// field doesn't apply; unlike Nginx Proxy Manager it still suggests a status
// page path, so that field stays.
test('proxyFieldView for the Caddy admin-API driver hides the config path and keeps the status page', () => {
  const CADDY_API = {
    id: 'caddy-api',
    label: 'Caddy (admin API)',
    defaultConfigPath: null,
    suggestedStatusPagePath: '/usr/share/caddy/index.html',
    managesProxy: true,
    usesSharedCertificate: false,
    usesCertResolver: false,
    usesApiUrl: false,
    usesCaddyTls: true, usesNpmApi: false,
    configPathNote: null,
  };
  const view = proxyFieldView('caddy-api', [CADDY_API], 'cloudflare');
  assert.equal(view.showConfigPath, false);
  assert.equal(view.configPathHelp, undefined);
  assert.equal(view.showStatusPagePath, true);
  assert.equal(view.statusPagePlaceholder, '/usr/share/caddy/index.html');
  assert.equal(view.showTlsFields, false);
  assert.equal(view.showCaddyTlsField, true);
});

// issue #35 (T018): Traefik's entry exactly as GET /api/settings serves
// it -- the only driver with usesCertResolver/usesApiUrl set.
const TRAEFIK = {
  id: 'traefik',
  label: 'Traefik',
  defaultConfigPath: '/etc/traefik/dynamic/bellhop.yml',
  suggestedStatusPagePath: null,
  managesProxy: true,
  usesSharedCertificate: false,
  usesCertResolver: true,
  usesApiUrl: true,
  usesCaddyTls: false, usesNpmApi: false,
  configPathNote:
    "Traefik's file provider must watch this file's directory. The whole file is replaced on every apply, and a file Bellhop didn't generate is refused.",
};

test('proxyFieldView for Traefik shows the cert resolver and API URL fields, hides the status page and TLS fields', () => {
  const view = proxyFieldView('traefik', [...DRIVERS, NGINX, HAPROXY, TRAEFIK], 'cloudflare');
  assert.equal(view.showConfigPath, true);
  assert.equal(view.configPathPlaceholder, '/etc/traefik/dynamic/bellhop.yml');
  assert.equal(view.showStatusPagePath, false);
  assert.equal(view.showTlsFields, false);
  assert.equal(view.showCertResolverField, true);
  assert.equal(view.showApiUrlField, true);
});

test('proxyFieldView hides the cert resolver and API URL fields for every non-Traefik driver', () => {
  assert.equal(proxyFieldView('caddy', [...DRIVERS, NGINX, HAPROXY, TRAEFIK], 'cloudflare').showCertResolverField, false);
  assert.equal(proxyFieldView('caddy', [...DRIVERS, NGINX, HAPROXY, TRAEFIK], 'cloudflare').showApiUrlField, false);
  assert.equal(proxyFieldView('nginx', [...DRIVERS, NGINX, HAPROXY, TRAEFIK], 'cloudflare').showCertResolverField, false);
  assert.equal(proxyFieldView('nginx', [...DRIVERS, NGINX, HAPROXY, TRAEFIK], 'cloudflare').showApiUrlField, false);
  assert.equal(proxyFieldView('haproxy', [...DRIVERS, NGINX, HAPROXY, TRAEFIK], 'cloudflare').showCertResolverField, false);
  assert.equal(proxyFieldView('haproxy', [...DRIVERS, NGINX, HAPROXY, TRAEFIK], 'cloudflare').showApiUrlField, false);
  assert.equal(proxyFieldView('none', [...DRIVERS, NGINX, HAPROXY, TRAEFIK], 'cloudflare').showCertResolverField, false);
  assert.equal(proxyFieldView('none', [...DRIVERS, NGINX, HAPROXY, TRAEFIK], 'cloudflare').showApiUrlField, false);
});

test('proxyFieldView hides the cert resolver and API URL fields for an unmanaged or unknown driver', () => {
  const unmanaged = proxyFieldView('none', DRIVERS, 'cloudflare');
  assert.equal(unmanaged.showCertResolverField, false);
  assert.equal(unmanaged.showApiUrlField, false);
  const unknown = proxyFieldView('unknown-provider', DRIVERS, 'cloudflare');
  assert.equal(unknown.showCertResolverField, false);
  assert.equal(unknown.showApiUrlField, false);
});

// issue #73 (US1): Nginx Proxy Manager's entry exactly as GET /api/settings
// serves it -- the only driver with usesNpmApi set, no config file, and no
// status page.
const NGINX_PROXY_MANAGER = {
  id: 'nginx-proxy-manager',
  label: 'Nginx Proxy Manager',
  defaultConfigPath: null,
  suggestedStatusPagePath: null,
  managesProxy: true,
  usesSharedCertificate: false,
  usesCertResolver: false,
  usesApiUrl: false,
  usesCaddyTls: false,
  usesNpmApi: true,
  configPathNote: null,
};

test('proxyFieldView for Nginx Proxy Manager shows only the Nginx Proxy Manager fields', () => {
  const view = proxyFieldView('nginx-proxy-manager', [...DRIVERS, NGINX, HAPROXY, TRAEFIK, NGINX_PROXY_MANAGER], 'cloudflare');
  assert.equal(view.showNpmApiFields, true);
  assert.equal(view.showConfigPath, false);
  assert.equal(view.showStatusPagePath, false);
  assert.equal(view.showTlsFields, false);
  assert.equal(view.showCaddyTlsField, false);
  assert.equal(view.showCertResolverField, false);
  assert.equal(view.showApiUrlField, false);
});

// issue #51 (T016): proxyFieldView's third argument is the shown Caddy TLS
// value (draft, else stored, else default), resolved by the caller the same
// way selectedId already is. showCaddyTlsField is true only for a driver
// whose usesCaddyTls metadata says so (the two Caddy drivers) -- independent
// of which mode is selected.
test('proxyFieldView shows showCaddyTlsField only for a driver with usesCaddyTls', () => {
  assert.equal(proxyFieldView('caddy', DRIVERS, 'cloudflare').showCaddyTlsField, true);
  assert.equal(proxyFieldView('nginx', [...DRIVERS, NGINX], 'cloudflare').showCaddyTlsField, false);
  assert.equal(proxyFieldView('haproxy', [...DRIVERS, NGINX, HAPROXY], 'cloudflare').showCaddyTlsField, false);
  assert.equal(proxyFieldView('traefik', [...DRIVERS, NGINX, HAPROXY, TRAEFIK], 'cloudflare').showCaddyTlsField, false);
  assert.equal(proxyFieldView('none', DRIVERS, 'cloudflare').showCaddyTlsField, false);
  assert.equal(proxyFieldView('unknown-provider', DRIVERS, 'cloudflare').showCaddyTlsField, false);
});

// The certificate/key fields apply to a Caddy driver only while its shown
// Caddy TLS mode is 'files' -- every other mode issues/obtains its own
// certificate one fixed way and never reads proxyTlsCertificate/
// proxyTlsKey. The default third argument ('cloudflare', unset mode) keeps
// every call site above that never passes one asserting showTlsFields false
// for Caddy, matching today's only behavior.
test('proxyFieldView shows the TLS fields for Caddy only while its shown mode is files', () => {
  assert.equal(proxyFieldView('caddy', DRIVERS, 'cloudflare').showTlsFields, false);
  assert.equal(proxyFieldView('caddy', DRIVERS, 'letsencrypt').showTlsFields, false);
  assert.equal(proxyFieldView('caddy', DRIVERS, 'internal').showTlsFields, false);
  assert.equal(proxyFieldView('caddy', DRIVERS, 'files').showTlsFields, true);
});

test('proxyFieldView never shows the TLS fields for Traefik, whatever the Caddy TLS argument', () => {
  const drivers = [...DRIVERS, NGINX, HAPROXY, TRAEFIK];
  assert.equal(proxyFieldView('traefik', drivers, 'files').showTlsFields, false);
  assert.equal(proxyFieldView('traefik', drivers, 'cloudflare').showTlsFields, false);
});

test('caddyTlsOptions labels only the default mode " (default)"', () => {
  assert.deepEqual(caddyTlsOptions(['cloudflare', 'letsencrypt', 'internal', 'files'], 'cloudflare'), [
    { value: 'cloudflare', label: 'cloudflare (default)' },
    { value: 'letsencrypt', label: 'letsencrypt' },
    { value: 'internal', label: 'internal' },
    { value: 'files', label: 'files' },
  ]);
});

test('caddyTlsOptions suffixes whichever mode is passed as the default', () => {
  assert.deepEqual(caddyTlsOptions(['cloudflare', 'letsencrypt', 'internal', 'files'], 'files'), [
    { value: 'cloudflare', label: 'cloudflare' },
    { value: 'letsencrypt', label: 'letsencrypt' },
    { value: 'internal', label: 'internal' },
    { value: 'files', label: 'files (default)' },
  ]);
});

// Issue #64: the Settings page groups every setting by integration. Issue
// #73 drops the Nginx Proxy Manager tab -- its three fields move to Proxy.
test('SETTINGS_TABS lists the five integration tabs in order, with no Nginx Proxy Manager tab', () => {
  assert.deepEqual(
    SETTINGS_TABS.map((t) => t.label),
    ['General', 'Proxy', 'Authentik', 'Cloudflare', 'GitHub'],
  );
});

test('fieldsForTab places every server setting and secret in exactly one tab', () => {
  const placed = SETTINGS_TABS.flatMap((t) => [...fieldsForTab(t.id)]);
  // Sorted comparison catches both a missing key and one listed twice.
  assert.deepEqual([...placed].sort(), [...SETTINGS_KEYS, ...SECRET_SETTINGS_KEYS].sort());
});

test('fieldsForTab puts each secret beside its own integration', () => {
  assert.ok(fieldsForTab('authentik').includes('authentikApiToken'));
  assert.ok(fieldsForTab('authentik').includes('authentikApiUrl'));
  assert.deepEqual([...fieldsForTab('cloudflare')], ['cloudflareDnsApiToken']);
  assert.deepEqual([...fieldsForTab('github')], ['githubApiToken']);
});

// Issue #73: the three Nginx Proxy Manager fields move onto the end of the
// Proxy tab, after the other driver-dependent fields, rather than keeping
// their own tab.
test('fieldsForTab keeps every proxy-driver-dependent field in the Proxy tab, ending with the Nginx Proxy Manager fields', () => {
  assert.deepEqual([...fieldsForTab('proxy')], [
    'proxyDriver',
    'proxyConfigPath',
    'statusPagePath',
    'proxyCaddyTls',
    'proxyTlsCertificate',
    'proxyTlsKey',
    'proxyCertResolver',
    'proxyApiUrl',
    'npmApiUrl',
    'npmApiEmail',
    'npmApiPassword',
  ]);
  assert.ok(fieldsForTab('general').includes('webUiAuthMode'));
});

test('fieldState reports a key the environment pins as env-pinned with its variable and stored copy', () => {
  const data = {
    environment: {
      webUiAuthMode: { variable: 'WEB_UI_AUTH_MODE', value: 'authentik', stored: true, storedValue: 'authentik' },
    },
  };
  assert.deepEqual(fieldState('webUiAuthMode', data), {
    kind: 'env-pinned',
    variable: 'WEB_UI_AUTH_MODE',
    value: 'authentik',
    stored: true,
    storedValue: 'authentik',
  });
});

test('fieldState reports a pinned secret with no value and no stored value', () => {
  const data = { environment: { githubApiToken: { variable: 'GITHUB_API_TOKEN', stored: true } } };
  assert.deepEqual(fieldState('githubApiToken', data), { kind: 'env-pinned', variable: 'GITHUB_API_TOKEN', stored: true });
});

test('storedCopyText shows whether a pinned field has a stored copy, and its value only for a non-secret', () => {
  assert.equal(
    storedCopyText({ kind: 'env-pinned', variable: 'WEB_UI_AUTH_MODE', value: 'authentik', stored: true, storedValue: 'authentik' }),
    'Stored copy: authentik',
  );
  assert.equal(storedCopyText({ kind: 'env-pinned', variable: 'GITHUB_API_TOKEN', stored: true }), 'Stored copy: set');
  assert.equal(
    storedCopyText({ kind: 'env-pinned', variable: 'NPM_API_URL', value: 'http://192.0.2.10:81', stored: false }),
    'Stored copy: not set',
  );
});

test('fieldState reports an unpinned key as editable', () => {
  assert.deepEqual(fieldState('nfsServer', { environment: {} }), { kind: 'editable' });
  assert.deepEqual(fieldState('authentikApiUrl', { environment: {} }), { kind: 'editable' });
});

test('effectiveWebUiAuthMode prefers the environment, then the stored value, then auto', () => {
  assert.equal(
    effectiveWebUiAuthMode({
      settings: { webUiAuthMode: 'none' },
      environment: { webUiAuthMode: { variable: 'WEB_UI_AUTH_MODE', value: 'authentik', stored: false } },
    }),
    'authentik',
  );
  assert.equal(effectiveWebUiAuthMode({ settings: { webUiAuthMode: 'none' }, environment: {} }), 'none');
  assert.equal(effectiveWebUiAuthMode({ settings: {}, environment: {} }), 'auto');
});

test('needsConfirmation is true for any change to either admin-group field, including a clear', () => {
  for (const key of ['authentikAdminGroup', 'authentikBuiltinAdminGroup'] as const) {
    assert.equal(needsConfirmation(key, 'bellhop-admins', 'ops-admins'), true);
    assert.equal(needsConfirmation(key, undefined, 'ops-admins'), true);
    assert.equal(needsConfirmation(key, 'bellhop-admins', null), true);
    assert.equal(needsConfirmation(key, 'bellhop-admins', 'bellhop-admins'), false);
    assert.equal(needsConfirmation(key, undefined, null), false);
  }
});

test('needsConfirmation is true for webUiAuthMode only when leaving authentik', () => {
  assert.equal(needsConfirmation('webUiAuthMode', 'authentik', 'auto'), true);
  assert.equal(needsConfirmation('webUiAuthMode', 'authentik', 'none'), true);
  // Clearing falls back to auto, which also leaves authentik.
  assert.equal(needsConfirmation('webUiAuthMode', 'authentik', null), true);
  assert.equal(needsConfirmation('webUiAuthMode', 'authentik', 'authentik'), false);
  assert.equal(needsConfirmation('webUiAuthMode', 'auto', 'authentik'), false);
  assert.equal(needsConfirmation('webUiAuthMode', 'auto', 'none'), false);
});

test('needsConfirmation is false for every other setting', () => {
  assert.equal(needsConfirmation('nfsServer', '192.0.2.5', null), false);
  assert.equal(needsConfirmation('authentikApiToken', undefined, 'example-token'), false);
});

test('confirmationMessage explains each guarded change', () => {
  assert.match(confirmationMessage('authentikAdminGroup'), /administrator/);
  assert.match(confirmationMessage('authentikAdminGroup'), /refused if it would remove your own/);
  assert.match(confirmationMessage('authentikBuiltinAdminGroup'), /administrator/);
  assert.match(confirmationMessage('webUiAuthMode'), /without signing in through Authentik/);
});

test('secretStatusText names whether a secret is set and where it comes from', () => {
  assert.equal(secretStatusText({ set: true, source: 'settings' }), 'Set -- from settings');
  assert.equal(
    secretStatusText({ set: true, source: 'environment' }, 'GITHUB_API_TOKEN'),
    'Set -- set by environment GITHUB_API_TOKEN',
  );
  assert.equal(secretStatusText({ set: false, source: 'none' }), 'Not set');
});

function settingsResponse(overrides: Partial<SettingsResponse> = {}): SettingsResponse {
  return {
    settings: {},
    derived: { lanGateways: [], proxy: null },
    proxyDrivers: [],
    defaultProxyDriver: 'caddy',
    caddyTlsModes: ['cloudflare'],
    defaultCaddyTls: 'cloudflare',
    sources: {},
    environment: {},
    secrets: {
      authentikApiToken: { set: false, source: 'none' },
      cloudflareDnsApiToken: { set: false, source: 'none' },
      npmApiPassword: { set: false, source: 'none' },
      githubApiToken: { set: false, source: 'none' },
    },
    ...overrides,
  };
}

test('mergeSettingsResponse takes only the saved non-secret key from the response', () => {
  const prev = settingsResponse({
    settings: { nfsServer: '192.0.2.5', dnsServer: '192.0.2.53' },
    sources: { nfsServer: 'settings', dnsServer: 'settings' },
  });
  // The response reflects a concurrent save of dnsServer that this merge
  // must not apply.
  const res = settingsResponse({
    settings: { nfsServer: '192.0.2.6' },
    sources: { nfsServer: 'settings', dnsServer: 'none' },
    derived: { lanGateways: [{ host: 'pve-a', gateway: '192.0.2.1' }], proxy: null },
  });
  const merged = mergeSettingsResponse(prev, res, 'nfsServer');
  assert.deepEqual(merged.settings, { nfsServer: '192.0.2.6', dnsServer: '192.0.2.53' });
  assert.deepEqual(merged.sources, { nfsServer: 'settings', dnsServer: 'settings' });
  assert.deepEqual(merged.derived.lanGateways, [{ host: 'pve-a', gateway: '192.0.2.1' }]);
});

test('mergeSettingsResponse takes only the saved secret status from the response', () => {
  const prev = settingsResponse();
  const res = settingsResponse({
    secrets: {
      authentikApiToken: { set: true, source: 'settings' },
      cloudflareDnsApiToken: { set: true, source: 'settings' },
      npmApiPassword: { set: false, source: 'none' },
      githubApiToken: { set: false, source: 'none' },
    },
  });
  const merged = mergeSettingsResponse(prev, res, 'authentikApiToken');
  assert.deepEqual(merged.secrets.authentikApiToken, { set: true, source: 'settings' });
  assert.deepEqual(merged.secrets.cloudflareDnsApiToken, { set: false, source: 'none' });
  assert.deepEqual(merged.settings, {});
});

test('mergeSettingsResponse updates or drops the saved key\'s environment pin', () => {
  const pin = { variable: 'NPM_API_URL', value: 'http://192.0.2.10:81', stored: false };
  const prev = settingsResponse({ environment: { npmApiUrl: pin, npmApiEmail: { variable: 'NPM_API_EMAIL', value: 'admin@example.com', stored: false } } });
  const dropped = mergeSettingsResponse(prev, settingsResponse(), 'npmApiUrl');
  assert.deepEqual(dropped.environment, { npmApiEmail: { variable: 'NPM_API_EMAIL', value: 'admin@example.com', stored: false } });
  const kept = mergeSettingsResponse(settingsResponse(), settingsResponse({ environment: { npmApiUrl: pin } }), 'npmApiUrl');
  assert.deepEqual(kept.environment, { npmApiUrl: pin });
});
