// Issue #26: the admin-API Caddy driver end to end through FakeSSHClient,
// answering with the real Caddy v2.10.2 captures in test/fixtures/caddy/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Inventory } from '../../../../src/lib/inventory.ts';
import { buildRoutes, buildProxyContext } from '../../../../src/lib/proxy/routes.ts';
import { caddyApiDriver } from '../../../../src/lib/proxy/drivers/caddy-api.ts';
import { caddyfileModeMessage } from '../../../../src/lib/proxy/caddy-admin.ts';
import { NO_CHANGES_MESSAGE, planCaddyConfig } from '../../../../src/lib/proxy/caddy-json.ts';
import { FakeSSHClient } from '../../../support/fake-ssh-client.ts';

const FIXTURES = new URL('../../../fixtures/caddy/', import.meta.url);
const fixture = (name: string) => readFileSync(new URL(name, FIXTURES), 'utf8');
const handAuthored = JSON.parse(fixture('convert-adapted.json'));

const inventory: Inventory = {
  domain: 'example.com',
  proxyDriver: 'caddy-api',
  hosts: [{ name: 'pve1', ssh_target: '192.0.2.1', ssh_user: 'root', proxy: true }],
  guests: [
    { name: 'media', type: 'lxc', vmid: 105, host: 'pve1', ip: '192.0.2.50', port: 8096, subdomains: ['media'] },
    { name: 'web-lxc', type: 'lxc', vmid: 106, host: 'pve1', ip: '192.0.2.51', subdomains: ['web'] },
  ],
};

// GET /config/ as curl -D - prints it, for an arbitrary configuration.
function getResponse(config: unknown, etag = '"/config/ 1111111111111111"'): string {
  return `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nEtag: ${etag}\r\n\r\n${JSON.stringify(config)}`;
}

// Answers reads with `read` and writes with `write`, recording nothing
// else -- the driver's commands are told apart by the PATCH.
function fakeCaddy(read: { stdout: string; code?: number }, write = fixture('patch-200.txt')) {
  return new FakeSSHClient((_t, _u, command) =>
    command.includes('-X PATCH') ? { stdout: write, stderr: '', code: 0 } : { stdout: read.stdout, stderr: '', code: read.code ?? 0 }
  );
}

function driverDeps(ssh: FakeSSHClient, inv: Inventory = inventory) {
  return { ssh, inventory: inv, proxyHost: 'pve1', configPath: null };
}

async function plan(ssh: FakeSSHClient, inv: Inventory = inventory) {
  return caddyApiDriver.plan(buildRoutes(inv), buildProxyContext(inv, caddyApiDriver), driverDeps(ssh, inv));
}

test('declares what the Settings page and capability checks read', () => {
  assert.equal(caddyApiDriver.id, 'caddy-api');
  assert.equal(caddyApiDriver.label, 'Caddy (admin API)');
  assert.equal(caddyApiDriver.defaultConfigPath, null);
  assert.deepEqual(caddyApiDriver.capabilities.authModes, ['forward', 'oidc']);
  assert.deepEqual(caddyApiDriver.statusPage, { suggestedPath: '/usr/share/caddy/index.html' });
  // issue #72: the same TLS sources as the file-based Caddy driver.
  assert.deepEqual(caddyApiDriver.capabilities.tlsSources, ['acme-dns', 'acme-http', 'internal', 'files']);
  assert.equal(caddyApiDriver.capabilities.defaultTlsSource, 'acme-dns');
});

test('a dry run reads once, with the Caddyfile-mode check, and writes nothing (FR-003)', async () => {
  const ssh = fakeCaddy({ stdout: fixture('get-config-routes.txt') });
  const p = await plan(ssh);
  assert.equal(ssh.history.length, 1);
  assert.match(ssh.history[0].command, /systemctl is-active --quiet caddy\.service/);
  assert.match(p.preview, /^\+ route media\.example\.com -> 192\.0\.2\.50:8096$/m);
  assert.match(p.preview, /^\+ route web\.example\.com -> 192\.0\.2\.51:80$/m);
});

