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

test('GET /api/settings includes proxyDrivers and defaultProxyDriver', async () => {
  const { app } = testApp();
  const res = await asAdmin(request(app).get('/api/settings'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.proxyDrivers, [
    { id: 'caddy', label: 'Caddy', defaultConfigPath: '/etc/caddy/Caddyfile', suggestedStatusPagePath: '/usr/share/caddy/index.html', managesProxy: true, usesSharedCertificate: false, configPathNote: CADDY_CONFIG_PATH_NOTE },
    { id: 'nginx', label: 'nginx', defaultConfigPath: '/etc/nginx/conf.d/bellhop.conf', suggestedStatusPagePath: '/var/www/html/index.html', managesProxy: true, usesSharedCertificate: true, configPathNote: NGINX_CONFIG_PATH_NOTE },
    { id: 'none', label: 'No proxy', defaultConfigPath: null, suggestedStatusPagePath: null, managesProxy: false, usesSharedCertificate: false, configPathNote: null },
  ]);
  assert.equal(res.body.defaultProxyDriver, 'caddy');
});

test('PATCH /api/settings response also includes proxyDrivers and defaultProxyDriver', async () => {
  const { app } = testApp();
  const res = await asAdmin(request(app).patch('/api/settings')).send({ nfsServer: '10.0.0.5' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.proxyDrivers, [
    { id: 'caddy', label: 'Caddy', defaultConfigPath: '/etc/caddy/Caddyfile', suggestedStatusPagePath: '/usr/share/caddy/index.html', managesProxy: true, usesSharedCertificate: false, configPathNote: CADDY_CONFIG_PATH_NOTE },
    { id: 'nginx', label: 'nginx', defaultConfigPath: '/etc/nginx/conf.d/bellhop.conf', suggestedStatusPagePath: '/var/www/html/index.html', managesProxy: true, usesSharedCertificate: true, configPathNote: NGINX_CONFIG_PATH_NOTE },
    { id: 'none', label: 'No proxy', defaultConfigPath: null, suggestedStatusPagePath: null, managesProxy: false, usesSharedCertificate: false, configPathNote: null },
  ]);
  assert.equal(res.body.defaultProxyDriver, 'caddy');
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
