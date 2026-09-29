import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proxyHostText, LAN_GATEWAYS_EMPTY_TEXT, proxyDriverOptions } from '../../web-client/src/lib/settings-display.ts';

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
    { id: 'caddy', label: 'Caddy', defaultConfigPath: '/etc/caddy/Caddyfile', suggestedStatusPagePath: '/usr/share/caddy/index.html' },
    { id: 'none', label: 'No proxy', defaultConfigPath: null, suggestedStatusPagePath: null },
  ];
  assert.deepEqual(proxyDriverOptions(drivers, 'caddy'), [
    { value: 'caddy', label: 'Caddy (default)' },
    { value: 'none', label: 'No proxy' },
  ]);
});

test('proxyDriverOptions preserves driver order and suffixes whichever id is the default', () => {
  const drivers = [
    { id: 'caddy', label: 'Caddy', defaultConfigPath: '/etc/caddy/Caddyfile', suggestedStatusPagePath: '/usr/share/caddy/index.html' },
    { id: 'none', label: 'No proxy', defaultConfigPath: null, suggestedStatusPagePath: null },
  ];
  assert.deepEqual(proxyDriverOptions(drivers, 'none'), [
    { value: 'caddy', label: 'Caddy' },
    { value: 'none', label: 'No proxy (default)' },
  ]);
});
