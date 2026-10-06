import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupTestApp } from '../../support/setup-app.ts';
import { loadInventory, saveInventory, type Inventory } from '../../../src/lib/inventory.ts';
import { loadSetupState } from '../../../src/lib/setup-state.ts';
import { configValueAt, storedSecretKeys } from '../../../src/lib/config.ts';

const PASSWORD = 'correct-horse-battery';

// The host and guests step 1 would have left in inventory (RFC 5737 addresses).
const INVENTORY: Inventory = {
  domain: 'example.com',
  hosts: [{ name: 'pve1', ssh_target: '192.0.2.10', ssh_user: 'root' }],
  guests: [
    { name: 'proxy-lxc', type: 'lxc', vmid: 101, host: 'pve1', ip: '192.0.2.30' },
    { name: 'web-lxc', type: 'lxc', vmid: 102, host: 'pve1', ip: '192.0.2.31' },
  ],
  externalSites: [{ name: 'nas', ip: '192.0.2.40', subdomains: ['nas'] }],
};

// A pending install (no hosts at start-up, as a fresh one) that then gets
// step 1's inventory, the way the Proxmox step would have left it.
function proxyApp() {
  const t = setupTestApp();
  saveInventory(t.inventoryPath, INVENTORY);
  const put = (body: unknown) => request(t.app).put('/api/setup/proxy').set('Cookie', t.cookie).send(body as object);
  const get = () => request(t.app).get('/api/setup/proxy').set('Cookie', t.cookie);
  return { ...t, put, get };
}

const proxyFlags = (path: string) =>
  [...loadInventory(path).hosts, ...loadInventory(path).guests].filter((e) => e.proxy).map((e) => e.name);

test('GET /api/setup/proxy lists every driver with its label, and the host and guest entries only', async () => {
  const { get } = proxyApp();
  const res = await get();
  assert.equal(res.status, 200);
  const ids = res.body.drivers.map((d: { id: string }) => d.id);
  assert.deepEqual(ids, ['caddy', 'caddy-api', 'nginx', 'nginx-proxy-manager', 'haproxy', 'traefik', 'none']);
  assert.equal(res.body.drivers.find((d: { id: string }) => d.id === 'none').label, 'No proxy');
  assert.deepEqual(
    res.body.entries.map((e: { name: string; kind: string }) => [e.name, e.kind]),
    [
      ['pve1', 'host'],
      ['proxy-lxc', 'guest'],
      ['web-lxc', 'guest'],
    ]
  );
  assert.equal(res.body.complete, false);
});

test('PUT saves the driver and marks exactly the chosen guest as the proxy', async () => {
  const { put, inventoryPath } = proxyApp();
  const res = await put({ driver: 'nginx', entry: 'proxy-lxc' });
  assert.equal(res.status, 200);
  assert.equal(loadInventory(inventoryPath).proxyDriver, 'nginx');
  assert.deepEqual(proxyFlags(inventoryPath), ['proxy-lxc']);
  assert.equal(res.body.state.choice.driver, 'nginx');
  assert.equal(res.body.state.choice.entry, 'proxy-lxc');
});

test('PUT with another entry moves the proxy flag', async () => {
  const { put, inventoryPath } = proxyApp();
  await put({ driver: 'nginx', entry: 'proxy-lxc' });
  await put({ driver: 'nginx', entry: 'pve1' });
  assert.deepEqual(proxyFlags(inventoryPath), ['pve1']);
});

test('PUT refuses an entry that is not a host or guest, and a missing entry, naming the field', async () => {
  const { put, inventoryPath } = proxyApp();
  const external = await put({ driver: 'nginx', entry: 'nas' });
  assert.equal(external.status, 400);
  assert.match(external.body.error, /entry: no host or guest named "nas"/);
  const missing = await put({ driver: 'nginx' });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /entry: is required/);
  assert.deepEqual(proxyFlags(inventoryPath), []);
  assert.equal(loadInventory(inventoryPath).proxyDriver, undefined);
});

test('PUT validates driver settings with the Settings rules and names the field', async () => {
  const { put, inventoryPath } = proxyApp();
  const relative = await put({ driver: 'nginx', entry: 'proxy-lxc', configPath: 'etc/nginx/bellhop.conf' });
  assert.equal(relative.status, 400);
  assert.match(relative.body.error, /configPath: must be an absolute path/);
  const badUrl = await put({ driver: 'nginx-proxy-manager', entry: 'proxy-lxc', npmApiUrl: 'not a url' });
  assert.equal(badUrl.status, 400);
  assert.match(badUrl.body.error, /npmApiUrl/);
  assert.equal(loadInventory(inventoryPath).proxyConfigPath, undefined);
});

