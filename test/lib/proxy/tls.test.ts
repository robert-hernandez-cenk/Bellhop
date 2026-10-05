import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Inventory } from '../../../src/lib/inventory.ts';
import { listDrivers } from '../../../src/lib/proxy/index.ts';
import { caddyDriver } from '../../../src/lib/proxy/drivers/caddy.ts';
import { nginxDriver } from '../../../src/lib/proxy/drivers/nginx.ts';
import { noneDriver } from '../../../src/lib/proxy/drivers/none.ts';
import { TLS_SOURCES } from '../../../src/lib/proxy/ids.ts';
import { effectiveTlsSource, acmeDnsProvider, checkTlsSource, usesCloudflareDns01 } from '../../../src/lib/proxy/tls.ts';

function inv(overrides: Partial<Inventory> = {}): Inventory {
  return { domain: 'example.com', hosts: [{ name: 'pve1', ssh_target: '192.0.2.1', ssh_user: 'root', proxy: true }], guests: [], ...overrides };
}

test('effectiveTlsSource: unset resolves to each driver default', () => {
  for (const driver of listDrivers()) {
    assert.equal(effectiveTlsSource(inv(), driver), driver.capabilities.defaultTlsSource, driver.id);
  }
});

test('effectiveTlsSource: a set tlsSource wins over the driver default', () => {
  assert.equal(effectiveTlsSource(inv({ tlsSource: 'internal' }), caddyDriver), 'internal');
});

test('acmeDnsProvider: unset is cloudflare, set is returned', () => {
  assert.equal(acmeDnsProvider(inv()), 'cloudflare');
  assert.equal(acmeDnsProvider(inv({ acmeDnsProvider: 'cloudflare' })), 'cloudflare');
});

test('checkTlsSource: null when unset or supported', () => {
  for (const driver of listDrivers()) {
    assert.equal(checkTlsSource(inv(), driver), null, driver.id);
    for (const source of driver.capabilities.tlsSources) {
      assert.equal(checkTlsSource(inv({ tlsSource: source }), driver), null, `${driver.id}/${source}`);
    }
  }
});

test('checkTlsSource: unsupported source gives the contract message', () => {
  assert.equal(
    checkTlsSource(inv({ tlsSource: 'internal' }), nginxDriver),
    "tlsSource 'internal' is not supported by the 'nginx' proxy driver (it supports: files) -- to use its default (files), run: bellhop set-config tlsSource --unset --apply, or set it on the web UI's Settings page",
  );
});

test('checkTlsSource: lists every supported source, comma-separated, in declared order', () => {
  assert.equal(
    checkTlsSource(inv({ tlsSource: 'external' }), caddyDriver),
    "tlsSource 'external' is not supported by the 'caddy' proxy driver (it supports: acme-dns, acme-http, internal, files) -- to use its default (acme-dns), run: bellhop set-config tlsSource --unset --apply, or set it on the web UI's Settings page",
  );
});

test('checkTlsSource: the none driver accepts every source', () => {
  for (const source of TLS_SOURCES) {
    assert.equal(checkTlsSource(inv({ tlsSource: source }), noneDriver), null, source);
  }
});

test('usesCloudflareDns01 truth table: only acme-dns with the cloudflare provider', () => {
  for (const source of TLS_SOURCES) {
    assert.equal(usesCloudflareDns01(inv({ tlsSource: source, acmeDnsProvider: 'cloudflare' }), caddyDriver), source === 'acme-dns', source);
  }
  // Unset resolves through the driver default: caddy -> acme-dns, nginx -> files, none -> external.
  assert.equal(usesCloudflareDns01(inv(), caddyDriver), true);
  assert.equal(usesCloudflareDns01(inv(), nginxDriver), false);
  assert.equal(usesCloudflareDns01(inv(), noneDriver), false);
});

// A stored acme-dns must not prune when Bellhop manages no proxy (the
// operator's own proxy owns those records) or when the driver cannot serve
// it (sync-proxy refuses that configuration, so nothing obtained them).
test('usesCloudflareDns01: false under the none driver or an unsupported source, even with acme-dns stored', () => {
  const acmeDns = inv({ tlsSource: 'acme-dns', acmeDnsProvider: 'cloudflare' });
  assert.equal(usesCloudflareDns01(acmeDns, noneDriver), false);
  assert.equal(usesCloudflareDns01(acmeDns, nginxDriver), false);
  assert.equal(usesCloudflareDns01(acmeDns, caddyDriver), true);
});
