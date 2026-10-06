import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupTestApp } from '../../support/setup-app.ts';
import { finishSetup } from '../../../src/lib/setup-state.ts';

const HOST = { name: 'pve1', ssh_target: '192.0.2.10', ssh_user: 'root' };

test('while setup is pending, another API call is refused with setupRequired', async () => {
  const { app } = setupTestApp();
  const res = await request(app).get('/api/inventory');
  assert.equal(res.status, 503);
  assert.equal(res.body.setupRequired, true);
  assert.match(res.body.error, /Setup is in progress/);
});

test('while setup is pending, sign-in routes are refused too', async () => {
  const { app } = setupTestApp();
  const res = await request(app).get('/auth/login');
  assert.equal(res.status, 503);
  assert.equal(res.body.setupRequired, true);
});

test('while setup is pending, a page load is sent to /setup', async () => {
  const { app } = setupTestApp();
  const res = await request(app).get('/settings');
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/setup');
});

test('while setup is pending, a static asset request is not redirected', async () => {
  const { app } = setupTestApp();
  const res = await request(app).get('/assets/index-abc123.js');
  assert.notEqual(res.status, 303);
  assert.notEqual(res.status, 503);
});

test('the setup address with the right token sets the setup cookie and drops the token from the address', async () => {
  const { app, token } = setupTestApp();
  const res = await request(app).get(`/setup?token=${token}`);
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/setup');
  const setCookie = String(res.headers['set-cookie']);
  assert.match(setCookie, new RegExp(`^bellhop_setup=${token};`));
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Path=\//);
  assert.doesNotMatch(setCookie, /Secure/);
});

test('the setup address with a wrong token sets no cookie', async () => {
  const { app } = setupTestApp();
  const res = await request(app).get('/setup?token=not-the-token');
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/setup');
  assert.equal(res.headers['set-cookie'], undefined);
});

test('setup state needs the setup cookie', async () => {
  const { app, cookie } = setupTestApp();
  const without = await request(app).get('/api/setup/state');
  assert.equal(without.status, 401);
  assert.match(without.body.error, /open the setup address from the service log/);
  const wrong = await request(app).get('/api/setup/state').set('Cookie', 'bellhop_setup=wrong');
  assert.equal(wrong.status, 401);
  const right = await request(app).get('/api/setup/state').set('Cookie', cookie);
  assert.equal(right.status, 200);
  assert.deepEqual(right.body.completedSteps, []);
  assert.deepEqual(right.body.requiredSteps, ['proxmox', 'basics']);
});

test('setup status needs no cookie and reports the phase', async () => {
  const { app } = setupTestApp();
  const res = await request(app).get('/api/setup/status');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { phase: 'pending' });
});

test('an existing deployment (hosts, no setup record) is never gated', async () => {
  const { app, token } = setupTestApp({ inventory: { domain: 'example.com', hosts: [HOST], guests: [] } });
  assert.equal(token, undefined);
  const inv = await request(app).get('/api/inventory');
  assert.equal(inv.status, 200);
  const status = await request(app).get('/api/setup/status');
  assert.deepEqual(status.body, { phase: 'not-applicable' });
  const state = await request(app).get('/api/setup/state');
  assert.equal(state.status, 404);
  const page = await request(app).get('/setup');
  assert.equal(page.status, 303);
  assert.equal(page.headers.location, '/');
});

test('after setup finished, the gate is off and the old token is refused', async () => {
  const first = setupTestApp();
  finishSetup(first.inventoryPath);
  const { app } = setupTestApp({ inventoryPath: first.inventoryPath });
  const inv = await request(app).get('/api/inventory');
  assert.equal(inv.status, 200);
  const exchange = await request(app).get(`/setup?token=${first.token}`);
  assert.equal(exchange.status, 303);
  assert.equal(exchange.headers.location, '/');
  assert.equal(exchange.headers['set-cookie'], undefined);
  const state = await request(app).get('/api/setup/state').set('Cookie', first.cookie);
  assert.equal(state.status, 404);
});

test('while setup is pending, a mixed-case API or sign-in path is gated like its lowercase form', async () => {
  const { app } = setupTestApp();
  // Express routes case-insensitively, so /API/... reaches the same handlers;
  // a dotted last segment must not read as a static asset.
  for (const path of ['/API/jobs/a.b', '/Api/inventory.json', '/AUTH/login.php', '/Auth/callback']) {
    const res = await request(app).get(path);
    assert.equal(res.status, 503, path);
    assert.equal(res.body.setupRequired, true, path);
  }
  const post = await request(app).post('/API/jobs/a.b').send({});
  assert.equal(post.status, 503);
});
