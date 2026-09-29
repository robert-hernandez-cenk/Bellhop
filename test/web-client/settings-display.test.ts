import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proxyHostText, LAN_GATEWAYS_EMPTY_TEXT, proxyDriverOptions, proxyFieldView } from '../../web-client/src/lib/settings-display.ts';

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
    { id: 'caddy', label: 'Caddy', defaultConfigPath: '/etc/caddy/Caddyfile', suggestedStatusPagePath: '/usr/share/caddy/index.html', managesProxy: true, usesSharedCertificate: false, configPathNote: null, usesConfigFile: true },
    { id: 'none', label: 'No proxy', defaultConfigPath: null, suggestedStatusPagePath: null, managesProxy: false, usesSharedCertificate: false, configPathNote: null, usesConfigFile: true },
  ];
  assert.deepEqual(proxyDriverOptions(drivers, 'caddy'), [
    { value: 'caddy', label: 'Caddy (default)' },
    { value: 'none', label: 'No proxy' },
  ]);
});

test('proxyDriverOptions preserves driver order and suffixes whichever id is the default', () => {
  const drivers = [
    { id: 'caddy', label: 'Caddy', defaultConfigPath: '/etc/caddy/Caddyfile', suggestedStatusPagePath: '/usr/share/caddy/index.html', managesProxy: true, usesSharedCertificate: false, configPathNote: null, usesConfigFile: true },
    { id: 'none', label: 'No proxy', defaultConfigPath: null, suggestedStatusPagePath: null, managesProxy: false, usesSharedCertificate: false, configPathNote: null, usesConfigFile: true },
  ];
  assert.deepEqual(proxyDriverOptions(drivers, 'none'), [
    { value: 'caddy', label: 'Caddy' },
    { value: 'none', label: 'No proxy (default)' },
  ]);
});

const DRIVERS = [
  { id: 'caddy', label: 'Caddy', defaultConfigPath: '/etc/caddy/Caddyfile', suggestedStatusPagePath: '/usr/share/caddy/index.html', managesProxy: true, usesSharedCertificate: false, configPathNote: null, usesConfigFile: true },
  { id: 'none', label: 'No proxy', defaultConfigPath: null, suggestedStatusPagePath: null, managesProxy: false, usesSharedCertificate: false, configPathNote: null, usesConfigFile: true },
];

test('proxyFieldView shows both fields with Caddy-specific placeholders/help when Caddy is selected', () => {
  const view = proxyFieldView('caddy', DRIVERS);
  assert.equal(view.showConfigPath, true);
  assert.equal(view.configPathPlaceholder, '/etc/caddy/Caddyfile');
  assert.match(view.configPathHelp ?? '', /Caddy/);
  assert.match(view.configPathHelp ?? '', /\/etc\/caddy\/Caddyfile/);
  assert.equal(view.showStatusPagePath, true);
  assert.equal(view.statusPagePlaceholder, '/usr/share/caddy/index.html');
});

test('proxyFieldView hides both fields when "no proxy" is selected', () => {
  const view = proxyFieldView('none', DRIVERS);
  assert.equal(view.showConfigPath, false);
  assert.equal(view.showStatusPagePath, false);
});

test('proxyFieldView hides both fields for an unknown driver id', () => {
  const view = proxyFieldView('unknown-provider', DRIVERS);
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
  configPathNote: "nginx replaces this whole file on every apply, and refuses to replace a file it didn't generate.",
  usesConfigFile: true,
};

test('proxyFieldView for nginx shows the config path (nginx default, whole-file note), the status page, and the TLS fields', () => {
  const view = proxyFieldView('nginx', [...DRIVERS, NGINX]);
  assert.equal(view.showConfigPath, true);
  assert.equal(view.configPathPlaceholder, '/etc/nginx/conf.d/bellhop.conf');
  assert.match(view.configPathHelp ?? '', /\/etc\/nginx\/conf\.d\/bellhop\.conf/);
  assert.match(view.configPathHelp ?? '', /replaces this whole file/);
  assert.match(view.configPathHelp ?? '', /refuses to replace a file it didn't generate/);
  assert.equal(view.showStatusPagePath, true);
  assert.equal(view.statusPagePlaceholder, '/var/www/html/index.html');
  assert.equal(view.showTlsFields, true);
});

test('proxyFieldView hides the TLS fields for Caddy and for no proxy', () => {
  assert.equal(proxyFieldView('caddy', DRIVERS).showTlsFields, false);
  assert.equal(proxyFieldView('none', DRIVERS).showTlsFields, false);
});

test('proxyFieldView appends a driver-supplied configPathNote to the config path help', () => {
  const drivers = [{ ...DRIVERS[0], configPathNote: 'Only a section is replaced.' }];
  assert.equal(
    proxyFieldView('caddy', drivers).configPathHelp,
    "Overrides the Caddy driver's default config path (/etc/caddy/Caddyfile). Unset: that default. Only a section is replaced.",
  );
});

// managesProxy, not defaultConfigPath, decides whether the config path field
// applies at all: a managed driver with no default still needs a path, and
// one that manages no proxy never does.
test('proxyFieldView shows the config path field for a managed driver with no default, saying it is required', () => {
  const drivers = [{ id: 'nodefault', label: 'No Default', defaultConfigPath: null, suggestedStatusPagePath: null, managesProxy: true, usesSharedCertificate: false, configPathNote: null, usesConfigFile: true }];
  const view = proxyFieldView('nodefault', drivers);
  assert.equal(view.showConfigPath, true);
  assert.equal(view.configPathPlaceholder, '');
  assert.equal(view.configPathHelp, 'Config path for the No Default driver. Required: this driver has no default.');
  assert.equal(view.showStatusPagePath, false, 'a managed driver with no suggested status page path hides that field');
});

test('proxyFieldView hides the config path field for a driver that manages no proxy, even if it reports a default path', () => {
  const drivers = [{ id: 'odd', label: 'Odd', defaultConfigPath: '/etc/odd.conf', suggestedStatusPagePath: '/var/www/index.html', managesProxy: false, usesSharedCertificate: false, configPathNote: null, usesConfigFile: true }];
  const view = proxyFieldView('odd', drivers);
  assert.equal(view.showConfigPath, false);
  assert.equal(view.showStatusPagePath, false);
});

// issue #26: the admin-API Caddy driver writes no file, so the config path
// field doesn't apply; the status page still does.
test('proxyFieldView hides the config path for a driver that uses no config file, and keeps the status page', () => {
  const CADDY_API = {
    id: 'caddy-api',
    label: 'Caddy (admin API)',
    defaultConfigPath: null,
    suggestedStatusPagePath: '/usr/share/caddy/index.html',
    managesProxy: true,
    usesSharedCertificate: false,
    configPathNote: null,
    usesConfigFile: false,
  };
  const view = proxyFieldView('caddy-api', [...DRIVERS, CADDY_API]);
  assert.equal(view.showConfigPath, false);
  assert.equal(view.configPathHelp, undefined);
  assert.equal(view.showStatusPagePath, true);
  assert.equal(view.statusPagePlaceholder, '/usr/share/caddy/index.html');
  assert.equal(view.showTlsFields, false);
});