test('PUT saves the settings the chosen driver uses', async () => {
  const { put, inventoryPath } = proxyApp();
  const res = await put({
    driver: 'traefik',
    entry: 'proxy-lxc',
    configPath: '/etc/traefik/dynamic/bellhop.yml',
    tlsSource: 'acme-http',
    certResolver: 'letsencrypt',
    apiUrl: 'http://192.0.2.30:8080',
  });
  assert.equal(res.status, 200);
  const inv = loadInventory(inventoryPath);
  assert.equal(inv.proxyConfigPath, '/etc/traefik/dynamic/bellhop.yml');
  assert.equal(inv.proxyCertResolver, 'letsencrypt');
  assert.equal(inv.proxyApiUrl, 'http://192.0.2.30:8080');
});

test('the NPM password is write-only: stored as a secret, shown only as set, never returned', async () => {
  const { put, get, inventoryPath } = proxyApp();
  const res = await put({
    driver: 'nginx-proxy-manager',
    entry: 'proxy-lxc',
    npmApiUrl: 'http://192.0.2.30:81',
    npmApiEmail: 'admin@example.com',
    secrets: { npmApiPassword: PASSWORD },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.state.secrets.npmApiPassword, true);
  assert.equal(configValueAt(inventoryPath, 'npmApiPassword', {}).value, PASSWORD);
  assert.ok(storedSecretKeys(inventoryPath).has('npmApiPassword'));
  assert.ok(!JSON.stringify(res.body).includes(PASSWORD));
  const read = await get();
  assert.equal(read.body.secrets.npmApiPassword, true);
  assert.ok(!JSON.stringify(read.body).includes(PASSWORD));
  // Never in the inventory tables either.
  assert.ok(!JSON.stringify(loadInventory(inventoryPath)).includes(PASSWORD));
});

test('a blank secret on a later PUT keeps the stored one', async () => {
  const { put, inventoryPath } = proxyApp();
  const body = { driver: 'nginx-proxy-manager', entry: 'proxy-lxc', npmApiUrl: 'http://192.0.2.30:81', npmApiEmail: 'admin@example.com' };
  await put({ ...body, secrets: { npmApiPassword: PASSWORD } });
  await put({ ...body, secrets: { npmApiPassword: '' } });
  assert.equal(configValueAt(inventoryPath, 'npmApiPassword', {}).value, PASSWORD);
});

test('a secret that breaks its rule is refused without echoing it', async () => {
  const { put } = proxyApp();
  const res = await put({ driver: 'nginx-proxy-manager', entry: 'proxy-lxc', secrets: { npmApiPassword: 'bad\npassword' } });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /npmApiPassword/);
  assert.ok(!res.text.includes('bad'));
});

test('a setting pinned by an environment variable is refused, naming the variable', async () => {
  const { put } = proxyApp();
  process.env.NPM_API_URL = 'http://192.0.2.99:81';
  try {
    const res = await put({ driver: 'nginx-proxy-manager', entry: 'proxy-lxc', npmApiUrl: 'http://192.0.2.30:81' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /NPM_API_URL/);
    assert.match(res.body.error, /restart/i);
  } finally {
    delete process.env.NPM_API_URL;
  }
});

test('a rejected PUT changes nothing', async () => {
  const { put, inventoryPath } = proxyApp();
  const res = await put({
    driver: 'nginx-proxy-manager',
    entry: 'proxy-lxc',
    npmApiEmail: 'admin@example.com',
    npmApiUrl: 'not a url',
    secrets: { npmApiPassword: PASSWORD },
  });
  assert.equal(res.status, 400);
  const inv = loadInventory(inventoryPath);
  assert.equal(inv.proxyDriver, undefined);
  assert.equal(inv.npmApiEmail, undefined);
  assert.deepEqual(proxyFlags(inventoryPath), []);
  assert.ok(!storedSecretKeys(inventoryPath).has('npmApiPassword'));
});

test('the proxy routes need the setup cookie', async () => {
  const { app } = proxyApp();
  assert.equal((await request(app).get('/api/setup/proxy')).status, 401);
  assert.equal((await request(app).put('/api/setup/proxy').send({ driver: 'none' })).status, 401);
});

test('GET reports an inventory with no host or guest so the client can point back to step 1', async () => {
  const t = setupTestApp();
  const res = await request(t.app).get('/api/setup/proxy').set('Cookie', t.cookie);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.entries, []);
  assert.deepEqual(loadSetupState(t.inventoryPath)?.completedSteps, []);
});

// -- Certificates (US2) --------------------------------------------------

const CF_TOKEN = 'cf-token-0123456789abcdef';

test('a certificate source the driver supports saves; the driver default is what GET offers when unset', async () => {
  const { put, get, inventoryPath } = proxyApp();
  const res = await put({ driver: 'nginx', entry: 'proxy-lxc', tlsSource: 'files' });
  assert.equal(res.status, 200);
  assert.equal(loadInventory(inventoryPath).tlsSource, 'files');
  const info = (await get()).body.drivers.find((d: { id: string }) => d.id === 'nginx');
  assert.deepEqual(info.tlsSources, ['files']);
  assert.equal(info.defaultTlsSource, 'files');
});

