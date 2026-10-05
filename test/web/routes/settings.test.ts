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
// issue #73: usesNpmApi is true only for the Nginx Proxy Manager driver --
// every other driver's own field must come back false.
const PROXY_DRIVERS_WITH_CADDY_TLS = [
  { id: 'caddy', label: 'Caddy', defaultConfigPath: '/etc/caddy/Caddyfile', suggestedStatusPagePath: '/usr/share/caddy/index.html', managesProxy: true, usesSharedCertificate: false, usesCertResolver: false, usesApiUrl: false, usesCaddyTls: true, usesNpmApi: false, configPathNote: CADDY_CONFIG_PATH_NOTE },
  { id: 'caddy-api', label: 'Caddy (admin API)', defaultConfigPath: null, suggestedStatusPagePath: '/usr/share/caddy/index.html', managesProxy: true, usesSharedCertificate: false, usesCertResolver: false, usesApiUrl: false, usesCaddyTls: true, usesNpmApi: false, configPathNote: null },
  { id: 'nginx', label: 'nginx', defaultConfigPath: '/etc/nginx/conf.d/bellhop.conf', suggestedStatusPagePath: '/var/www/html/index.html', managesProxy: true, usesSharedCertificate: true, usesCertResolver: false, usesApiUrl: false, usesCaddyTls: false, usesNpmApi: false, configPathNote: NGINX_CONFIG_PATH_NOTE },
  { id: 'nginx-proxy-manager', label: 'Nginx Proxy Manager', defaultConfigPath: null, suggestedStatusPagePath: null, managesProxy: true, usesSharedCertificate: false, usesCertResolver: false, usesApiUrl: false, usesCaddyTls: false, usesNpmApi: true, configPathNote: null },
  { id: 'haproxy', label: 'HAProxy', defaultConfigPath: '/etc/haproxy/bellhop.cfg', suggestedStatusPagePath: null, managesProxy: true, usesSharedCertificate: false, usesCertResolver: false, usesApiUrl: false, usesCaddyTls: false, usesNpmApi: false, configPathNote: HAPROXY_CONFIG_PATH_NOTE },
  { id: 'traefik', label: 'Traefik', defaultConfigPath: '/etc/traefik/dynamic/bellhop.yml', suggestedStatusPagePath: null, managesProxy: true, usesSharedCertificate: false, usesCertResolver: true, usesApiUrl: true, usesCaddyTls: false, usesNpmApi: false, configPathNote: TRAEFIK_CONFIG_PATH_NOTE },
  { id: 'none', label: 'No proxy', defaultConfigPath: null, suggestedStatusPagePath: null, managesProxy: false, usesSharedCertificate: false, usesCertResolver: false, usesApiUrl: false, usesCaddyTls: false, usesNpmApi: false, configPathNote: null },
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
    .set('x-authentik-username', 'admin')
    .set('x-authentik-groups', 'authentik Admins')
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

test('PATCH /api/settings refuses webUiAuthMode: authentik from a request with no forward-auth headers', async () => {
  const { app, inventoryPath } = testApp();
  const originalGroups = process.env.WEB_UI_DEV_GROUPS;
  process.env.WEB_UI_DEV_GROUPS = 'bellhop-admins';
  try {
    // No x-authentik-username header -> falls to the WEB_UI_DEV_USER=test-user
    // dev identity (set for the whole `npm test` run), which is never
    // viaForwardAuth.
    const res = await request(app).patch('/api/settings').send({ webUiAuthMode: 'oidc' });
    assert.equal(res.status, 409);
    assert.equal(
      res.body.error,
      'Refusing to set webUiAuthMode to authentik: this request did not come through Authentik forward-auth, so every later request would be rejected'
    );
    assert.equal(loadInventory(inventoryPath).webUiAuthMode, undefined);
  } finally {
    if (originalGroups === undefined) delete process.env.WEB_UI_DEV_GROUPS;
    else process.env.WEB_UI_DEV_GROUPS = originalGroups;
  }
});

test('PATCH /api/settings allows webUiAuthMode: authentik from a request with forward-auth headers', async () => {
  const { app, inventoryPath } = testApp();
  const res = await asAdmin(request(app).patch('/api/settings')).send({ webUiAuthMode: 'oidc' });
  assert.equal(res.status, 200);
  assert.equal(loadInventory(inventoryPath).webUiAuthMode, 'oidc');
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

// -- Final review F2: switching to authentik checks the header identity ------

// Registers the test app's own database as the config store, so its stored
// webUiAuthMode is the mode requireAuth actually runs under.
async function withStoredAuthMode(
  mode: 'oidc' | 'none' | undefined,
  fn: (app: ReturnType<typeof testApp>['app'], inventoryPath: string) => Promise<void>
): Promise<void> {
  const { app, inventoryPath } = testApp({ ...baseInventory(), webUiAuthMode: mode });
  useConfigStore(inventoryPath);
  try {
    await fn(app, inventoryPath);
  } finally {
    useConfigStore(null);
  }
}

test('PATCH webUiAuthMode: oidc in unset mode with admin forward-auth headers is allowed', async () => {
  await withStoredAuthMode(undefined, async (app, inventoryPath) => {
    const res = await asAdmin(request(app).patch('/api/settings')).send({ webUiAuthMode: 'oidc' });
    assert.equal(res.status, 200);
    assert.equal(loadInventory(inventoryPath).webUiAuthMode, 'oidc');
  });
});

test('PATCH webUiAuthMode: oidc in none mode with admin forward-auth headers is allowed', async () => {
  await withStoredAuthMode('none', async (app, inventoryPath) => {
    const res = await asAdmin(request(app).patch('/api/settings')).send({ webUiAuthMode: 'oidc' });
    assert.equal(res.status, 200);
    assert.equal(loadInventory(inventoryPath).webUiAuthMode, 'oidc');
  });
});

test('PATCH webUiAuthMode: oidc in none mode with non-admin forward-auth headers is refused', async () => {
  await withStoredAuthMode('none', async (app, inventoryPath) => {
    // none mode serves this request as the (admin) local operator, so it
    // passes requireAdminGroup; the Authentik identity it carries is not.
    const res = await request(app)
      .patch('/api/settings')
      .set('x-authentik-username', 'someone')
      .set('x-authentik-groups', 'family')
      .send({ webUiAuthMode: 'oidc' });
    assert.equal(res.status, 409);
    assert.equal(
      res.body.error,
      'Refusing to set webUiAuthMode to authentik: the Authentik identity on this request (someone) is not an administrator, so it would lose access to this page'
    );
    assert.equal(loadInventory(inventoryPath).webUiAuthMode, 'none');
  });
});

test('PATCH webUiAuthMode: oidc in none mode with no forward-auth headers is refused', async () => {
  await withStoredAuthMode('none', async (app, inventoryPath) => {
    const res = await request(app).patch('/api/settings').send({ webUiAuthMode: 'oidc' });
    assert.equal(res.status, 409);
    assert.equal(
      res.body.error,
      'Refusing to set webUiAuthMode to authentik: this request did not come through Authentik forward-auth, so every later request would be rejected'
    );
    assert.equal(loadInventory(inventoryPath).webUiAuthMode, 'none');
  });
});

test('PATCH webUiAuthMode: oidc checks the header identity against the admin groups the same request sets', async () => {
  await withStoredAuthMode('none', async (app, inventoryPath) => {
    const res = await asAdmin(request(app).patch('/api/settings')).send({
      webUiAuthMode: 'oidc',
      authentikAdminGroup: 'example-other-admins',
    });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /^Refusing to set webUiAuthMode to authentik: the Authentik identity on this request \(admin\) is not an administrator/);
    assert.equal(loadInventory(inventoryPath).webUiAuthMode, 'none');
  });
});

// -- Final review M7: leaving authentik is logged ------------------------------

test('PATCH /api/settings logs a warning naming the real user when webUiAuthMode leaves authentik', async (t) => {
  const { app } = testApp({ ...baseInventory(), webUiAuthMode: 'oidc' });
  const errors: string[] = [];
  t.mock.method(console, 'error', (message: string) => errors.push(message));
  const res = await asAdmin(request(app).patch('/api/settings')).send({ webUiAuthMode: 'none' });
  assert.equal(res.status, 200);
  assert.ok(
    errors.some((line) =>
      line.includes('Sign-in mode changed from authentik to none by admin -- the web UI no longer requires Authentik sign-in')
    ),
    `expected the sign-in mode warning, got: ${errors.join(' | ')}`
  );
});

test('PATCH /api/settings logs nothing about sign-in mode for a change that does not leave authentik', async (t) => {
  const { app } = testApp({ ...baseInventory() });
  const errors: string[] = [];
  t.mock.method(console, 'error', (message: string) => errors.push(message));
  const res = await asAdmin(request(app).patch('/api/settings')).send({ webUiAuthMode: 'none' });
  assert.equal(res.status, 200);
  assert.ok(!errors.some((line) => line.includes('Sign-in mode changed')));
});
