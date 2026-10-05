import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import request from 'supertest';
import { setupTestApp } from '../../support/setup-app.ts';
import { loadInventory, saveInventory } from '../../../src/lib/inventory.ts';
import { loadSetupState } from '../../../src/lib/setup-state.ts';
import type { FakeSSHResponder } from '../../support/fake-ssh-client.ts';

const fixture = (name: string) =>
  readFileSync(new URL(`../../fixtures/proxmox/${name}.json`, import.meta.url), 'utf8').trim();
const PASSWORD = 'correct-horse-battery';
const ok = (stdout: string) => ({ stdout, stderr: '', code: 0 });

// A cluster node answering from the captured Proxmox responses, with one
// container.
function proxmoxResponder(opts: { node?: string } = {}): FakeSSHResponder {
  const node = opts.node ?? 'pve1';
  return (_host, _user, command) => {
    if (command.startsWith('hostname &&')) return ok(`${node}\n${fixture('version')}\n`);
    if (command.includes('/cluster/status')) return ok(fixture('cluster-status'));
    if (command.includes('/network')) return ok(fixture('network'));
    if (command.includes('/storage')) return ok('[]');
    if (command.includes('/lxc/')) return ok(JSON.stringify({ net0: 'name=eth0,bridge=vmbr0,ip=192.0.2.50/24' }));
    if (command.includes('/lxc')) return ok(JSON.stringify([{ vmid: 101, name: 'web1' }]));
    if (command.includes('/qemu')) return ok('[]');
    return ok('');
  };
}

const endpoint = { address: '192.0.2.10', user: 'root', port: 22 };

async function withKey(opts: Parameters<typeof setupTestApp>[0] = { responder: proxmoxResponder() }) {
  const t = setupTestApp(opts);
  await request(t.app).post('/api/setup/key').set('Cookie', t.cookie).send({ mode: 'generated' });
  return t;
}

test("POST /api/setup/key generates Bellhop's key and shows the authorized_keys line", async () => {
  const { app, cookie } = setupTestApp();
  const res = await request(app).post('/api/setup/key').set('Cookie', cookie).send({ mode: 'generated' });
  assert.equal(res.status, 200);
  assert.equal(res.body.mode, 'generated');
  assert.match(res.body.authorizedKeysLine, /^ssh-ed25519 \S+ bellhop$/);
  assert.match(res.body.path, /id_ed25519$/);
  const again = await request(app).post('/api/setup/key').set('Cookie', cookie).send({ mode: 'generated' });
  assert.equal(again.body.authorizedKeysLine, res.body.authorizedKeysLine);
});

test('POST /api/setup/key refuses a missing key file with the reason', async () => {
  const { app, cookie } = setupTestApp();
  const res = await request(app)
    .post('/api/setup/key')
    .set('Cookie', cookie)
    .send({ mode: 'file', path: '/nonexistent/key' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /can't be read/);
});

test('install-key sends the ensure-present script over a password target and never returns the password', async () => {
  const { app, cookie, ssh } = await withKey();
  const logged: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...a: unknown[]) => void logged.push(a.join(' '));
  let res;
  try {
    res = await request(app)
      .post('/api/setup/hosts/install-key')
      .set('Cookie', cookie)
      .send({ ...endpoint, password: PASSWORD });
  } finally {
    Object.assign(console, orig);
  }
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { installed: true });
  assert.equal(JSON.stringify(res.body).includes(PASSWORD), false);
  assert.equal(logged.join('\n').includes(PASSWORD), false);
  const call = ssh.history.at(-1)!;
  assert.equal(call.sshPassword, PASSWORD);
  assert.equal(call.sshTarget, '192.0.2.10');
  assert.match(call.command, /\/root\/\.ssh/);
  assert.match(call.command, /ssh-ed25519 \S+ bellhop/);
});

