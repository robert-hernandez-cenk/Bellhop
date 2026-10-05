import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupTestApp } from '../../support/setup-app.ts';
import { loadInventory, saveInventory } from '../../../src/lib/inventory.ts';
import { completeSetupStep, loadSetupState } from '../../../src/lib/setup-state.ts';

test('PUT /api/setup/basics saves the domain and optional values and completes the step', async () => {
  const { app, cookie, inventoryPath } = setupTestApp();
  const res = await request(app)
    .put('/api/setup/basics')
    .set('Cookie', cookie)
    .send({ domain: 'example.com', dnsServer: '192.0.2.53', nfsServer: '192.0.2.5', backupStorage: '' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.settings, { domain: 'example.com', dnsServer: '192.0.2.53', nfsServer: '192.0.2.5' });
  assert.deepEqual(res.body.completedSteps, ['basics']);
  const inv = loadInventory(inventoryPath);
  assert.equal(inv.domain, 'example.com');
  assert.equal(inv.dnsServer, '192.0.2.53');
  assert.equal(inv.backupStorage, undefined);
});

test('PUT /api/setup/basics refuses an invalid or missing domain, naming the field', async () => {
  const { app, cookie, inventoryPath } = setupTestApp();
  const bad = await request(app).put('/api/setup/basics').set('Cookie', cookie).send({ domain: 'not_a_domain' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /^domain: must be a domain name such as example\.com/);
  const missing = await request(app).put('/api/setup/basics').set('Cookie', cookie).send({ dnsServer: '192.0.2.53' });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /domain/);
  assert.equal(loadInventory(inventoryPath).domain, undefined);
  assert.deepEqual(loadSetupState(inventoryPath)?.completedSteps, []);
});

test('PUT /api/setup/basics needs the setup cookie', async () => {
  const { app } = setupTestApp();
  const res = await request(app).put('/api/setup/basics').send({ domain: 'example.com' });
  assert.equal(res.status, 401);
});

test('finishing is refused while a required step is incomplete, naming it', async () => {
  const { app, cookie, inventoryPath } = setupTestApp();
  const none = await request(app).post('/api/setup/finish').set('Cookie', cookie);
  assert.equal(none.status, 409);
  assert.match(none.body.error, /Finish step "Proxmox" first/);
  completeSetupStep(inventoryPath, 'proxmox');
  const onlyProxmox = await request(app).post('/api/setup/finish').set('Cookie', cookie);
  assert.equal(onlyProxmox.status, 409);
  assert.match(onlyProxmox.body.error, /Finish step "Domain and basics" first/);
});

test('finishing ends setup for good: token dropped, cookie cleared, gate off, even with no hosts later', async () => {
  const first = setupTestApp();
  completeSetupStep(first.inventoryPath, 'proxmox');
  completeSetupStep(first.inventoryPath, 'basics');
  const res = await request(first.app).post('/api/setup/finish').set('Cookie', first.cookie);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { redirect: '/' });
  assert.match(String(res.headers['set-cookie']), /^bellhop_setup=;.*Expires=Thu, 01 Jan 1970/);
  const state = loadSetupState(first.inventoryPath);
  assert.equal(state?.status, 'finished');
  assert.equal(state?.token, null);
  // The same process: the gate is off at once.
  const inv = await request(first.app).get('/api/inventory');
  assert.equal(inv.status, 200);
  const again = await request(first.app).get('/api/setup/state').set('Cookie', first.cookie);
  assert.equal(again.status, 404);
  // A restart over the same database with no hosts at all stays finished.
  saveInventory(first.inventoryPath, { hosts: [], guests: [] });
  const restarted = setupTestApp({ inventoryPath: first.inventoryPath });
  assert.equal(restarted.token, undefined);
  assert.equal(restarted.setup.phase(), 'finished');
});
