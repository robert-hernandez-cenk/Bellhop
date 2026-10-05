import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertLegacyTlsSettings } from '../../../src/lib/proxy/legacy-tls.ts';

test('caddy / caddy-api / unset driver: each proxyCaddyTls value maps to its tlsSource and is removed', () => {
  const map = { cloudflare: 'acme-dns', letsencrypt: 'acme-http', internal: 'internal', files: 'files' } as const;
  for (const driver of ['caddy', 'caddy-api', undefined] as const) {
    for (const [legacy, tlsSource] of Object.entries(map)) {
      const result = convertLegacyTlsSettings({ proxyDriver: driver, proxyCaddyTls: legacy });
      assert.equal(result.tlsSource, tlsSource, `${driver}/${legacy}`);
      assert.deepEqual(result.remove, ['proxyCaddyTls']);
      assert.equal(result.description, `proxyCaddyTls '${legacy}' -> tlsSource '${tlsSource}'; removed proxyCaddyTls`);
    }
  }
});

test('traefik: proxyCertResolver none maps to external and is removed', () => {
  const result = convertLegacyTlsSettings({ proxyDriver: 'traefik', proxyCertResolver: 'none' });
  assert.equal(result.tlsSource, 'external');
  assert.deepEqual(result.remove, ['proxyCertResolver']);
  assert.equal(result.description, "proxyCertResolver 'none' -> tlsSource 'external'; removed proxyCertResolver");
});

test('any other driver: proxyCaddyTls is removed without writing tlsSource', () => {
  for (const driver of ['nginx', 'nginx-proxy-manager', 'haproxy', 'none'] as const) {
    const result = convertLegacyTlsSettings({ proxyDriver: driver, proxyCaddyTls: 'internal' });
    assert.equal(result.tlsSource, undefined, driver);
    assert.deepEqual(result.remove, ['proxyCaddyTls']);
    assert.equal(result.description, 'removed proxyCaddyTls');
  }
});

test('traefik: proxyCaddyTls is removed without writing tlsSource', () => {
  const result = convertLegacyTlsSettings({ proxyDriver: 'traefik', proxyCaddyTls: 'files' });
  assert.equal(result.tlsSource, undefined);
  assert.deepEqual(result.remove, ['proxyCaddyTls']);
});

test('any driver other than traefik: proxyCertResolver none is removed without writing tlsSource', () => {
  for (const driver of ['caddy', 'nginx', 'haproxy', undefined] as const) {
    const result = convertLegacyTlsSettings({ proxyDriver: driver, proxyCertResolver: 'none' });
    assert.equal(result.tlsSource, undefined, String(driver));
    assert.deepEqual(result.remove, ['proxyCertResolver']);
    assert.equal(result.description, 'removed proxyCertResolver');
  }
});

test('a named proxyCertResolver is untouched on every driver', () => {
  for (const driver of ['caddy', 'traefik', 'nginx', undefined] as const) {
    const result = convertLegacyTlsSettings({ proxyDriver: driver, proxyCertResolver: 'cloudflare' });
    assert.equal(result.tlsSource, undefined);
    assert.deepEqual(result.remove, []);
    assert.equal(result.description, undefined);
  }
});

test('never overwrites an existing tlsSource, but still removes the legacy value', () => {
  const result = convertLegacyTlsSettings({ proxyDriver: 'caddy', proxyCaddyTls: 'letsencrypt', tlsSource: 'internal' });
  assert.equal(result.tlsSource, undefined);
  assert.deepEqual(result.remove, ['proxyCaddyTls']);
  assert.equal(result.description, 'removed proxyCaddyTls (tlsSource already set)');

  const traefik = convertLegacyTlsSettings({ proxyDriver: 'traefik', proxyCertResolver: 'none', tlsSource: 'files' });
  assert.equal(traefik.tlsSource, undefined);
  assert.deepEqual(traefik.remove, ['proxyCertResolver']);
});

test('both legacy values present: each applies to its own driver only', () => {
  const caddy = convertLegacyTlsSettings({ proxyDriver: 'caddy', proxyCaddyTls: 'internal', proxyCertResolver: 'none' });
  assert.equal(caddy.tlsSource, 'internal');
  assert.deepEqual(caddy.remove, ['proxyCaddyTls', 'proxyCertResolver']);
  assert.equal(caddy.description, "proxyCaddyTls 'internal' -> tlsSource 'internal'; removed proxyCaddyTls; removed proxyCertResolver");

  const traefik = convertLegacyTlsSettings({ proxyDriver: 'traefik', proxyCaddyTls: 'internal', proxyCertResolver: 'none' });
  assert.equal(traefik.tlsSource, 'external');
  assert.deepEqual(traefik.remove, ['proxyCaddyTls', 'proxyCertResolver']);
  assert.equal(traefik.description, "proxyCertResolver 'none' -> tlsSource 'external'; removed proxyCaddyTls; removed proxyCertResolver");
});

test('nothing to do: no tlsSource, empty remove, no description', () => {
  for (const input of [{}, { proxyDriver: 'caddy' as const }, { tlsSource: 'files' as const }]) {
    const result = convertLegacyTlsSettings(input);
    assert.equal(result.tlsSource, undefined);
    assert.deepEqual(result.remove, []);
    assert.equal(result.description, undefined);
  }
});
