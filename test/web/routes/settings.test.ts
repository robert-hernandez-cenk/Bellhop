import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from '../../../src/web/app.ts';
import { JobStore } from '../../../src/web/jobs/job-store.ts';
import { createJobLog } from '../../../src/web/jobs/job-log.ts';
import { JobRunner } from '../../../src/web/jobs/job-runner.ts';
import { FakeSSHClient } from '../../support/fake-ssh-client.ts';
import { FakeAuthentikClient } from '../../support/fake-authentik-client.ts';
import { loadInventory, saveInventory, type Inventory } from '../../../src/lib/inventory.ts';
import { caddyDriver } from '../../../src/lib/proxy/drivers/caddy.ts';
import { nginxDriver } from '../../../src/lib/proxy/drivers/nginx.ts';
import { SETTINGS_KEYS } from '../../../src/lib/inventory.ts';
import { SECRET_SETTINGS_KEYS } from '../../../src/lib/settings-defs.ts';
import { envPinnedError } from '../../../src/web/routes/settings.ts';
import Database from 'better-sqlite3';
import { configValueAt, useConfigStore, writeSecret } from '../../../src/lib/config.ts';
import { newTestSessions, sessionCookie } from '../../support/web-session.ts';

// #69: one web-login session service for the file, passed to every
// buildApp; sessionCookie() mints a signed-in Cookie header on it.
const sessions = newTestSessions();

function baseInventory(): Inventory {
  return {
    domain: 'example.com',
    hosts: [
      {
        name: 'pve1',
        ssh_target: 'pve1.local',
        ssh_user: 'root',
        midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '10.0.0.1' },
      },
    ],
    guests: [{ name: 'proxy', type: 'lxc', vmid: 110, host: 'pve1', ip: '10.0.0.2', proxy: true }],
  };
}

function testApp(inv: Inventory = baseInventory()) {
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const jobRunner = new JobRunner(jobStore, jobLog, ssh);
  const inventoryPath = path.join(mkdtempSync(path.join(tmpdir(), 'inventory-')), 'bellhop.db');
  saveInventory(inventoryPath, inv);
  const app = buildApp({
    sessions,
    inventory: inv,
    baseSsh: ssh,
    jobStore,
    jobLog,
    jobRunner,
    inventoryPath,
    authentik: new FakeAuthentikClient(),
  });
  return { app, inventoryPath };
}

function asAdmin(req: request.Test): request.Test {
  return req.set('Cookie', sessionCookie(sessions, { username: 'admin', groups: ['bellhop-admins'] }));
}

// The three stored (non-secret) OIDC web-login settings; the fourth, the
// client secret, lives in the secret table. Example values only.
const LOGIN_SETTINGS = {
  webUiOidcIssuer: 'https://authentik.example.com/application/o/bellhop/',
  webUiOidcClientId: 'example-client-id',
  webUiOidcRedirectUri: 'https://bellhop.example.com/auth/callback',
};

// A test app whose web login is fully configured, so the oidc guard reaches
// its session check. Registers the db as the config store (as the real
// service does) and leaves the caller to useConfigStore(null).
function loginConfiguredApp(extra: Partial<Inventory> = {}) {
  const made = testApp({ ...baseInventory(), ...LOGIN_SETTINGS, ...extra });
  writeSecret(made.inventoryPath, 'webUiOidcClientSecret', 'example-client-secret');
  useConfigStore(made.inventoryPath);
  return made;
}

const SIGN_IN_FIRST = 'Sign in through /auth/login first, so Bellhop can confirm you can still sign in after this change';

test('GET /api/settings returns 403 for a non-admin', async () => {
  const { app } = testApp();
  const res = await request(app)
    .get('/api/settings')
    .set('Cookie', sessionCookie(sessions, { username: 'someone', groups: ['family'] }));
  assert.equal(res.status, 403);
});

test('GET /api/settings returns current and derived values', async () => {
  const { app } = testApp({ ...baseInventory(), dnsServer: '10.0.0.53' });
  const res = await asAdmin(request(app).get('/api/settings'));
  assert.equal(res.status, 200);
  assert.equal(res.body.settings.dnsServer, '10.0.0.53');
  assert.equal(res.body.settings.nfsServer, undefined);
  assert.deepEqual(res.body.derived.lanGateways, [{ host: 'pve1', gateway: '10.0.0.1' }]);
  assert.ok(!('proxy' in res.body.derived), 'derived.proxy is gone: the firewall rule is no longer scoped to the proxy');
  assert.ok(!('caddy' in res.body.derived), 'derived.caddy is renamed, not aliased');
});

test('PATCH /api/settings writes a value', async () => {
  const { app, inventoryPath } = testApp();
  const res = await asAdmin(request(app).patch('/api/settings')).send({ nfsServer: '10.0.0.5' });
  assert.equal(res.status, 200);
  assert.equal(res.body.settings.nfsServer, '10.0.0.5');
  assert.equal(loadInventory(inventoryPath).nfsServer, '10.0.0.5');
});

test('PATCH /api/settings clears a value sent as null', async () => {
  const { app, inventoryPath } = testApp({ ...baseInventory(), nfsServer: '10.0.0.5' });
  await asAdmin(request(app).patch('/api/settings')).send({ nfsServer: null });
  assert.equal(loadInventory(inventoryPath).nfsServer, undefined);

  // Regression coverage (issue #124): the disk read above passes even if
  // the shared in-memory `inventory` object never actually got the clear
  // applied to it. Exercise the same live request path a real client
  // would use next -- a follow-up GET against the same app instance --
  // to prove the clear is visible through the shared in-memory object,
  // not just on disk.
  const res = await asAdmin(request(app).get('/api/settings'));
  assert.equal(res.status, 200);
  assert.equal(res.body.settings.nfsServer, undefined);
});

test('PATCH /api/settings rejects an unknown key', async () => {
  const { app } = testApp();
  const res = await asAdmin(request(app).patch('/api/settings')).send({ domain: 'other.com' });
  assert.equal(res.status, 400);
});

test('PATCH /api/settings rejects a relative statusPagePath', async () => {
  const { app } = testApp();
  const res = await asAdmin(request(app).patch('/api/settings')).send({ statusPagePath: 'relative.html' });
  assert.equal(res.status, 400);
});

test('GET /api/settings includes customScriptsRepo/customScriptsBranch', async () => {
  const { app } = testApp({
    ...baseInventory(),
    customScriptsRepo: 'example-user/ProxmoxVED',
    customScriptsBranch: 'my-apps',
  });
  const res = await asAdmin(request(app).get('/api/settings'));
  assert.equal(res.status, 200);
  assert.equal(res.body.settings.customScriptsRepo, 'example-user/ProxmoxVED');
  assert.equal(res.body.settings.customScriptsBranch, 'my-apps');
});

