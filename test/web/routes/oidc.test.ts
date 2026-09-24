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
import { UnconfiguredAuthentikClient } from '../../../src/lib/authentik-client.ts';
import type { AuthentikClient } from '../../../src/lib/authentik-client.ts';
import { saveInventory, type Inventory } from '../../../src/lib/inventory.ts';
import type { ImpersonationStore } from '../../../src/web/impersonation.ts';
import { captureWarnings } from '../../support/capture-warnings.ts';

function oidcInventory(): Inventory {
  return {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
    guests: [
      {
        name: 'media',
        type: 'lxc',
        vmid: 130,
        host: 'pve1',
        ip: '192.0.2.30',
        subdomains: ['media'],
        authGroup: 'bellhop-users',
        authMode: 'oidc',
        oidcRedirectUris: ['https://media.example.com/oauth/callback'],
      },
    ],
  };
}

// An owned OpenID client for the 'media' slug -- FakeAuthentikClient's
// default clientSecret for provider id '50' is 'secret-50', which the
// "never logged" test below greps captured console output for.
function ownedAuthentik(): FakeAuthentikClient {
  return new FakeAuthentikClient({
    applications: [{ id: 'media', pk: 'pk-media', name: 'media', slug: 'media', providerId: '50', metaPublisher: 'bellhop' }],
    oauth2Providers: [
      {
        id: '50',
        name: 'media',
        assignedApplicationSlug: 'media',
        clientType: 'confidential',
        grantTypes: ['authorization_code', 'refresh_token'],
        signingKeyId: 'key-1',
        propertyMappingIds: ['scope-openid-1', 'scope-profile-1', 'scope-email-1'],
        redirectUris: [{ matchingMode: 'strict', url: 'https://media.example.com/oauth/callback' }],
      },
    ],
  });
}

function testApp(
  authentik: AuthentikClient = ownedAuthentik(),
  inventory: Inventory = oidcInventory(),
  impersonationStore?: ImpersonationStore
) {
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const jobRunner = new JobRunner(jobStore, jobLog, ssh);
  const inventoryPath = path.join(mkdtempSync(path.join(tmpdir(), 'inventory-')), 'bellhop.db');
  saveInventory(inventoryPath, inventory);
  return buildApp({ inventory, baseSsh: ssh, jobStore, jobLog, jobRunner, inventoryPath, authentik, impersonationStore });
}

function asAdmin(req: request.Test): request.Test {
  return req.set('x-authentik-username', 'admin').set('x-authentik-groups', 'bellhop-admins');
}

function asNonAdmin(req: request.Test): request.Test {
  return req.set('x-authentik-username', 'someone').set('x-authentik-groups', 'family');
}

test('GET /api/oidc/:entry/credentials returns 200 with all three values for an admin', async () => {
  const app = testApp();
  const res = await asAdmin(request(app).get('/api/oidc/media/credentials'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    issuer: 'https://auth.example.com/application/o/media/',
    clientId: 'client-50',
    clientSecret: 'secret-50',
  });
});

test('GET /api/oidc/:entry/credentials returns 403 for a non-admin', async () => {
  const app = testApp();
  const res = await asNonAdmin(request(app).get('/api/oidc/media/credentials'));
  assert.equal(res.status, 403);
});

test('GET /api/oidc/:entry/credentials returns 403 for an admin impersonating a non-admin group', async () => {
  const impersonationStore: ImpersonationStore = new Map([['admin', 'family']]);
  const app = testApp(ownedAuthentik(), oidcInventory(), impersonationStore);
  const res = await asAdmin(request(app).get('/api/oidc/media/credentials'));
  assert.equal(res.status, 403);
});

test('GET /api/oidc/:entry/credentials returns 404 for an unknown entry', async () => {
  const app = testApp();
  const res = await asAdmin(request(app).get('/api/oidc/does-not-exist/credentials'));
  assert.equal(res.status, 404);
});

test('GET /api/oidc/:entry/credentials returns 409 when not OIDC / no client yet', async () => {
  const app = testApp(new FakeAuthentikClient(), oidcInventory());
  const res = await asAdmin(request(app).get('/api/oidc/media/credentials'));
  assert.equal(res.status, 409);
  assert.match(res.body.error, /sync-authentik --apply/);
});

test('GET /api/oidc/:entry/credentials returns 503 when Authentik is unconfigured', async () => {
  const app = testApp(new UnconfiguredAuthentikClient());
  const res = await asAdmin(request(app).get('/api/oidc/media/credentials'));
  assert.equal(res.status, 503);
});

test('GET /api/oidc/:entry/credentials never lets the secret reach captured console output', async () => {
  const app = testApp();
  const { result, warnings } = await captureWarnings(async () => asAdmin(request(app).get('/api/oidc/media/credentials')));
  assert.equal(result.status, 200);
  assert.equal(result.body.clientSecret, 'secret-50');
  assert.ok(!warnings.join('\n').includes('secret-50'));
});

// T038: adopt-oidc-client's preview/apply routes. Uses a hand-made
// (unmarked) OAuth2-backed Application at 'media' -- ownedAuthentik()'s own
// fixture is already Bellhop-owned (metaPublisher: 'bellhop'), so adoption
// tests need their own fixture without that marker.
function handMadeAuthentik(): FakeAuthentikClient {
  return new FakeAuthentikClient({
    applications: [{ id: 'media', pk: 'pk-media', name: 'media', slug: 'media', providerId: '50' }],
    oauth2Providers: [
      {
        id: '50',
        name: 'media',
        assignedApplicationSlug: 'media',
        clientType: 'confidential',
        grantTypes: ['authorization_code', 'refresh_token'],
        signingKeyId: 'key-1',
        propertyMappingIds: ['scope-openid-1', 'scope-profile-1', 'scope-email-1'],
        redirectUris: [{ matchingMode: 'strict', url: 'https://media.example.com/oauth/callback' }],
      },
    ],
  });
}

test('POST /api/oidc/:entry/adopt/preview returns the preview text for an admin', async () => {
  const app = testApp(handMadeAuthentik());
  const res = await asAdmin(request(app).post('/api/oidc/media/adopt/preview'));
  assert.equal(res.status, 200);
  assert.match(res.body.preview, /meta_publisher -> bellhop/);
});

test('POST /api/oidc/:entry/adopt/preview returns 403 for a non-admin', async () => {
  const app = testApp(handMadeAuthentik());
  const res = await asNonAdmin(request(app).post('/api/oidc/media/adopt/preview'));
  assert.equal(res.status, 403);
});

test('POST /api/oidc/:entry/adopt/preview returns 400 naming why for an entry that cannot be adopted', async () => {
  const app = testApp(handMadeAuthentik());
  const res = await asAdmin(request(app).post('/api/oidc/does-not-exist/adopt/preview'));
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Unknown entry/);
});

test('POST /api/oidc/:entry/adopt/apply enqueues a job for an admin', async () => {
  const app = testApp(handMadeAuthentik());
  const res = await asAdmin(request(app).post('/api/oidc/media/adopt/apply'));
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.jobId, 'number');
});

test('POST /api/oidc/:entry/adopt/apply returns 403 for a non-admin', async () => {
  const app = testApp(handMadeAuthentik());
  const res = await asNonAdmin(request(app).post('/api/oidc/media/adopt/apply'));
  assert.equal(res.status, 403);
});