test('a certificate source the driver cannot serve is refused with the supported list, and nothing is saved', async () => {
  const { put, inventoryPath } = proxyApp();
  const res = await put({ driver: 'nginx', entry: 'proxy-lxc', tlsSource: 'acme-dns', secrets: { cloudflareDnsApiToken: CF_TOKEN } });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /tlsSource 'acme-dns' is not supported by the 'nginx' proxy driver \(it supports: files\)/);
  assert.ok(!res.text.includes(CF_TOKEN));
  assert.equal(loadInventory(inventoryPath).proxyDriver, undefined);
  assert.ok(!storedSecretKeys(inventoryPath).has('cloudflareDnsApiToken'));
});

test('switching to a driver that cannot serve the stored source is refused until a supported one is chosen', async () => {
  const { put } = proxyApp();
  await put({ driver: 'caddy', entry: 'proxy-lxc', tlsSource: 'internal' });
  const refused = await put({ driver: 'traefik', entry: 'proxy-lxc' });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /tlsSource 'internal' is not supported by the 'traefik' proxy driver/);
  const fixed = await put({ driver: 'traefik', entry: 'proxy-lxc', tlsSource: 'external' });
  assert.equal(fixed.status, 200);
});

test('DNS-01 with Cloudflare needs the token unless one is already stored', async () => {
  const { put, get, inventoryPath } = proxyApp();
  const missing = await put({ driver: 'caddy', entry: 'proxy-lxc', tlsSource: 'acme-dns', acmeDnsProvider: 'cloudflare' });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /cloudflareDnsApiToken: is required/);
  const saved = await put({
    driver: 'caddy',
    entry: 'proxy-lxc',
    tlsSource: 'acme-dns',
    acmeDnsProvider: 'cloudflare',
    secrets: { cloudflareDnsApiToken: CF_TOKEN },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.state.secrets.cloudflareDnsApiToken, true);
  assert.equal(configValueAt(inventoryPath, 'cloudflareDnsApiToken', {}).value, CF_TOKEN);
  assert.ok(!saved.text.includes(CF_TOKEN));
  assert.ok(!(await get()).text.includes(CF_TOKEN));
  // A later save with the field blank keeps it and is not refused.
  const again = await put({ driver: 'caddy', entry: 'proxy-lxc', tlsSource: 'acme-dns', acmeDnsProvider: 'cloudflare', secrets: { cloudflareDnsApiToken: '' } });
  assert.equal(again.status, 200);
  assert.equal(configValueAt(inventoryPath, 'cloudflareDnsApiToken', {}).value, CF_TOKEN);
});

test('a Cloudflare token that breaks its rule is refused without echoing it', async () => {
  const { put } = proxyApp();
  const res = await put({
    driver: 'caddy',
    entry: 'proxy-lxc',
    tlsSource: 'acme-dns',
    secrets: { cloudflareDnsApiToken: 'has a space' },
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /cloudflareDnsApiToken/);
  assert.ok(!res.text.includes('has a space'));
});

test('existing certificate files: paths are optional (they default from the domain) and must be absolute', async () => {
  const { put, inventoryPath } = proxyApp();
  const blank = await put({ driver: 'caddy', entry: 'proxy-lxc', tlsSource: 'files' });
  assert.equal(blank.status, 200);
  const relative = await put({ driver: 'caddy', entry: 'proxy-lxc', tlsSource: 'files', certificatePath: 'certs/fullchain.pem' });
  assert.equal(relative.status, 400);
  assert.match(relative.body.error, /certificatePath: must be an absolute path/);
  const good = await put({
    driver: 'caddy',
    entry: 'proxy-lxc',
    tlsSource: 'files',
    certificatePath: '/etc/ssl/example.com/fullchain.pem',
    keyPath: '/etc/ssl/example.com/privkey.pem',
  });
  assert.equal(good.status, 200);
  const inv = loadInventory(inventoryPath);
  assert.equal(inv.proxyTlsCertificate, '/etc/ssl/example.com/fullchain.pem');
  assert.equal(inv.proxyTlsKey, '/etc/ssl/example.com/privkey.pem');
});

test('"No proxy" ignores certificate fields and completes the step', async () => {
  const { put, inventoryPath } = proxyApp();
  const res = await put({ driver: 'none', tlsSource: 'acme-dns', secrets: { cloudflareDnsApiToken: CF_TOKEN } });
  assert.equal(res.status, 200);
  assert.equal(loadInventory(inventoryPath).tlsSource, undefined);
  assert.ok(!storedSecretKeys(inventoryPath).has('cloudflareDnsApiToken'));
  assert.equal(res.body.state.complete, true);
});