test('apply PATCHes exactly the planned configuration with the read Etag', async () => {
  const ssh = fakeCaddy({ stdout: fixture('get-config-routes.txt') });
  const p = await plan(ssh);
  await caddyApiDriver.apply(p, driverDeps(ssh));
  assert.equal(ssh.history.length, 2);
  const write = ssh.history[1].command;
  assert.match(write, /-H 'If-Match: "\/config\/ 5fa1bc684323e7a0"'/);
  const body = JSON.parse(write.split('\n')[2]);
  // The hand-authored www route is still there, after Bellhop's.
  assert.deepEqual(
    body.apps.http.servers.srv0.routes.map((r: { '@id'?: string }) => r['@id'] ?? 'www'),
    ['bellhop-route-media.example.com', 'bellhop-route-web.example.com', 'www']
  );
  const expected = planCaddyConfig(handAuthored, buildRoutes(inventory), buildProxyContext(inventory, caddyApiDriver), 'pve1').config;
  assert.deepEqual(body, expected);
});

test('a second sync with nothing changed previews no changes and sends no write (SC-003)', async () => {
  const synced = planCaddyConfig(handAuthored, buildRoutes(inventory), buildProxyContext(inventory, caddyApiDriver), 'pve1').config;
  const ssh = fakeCaddy({ stdout: getResponse(synced) });
  const p = await plan(ssh);
  assert.equal(p.preview, NO_CHANGES_MESSAGE);
  await caddyApiDriver.apply(p, driverDeps(ssh));
  assert.equal(ssh.history.length, 1);
});

test('a conflicting hand-authored route: the rest is written, then apply fails naming it (FR-007)', async () => {
  const live = JSON.parse(JSON.stringify(handAuthored));
  live.apps.http.servers.srv0.routes.push({ match: [{ host: ['web.example.com'] }], handle: [{ handler: 'static_response' }] });
  const ssh = fakeCaddy({ stdout: getResponse(live) });
  const p = await plan(ssh);
  assert.match(p.preview, /^! conflict web\.example\.com \(entry 'web-lxc'\)/m);
  await assert.rejects(caddyApiDriver.apply(p, driverDeps(ssh)), /^Error: Hostname 'web\.example\.com' for entry 'web-lxc' is already claimed/);
  assert.equal(ssh.history.length, 2);
  const body = JSON.parse(ssh.history[1].command.split('\n')[2]);
  const ids = body.apps.http.servers.srv0.routes.map((r: { '@id'?: string }) => r['@id']);
  assert.ok(ids.includes('bellhop-route-media.example.com'));
  assert.ok(!ids.includes('bellhop-route-web.example.com'));
});

test('a Caddyfile-mode Caddy is refused before any change, dry run or apply (FR-010, SC-005)', async () => {
  const ssh = fakeCaddy({ stdout: '', code: 3 });
  await assert.rejects(plan(ssh), { message: caddyfileModeMessage('pve1') });
  assert.equal(ssh.history.length, 1);
  assert.ok(!ssh.history[0].command.includes('PATCH'));
});

test('a stale Etag is reported and nothing else is attempted (FR-005)', async () => {
  const ssh = fakeCaddy({ stdout: fixture('get-config-routes.txt') }, fixture('patch-412.txt'));
  const p = await plan(ssh);
  await assert.rejects(caddyApiDriver.apply(p, driverDeps(ssh)), /changed after it was read; nothing was written/);
});

test('snapshot pretty-prints the live configuration without the service check (FR-013)', async () => {
  const ssh = fakeCaddy({ stdout: fixture('get-config-routes.txt') });
  // A forward-gated entry with no authentik ip would make buildRoutes
  // throw; snapshot must never need routes.
  const broken: Inventory = {
    ...inventory,
    guests: [{ name: 'app-lxc', type: 'lxc', vmid: 120, host: 'pve1', ip: '192.0.2.20', subdomains: ['app'], authGroup: 'bellhop-users' }],
  };
  const text = await caddyApiDriver.snapshot(driverDeps(ssh, broken));
  assert.deepEqual(JSON.parse(text), handAuthored);
  assert.match(text, /^\{\n  "apps": \{/);
  assert.ok(!ssh.history[0].command.includes('systemctl'));
});
