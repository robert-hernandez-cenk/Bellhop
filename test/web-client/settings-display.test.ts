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
    { id: 'caddy', label: 'Caddy', defaultConfigPath: '/etc/caddy/Caddyfile', suggestedStatusPagePath: '/usr/share/caddy/index.html', managesProxy: true, usesSharedCertificate: false, usesCertResolver: false, usesApiUrl: false, configPathNote: null },
    { id: 'none', label: 'No proxy', defaultConfigPath: null, suggestedStatusPagePath: null, managesProxy: false, usesSharedCertificate: false, usesCertResolver: false, usesApiUrl: false, configPathNote: null },
  ];
  assert.deepEqual(proxyDriverOptions(drivers, 'caddy'), [
    { value: 'caddy', label: 'Caddy (default)' },
    { value: 'none', label: 'No proxy' },
  ]);
});

test('proxyDriverOptions preserves driver order and suffixes whichever id is the default', () => {
  const drivers = [
    { id: 'caddy', label: 'Caddy', defaultConfigPath: '/etc/caddy/Caddyfile', suggestedStatusPagePath: '/usr/share/caddy/index.html', managesProxy: true, usesSharedCertificate: false, usesCertResolver: false, usesApiUrl: false, configPathNote: null },
    { id: 'none', label: 'No proxy', defaultConfigPath: null, suggestedStatusPagePath: null, managesProxy: false, usesSharedCertificate: false, usesCertResolver: false, usesApiUrl: false, configPathNote: null },
  ];
  assert.deepEqual(proxyDriverOptions(drivers, 'none'), [
    { value: 'caddy', label: 'Caddy' },
    { value: 'none', label: 'No proxy (default)' },
  ]);
});

const DRIVERS = [
  { id: 'caddy', label: 'Caddy', defaultConfigPath: '/etc/caddy/Caddyfile', suggestedStatusPagePath: '/usr/share/caddy/index.html', managesProxy: true, usesSharedCertificate: false, usesCertResolver: false, usesApiUrl: false, configPathNote: null },
  { id: 'none', label: 'No proxy', defaultConfigPath: null, suggestedStatusPagePath: null, managesProxy: false, usesSharedCertificate: false, usesCertResolver: false, usesApiUrl: false, configPathNote: null },
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
  usesCertResolver: false,
  usesApiUrl: false,
  configPathNote: "nginx replaces this whole file on every apply, and refuses to replace a file it didn't generate.",
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
  configPathNote:
    "HAProxy replaces this whole file and writes bellhop.map beside it on every apply, and refuses to replace a file it didn't generate.",
};