test("install-key uses the user's home .ssh for a non-root user", async () => {
  const { app, cookie, ssh } = await withKey();
  await request(app)
    .post('/api/setup/hosts/install-key')
    .set('Cookie', cookie)
    .send({ ...endpoint, user: 'admin', password: PASSWORD });
  assert.match(ssh.history.at(-1)!.command, /\/home\/admin\/\.ssh/);
});

test('a failed password login gives 502 with fixed text that never echoes the password', async () => {
  const { app, cookie } = await withKey({
    responder: () => {
      throw new Error(`All configured authentication methods failed (${PASSWORD})`);
    },
  });
  const res = await request(app)
    .post('/api/setup/hosts/install-key')
    .set('Cookie', cookie)
    .send({ ...endpoint, password: PASSWORD });
  assert.equal(res.status, 502);
  assert.match(res.body.error, /password login failed for root@192\.0\.2\.10:22 -- check the password, or add the key by hand/);
  assert.equal(JSON.stringify(res.body).includes(PASSWORD), false);
});

test('install-key needs a key first and validates its body without echoing the password', async () => {
  const fresh = setupTestApp({ responder: proxmoxResponder() });
  const noKey = await request(fresh.app)
    .post('/api/setup/hosts/install-key')
    .set('Cookie', fresh.cookie)
    .send({ ...endpoint, password: PASSWORD });
  assert.equal(noKey.status, 400);
  assert.match(noKey.body.error, /key/i);

  const { app, cookie } = await withKey();
  const badPort = await request(app)
    .post('/api/setup/hosts/install-key')
    .set('Cookie', cookie)
    .send({ ...endpoint, port: 70000, password: PASSWORD });
  assert.equal(badPort.status, 400);
  assert.match(badPort.body.error, /port/);
  assert.equal(JSON.stringify(badPort.body).includes(PASSWORD), false);
  const badUser = await request(app)
    .post('/api/setup/hosts/install-key')
    .set('Cookie', cookie)
    .send({ ...endpoint, user: 'a b; rm', password: PASSWORD });
  assert.equal(badUser.status, 400);
});

test('hosts/test returns the node name and version, and 502 for a non-Proxmox answer', async () => {
  const good = await withKey();
  const res = await request(good.app).post('/api/setup/hosts/test').set('Cookie', good.cookie).send(endpoint);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { nodeName: 'pve1', version: '9.2.10' });
  assert.equal(good.ssh.history.at(-1)!.sshIdentityFile?.endsWith('id_ed25519'), true);

  const bad = await withKey({ responder: () => ok('Debian GNU/Linux\n') });
  const nope = await request(bad.app).post('/api/setup/hosts/test').set('Cookie', bad.cookie).send(endpoint);
  assert.equal(nope.status, 502);
  assert.match(nope.body.error, /Proxmox/);
});

test('POST /api/setup/hosts saves the host under its node name, syncs guests, lists peers, and is idempotent', async () => {
  const { app, cookie, inventoryPath } = await withKey();
  const res = await request(app).post('/api/setup/hosts').set('Cookie', cookie).send(endpoint);
  assert.equal(res.status, 200);
  assert.equal(res.body.host.name, 'pve1');
  assert.equal(res.body.host.address, '192.0.2.10');
  assert.deepEqual(res.body.host.suggestedMidScheme, {
    vmidBase: 1000,
    ipPrefix: '192.0.2.',
    cidrSuffix: 24,
    gateway: '192.0.2.1',
  });
  assert.deepEqual(res.body.peers, [{ name: 'pve2', address: '192.0.2.11', inInventory: false }]);
  const inv = loadInventory(inventoryPath);
  assert.equal(inv.hosts.length, 1);
  assert.equal(inv.hosts[0].ssh_identity_file?.endsWith('id_ed25519'), true);
  assert.equal(inv.hosts[0].ssh_port, undefined);
  assert.deepEqual(inv.guests.map((g) => g.name), ['web1']);

  const again = await request(app).post('/api/setup/hosts').set('Cookie', cookie).send(endpoint);
  assert.equal(again.status, 200);
  const inv2 = loadInventory(inventoryPath);
  assert.equal(inv2.hosts.length, 1);
  assert.deepEqual(inv2.guests.map((g) => g.name), ['web1']);
});

