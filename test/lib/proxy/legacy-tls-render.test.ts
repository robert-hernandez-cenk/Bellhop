// Issue #72 (User Story 4, SC-001): an existing deployment's rendered proxy
// configuration is unchanged by the migration. Each test starts from a
// database holding the pre-#72 meta row (proxyCaddyTls / proxyCertResolver
// 'none') with no tlsSource, opens it through loadInventory (which runs the
// one-time migration), and renders through runSyncProxy's dry run.
//
// File-based Caddy and Traefik are pinned against literal pre-#72 output --
// the same clause text test/lib/proxy/drivers/caddy.test.ts and
// traefik.test.ts pin for each mode. caddy-api renders JSON objects whose
// byte-level parity with Caddy's own adapter is pinned in
// test/lib/proxy/caddy-json.test.ts (test/fixtures/caddy/tls-*-adapted.json,
// captured before #72); here its migrated preview is compared with the
// preview for the explicit tlsSource the legacy value maps to, plus the
// distinguishing TLS object each legacy mode always produced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { loadInventory, saveInventory, type Inventory } from '../../../src/lib/inventory.ts';
import { runSyncProxy } from '../../../src/commands/networking/sync-proxy.ts';
import { FakeSSHClient } from '../../support/fake-ssh-client.ts';
import { checkTlsSource } from '../../../src/lib/proxy/tls.ts';
import { nginxDriver } from '../../../src/lib/proxy/drivers/nginx.ts';

const base: Inventory = {
  domain: 'example.com',
  hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', proxy: true }],
  guests: [{ name: 'media', type: 'lxc', vmid: 105, host: 'pve1', ip: '192.0.2.50', port: 8096, subdomains: ['media'] }],
};

// A database as a pre-#72 deployment left it: the settings plus the raw
// legacy meta rows, never a tlsSource.
function legacyInventory(proxyDriver: string, legacyRows: Record<string, string>): Inventory {
  const dir = mkdtempSync(path.join(tmpdir(), 'bellhop-test-'));
  const dest = path.join(dir, 'bellhop.db');
  saveInventory(dest, base);
  const writer = new Database(dest);
  const upsert = writer.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  upsert.run('proxyDriver', proxyDriver);
  for (const [k, v] of Object.entries(legacyRows)) upsert.run(k, v);
  writer.close();
  const originalLog = console.log;
  console.log = () => {}; // the one-time migration log line
  try {
    return loadInventory(dest);
  } finally {
    console.log = originalLog;
  }
}

const quiet = () => new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));

const SITE = ['media.example.com {', '    reverse_proxy 192.0.2.50:8096 {', '        header_up X-Forwarded-Port 443', '    }'];
const caddyBlock = (clause: string[]) => ['# BEGIN bellhop-managed', ...SITE, ...clause, '}', '# END bellhop-managed'].join('\n');

// The pre-#72 Caddyfile output per proxyCaddyTls mode.
const PRE_72_CADDY: Record<string, string> = {
  cloudflare: caddyBlock([
    '    tls {',
    '        dns cloudflare {env.CLOUDFLARE_API_TOKEN}',
    '        resolvers 1.1.1.1 8.8.8.8',
    '    }',
  ]),
  letsencrypt: caddyBlock([]),
  internal: caddyBlock(['    tls internal']),
  files: caddyBlock([
    '    tls /etc/letsencrypt/live/example.com/fullchain.pem /etc/letsencrypt/live/example.com/privkey.pem',
  ]),
};

for (const [mode, expected] of Object.entries(PRE_72_CADDY)) {
  test(`caddy with legacy proxyCaddyTls '${mode}' renders the pre-#72 Caddyfile byte for byte after migration`, async () => {
    const inventory = legacyInventory('caddy', { proxyCaddyTls: mode });
    const result = await runSyncProxy({}, { ssh: quiet(), inventory });
    assert.equal(result.preview, expected);
  });
}

const FIXTURES = new URL('../../fixtures/caddy/', import.meta.url);
const fixture = (name: string) => readFileSync(new URL(name, FIXTURES), 'utf8');

function fakeCaddyApi() {
  return new FakeSSHClient((_t, _u, command) => ({
    stdout: command.includes('-X PATCH') ? fixture('patch-200.txt') : fixture('get-config-empty.txt'),
    stderr: '',
    code: 0,
  }));
}

const CADDY_API_SOURCE: Record<string, { tlsSource: Inventory['tlsSource']; marker: RegExp | null }> = {
  cloudflare: { tlsSource: 'acme-dns', marker: /"dns"/ },
  letsencrypt: { tlsSource: 'acme-http', marker: null },
  internal: { tlsSource: 'internal', marker: /"module": ?"internal"/ },
  files: { tlsSource: 'files', marker: /fullchain.pem/ },
};

for (const [mode, { tlsSource, marker }] of Object.entries(CADDY_API_SOURCE)) {
  test(`caddy-api with legacy proxyCaddyTls '${mode}' previews exactly what tlsSource '${tlsSource}' did, TLS objects included`, async () => {
    const migrated = await runSyncProxy({}, { ssh: fakeCaddyApi(), inventory: legacyInventory('caddy-api', { proxyCaddyTls: mode }) });
    const explicit = await runSyncProxy({}, { ssh: fakeCaddyApi(), inventory: { ...base, proxyDriver: 'caddy-api', tlsSource } });
    assert.equal(migrated.preview, explicit.preview);
    if (marker) assert.match(migrated.preview, marker);
    else assert.doesNotMatch(migrated.preview, /tls/);
  });
}

test("traefik with legacy proxyCertResolver 'none' renders the pre-#72 resolver-less routers byte for byte after migration", async () => {
  const inventory = legacyInventory('traefik', { proxyCertResolver: 'none' });
  const result = await runSyncProxy({}, { ssh: quiet(), inventory });
  const lines = result.preview.split('\n');
  // Pre-#72 'none' rendered an empty `tls: {}` and never named a resolver.
  assert.ok(lines.includes('      tls: {}'));
  assert.doesNotMatch(result.preview, /certResolver/);
  const explicit = await runSyncProxy({}, { ssh: quiet(), inventory: { ...base, proxyDriver: 'traefik', tlsSource: 'external' } });
  assert.equal(result.preview, explicit.preview);
});

// Code review (#72): the old default proxyCaddyTls 'cloudflare' migrates to
// an unset tlsSource, not a pinned 'acme-dns' -- Caddy's output is the same
// (pinned above), and a later switch to a driver without acme-dns falls
// back to that driver's default instead of being refused.
test("caddy with legacy proxyCaddyTls 'cloudflare' migrates to an unset tlsSource, so a switch to nginx is not refused", () => {
  const inventory = legacyInventory('caddy', { proxyCaddyTls: 'cloudflare' });
  assert.equal(inventory.tlsSource, undefined);
  assert.equal(checkTlsSource({ ...inventory, proxyDriver: 'nginx' }, nginxDriver), null);
});
