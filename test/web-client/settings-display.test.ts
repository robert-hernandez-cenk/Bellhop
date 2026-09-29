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
    { id: 'caddy', label: 'Caddy', defaultConfigPath: '/etc/caddy/Caddyfile', suggestedStatusPagePath: '/usr/share/caddy/index.html', managesProxy: true },
    { id: 'none', label: 'No proxy', defaultConfigPath: null, suggestedStatusPagePath: null, managesProxy: false },
  ];
  assert.deepEqual(proxyDriverOptions(drivers, 'caddy'), [
    { value: 'caddy', label: 'Caddy (default)' },
    { value: 'none', label: 'No proxy' },
  ]);
});

test('proxyDriverOptions preserves driver order and suffixes whichever id is the default', () => {
  const drivers = [
    { id: 'caddy', label: 'Caddy', defaultConfigPath: '/etc/caddy/Caddyfile', suggestedStatusPagePath: '/usr/share/caddy/index.html', managesProxy: true },
    { id: 'none', label: 'No proxy', defaultConfigPath: null, suggestedStatusPagePath: null, managesProxy: false },
  ];
  assert.deepEqual(proxyDriverOptions(drivers, 'none'), [
    { value: 'caddy', label: 'Caddy' },
    { value: 'none', label: 'No proxy (default)' },
  ]);
});

const DRIVERS = [
  { id: 'caddy', label: 'Caddy', defaultConfigPath: '/etc/caddy/Caddyfile', suggestedStatusPagePath: '/usr/share/caddy/index.html', managesProxy: true },
  { id: 'none', label: 'No proxy', defaultConfigPath: null, suggestedStatusPagePath: null, managesProxy: false },
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
  const view = proxyFieldView('nginx', DRIVERS);
  assert.equal(view.showConfigPath, false);
  assert.equal(view.showStatusPagePath, false);
});

// managesProxy, not defaultConfigPath, decides whether the config path field
// applies at all: a managed driver with no default still needs a path, and
// one that manages no proxy never does.
test('proxyFieldView shows the config path field for a managed driver with no default, saying it is required', () => {
  const drivers = [{ id: 'nodefault', label: 'No Default', defaultConfigPath: null, suggestedStatusPagePath: null, managesProxy: true }];
  const view = proxyFieldView('nodefault', drivers);
  assert.equal(view.showConfigPath, true);
  assert.equal(view.configPathPlaceholder, '');
  assert.equal(view.configPathHelp, 'Config path for the No Default driver. Required: this driver has no default.');
  assert.equal(view.showStatusPagePath, false, 'a managed driver with no suggested status page path hides that field');
});

test('proxyFieldView hides the config path field for a driver that manages no proxy, even if it reports a default path', () => {
  const drivers = [{ id: 'odd', label: 'Odd', defaultConfigPath: '/etc/odd.conf', suggestedStatusPagePath: '/var/www/index.html', managesProxy: false }];
  const view = proxyFieldView('odd', drivers);
  assert.equal(view.showConfigPath, false);
  assert.equal(view.showStatusPagePath, false);
});