test('saving a host whose node name collides with a guest gives 409', async () => {
  const { app, cookie, inventoryPath } = await withKey({ responder: proxmoxResponder({ node: 'web1' }) });
  saveInventory(inventoryPath, {
    hosts: [{ name: 'pve9', ssh_target: '192.0.2.99', ssh_user: 'root' }],
    guests: [{ name: 'web1', type: 'lxc', vmid: 101, host: 'pve9' }],
  });
  const res = await request(app).post('/api/setup/hosts').set('Cookie', cookie).send(endpoint);
  assert.equal(res.status, 409);
  assert.match(res.body.error, /web1/);
});

test('PUT hosts/:name/mid-scheme validates, saves, and completes the proxmox step', async () => {
  const { app, cookie, inventoryPath } = await withKey();
  await request(app).post('/api/setup/hosts').set('Cookie', cookie).send(endpoint);

  const bad = await request(app)
    .put('/api/setup/hosts/pve1/mid-scheme')
    .set('Cookie', cookie)
    .send({ vmidBase: 1000, ipPrefix: 'nope', gateway: '192.0.2.1' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /ipPrefix/);
  assert.deepEqual(loadSetupState(inventoryPath)?.completedSteps, []);

  const scheme = { vmidBase: 1000, ipPrefix: '192.0.2.', cidrSuffix: 24, gateway: '192.0.2.1' };
  const res = await request(app).put('/api/setup/hosts/pve1/mid-scheme').set('Cookie', cookie).send(scheme);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.host.midScheme, scheme);
  assert.deepEqual(res.body.completedSteps, ['proxmox']);
  assert.deepEqual(loadInventory(inventoryPath).hosts[0].midScheme, scheme);

  const missing = await request(app).put('/api/setup/hosts/nope/mid-scheme').set('Cookie', cookie).send(scheme);
  assert.equal(missing.status, 404);
});

test('the state route offers the suggested midScheme and the chosen key', async () => {
  const { app, cookie } = await withKey();
  await request(app).post('/api/setup/hosts').set('Cookie', cookie).send(endpoint);
  const res = await request(app).get('/api/setup/state').set('Cookie', cookie);
  assert.equal(res.body.key.mode, 'generated');
  assert.match(res.body.key.publicKey, /^ssh-ed25519 /);
  assert.equal(res.body.hosts[0].name, 'pve1');
  assert.equal(res.body.hosts[0].midScheme, undefined);
  assert.equal(res.body.hosts[0].suggestedMidScheme.vmidBase, 1000);
});

test('after step 1 a fresh app over the same database resumes with the host and midScheme (US4)', async () => {
  const first = await withKey();
  await request(first.app).post('/api/setup/hosts').set('Cookie', first.cookie).send(endpoint);
  const scheme = { vmidBase: 1000, ipPrefix: '192.0.2.', cidrSuffix: 24, gateway: '192.0.2.1' };
  await request(first.app).put('/api/setup/hosts/pve1/mid-scheme').set('Cookie', first.cookie).send(scheme);

  const second = setupTestApp({
    inventoryPath: first.inventoryPath,
    dataDir: first.dataDir,
    responder: proxmoxResponder(),
  });
  const res = await request(second.app).get('/api/setup/state').set('Cookie', second.cookie);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.completedSteps, ['proxmox']);
  assert.equal(res.body.hosts[0].name, 'pve1');
  assert.deepEqual(res.body.hosts[0].midScheme, scheme);
  // Bellhop's key survives the restart, so the walkthrough can show it again.
  assert.equal(res.body.key.mode, 'generated');
});
