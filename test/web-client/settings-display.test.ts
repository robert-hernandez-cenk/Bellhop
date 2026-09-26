import { test } from 'node:test';
import assert from 'node:assert/strict';
import { caddyHostText, LAN_GATEWAYS_EMPTY_TEXT } from '../../web-client/src/lib/settings-display.ts';

test('caddyHostText returns "<name> (<ip>)" for a set caddy entry', () => {
  assert.equal(caddyHostText({ name: 'proxy', ip: '10.0.0.2' }), 'proxy (10.0.0.2)');
});

test('caddyHostText explains the empty state for null', () => {
  assert.equal(caddyHostText(null), 'not set — no inventory entry has caddy: true with an IP yet');
});

test('LAN_GATEWAYS_EMPTY_TEXT explains the empty state', () => {
  assert.equal(LAN_GATEWAYS_EMPTY_TEXT, 'LAN gateways: none yet — no host has a midScheme');
});
