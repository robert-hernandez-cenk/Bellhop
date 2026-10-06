import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupTestApp } from '../../support/setup-app.ts';
import { loadInventory, saveInventory, type Inventory } from '../../../src/lib/inventory.ts';
import { completeSetupStep, loadSetupState } from '../../../src/lib/setup-state.ts';
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

// -- Checking the proxy (US3) --------------------------------------------

import { FakeSSHClient } from '../../support/fake-ssh-client.ts';
import { runSyncProxy } from '../../../src/commands/networking/sync-proxy.ts';
import { useConfigStore } from '../../../src/lib/config.ts';

const FORBIDDEN = /\b(cp|mv|rm|mktemp|tee)\s|trap |cat >|reload|restart|sed -i|-X (PATCH|POST|PUT|DELETE)/;

// A proxy-checking app: the saved choice plus a responder for the proxy host.
function checkApp(responder?: (command: string) => { stdout?: string; stderr?: string; code?: number }) {
  const t = setupTestApp({
    responder: (_h, _u, command) => {
      const r = responder?.(command) ?? {};
      return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.code ?? 0 };
    },
  });
  saveInventory(t.inventoryPath, INVENTORY);
  const put = (body: unknown) => request(t.app).put('/api/setup/proxy').set('Cookie', t.cookie).send(body as object);
  const check = () => request(t.app).post('/api/setup/proxy/check').set('Cookie', t.cookie);
  const completed = () => loadSetupState(t.inventoryPath)?.completedSteps ?? [];
  return { ...t, put, check, completed };
}

const NGINX = { driver: 'nginx', entry: 'proxy-lxc' };

test('a passing check returns the sync-proxy dry-run text and completes the step', async () => {
  const t = checkApp();
  assert.equal((await t.put(NGINX)).status, 200);
  const res = await t.check();
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.match(res.body.summary, /proxy-lxc/);
  const expected = await runSyncProxy({ apply: false }, { ssh: new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 })), inventory: loadInventory(t.inventoryPath) });
  assert.equal(res.body.preview, expected.preview);
  assert.deepEqual(t.completed(), ['proxy']);
  assert.deepEqual(res.body.completedSteps, ['proxy']);
});

test('a failing check answers 502 with the proxy output and leaves the step incomplete', async () => {
  const t = checkApp((command) => (command.includes('nginx -t') ? { code: 1, stderr: 'nginx: [emerg] unexpected "}"' } : {}));
  await t.put(NGINX);
  const res = await t.check();
  assert.equal(res.status, 502);
  assert.match(res.body.error, /'proxy-lxc'/);
  assert.match(res.body.error, /unexpected "\}"/);
  assert.deepEqual(t.completed(), []);
});

test('a missing config path is named with the setting that controls it', async () => {
  const t = checkApp(() => ({ code: 3 }));
  await t.put(NGINX);
  const res = await t.check();
  assert.equal(res.status, 502);
  assert.match(res.body.error, /\/etc\/nginx\/conf\.d not found on 'proxy-lxc'/);
  assert.match(res.body.error, /proxyConfigPath/);
});

test('a pass whose dry run cannot be built reports why and does not complete the step', async () => {
  const t = checkApp();
  // A forward-gated guest under HAProxy, which can only enforce OIDC: the
  // check passes but the dry run refuses.
  saveInventory(t.inventoryPath, {
    ...INVENTORY,
    guests: [
      ...INVENTORY.guests,
      { name: 'gated-lxc', type: 'lxc', vmid: 103, host: 'pve1', ip: '192.0.2.32', subdomains: ['gated'], authGroup: 'bellhop-users' },
      { name: 'auth-lxc', type: 'lxc', vmid: 104, host: 'pve1', ip: '192.0.2.33', authentik: true },
    ],
  });
  await t.put({ driver: 'haproxy', entry: 'proxy-lxc' });
  const res = await t.check();
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.preview, undefined);
  assert.match(res.body.previewError, /haproxy.*cannot enforce/);
  assert.deepEqual(t.completed(), []);
});

test('check refuses "No proxy" and a choice with no proxy entry', async () => {
  const t = checkApp();
  await t.put({ driver: 'none' });
  const none = await t.check();
  assert.equal(none.status, 400);
  assert.match(none.body.error, /No proxy needs no check/);
  const fresh = checkApp();
  const unsaved = await fresh.check();
  assert.equal(unsaved.status, 400);
  assert.match(unsaved.body.error, /entry/);
});

test('every file driver\'s check from the route issues only read commands', async () => {
  const choices: [string, Record<string, string>][] = [
    ['caddy', { tlsSource: 'internal' }],
    ['nginx', {}],
    ['haproxy', {}],
    ['traefik', { tlsSource: 'external', apiUrl: 'http://192.0.2.30:8080' }],
  ];
  for (const [driver, extra] of choices) {
    const t = checkApp((command) => (command.includes('curl') ? { stdout: '200' } : {}));
    assert.equal((await t.put({ driver, entry: 'proxy-lxc', ...extra })).status, 200, driver);
    const res = await t.check();
    assert.equal(res.status, 200, `${driver}: ${res.text}`);
    for (const call of t.ssh.history) assert.doesNotMatch(call.command.replace(/'\''/g, "'"), FORBIDDEN, driver);
  }
});

