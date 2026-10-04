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
  return req.set('x-authentik-username', 'admin').set('x-authentik-groups', 'bellhop-admins');
}

test('GET /api/settings returns 403 for a non-admin', async () => {
  const { app } = testApp();
  const res = await request(app)
    .get('/api/settings')
    .set('x-authentik-username', 'someone')
    .set('x-authentik-groups', 'family');
  assert.equal(res.status, 403);
});

test('GET /api/settings returns current and derived values', async () => {
  const { app } = testApp({ ...baseInventory(), dnsServer: '10.0.0.53' });
  const res = await asAdmin(request(app).get('/api/settings'));
  assert.equal(res.status, 200);
  assert.equal(res.body.settings.dnsServer, '10.0.0.53');
  assert.equal(res.body.settings.nfsServer, undefined);
  assert.deepEqual(res.body.derived.lanGateways, [{ host: 'pve1', gateway: '10.0.0.1' }]);
  assert.deepEqual(res.body.derived.proxy, { name: 'proxy', ip: '10.0.0.2' });
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
    .set('x-authentik-username', 'someone')
    .set('x-authentik-groups', 'family')
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

// issue #51 (T015): usesCaddyTls is true only for the two Caddy drivers --
// every other driver either always obtains its own certificate one fixed
// way or reads ctx.tls/certResolver instead, so proxyCaddyTls is inert for
// it and the Settings page's Caddy TLS dropdown never shows.
const PROXY_DRIVERS_WITH_CADDY_TLS = [
  { id: 'caddy', label: 'Caddy', defaultConfigPath: '/etc/caddy/Caddyfile', suggestedStatusPagePath: '/usr/share/caddy/index.html', managesProxy: true, usesSharedCertificate: false, usesCertResolver: false, usesApiUrl: false, usesCaddyTls: true, configPathNote: CADDY_CONFIG_PATH_NOTE },
  { id: 'caddy-api', label: 'Caddy (admin API)', defaultConfigPath: null, suggestedStatusPagePath: '/usr/share/caddy/index.html', managesProxy: true, usesSharedCertificate: false, usesCertResolver: false, usesApiUrl: false, usesCaddyTls: true, configPathNote: null },
  { id: 'nginx', label: 'nginx', defaultConfigPath: '/etc/nginx/conf.d/bellhop.conf', suggestedStatusPagePath: '/var/www/html/index.html', managesProxy: true, usesSharedCertificate: true, usesCertResolver: false, usesApiUrl: false, usesCaddyTls: false, configPathNote: NGINX_CONFIG_PATH_NOTE },
  { id: 'nginx-proxy-manager', label: 'Nginx Proxy Manager', defaultConfigPath: null, suggestedStatusPagePath: null, managesProxy: true, usesSharedCertificate: false, usesCertResolver: false, usesApiUrl: false, usesCaddyTls: false, configPathNote: null },
  { id: 'haproxy', label: 'HAProxy', defaultConfigPath: '/etc/haproxy/bellhop.cfg', suggestedStatusPagePath: null, managesProxy: true, usesSharedCertificate: false, usesCertResolver: false, usesApiUrl: false, usesCaddyTls: false, configPathNote: HAPROXY_CONFIG_PATH_NOTE },
  { id: 'traefik', label: 'Traefik', defaultConfigPath: '/etc/traefik/dynamic/bellhop.yml', suggestedStatusPagePath: null, managesProxy: true, usesSharedCertificate: false, usesCertResolver: true, usesApiUrl: true, usesCaddyTls: false, configPathNote: TRAEFIK_CONFIG_PATH_NOTE },
  { id: 'none', label: 'No proxy', defaultConfigPath: null, suggestedStatusPagePath: null, managesProxy: false, usesSharedCertificate: false, usesCertResolver: false, usesApiUrl: false, usesCaddyTls: false, configPathNote: null },
];

test('GET /api/settings includes proxyDrivers and defaultProxyDriver', async () => {
  const { app } = testApp();
  const res = await asAdmin(request(app).get('/api/settings'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.proxyDrivers, PROXY_DRIVERS_WITH_CADDY_TLS);
  assert.equal(res.body.defaultProxyDriver, 'caddy');
});

test('PATCH /api/settings response also includes proxyDrivers and defaultProxyDriver', async () => {
  const { app } = testApp();
  const res = await asAdmin(request(app).patch('/api/settings')).send({ nfsServer: '10.0.0.5' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.proxyDrivers, PROXY_DRIVERS_WITH_CADDY_TLS);
  assert.equal(res.body.defaultProxyDriver, 'caddy');
});

// issue #51 (T015): caddyTlsModes/defaultCaddyTls accompany proxyDrivers on
// both GET and PATCH, the same "shared by settingsResponse()" guarantee
// proxyDrivers/defaultProxyDriver already have.
test('GET /api/settings includes caddyTlsModes and defaultCaddyTls', async () => {
  const { app } = testApp();
  const res = await asAdmin(request(app).get('/api/settings'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.caddyTlsModes, ['cloudflare', 'letsencrypt', 'internal', 'files']);
  assert.equal(res.body.defaultCaddyTls, 'cloudflare');
});

test('PATCH /api/settings response also includes caddyTlsModes and defaultCaddyTls', async () => {
  const { app } = testApp();
  const res = await asAdmin(request(app).patch('/api/settings')).send({ nfsServer: '10.0.0.5' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.caddyTlsModes, ['cloudflare', 'letsencrypt', 'internal', 'files']);
  assert.equal(res.body.defaultCaddyTls, 'cloudflare');
});

test('PATCH /api/settings writes proxyCaddyTls', async () => {
  const { app, inventoryPath } = testApp();
  const res = await asAdmin(request(app).patch('/api/settings')).send({ proxyCaddyTls: 'internal' });
  assert.equal(res.status, 200);
  assert.equal(res.body.settings.proxyCaddyTls, 'internal');
  assert.equal(loadInventory(inventoryPath).proxyCaddyTls, 'internal');
});

test('PATCH /api/settings rejects a proxyCaddyTls value outside the four modes, with the same message set-config produces', async () => {
  const { app, inventoryPath } = testApp();
  const res = await asAdmin(request(app).patch('/api/settings')).send({ proxyCaddyTls: 'bogus' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /^proxyCaddyTls: /);
  assert.equal(loadInventory(inventoryPath).proxyCaddyTls, undefined);
});

test('PATCH /api/settings clears proxyCaddyTls sent as null', async () => {
  const { app, inventoryPath } = testApp({ ...baseInventory(), proxyCaddyTls: 'files' });
  const res = await asAdmin(request(app).patch('/api/settings')).send({ proxyCaddyTls: null });
  assert.equal(res.status, 200);
  assert.equal(res.body.settings.proxyCaddyTls, undefined);
  assert.equal(loadInventory(inventoryPath).proxyCaddyTls, undefined);
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