test('proxyFieldView for HAProxy shows the config path (HAProxy default, map-file note) and hides the status page and TLS fields', () => {
  const view = proxyFieldView('haproxy', [...DRIVERS, NGINX, HAPROXY]);
  assert.equal(view.showConfigPath, true);
  assert.equal(view.configPathPlaceholder, '/etc/haproxy/bellhop.cfg');
  assert.match(view.configPathHelp ?? '', /\/etc\/haproxy\/bellhop\.cfg/);
  assert.match(view.configPathHelp ?? '', /writes bellhop\.map beside it/);
  assert.match(view.configPathHelp ?? '', /refuses to replace a file it didn't generate/);
  assert.equal(view.showStatusPagePath, false);
  assert.equal(view.showTlsFields, false);
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

// issue #31 (T005): a managed driver with no config file at all (e.g. Nginx
// Proxy Manager, which is REST-managed) hides the config path field
// entirely rather than showing it as "required" -- there is no default
// config-path state left to show for a managed driver with
// defaultConfigPath: null; only a driver that manages no proxy used to hide
// it. Paired with no suggested status page path and no shared certificate,
// all three fields are hidden.
test('proxyFieldView hides all three fields for a managed driver with no config file, no status page, and no shared certificate', () => {
  const drivers = [{ id: 'nodefault', label: 'No Default', defaultConfigPath: null, suggestedStatusPagePath: null, managesProxy: true, usesSharedCertificate: false, usesCertResolver: false, usesApiUrl: false, configPathNote: null }];
  const view = proxyFieldView('nodefault', drivers);
  assert.equal(view.showConfigPath, false);
  assert.equal(view.configPathHelp, undefined, 'no "required" help text is shown once the field itself is hidden');
  assert.equal(view.showStatusPagePath, false);
  assert.equal(view.showTlsFields, false);
});

test('proxyFieldView hides the config path field for a driver that manages no proxy, even if it reports a default path', () => {
  const drivers = [{ id: 'odd', label: 'Odd', defaultConfigPath: '/etc/odd.conf', suggestedStatusPagePath: '/var/www/index.html', managesProxy: false, usesSharedCertificate: false, usesCertResolver: false, usesApiUrl: false, configPathNote: null }];
  const view = proxyFieldView('odd', drivers);
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
    configPathNote: null,
  };
  const view = proxyFieldView('caddy-api', [CADDY_API]);
  assert.equal(view.showConfigPath, false);
  assert.equal(view.configPathHelp, undefined);
  assert.equal(view.showStatusPagePath, true);
  assert.equal(view.statusPagePlaceholder, '/usr/share/caddy/index.html');
  assert.equal(view.showTlsFields, false);
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
  configPathNote:
    "Traefik's file provider must watch this file's directory. The whole file is replaced on every apply, and a file Bellhop didn't generate is refused.",
};

test('proxyFieldView for Traefik shows the cert resolver and API URL fields, hides the status page and TLS fields', () => {
  const view = proxyFieldView('traefik', [...DRIVERS, NGINX, HAPROXY, TRAEFIK]);
  assert.equal(view.showConfigPath, true);
  assert.equal(view.configPathPlaceholder, '/etc/traefik/dynamic/bellhop.yml');
  assert.equal(view.showStatusPagePath, false);
  assert.equal(view.showTlsFields, false);
  assert.equal(view.showCertResolverField, true);
  assert.equal(view.showApiUrlField, true);
});

test('proxyFieldView hides the cert resolver and API URL fields for every non-Traefik driver', () => {
  assert.equal(proxyFieldView('caddy', [...DRIVERS, NGINX, HAPROXY, TRAEFIK]).showCertResolverField, false);
  assert.equal(proxyFieldView('caddy', [...DRIVERS, NGINX, HAPROXY, TRAEFIK]).showApiUrlField, false);
  assert.equal(proxyFieldView('nginx', [...DRIVERS, NGINX, HAPROXY, TRAEFIK]).showCertResolverField, false);
  assert.equal(proxyFieldView('nginx', [...DRIVERS, NGINX, HAPROXY, TRAEFIK]).showApiUrlField, false);
  assert.equal(proxyFieldView('haproxy', [...DRIVERS, NGINX, HAPROXY, TRAEFIK]).showCertResolverField, false);
  assert.equal(proxyFieldView('haproxy', [...DRIVERS, NGINX, HAPROXY, TRAEFIK]).showApiUrlField, false);
  assert.equal(proxyFieldView('none', [...DRIVERS, NGINX, HAPROXY, TRAEFIK]).showCertResolverField, false);
  assert.equal(proxyFieldView('none', [...DRIVERS, NGINX, HAPROXY, TRAEFIK]).showApiUrlField, false);
});

test('proxyFieldView hides the cert resolver and API URL fields for an unmanaged or unknown driver', () => {
  const unmanaged = proxyFieldView('none', DRIVERS);
  assert.equal(unmanaged.showCertResolverField, false);
  assert.equal(unmanaged.showApiUrlField, false);
  const unknown = proxyFieldView('unknown-provider', DRIVERS);
  assert.equal(unknown.showCertResolverField, false);
  assert.equal(unknown.showApiUrlField, false);
});