test('the NPM check signs in with the saved credentials and its failure never carries the password', async () => {
  const t = checkApp();
  useConfigStore(t.inventoryPath);
  const realFetch = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push(`${init?.method ?? 'GET'} ${new URL(String(url)).pathname}`);
    return new Response(JSON.stringify({ error: { code: 400, message: 'Invalid email or password' } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  try {
    await t.put({
      driver: 'nginx-proxy-manager',
      entry: 'proxy-lxc',
      npmApiUrl: 'http://192.0.2.30:81',
      npmApiEmail: 'admin@example.com',
      secrets: { npmApiPassword: PASSWORD },
    });
    const res = await t.check();
    assert.equal(res.status, 502);
    assert.match(res.body.error, /rejected the login for admin@example\.com/);
    assert.ok(!res.text.includes(PASSWORD));
    assert.deepEqual(seen, ['POST /api/tokens']);
    assert.deepEqual(t.completed(), []);
  } finally {
    globalThis.fetch = realFetch;
    useConfigStore(null);
  }
});

// -- Re-running and resuming (US4) ---------------------------------------

import { SetupService } from '../../../src/web/setup/service.ts';

async function completedNginx() {
  const t = checkApp();
  await t.put(NGINX);
  assert.equal((await t.check()).status, 200);
  assert.deepEqual(t.completed(), ['proxy']);
  return t;
}

test('changing the driver, entry, a setting, the TLS source or a secret reopens the step', async () => {
  const changes: Record<string, unknown>[] = [
    { driver: 'haproxy', entry: 'proxy-lxc' },
    { ...NGINX, entry: 'pve1' },
    { ...NGINX, configPath: '/etc/nginx/conf.d/other.conf' },
    { ...NGINX, tlsSource: 'files' },
    { ...NGINX, secrets: { cloudflareDnsApiToken: CF_TOKEN } },
  ];
  for (const change of changes) {
    const t = await completedNginx();
    const res = await t.put(change);
    assert.equal(res.status, 200, JSON.stringify(change));
    assert.deepEqual(t.completed(), [], JSON.stringify(change));
    assert.equal(res.body.state.complete, false);
  }
});

test('a repeated save with the same values changes nothing and keeps the step complete', async () => {
  const t = await completedNginx();
  const before = JSON.stringify(loadInventory(t.inventoryPath));
  const res = await t.put({ ...NGINX, configPath: '', secrets: {} });
  assert.equal(res.status, 200);
  assert.equal(JSON.stringify(loadInventory(t.inventoryPath)), before);
  assert.deepEqual(t.completed(), ['proxy']);
  assert.equal(res.body.state.complete, true);
});

test('after a restart the saved choice and set/not-set secrets come back', async () => {
  const t = checkApp();
  await t.put({
    driver: 'nginx-proxy-manager',
    entry: 'proxy-lxc',
    npmApiUrl: 'http://192.0.2.30:81',
    npmApiEmail: 'admin@example.com',
    secrets: { npmApiPassword: PASSWORD },
  });
  const restarted = setupTestApp({ inventoryPath: t.inventoryPath });
  const res = await request(restarted.app).get('/api/setup/proxy').set('Cookie', restarted.cookie);
  assert.equal(res.status, 200);
  assert.equal(res.body.choice.driver, 'nginx-proxy-manager');
  assert.equal(res.body.choice.entry, 'proxy-lxc');
  assert.equal(res.body.choice.npmApiEmail, 'admin@example.com');
  assert.equal(res.body.secrets.npmApiPassword, true);
  assert.equal(res.body.secrets.cloudflareDnsApiToken, false);
  assert.ok(!res.text.includes(PASSWORD));
  assert.ok(restarted.setup instanceof SetupService);
});

test('Finish waits for the proxy step and then succeeds', async () => {
  const t = checkApp();
  completeSetupStepsExceptProxy(t.inventoryPath);
  const early = await request(t.app).post('/api/setup/finish').set('Cookie', t.cookie);
  assert.equal(early.status, 409);
  assert.match(early.body.error, /Finish step "Reverse proxy" first/);
  await t.put(NGINX);
  await t.check();
  const done = await request(t.app).post('/api/setup/finish').set('Cookie', t.cookie);
  assert.equal(done.status, 200);
});

test('repeated saves leave at most one entry flagged as the proxy', async () => {
  const t = checkApp();
  for (const entry of ['proxy-lxc', 'pve1', 'web-lxc', 'proxy-lxc', 'proxy-lxc']) {
    await t.put({ driver: 'nginx', entry });
    assert.equal(proxyFlags(t.inventoryPath).length, 1);
  }
  assert.deepEqual(proxyFlags(t.inventoryPath), ['proxy-lxc']);
});

function completeSetupStepsExceptProxy(inventoryPath: string) {
  completeSetupStep(inventoryPath, 'proxmox');
  completeSetupStep(inventoryPath, 'basics');
}