test('PATCH /api/settings rejects a customScriptsRepo not shaped like owner/repo, with the same message set-config produces', async () => {
  const { app } = testApp();
  const res = await asAdmin(request(app).patch('/api/settings')).send({ customScriptsRepo: 'not-a-repo' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /must be owner\/repo/);
});

test('PATCH /api/settings clears customScriptsRepo sent as an empty string', async () => {
  const { app, inventoryPath } = testApp({ ...baseInventory(), customScriptsRepo: 'example-user/ProxmoxVED' });
  const res = await asAdmin(request(app).patch('/api/settings')).send({ customScriptsRepo: '' });
  assert.equal(res.status, 200);
  assert.equal(res.body.settings.customScriptsRepo, undefined);
  assert.equal(loadInventory(inventoryPath).customScriptsRepo, undefined);
});

test('PATCH /api/settings returns 403 for a non-admin', async () => {
  const { app } = testApp();
  const res = await request(app)
    .patch('/api/settings')
    .set('Cookie', sessionCookie(sessions, { username: 'someone', groups: ['family'] }))
    .send({ nfsServer: '10.0.0.5' });
  assert.equal(res.status, 403);
});

test('PATCH /api/settings writes proxyDriver and proxyConfigPath', async () => {
  const { app, inventoryPath } = testApp();
  const res = await asAdmin(request(app).patch('/api/settings')).send({
    proxyDriver: 'caddy',
    proxyConfigPath: '/etc/caddy/Caddyfile',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.settings.proxyDriver, 'caddy');
  assert.equal(res.body.settings.proxyConfigPath, '/etc/caddy/Caddyfile');
  const onDisk = loadInventory(inventoryPath);
  assert.equal(onDisk.proxyDriver, 'caddy');
  assert.equal(onDisk.proxyConfigPath, '/etc/caddy/Caddyfile');
});

test('PATCH /api/settings rejects an unknown proxyDriver', async () => {
  const { app, inventoryPath } = testApp();
  const res = await asAdmin(request(app).patch('/api/settings')).send({ proxyDriver: 'unknown-provider' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /^proxyDriver: /);
  assert.equal(loadInventory(inventoryPath).proxyDriver, undefined);
});

test('PATCH /api/settings rejects a relative proxyConfigPath, with the same message set-config produces', async () => {
  const { app } = testApp();
  const res = await asAdmin(request(app).patch('/api/settings')).send({ proxyConfigPath: 'etc/caddy/Caddyfile' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /proxyConfigPath: must be an absolute path/);
});

test('PATCH /api/settings clears proxyConfigPath sent as null', async () => {
  const { app, inventoryPath } = testApp({ ...baseInventory(), proxyConfigPath: '/opt/proxy/Caddyfile' });
  const res = await asAdmin(request(app).patch('/api/settings')).send({ proxyConfigPath: null });
  assert.equal(res.status, 200);
  assert.equal(loadInventory(inventoryPath).proxyConfigPath, undefined);
});

test('PATCH /api/settings writes proxyTlsCertificate and proxyTlsKey', async () => {
  const { app, inventoryPath } = testApp();
  const res = await asAdmin(request(app).patch('/api/settings')).send({
    proxyTlsCertificate: '/etc/letsencrypt/live/example.com/fullchain.pem',
    proxyTlsKey: '/etc/letsencrypt/live/example.com/privkey.pem',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.settings.proxyTlsCertificate, '/etc/letsencrypt/live/example.com/fullchain.pem');
  assert.equal(res.body.settings.proxyTlsKey, '/etc/letsencrypt/live/example.com/privkey.pem');
  const onDisk = loadInventory(inventoryPath);
  assert.equal(onDisk.proxyTlsCertificate, '/etc/letsencrypt/live/example.com/fullchain.pem');
  assert.equal(onDisk.proxyTlsKey, '/etc/letsencrypt/live/example.com/privkey.pem');
});

test('PATCH /api/settings clears proxyTlsCertificate/proxyTlsKey sent as null', async () => {
  const { app, inventoryPath } = testApp({
    ...baseInventory(),
    proxyTlsCertificate: '/etc/letsencrypt/live/example.com/fullchain.pem',
    proxyTlsKey: '/etc/letsencrypt/live/example.com/privkey.pem',
  });
  const res = await asAdmin(request(app).patch('/api/settings')).send({
    proxyTlsCertificate: null,
    proxyTlsKey: null,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.settings.proxyTlsCertificate, undefined);
  assert.equal(res.body.settings.proxyTlsKey, undefined);
  const onDisk = loadInventory(inventoryPath);
  assert.equal(onDisk.proxyTlsCertificate, undefined);
  assert.equal(onDisk.proxyTlsKey, undefined);
});

test('PATCH /api/settings rejects a relative proxyTlsCertificate, with the same message set-config produces', async () => {
  const { app } = testApp();
  const res = await asAdmin(request(app).patch('/api/settings')).send({
    proxyTlsCertificate: 'etc/letsencrypt/live/example.com/fullchain.pem',
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /proxyTlsCertificate: must be an absolute path/);
});

test('PATCH /api/settings accepts proxyDriver nginx', async () => {
  const { app, inventoryPath } = testApp();
  const res = await asAdmin(request(app).patch('/api/settings')).send({ proxyDriver: 'nginx' });
  assert.equal(res.status, 200);
  assert.equal(res.body.settings.proxyDriver, 'nginx');
  assert.equal(loadInventory(inventoryPath).proxyDriver, 'nginx');
});

const CADDY_CONFIG_PATH_NOTE = caddyDriver.configPathNote;
const NGINX_CONFIG_PATH_NOTE = nginxDriver.configPathNote;
const HAPROXY_CONFIG_PATH_NOTE =
  "HAProxy replaces this whole file and writes bellhop.map beside it on every apply, and refuses to replace a file it didn't generate.";
const TRAEFIK_CONFIG_PATH_NOTE =
  "Traefik's file provider must watch this file's directory. The whole file is replaced on every apply, and a file Bellhop didn't generate is refused.";

// issue #72 (contracts/settings-api-and-ui.md): every driver reports its
// supported tlsSources (in TLS_SOURCES order) and defaultTlsSource, which
// replace the old usesCaddyTls/usesSharedCertificate hints.
// issue #73: usesNpmApi is true only for the Nginx Proxy Manager driver --
// every other driver's own field must come back false.
const PROXY_DRIVERS_INFO = [
  { id: 'caddy', label: 'Caddy', defaultConfigPath: '/etc/caddy/Caddyfile', suggestedStatusPagePath: '/usr/share/caddy/index.html', managesProxy: true, tlsSources: ['acme-dns', 'acme-http', 'internal', 'files'], defaultTlsSource: 'acme-dns', usesCertResolver: false, usesApiUrl: false, usesNpmApi: false, configPathNote: CADDY_CONFIG_PATH_NOTE },
  { id: 'caddy-api', label: 'Caddy (admin API)', defaultConfigPath: null, suggestedStatusPagePath: '/usr/share/caddy/index.html', managesProxy: true, tlsSources: ['acme-dns', 'acme-http', 'internal', 'files'], defaultTlsSource: 'acme-dns', usesCertResolver: false, usesApiUrl: false, usesNpmApi: false, configPathNote: null },
  { id: 'nginx', label: 'nginx', defaultConfigPath: '/etc/nginx/conf.d/bellhop.conf', suggestedStatusPagePath: '/var/www/html/index.html', managesProxy: true, tlsSources: ['files'], defaultTlsSource: 'files', usesCertResolver: false, usesApiUrl: false, usesNpmApi: false, configPathNote: NGINX_CONFIG_PATH_NOTE },
  { id: 'nginx-proxy-manager', label: 'Nginx Proxy Manager', defaultConfigPath: null, suggestedStatusPagePath: null, managesProxy: true, tlsSources: ['acme-http'], defaultTlsSource: 'acme-http', usesCertResolver: false, usesApiUrl: false, usesNpmApi: true, configPathNote: null },
  { id: 'haproxy', label: 'HAProxy', defaultConfigPath: '/etc/haproxy/bellhop.cfg', suggestedStatusPagePath: null, managesProxy: true, tlsSources: ['external'], defaultTlsSource: 'external', usesCertResolver: false, usesApiUrl: false, usesNpmApi: false, configPathNote: HAPROXY_CONFIG_PATH_NOTE },
  { id: 'traefik', label: 'Traefik', defaultConfigPath: '/etc/traefik/dynamic/bellhop.yml', suggestedStatusPagePath: null, managesProxy: true, tlsSources: ['acme-dns', 'acme-http', 'files', 'external'], defaultTlsSource: 'acme-dns', usesCertResolver: true, usesApiUrl: true, usesNpmApi: false, configPathNote: TRAEFIK_CONFIG_PATH_NOTE },
  { id: 'none', label: 'No proxy', defaultConfigPath: null, suggestedStatusPagePath: null, managesProxy: false, tlsSources: ['acme-dns', 'acme-http', 'internal', 'files', 'external'], defaultTlsSource: 'external', usesCertResolver: false, usesApiUrl: false, usesNpmApi: false, configPathNote: null },
];

test('GET /api/settings includes proxyDrivers and defaultProxyDriver', async () => {
  const { app } = testApp();
  const res = await asAdmin(request(app).get('/api/settings'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.proxyDrivers, PROXY_DRIVERS_INFO);
  assert.equal(res.body.defaultProxyDriver, 'caddy');
});

test('PATCH /api/settings response also includes proxyDrivers and defaultProxyDriver', async () => {
  const { app } = testApp();
  const res = await asAdmin(request(app).patch('/api/settings')).send({ nfsServer: '10.0.0.5' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.proxyDrivers, PROXY_DRIVERS_INFO);
  assert.equal(res.body.defaultProxyDriver, 'caddy');
});

// issue #72: acmeDnsProviders/defaultAcmeDnsProvider accompany proxyDrivers
// on both GET and PATCH (the same "shared by settingsResponse()" guarantee),
// replacing the old caddyTlsModes/defaultCaddyTls.
test('GET /api/settings includes acmeDnsProviders and defaultAcmeDnsProvider, and no caddyTlsModes/defaultCaddyTls', async () => {
  const { app } = testApp();
  const res = await asAdmin(request(app).get('/api/settings'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.acmeDnsProviders, ['cloudflare']);
  assert.equal(res.body.defaultAcmeDnsProvider, 'cloudflare');
  assert.equal('caddyTlsModes' in res.body, false);
  assert.equal('defaultCaddyTls' in res.body, false);
});

test('PATCH /api/settings response also includes acmeDnsProviders and defaultAcmeDnsProvider', async () => {
  const { app } = testApp();
  const res = await asAdmin(request(app).patch('/api/settings')).send({ nfsServer: '10.0.0.5' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.acmeDnsProviders, ['cloudflare']);
  assert.equal(res.body.defaultAcmeDnsProvider, 'cloudflare');
});

test('PATCH /api/settings writes tlsSource and acmeDnsProvider', async () => {
  const { app, inventoryPath } = testApp();
  const res = await asAdmin(request(app).patch('/api/settings')).send({ tlsSource: 'acme-http', acmeDnsProvider: 'cloudflare' });
  assert.equal(res.status, 200);
  assert.equal(res.body.settings.tlsSource, 'acme-http');
  assert.equal(res.body.settings.acmeDnsProvider, 'cloudflare');
  const stored = loadInventory(inventoryPath);
  assert.equal(stored.tlsSource, 'acme-http');
  assert.equal(stored.acmeDnsProvider, 'cloudflare');
});

// No write-time driver check (contracts/settings-api-and-ui.md): a source
// the active driver cannot serve is stored, and sync-proxy refuses it later.
test('PATCH /api/settings accepts tlsSource internal while the driver is nginx', async () => {
  const { app, inventoryPath } = testApp({ ...baseInventory(), proxyDriver: 'nginx' });
  const res = await asAdmin(request(app).patch('/api/settings')).send({ tlsSource: 'internal' });
  assert.equal(res.status, 200);
  assert.equal(loadInventory(inventoryPath).tlsSource, 'internal');
});

test('PATCH /api/settings rejects a tlsSource outside the list, with the same message set-config produces', async () => {
  const { app, inventoryPath } = testApp();
  const res = await asAdmin(request(app).patch('/api/settings')).send({ tlsSource: 'letsencrypt' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /^tlsSource: /);
  assert.equal(loadInventory(inventoryPath).tlsSource, undefined);
});

test('PATCH /api/settings clears tlsSource sent as null', async () => {
  const { app, inventoryPath } = testApp({ ...baseInventory(), tlsSource: 'files' });
  const res = await asAdmin(request(app).patch('/api/settings')).send({ tlsSource: null });
  assert.equal(res.status, 200);
  assert.equal(res.body.settings.tlsSource, undefined);
  assert.equal(loadInventory(inventoryPath).tlsSource, undefined);
});

test('PATCH /api/settings rejects proxyCaddyTls as an unknown key (issue #72 removed it)', async () => {
  const { app, inventoryPath } = testApp();
  const res = await asAdmin(request(app).patch('/api/settings')).send({ proxyCaddyTls: 'internal' });
  assert.equal(res.status, 400);
  assert.equal(loadInventory(inventoryPath).tlsSource, undefined);
});

test('PATCH /api/settings accepts proxyDriver caddy-api', async () => {
  const { app, inventoryPath } = testApp();
  const res = await asAdmin(request(app).patch('/api/settings')).send({ proxyDriver: 'caddy-api' });
  assert.equal(res.status, 200);
  assert.equal(res.body.settings.proxyDriver, 'caddy-api');
  assert.equal(loadInventory(inventoryPath).proxyDriver, 'caddy-api');
});

test('PATCH /api/settings writes proxyDriver "none" and persists it', async () => {
  const { app, inventoryPath } = testApp();
  const res = await asAdmin(request(app).patch('/api/settings')).send({ proxyDriver: 'none' });
  assert.equal(res.status, 200);
  assert.equal(res.body.settings.proxyDriver, 'none');
  assert.equal(loadInventory(inventoryPath).proxyDriver, 'none');
});

test('PATCH /api/settings clears proxyDriver sent as null', async () => {
  const { app, inventoryPath } = testApp({ ...baseInventory(), proxyDriver: 'none' });
  const res = await asAdmin(request(app).patch('/api/settings')).send({ proxyDriver: null });
  assert.equal(res.status, 200);
  assert.equal(res.body.settings.proxyDriver, undefined);
  assert.equal(loadInventory(inventoryPath).proxyDriver, undefined);
});

test('A stored proxyConfigPath is still returned while proxyDriver is none', async () => {
  const { app } = testApp({ ...baseInventory(), proxyDriver: 'none', proxyConfigPath: '/opt/proxy/Caddyfile' });
  const res = await asAdmin(request(app).get('/api/settings'));
  assert.equal(res.status, 200);
  assert.equal(res.body.settings.proxyDriver, 'none');
  assert.equal(res.body.settings.proxyConfigPath, '/opt/proxy/Caddyfile');
});

// issue #35, US4 (T017): the two Traefik-only settings. GET's full driver
// list is already covered above (traefik: usesCertResolver/usesApiUrl both
// true, every other driver both false) -- these tests cover the settings
// themselves.
test('PATCH /api/settings writes proxyCertResolver and proxyApiUrl', async () => {
  const { app, inventoryPath } = testApp();
  const res = await asAdmin(request(app).patch('/api/settings')).send({
    proxyCertResolver: 'cloudflare',
    proxyApiUrl: 'http://127.0.0.1:8080',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.settings.proxyCertResolver, 'cloudflare');
  assert.equal(res.body.settings.proxyApiUrl, 'http://127.0.0.1:8080');
  const onDisk = loadInventory(inventoryPath);
  assert.equal(onDisk.proxyCertResolver, 'cloudflare');
  assert.equal(onDisk.proxyApiUrl, 'http://127.0.0.1:8080');
});

test('PATCH /api/settings clears proxyCertResolver/proxyApiUrl sent as null', async () => {
  const { app, inventoryPath } = testApp({
    ...baseInventory(),
    proxyCertResolver: 'cloudflare',
    proxyApiUrl: 'http://127.0.0.1:8080',
  });
  const res = await asAdmin(request(app).patch('/api/settings')).send({
    proxyCertResolver: null,
    proxyApiUrl: null,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.settings.proxyCertResolver, undefined);
  assert.equal(res.body.settings.proxyApiUrl, undefined);
  const onDisk = loadInventory(inventoryPath);
  assert.equal(onDisk.proxyCertResolver, undefined);
  assert.equal(onDisk.proxyApiUrl, undefined);
});

test('PATCH /api/settings rejects a proxyApiUrl that is not an http(s) URL, with the same message set-config produces', async () => {
  const { app, inventoryPath } = testApp();
  const res = await asAdmin(request(app).patch('/api/settings')).send({ proxyApiUrl: 'ftp://x' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /proxyApiUrl: must be an http:\/\/ or https:\/\/ URL/);
  assert.equal(loadInventory(inventoryPath).proxyApiUrl, undefined);
});

// issue #53, US3 (T015): pveUserRealm/pveCreatorRole, the Proxmox
// creator-grant settings. Same SettingsSchema `set-config` validates
// against (test/commands/set-config.test.ts), so the message text here
// must match that file's assertions exactly.
test('GET /api/settings includes pveUserRealm/pveCreatorRole', async () => {
  const { app } = testApp({
    ...baseInventory(),
    pveUserRealm: 'authentik',
    pveCreatorRole: 'PVEVMAdmin',
  });
  const res = await asAdmin(request(app).get('/api/settings'));
  assert.equal(res.status, 200);
  assert.equal(res.body.settings.pveUserRealm, 'authentik');
  assert.equal(res.body.settings.pveCreatorRole, 'PVEVMAdmin');
});

test('PATCH /api/settings writes pveUserRealm and pveCreatorRole', async () => {
  const { app, inventoryPath } = testApp();
  const res = await asAdmin(request(app).patch('/api/settings')).send({
    pveUserRealm: 'authentik',
    pveCreatorRole: 'PVEVMAdmin',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.settings.pveUserRealm, 'authentik');
  assert.equal(res.body.settings.pveCreatorRole, 'PVEVMAdmin');
  const onDisk = loadInventory(inventoryPath);
  assert.equal(onDisk.pveUserRealm, 'authentik');
  assert.equal(onDisk.pveCreatorRole, 'PVEVMAdmin');
});

test('PATCH /api/settings clears pveUserRealm/pveCreatorRole sent as null', async () => {
  const { app, inventoryPath } = testApp({
    ...baseInventory(),
    pveUserRealm: 'authentik',
    pveCreatorRole: 'PVEVMAdmin',
  });
  const res = await asAdmin(request(app).patch('/api/settings')).send({
    pveUserRealm: null,
    pveCreatorRole: null,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.settings.pveUserRealm, undefined);
  assert.equal(res.body.settings.pveCreatorRole, undefined);
  const onDisk = loadInventory(inventoryPath);
  assert.equal(onDisk.pveUserRealm, undefined);
  assert.equal(onDisk.pveCreatorRole, undefined);
});

test('PATCH /api/settings rejects a pveUserRealm that does not start with a letter, with the same message set-config produces', async () => {
  const { app, inventoryPath } = testApp();
  const res = await asAdmin(request(app).patch('/api/settings')).send({ pveUserRealm: '1realm' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /pveUserRealm: must start with a letter and contain only letters, digits, \., - and _/);
  assert.equal(loadInventory(inventoryPath).pveUserRealm, undefined);
});

test('PATCH /api/settings rejects a pveCreatorRole with an invalid character, with the same message set-config produces', async () => {
  const { app, inventoryPath } = testApp();
  const res = await asAdmin(request(app).patch('/api/settings')).send({ pveCreatorRole: 'My Role' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /pveCreatorRole: must contain only letters, digits, \., - and _/);
  assert.equal(loadInventory(inventoryPath).pveCreatorRole, undefined);
});

// -- Issue #64 US5: sources, environment, env-pinned refusal -----------------

// Sets environment variables for one test and restores them afterwards.
async function withEnv(vars: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(vars)) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
  try {
    await fn();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('GET /api/settings reports a source for every non-secret key, and none for secrets', async () => {
  await withEnv({ AUTHENTIK_OUTPOST_NAME: 'example env outpost' }, async () => {
    const { app } = testApp({ ...baseInventory(), nfsServer: '10.0.0.5', authentikAdminGroup: 'bellhop-admins' });
    const res = await asAdmin(request(app).get('/api/settings'));
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body.sources).sort(), [...SETTINGS_KEYS].sort());
    for (const key of SECRET_SETTINGS_KEYS) assert.ok(!(key in res.body.sources), `${key} must not be in sources`);
    assert.equal(res.body.sources.nfsServer, 'settings');
    assert.equal(res.body.sources.dnsServer, 'none');
    assert.equal(res.body.sources.authentikAdminGroup, 'settings');
    assert.equal(res.body.sources.authentikOutpostName, 'environment');
    assert.equal(res.body.sources.npmApiUrl, 'none');
  });
});

test('GET /api/settings lists env-pinned keys, with a value only for non-secret ones', async () => {
  await withEnv(
    { AUTHENTIK_OUTPOST_NAME: 'example env outpost', GITHUB_API_TOKEN: 'example-GITHUB-SECRET-MARKER' },
    async () => {
      const { app } = testApp();
      const res = await asAdmin(request(app).get('/api/settings'));
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.environment.authentikOutpostName, {
        variable: 'AUTHENTIK_OUTPOST_NAME',
        value: 'example env outpost',
        stored: false,
      });
      assert.deepEqual(res.body.environment.githubApiToken, { variable: 'GITHUB_API_TOKEN', stored: false });
      assert.ok(!('nfsServer' in res.body.environment), 'a key with no env var is never pinned');
      assert.ok(!('authentikAdminGroup' in res.body.environment), 'an unset variable does not pin');
      assert.ok(!JSON.stringify(res.body).includes('GITHUB-SECRET-MARKER'), 'a secret value never appears');
    }
  );
});

test('an empty environment variable does not pin its key', async () => {
  await withEnv({ AUTHENTIK_OUTPOST_NAME: '' }, async () => {
    const { app } = testApp();
    const res = await asAdmin(request(app).get('/api/settings'));
    assert.equal(res.body.sources.authentikOutpostName, 'none');
    assert.ok(!('authentikOutpostName' in res.body.environment));
  });
});

test('PATCH /api/settings refuses an env-pinned key with 400 naming the variable, and writes nothing', async () => {
  await withEnv({ AUTHENTIK_OUTPOST_NAME: 'example env outpost' }, async () => {
    const { app, inventoryPath } = testApp();
    const res = await asAdmin(request(app).patch('/api/settings')).send({
      nfsServer: '10.0.0.5',
      authentikOutpostName: 'stored outpost',
    });
    assert.equal(res.status, 400);
    assert.equal(
      res.body.error,
      'authentikOutpostName is set by the environment variable AUTHENTIK_OUTPOST_NAME -- unset AUTHENTIK_OUTPOST_NAME (or remove it from data/authentik.env) and restart the service to manage it here'
    );
    const onDisk = loadInventory(inventoryPath);
    assert.equal(onDisk.authentikOutpostName, undefined);
    assert.equal(onDisk.nfsServer, undefined, 'the other key in the same request is not written either');
  });
});

test('PATCH /api/settings refuses clearing an env-pinned key too', async () => {
  await withEnv({ NPM_API_URL: 'http://198.51.100.5:81' }, async () => {
    const { app, inventoryPath } = testApp({ ...baseInventory(), npmApiUrl: 'http://198.51.100.6:81' });
    const res = await asAdmin(request(app).patch('/api/settings')).send({ npmApiUrl: null });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /^npmApiUrl is set by the environment variable NPM_API_URL -- .*data\/nginx-proxy-manager\.env/);
    assert.equal(loadInventory(inventoryPath).npmApiUrl, 'http://198.51.100.6:81');
  });
});

test('PATCH /api/settings writes a moved key that is not env-pinned', async () => {
  const { app, inventoryPath } = testApp();
  const res = await asAdmin(request(app).patch('/api/settings')).send({ authentikOutpostName: 'stored outpost' });
  assert.equal(res.status, 200);
  assert.equal(res.body.sources.authentikOutpostName, 'settings');
  assert.equal(loadInventory(inventoryPath).authentikOutpostName, 'stored outpost');
});

test('envPinnedError names each key\'s own env file, and omits the file for a key that has none', () => {
  assert.equal(
    envPinnedError('webUiAuthMode'),
    'webUiAuthMode is set by the environment variable WEB_UI_AUTH_MODE -- unset WEB_UI_AUTH_MODE (or remove it from data/authentik.env) and restart the service to manage it here'
  );
  assert.match(envPinnedError('cloudflareDnsApiToken'), /remove it from data\/cloudflare-api\.env/);
  assert.equal(
    envPinnedError('githubApiToken'),
    'githubApiToken is set by the environment variable GITHUB_API_TOKEN -- unset GITHUB_API_TOKEN and restart the service to manage it here'
  );
});

test('an admin impersonating a non-admin group gets 403 on GET and PATCH /api/settings', async () => {
  const inventoryPath = path.join(mkdtempSync(path.join(tmpdir(), 'inventory-')), 'bellhop.db');
  saveInventory(inventoryPath, baseInventory());
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const app = buildApp({
    sessions,
    inventory: baseInventory(),
    baseSsh: ssh,
    jobStore,
    jobLog,
    jobRunner: new JobRunner(jobStore, jobLog, ssh),
    inventoryPath,
    authentik: new FakeAuthentikClient(),
    impersonationStore: new Map([['admin', 'family']]),
  });
  assert.equal((await asAdmin(request(app).get('/api/settings'))).status, 403);
  const patch = await asAdmin(request(app).patch('/api/settings')).send({ nfsServer: '10.0.0.5' });
  assert.equal(patch.status, 403);
  assert.equal(loadInventory(inventoryPath).nfsServer, undefined);
});

// -- Issue #64 US2: secrets are write-only ------------------------------------

// Reads the two tables directly, so a test can prove where a secret landed
// without going through the accessor.
function storedRows(inventoryPath: string): { meta: string[]; secrets: Record<string, string> } {
  const db = new Database(inventoryPath, { readonly: true });
  try {
    const meta = (db.prepare('SELECT key FROM meta').all() as { key: string }[]).map((r) => r.key);
    const secrets = Object.fromEntries(
      (db.prepare('SELECT key, value FROM secret_settings').all() as { key: string; value: string }[]).map((r) => [r.key, r.value])
    );
    return { meta, secrets };
  } finally {
    db.close();
  }
}

test('GET /api/settings reports every secret as { set, source } and never its value', async () => {
  await withEnv({ GITHUB_API_TOKEN: 'example-github-ENV-MARKER' }, async () => {
    const { app, inventoryPath } = testApp();
    writeSecret(inventoryPath, 'authentikApiToken', 'example-authentik-STORED-MARKER');
    const res = await asAdmin(request(app).get('/api/settings'));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.secrets, {
      authentikApiToken: { set: true, source: 'settings' },
      cloudflareDnsApiToken: { set: false, source: 'none' },
      npmApiPassword: { set: false, source: 'none' },
      githubApiToken: { set: true, source: 'environment' },
      webUiOidcClientSecret: { set: false, source: 'none' },
    });
    const body = JSON.stringify(res.body);
    assert.ok(!body.includes('STORED-MARKER') && !body.includes('ENV-MARKER'), 'no secret value in the response');
  });
});

test('PATCH /api/settings stores a secret in secret_settings, not meta, and returns no value', async () => {
  const { app, inventoryPath } = testApp();
  const res = await asAdmin(request(app).patch('/api/settings')).send({ cloudflareDnsApiToken: 'example-cf-PATCH-MARKER' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.secrets.cloudflareDnsApiToken, { set: true, source: 'settings' });
  assert.ok(!JSON.stringify(res.body).includes('PATCH-MARKER'));
  const rows = storedRows(inventoryPath);
  assert.equal(rows.secrets.cloudflareDnsApiToken, 'example-cf-PATCH-MARKER');
  assert.ok(!rows.meta.includes('cloudflareDnsApiToken'));
  assert.equal(configValueAt(inventoryPath, 'cloudflareDnsApiToken', {}).value, 'example-cf-PATCH-MARKER');
});

test('PATCH /api/settings clears a secret with null or an empty string', async () => {
  const { app, inventoryPath } = testApp();
  writeSecret(inventoryPath, 'npmApiPassword', 'example npm password');
  writeSecret(inventoryPath, 'githubApiToken', 'example-github-token');
  const res = await asAdmin(request(app).patch('/api/settings')).send({ npmApiPassword: null, githubApiToken: '' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.secrets.npmApiPassword, { set: false, source: 'none' });
  assert.deepEqual(res.body.secrets.githubApiToken, { set: false, source: 'none' });
  assert.deepEqual(storedRows(inventoryPath).secrets, {});
});

test('PATCH /api/settings writes a secret and a non-secret key from the same body', async () => {
  const { app, inventoryPath } = testApp();
  const res = await asAdmin(request(app).patch('/api/settings')).send({
    nfsServer: '192.0.2.5',
    authentikApiToken: 'example-authentik-token',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.settings.nfsServer, '192.0.2.5');
  assert.deepEqual(res.body.secrets.authentikApiToken, { set: true, source: 'settings' });
  assert.equal(loadInventory(inventoryPath).nfsServer, '192.0.2.5');
});

test('PATCH /api/settings rejects an invalid secret naming the key, never the value, and writes nothing', async () => {
  const { app, inventoryPath } = testApp();
  const res = await asAdmin(request(app).patch('/api/settings')).send({
    nfsServer: '192.0.2.5',
    githubApiToken: 'example token INVALID-MARKER',
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'githubApiToken: must not contain whitespace');
  assert.ok(!JSON.stringify(res.body).includes('INVALID-MARKER'));
  assert.equal(loadInventory(inventoryPath).nfsServer, undefined, 'the valid key in the same request is not written');
  assert.deepEqual(storedRows(inventoryPath).secrets, {});
});

test('PATCH /api/settings rejects a non-string secret', async () => {
  const { app } = testApp();
  const res = await asAdmin(request(app).patch('/api/settings')).send({ npmApiPassword: 12345 });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'npmApiPassword must be a string or null');
});

test('PATCH /api/settings refuses an env-pinned secret, and writes nothing', async () => {
  await withEnv({ CLOUDFLARE_DNS_API_TOKEN: 'example-cf-ENV-MARKER' }, async () => {
    const { app, inventoryPath } = testApp();
    const res = await asAdmin(request(app).patch('/api/settings')).send({
      nfsServer: '192.0.2.5',
      cloudflareDnsApiToken: 'example-cf-stored',
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, envPinnedError('cloudflareDnsApiToken'));
    assert.ok(!JSON.stringify(res.body).includes('ENV-MARKER'));
    assert.deepEqual(storedRows(inventoryPath).secrets, {});
    assert.equal(loadInventory(inventoryPath).nfsServer, undefined);
  });
});

// -- Issue #64 US6: no self-lockout ------------------------------------------

test('PATCH /api/settings refuses an authentikAdminGroup change that would lock the real requester out', async () => {
  const { app, inventoryPath } = testApp();
  const res = await asAdmin(request(app).patch('/api/settings')).send({ authentikAdminGroup: 'other-admins' });
  assert.equal(res.status, 409);
  assert.equal(
    res.body.error,
    'Refusing to change authentikAdminGroup: you would no longer be an administrator (your groups: bellhop-admins)'
  );
  assert.equal(loadInventory(inventoryPath).authentikAdminGroup, undefined, 'nothing is written');
});

test('PATCH /api/settings refuses an authentikBuiltinAdminGroup change that would lock the real requester out', async () => {
  const { app, inventoryPath } = testApp();
  // Only in Authentik's own built-in admin group here (not the configured
  // bellhop-admins), so changing *that* name is what would lock them out.
  const res = await request(app)
    .patch('/api/settings')
    .set('Cookie', sessionCookie(sessions, { username: 'admin', groups: ['authentik Admins'] }))
    .send({ authentikBuiltinAdminGroup: 'other-builtin' });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /^Refusing to change authentikBuiltinAdminGroup: you would no longer be an administrator/);
  assert.equal(loadInventory(inventoryPath).authentikBuiltinAdminGroup, undefined);
});

test('PATCH /api/settings names the first admin-group field in the body when both would lock the requester out', async () => {
  const { app } = testApp();
  const res = await asAdmin(request(app).patch('/api/settings')).send({
    authentikBuiltinAdminGroup: 'other-builtin',
    authentikAdminGroup: 'other-admins',
  });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /^Refusing to change authentikBuiltinAdminGroup:/);
});

test('PATCH /api/settings allows an authentikAdminGroup change that keeps the real requester an admin', async () => {
  const { app, inventoryPath } = testApp();
  const res = await asAdmin(request(app).patch('/api/settings')).send({ authentikBuiltinAdminGroup: 'authentik Admins' });
  assert.equal(res.status, 200);
  assert.equal(loadInventory(inventoryPath).authentikBuiltinAdminGroup, 'authentik Admins');
});

test('PATCH /api/settings never blocks the synthetic local operator on an admin-group change', async () => {
  const { app, inventoryPath } = testApp();
  const originalDevUser = process.env.WEB_UI_DEV_USER;
  delete process.env.WEB_UI_DEV_USER;
  try {
    const res = await request(app).patch('/api/settings').send({ authentikAdminGroup: 'other-admins' });
    assert.equal(res.status, 200);
    assert.equal(loadInventory(inventoryPath).authentikAdminGroup, 'other-admins');
  } finally {
    if (originalDevUser !== undefined) process.env.WEB_UI_DEV_USER = originalDevUser;
  }
});

test('an impersonating admin still gets 403 on an admin-group PATCH, never reaching the lockout guard', async () => {
  const inventoryPath = path.join(mkdtempSync(path.join(tmpdir(), 'inventory-')), 'bellhop.db');
  saveInventory(inventoryPath, baseInventory());
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const app = buildApp({
    sessions,
    inventory: baseInventory(),
    baseSsh: ssh,
    jobStore,
    jobLog,
    jobRunner: new JobRunner(jobStore, jobLog, ssh),
    inventoryPath,
    authentik: new FakeAuthentikClient(),
    impersonationStore: new Map([['admin', 'family']]),
  });
  const res = await asAdmin(request(app).patch('/api/settings')).send({ authentikAdminGroup: 'bellhop-admins' });
  assert.equal(res.status, 403);
});

// -- #69 US4: switching to oidc is refused until an admin can sign in ---------

async function withoutDevUser<T>(fn: () => Promise<T>): Promise<T> {
  const original = process.env.WEB_UI_DEV_USER;
  delete process.env.WEB_UI_DEV_USER;
  try {
    return await fn();
  } finally {
    if (original !== undefined) process.env.WEB_UI_DEV_USER = original;
  }
}

test('PATCH webUiAuthMode: oidc is refused first for incomplete login settings, naming every missing key', async () => {
  const { app, inventoryPath } = testApp();
  useConfigStore(inventoryPath);
  try {
    // An admin session, so only the completeness check can be what refuses.
    const res = await asAdmin(request(app).patch('/api/settings')).send({ webUiAuthMode: 'oidc' });
    assert.equal(res.status, 409);
    assert.equal(
      res.body.error,
      'Web login is not configured: set webUiOidcIssuer, webUiOidcClientId, webUiOidcRedirectUri, webUiOidcClientSecret first (bellhop configure-web-login <entry> --apply)'
    );
    assert.equal(loadInventory(inventoryPath).webUiAuthMode, undefined);
  } finally {
    useConfigStore(null);
  }
});

test('PATCH webUiAuthMode: oidc counts login values set in the same request, secret included', async () => {
  const { app, inventoryPath } = testApp({ ...baseInventory(), ...LOGIN_SETTINGS });
  useConfigStore(inventoryPath);
  try {
    // Only the secret is missing from the store...
    const refused = await asAdmin(request(app).patch('/api/settings')).send({ webUiAuthMode: 'oidc' });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /set webUiOidcClientSecret first/);
    // ...and supplying it in the same request completes the set.
    const ok = await asAdmin(request(app).patch('/api/settings')).send({
      webUiAuthMode: 'oidc',
      webUiOidcClientSecret: 'example-client-secret',
    });
    assert.equal(ok.status, 200);
    assert.equal(loadInventory(inventoryPath).webUiAuthMode, 'oidc');
  } finally {
    useConfigStore(null);
  }
});

test('PATCH webUiAuthMode: oidc is refused when the same request clears a login value', async () => {
  const { app, inventoryPath } = loginConfiguredApp();
  try {
    const clearedSetting = await asAdmin(request(app).patch('/api/settings')).send({
      webUiAuthMode: 'oidc',
      webUiOidcClientId: null,
    });
    assert.equal(clearedSetting.status, 409);
    assert.match(clearedSetting.body.error, /set webUiOidcClientId first/);
    const clearedSecret = await asAdmin(request(app).patch('/api/settings')).send({
      webUiAuthMode: 'oidc',
      webUiOidcClientSecret: null,
    });
    assert.equal(clearedSecret.status, 409);
    assert.match(clearedSecret.body.error, /set webUiOidcClientSecret first/);
    assert.equal(loadInventory(inventoryPath).webUiAuthMode, undefined);
  } finally {
    useConfigStore(null);
  }
});

test('PATCH webUiAuthMode: oidc counts an environment-supplied login value as set', async () => {
  await withEnv({ WEB_UI_OIDC_ISSUER: 'https://authentik.example.com/application/o/bellhop/' }, async () => {
    const { app, inventoryPath } = testApp({
      ...baseInventory(),
      webUiOidcClientId: 'example-client-id',
      webUiOidcRedirectUri: 'https://bellhop.example.com/auth/callback',
    });
    writeSecret(inventoryPath, 'webUiOidcClientSecret', 'example-client-secret');
    useConfigStore(inventoryPath);
    try {
      const res = await asAdmin(request(app).patch('/api/settings')).send({ webUiAuthMode: 'oidc' });
      assert.equal(res.status, 200);
    } finally {
      useConfigStore(null);
    }
  });
});

test('PATCH webUiAuthMode: oidc is refused from a request with no web-login session (dev user)', async () => {
  const { app, inventoryPath } = loginConfiguredApp();
  const originalGroups = process.env.WEB_UI_DEV_GROUPS;
  process.env.WEB_UI_DEV_GROUPS = 'bellhop-admins';
  try {
    // No session cookie -> falls to the WEB_UI_DEV_USER=test-user dev
    // identity (set for the whole `npm test` run), which is never viaOidc.
    const res = await request(app).patch('/api/settings').send({ webUiAuthMode: 'oidc' });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, SIGN_IN_FIRST);
    assert.equal(loadInventory(inventoryPath).webUiAuthMode, undefined);
  } finally {
    useConfigStore(null);
    if (originalGroups === undefined) delete process.env.WEB_UI_DEV_GROUPS;
    else process.env.WEB_UI_DEV_GROUPS = originalGroups;
  }
});

test('PATCH webUiAuthMode: oidc is refused from the local operator (no session, no dev user)', async () => {
  const { app, inventoryPath } = loginConfiguredApp();
  try {
    // Without the suite-wide dev user, none mode serves this as the (admin)
    // local operator: it passes requireAdminGroup but has no session.
    await withoutDevUser(async () => {
      const res = await request(app).patch('/api/settings').send({ webUiAuthMode: 'oidc' });
      assert.equal(res.status, 409);
      assert.equal(res.body.error, SIGN_IN_FIRST);
    });
    assert.equal(loadInventory(inventoryPath).webUiAuthMode, undefined);
  } finally {
    useConfigStore(null);
  }
});

test('PATCH webUiAuthMode: oidc from a non-admin session never reaches the guard (403)', async () => {
  const { app, inventoryPath } = loginConfiguredApp();
  try {
    const res = await request(app)
      .patch('/api/settings')
      .set('Cookie', sessionCookie(sessions, { username: 'someone', groups: ['family'] }))
      .send({ webUiAuthMode: 'oidc' });
    assert.equal(res.status, 403);
    assert.equal(loadInventory(inventoryPath).webUiAuthMode, undefined);
  } finally {
    useConfigStore(null);
  }
});

// The contract's third message: requireAdminGroup judges the impersonation
// overlay and the lockout guard only runs on admin-group changes, so a real
// non-admin whose (persisting) impersonation entry names an admin group
// reaches the oidc guard and is refused by its own admin check.
test('PATCH webUiAuthMode: oidc is refused for a real non-admin passing requireAdminGroup via an impersonation entry', async () => {
  const inv = { ...baseInventory(), ...LOGIN_SETTINGS };
  const inventoryPath = path.join(mkdtempSync(path.join(tmpdir(), 'inventory-')), 'bellhop.db');
  saveInventory(inventoryPath, inv);
  writeSecret(inventoryPath, 'webUiOidcClientSecret', 'example-client-secret');
  useConfigStore(inventoryPath);
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const app = buildApp({
    sessions,
    inventory: inv,
    baseSsh: ssh,
    jobStore,
    jobLog,
    jobRunner: new JobRunner(jobStore, jobLog, ssh),
    inventoryPath,
    authentik: new FakeAuthentikClient(),
    impersonationStore: new Map([['someone', 'bellhop-admins']]),
  });
  try {
    const res = await request(app)
      .patch('/api/settings')
      .set('Cookie', sessionCookie(sessions, { username: 'someone', groups: ['family'] }))
      .send({ webUiAuthMode: 'oidc' });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'You are signed in as someone, who would not be an admin after this change');
    assert.equal(loadInventory(inventoryPath).webUiAuthMode, undefined);
  } finally {
    useConfigStore(null);
  }
});

test('PATCH webUiAuthMode: oidc together with admin groups that drop the session user is refused by the lockout guard', async () => {
  const { app, inventoryPath } = loginConfiguredApp();
  try {
    const res = await asAdmin(request(app).patch('/api/settings')).send({
      webUiAuthMode: 'oidc',
      authentikAdminGroup: 'example-other-admins',
    });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /you would no longer be an administrator/);
    assert.equal(loadInventory(inventoryPath).webUiAuthMode, undefined);
  } finally {
    useConfigStore(null);
  }
});

test('PATCH webUiAuthMode: oidc from a session admin succeeds and logs who did it', async (t) => {
  const { app, inventoryPath } = loginConfiguredApp({ webUiAuthMode: 'none' });
  const errors: string[] = [];
  t.mock.method(console, 'error', (message: string) => errors.push(message));
  try {
    const res = await asAdmin(request(app).patch('/api/settings')).send({ webUiAuthMode: 'oidc' });
    assert.equal(res.status, 200);
    assert.equal(loadInventory(inventoryPath).webUiAuthMode, 'oidc');
    assert.ok(
      errors.some((line) => line.includes('webUiAuthMode set to oidc by admin')),
      `expected the audit warning, got: ${errors.join(' | ')}`
    );
  } finally {
    useConfigStore(null);
  }
});

test('PATCH webUiAuthMode: oidc by an impersonating admin is judged by, and logged as, the real identity', async (t) => {
  const inv = { ...baseInventory(), ...LOGIN_SETTINGS };
  const inventoryPath = path.join(mkdtempSync(path.join(tmpdir(), 'inventory-')), 'bellhop.db');
  saveInventory(inventoryPath, inv);
  writeSecret(inventoryPath, 'webUiOidcClientSecret', 'example-client-secret');
  useConfigStore(inventoryPath);
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const app = buildApp({
    sessions,
    inventory: inv,
    baseSsh: ssh,
    jobStore,
    jobLog,
    jobRunner: new JobRunner(jobStore, jobLog, ssh),
    inventoryPath,
    authentik: new FakeAuthentikClient(),
    // Viewing as another admin group keeps the Settings page reachable.
    impersonationStore: new Map([['admin', 'authentik Admins']]),
  });
  const errors: string[] = [];
  t.mock.method(console, 'error', (message: string) => errors.push(message));
  try {
    const res = await asAdmin(request(app).patch('/api/settings')).send({ webUiAuthMode: 'oidc' });
    assert.equal(res.status, 200);
    assert.ok(errors.some((line) => line.includes('webUiAuthMode set to oidc by admin')));
  } finally {
    useConfigStore(null);
  }
});

test('PATCH webUiAuthMode: oidc while already oidc is not refused, even without a session', async () => {
  const { app, inventoryPath } = testApp({ ...baseInventory(), webUiAuthMode: 'oidc' });
  useConfigStore(inventoryPath);
  const originalGroups = process.env.WEB_UI_DEV_GROUPS;
  process.env.WEB_UI_DEV_GROUPS = 'bellhop-admins';
  try {
    // Login settings are incomplete and the requester is the dev user, yet a
    // resend of the mode already in force changes nothing.
    const res = await request(app).patch('/api/settings').send({ webUiAuthMode: 'oidc' });
    assert.equal(res.status, 200);
  } finally {
    useConfigStore(null);
    if (originalGroups === undefined) delete process.env.WEB_UI_DEV_GROUPS;
    else process.env.WEB_UI_DEV_GROUPS = originalGroups;
  }
});

test('PATCH webUiAuthMode: auto and authentik are rejected as unknown modes (400)', async () => {
  const { app, inventoryPath } = testApp();
  for (const mode of ['auto', 'authentik']) {
    const res = await asAdmin(request(app).patch('/api/settings')).send({ webUiAuthMode: mode });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /webUiAuthMode: .*oidc, none/);
  }
  assert.equal(loadInventory(inventoryPath).webUiAuthMode, undefined);
});

test('PATCH /api/settings allows clearing webUiAuthMode and setting none with no forward-auth check', async () => {
  const { app, inventoryPath } = testApp({ ...baseInventory(), webUiAuthMode: 'oidc' });
  const originalGroups = process.env.WEB_UI_DEV_GROUPS;
  process.env.WEB_UI_DEV_GROUPS = 'bellhop-admins';
  try {
    const cleared = await request(app).patch('/api/settings').send({ webUiAuthMode: null });
    assert.equal(cleared.status, 200);
    assert.equal(loadInventory(inventoryPath).webUiAuthMode, undefined);

    const none = await request(app).patch('/api/settings').send({ webUiAuthMode: 'none' });
    assert.equal(none.status, 200);
    assert.equal(loadInventory(inventoryPath).webUiAuthMode, 'none');
  } finally {
    if (originalGroups === undefined) delete process.env.WEB_UI_DEV_GROUPS;
    else process.env.WEB_UI_DEV_GROUPS = originalGroups;
  }
});

// -- Final review F1: a pinned key reports whether a stored copy exists ------

test('GET /api/settings reports a pinned key\'s stored copy: its value for a non-secret, never for a secret', async () => {
  await withEnv(
    { AUTHENTIK_OUTPOST_NAME: 'example env outpost', NPM_API_PASSWORD: 'example-npm-ENV-MARKER' },
    async () => {
      const { app, inventoryPath } = testApp({ ...baseInventory(), authentikOutpostName: 'example stored outpost' });
      writeSecret(inventoryPath, 'npmApiPassword', 'example-npm-STORED-MARKER');
      const res = await asAdmin(request(app).get('/api/settings'));
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.environment.authentikOutpostName, {
        variable: 'AUTHENTIK_OUTPOST_NAME',
        value: 'example env outpost',
        stored: true,
        storedValue: 'example stored outpost',
      });
      assert.deepEqual(res.body.environment.npmApiPassword, { variable: 'NPM_API_PASSWORD', stored: true });
      const body = JSON.stringify(res.body);
      assert.ok(!body.includes('STORED-MARKER') && !body.includes('ENV-MARKER'), 'no secret value in the response');
    }
  );
});

// -- Final review M7: leaving oidc is logged -----------------------------------

test('PATCH /api/settings logs a warning naming the real user when webUiAuthMode leaves oidc', async (t) => {
  const { app } = testApp({ ...baseInventory(), webUiAuthMode: 'oidc' });
  const errors: string[] = [];
  t.mock.method(console, 'error', (message: string) => errors.push(message));
  const res = await asAdmin(request(app).patch('/api/settings')).send({ webUiAuthMode: 'none' });
  assert.equal(res.status, 200);
  assert.ok(
    errors.some((line) =>
      line.includes('Sign-in mode changed from oidc to none by admin -- the web UI no longer requires sign-in')
    ),
    `expected the sign-in mode warning, got: ${errors.join(' | ')}`
  );
});

test('PATCH /api/settings logs nothing about sign-in mode for a change that does not leave oidc', async (t) => {
  const { app } = testApp({ ...baseInventory() });
  const errors: string[] = [];
  t.mock.method(console, 'error', (message: string) => errors.push(message));
  const res = await asAdmin(request(app).patch('/api/settings')).send({ webUiAuthMode: 'none' });
  assert.equal(res.status, 200);
  assert.ok(!errors.some((line) => line.includes('Sign-in mode changed')));
});
