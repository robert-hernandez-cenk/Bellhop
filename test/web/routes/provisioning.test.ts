import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { buildApp } from '../../../src/web/app.ts';
import { checkAppUrl, parseAppDefaults, parsePromptHints, parseSubdomains } from '../../../src/web/routes/provisioning.ts';
import { resolveInstallScriptUrl } from '../../../src/commands/provisioning/install-app.ts';
import { UPSTREAM_STABLE_BASE } from '../../../src/lib/app-source.ts';
import { JobStore } from '../../../src/web/jobs/job-store.ts';
import { createJobLog } from '../../../src/web/jobs/job-log.ts';
import { JobRunner } from '../../../src/web/jobs/job-runner.ts';
import { FakeSSHClient, defaultResponder } from '../../support/fake-ssh-client.ts';
import { FakeAuthentikClient } from '../../support/fake-authentik-client.ts';
import { UnconfiguredAuthentikClient } from '../../../src/lib/authentik-client.ts';
import { runSyncAuthentik } from '../../../src/commands/networking/sync-authentik.ts';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Inventory } from '../../../src/lib/inventory.ts';
import { loadInventory, saveInventory } from '../../../src/lib/inventory.ts';
import type { GoBuilder } from '../../../src/lib/go-build.ts';
import type { AuthentikClient } from '../../../src/lib/authentik-client.ts';
import { FakeGoBuilder, fakeNordVpnFetch, fakePiaFetch } from '../../support/fake-go-builder-and-fetch.ts';

const inventory: Inventory = {
  domain: 'example.com',
  hosts: [
    {
      name: 'pve1',
      ssh_target: 'pve1.local',
      ssh_user: 'root',
      midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' },
      caddy: true,
      storages: [
        { name: 'local', type: 'dir', content: ['vztmpl'], active: true },
        { name: 'local-lvm', type: 'lvmthin', content: ['rootdir', 'images'], active: true },
      ],
    },
  ],
  guests: [{ name: 'plex-lxc', type: 'lxc', vmid: 4003, host: 'pve1' }],
};

function testApp(
  respond: (t: string, u: string, c: string) => { stdout: string; stderr: string; code: number },
  extra?: { goBuilder?: GoBuilder; fetchImpl?: typeof fetch; tlsProbeSleepFn?: (ms: number) => Promise<void> }
) {
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
  const ssh = new FakeSSHClient(respond);
  const jobRunner = new JobRunner(jobStore, jobLog, ssh);
  // A real file on disk -- create-lxc/create-vm/install-app's apply path now
  // writes the newly-provisioned guest into inventory via saveInventory,
  // which reads-then-rewrites this path (see recordProvisionedGuest).
  const inventoryPath = path.join(mkdtempSync(path.join(tmpdir(), 'inventory-')), 'bellhop.db');
  saveInventory(inventoryPath, inventory);
  // install-app's apply route now calls checkAppUrl a second time (to
  // static-scan the script for prompt hints, see issue #57) -- default to a
  // fake 404 fetch so existing tests that don't care about that don't make
  // a real network call. A test that wants real-fetch behavior still passes
  // its own extra.fetchImpl, which wins here.
  const fetchImpl = extra?.fetchImpl ?? ((async () => new Response(null, { status: 404 })) as unknown as typeof fetch);
  return {
    app: buildApp({
      inventory,
      baseSsh: ssh,
      jobStore,
      jobLog,
      jobRunner,
      inventoryPath,
      authentik: new FakeAuthentikClient(),
      ...extra,
      fetchImpl,
    }),
    jobStore,
    inventoryPath,
  };
}

function waitForFinished(store: JobStore, id: number): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      const status = store.get(id)?.status;
      if (status === 'success' || status === 'failed') resolve();
      else setTimeout(check, 5);
    };
    check();
  });
}

// A self-contained alternative to testApp() (which always uses the same
// module-level `inventory` fixture and mutates it in place on every apply --
// unsafe to reuse for tests that *delete* a guest, since later tests in this
// file still expect earlier fixture guests like 'plex-lxc' to exist).
// Mirrors dashboard.test.ts's parameterized testApp(inventory) instead.
function isolatedApp(
  inv: Inventory,
  respond: (t: string, u: string, c: string) => { stdout: string; stderr: string; code: number },
  extra?: { goBuilder?: GoBuilder; fetchImpl?: typeof fetch; authentik?: AuthentikClient }
) {
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
  const ssh = new FakeSSHClient(respond);
  const jobRunner = new JobRunner(jobStore, jobLog, ssh);
  const inventoryPath = path.join(mkdtempSync(path.join(tmpdir(), 'inventory-')), 'bellhop.db');
  saveInventory(inventoryPath, inv);
  const fetchImpl = extra?.fetchImpl ?? ((async () => new Response(null, { status: 404 })) as unknown as typeof fetch);
  const authentik = extra?.authentik ?? new FakeAuthentikClient();
  return {
    app: buildApp({
      inventory: inv,
      baseSsh: ssh,
      jobStore,
      jobLog,
      jobRunner,
      inventoryPath,
      authentik,
      ...extra,
      fetchImpl,
    }),
    jobStore,
    authentik,
  };
}

test('GET /api/provisioning returns the 7 command definitions', async () => {
  const { app } = testApp(() => ({ stdout: '', stderr: '', code: 0 }));
  const res = await request(app).get('/api/provisioning');
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 7);
});

test('POST /api/provisioning/create-lxc/preview returns the dry-run command, resolving authorized_keys as its only ssh call', async () => {
  const calls: string[] = [];
  const { app } = testApp((_t, _u, c) => {
    calls.push(c);
    return { stdout: '', stderr: '', code: 0 };
  });
  const res = await request(app)
    .post('/api/provisioning/create-lxc/preview')
    .send({ host: 'pve1', mid: 4, hostname: 'media', template: 'debian-13-standard' });
  assert.equal(res.status, 200);
  assert.match(res.body.preview, /pct create 4004/);
  assert.deepEqual(calls, ['cat ~/.ssh/authorized_keys 2>/dev/null']);
});

test('POST /api/provisioning/create-lxc/apply enqueues a job and returns its id', async () => {
  const { app, jobStore } = testApp(() => ({ stdout: 'created', stderr: '', code: 0 }));
  const res = await request(app)
    .post('/api/provisioning/create-lxc/apply')
    .send({ host: 'pve1', mid: 4, hostname: 'media', template: 'debian-13-standard' });
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.jobId, 'number');
  await waitForFinished(jobStore, res.body.jobId);
  assert.equal(jobStore.get(res.body.jobId)?.status, 'success');
});

test('POST /api/provisioning/create-lxc/apply records who triggered the job', async () => {
  const { app, jobStore } = testApp(() => ({ stdout: 'created', stderr: '', code: 0 }));
  const res = await request(app)
    .post('/api/provisioning/create-lxc/apply')
    .set('x-authentik-username', 'admin')
    .set('x-authentik-groups', 'bellhop-admins')
    .send({ host: 'pve1', mid: 30, hostname: 'attributed-lxc', template: 'debian-13-standard' });
  await waitForFinished(jobStore, res.body.jobId);
  const job = jobStore.get(res.body.jobId);
  assert.equal(job?.triggeredByUsername, 'admin');
  assert.equal(job?.triggeredByImpersonating, null);
});

test('POST /api/provisioning/create-lxc/apply logs the dry-run preview at the top of the job log', async () => {
  const { app, jobStore } = testApp(() => ({ stdout: 'created', stderr: '', code: 0 }));
  const res = await request(app)
    .post('/api/provisioning/create-lxc/apply')
    .send({ host: 'pve1', mid: 5, hostname: 'preview-check', template: 'debian-13-standard' });
  await waitForFinished(jobStore, res.body.jobId);

  const jobRes = await request(app).get(`/api/jobs/${res.body.jobId}`);
  const preview = jobRes.body.log.split('----- end dry-run preview -----')[0];
  assert.match(preview, /----- dry-run preview -----/);
  assert.match(preview, /pct create 4005/);
  // The preview must appear before the job's own remote-execution output.
  assert.ok(jobRes.body.log.indexOf('----- dry-run preview -----') < jobRes.body.log.indexOf('created'));
});

test('POST /api/provisioning/create-lxc/apply writes the new guest into inventory, including parsed subdomains', async () => {
  const { app, jobStore } = testApp(() => ({ stdout: 'created', stderr: '', code: 0 }));
  const res = await request(app)
    .post('/api/provisioning/create-lxc/apply')
    .send({ host: 'pve1', mid: 7, hostname: 'sonarr', template: 'debian-13-standard', subdomains: 'tv ; tv ;downloads' });
  await waitForFinished(jobStore, res.body.jobId);
  assert.equal(jobStore.get(res.body.jobId)?.status, 'success');

  const invRes = await request(app).get('/api/inventory');
  const guest = invRes.body.guests.find((g: any) => g.name === 'sonarr');
  assert.ok(guest, 'new guest should be present in inventory');
  assert.equal(guest.type, 'lxc');
  assert.equal(guest.vmid, 4007);
  assert.equal(guest.host, 'pve1');
  assert.equal(guest.ip, '192.168.1.7');
  assert.deepEqual(guest.subdomains, ['tv', 'downloads']);
});

test('POST /api/provisioning/create-lxc/apply sets insecureBackendTls when the checkbox field is the string "true"', async () => {
  const { app, jobStore } = testApp(() => ({ stdout: 'created', stderr: '', code: 0 }));
  const res = await request(app)
    .post('/api/provisioning/create-lxc/apply')
    .send({ host: 'pve1', mid: 20, hostname: 'bentopdf', template: 'debian-13-standard', insecureBackendTls: 'true' });
  await waitForFinished(jobStore, res.body.jobId);
  assert.equal(jobStore.get(res.body.jobId)?.status, 'success');

  const invRes = await request(app).get('/api/inventory');
  const guest = invRes.body.guests.find((g: any) => g.name === 'bentopdf');
  assert.equal(guest.insecureBackendTls, true);
});

test('POST /api/provisioning/create-lxc/apply leaves insecureBackendTls unset when the checkbox field is the string "false"', async () => {
  const { app, jobStore } = testApp(() => ({ stdout: 'created', stderr: '', code: 0 }));
  const res = await request(app)
    .post('/api/provisioning/create-lxc/apply')
    .send({ host: 'pve1', mid: 21, hostname: 'plain-lxc', template: 'debian-13-standard', insecureBackendTls: 'false' });
  await waitForFinished(jobStore, res.body.jobId);
  assert.equal(jobStore.get(res.body.jobId)?.status, 'success');

  const invRes = await request(app).get('/api/inventory');
  const guest = invRes.body.guests.find((g: any) => g.name === 'plain-lxc');
  assert.equal(guest.insecureBackendTls, undefined);
});

test('POST /api/provisioning/create-vm/apply and POST /api/provisioning/install-app/apply also set insecureBackendTls from the string "true"', async () => {
  const { app: vmApp, jobStore: vmJobStore } = testApp(() => ({ stdout: 'created', stderr: '', code: 0 }));
  const vmRes = await request(vmApp)
    .post('/api/provisioning/create-vm/apply')
    .send({ host: 'pve1', mid: 22, name: 'insecure-vm', insecureBackendTls: 'true' });
  await waitForFinished(vmJobStore, vmRes.body.jobId);
  assert.equal(vmJobStore.get(vmRes.body.jobId)?.status, 'success');
  const vmInvRes = await request(vmApp).get('/api/inventory');
  assert.equal(vmInvRes.body.guests.find((g: any) => g.name === 'insecure-vm').insecureBackendTls, true);

  const { app: installApp, jobStore: installJobStore } = testApp(defaultResponder);
  const installRes = await request(installApp)
    .post('/api/provisioning/install-app/apply')
    .send({ app: 'bentopdf', host: 'pve1', mid: 23, hostname: 'bentopdf-app', insecureBackendTls: 'true' });
  await waitForFinished(installJobStore, installRes.body.jobId);
  assert.equal(installJobStore.get(installRes.body.jobId)?.status, 'success');
  const installInvRes = await request(installApp).get('/api/inventory');
  assert.equal(installInvRes.body.guests.find((g: any) => g.name === 'bentopdf-app').insecureBackendTls, true);
});

test('POST /api/provisioning/create-lxc/apply does not clobber an existing insecureBackendTls on a repeat apply for the same host+vmid', async () => {
  const { app, jobStore } = testApp(() => ({ stdout: 'created', stderr: '', code: 0 }));

  // First apply: checkbox checked, records insecureBackendTls: true.
  const res1 = await request(app)
    .post('/api/provisioning/create-lxc/apply')
    .send({ host: 'pve1', mid: 24, hostname: 'reused-vmid', template: 'debian-13-standard', insecureBackendTls: 'true' });
  await waitForFinished(jobStore, res1.body.jobId);
  assert.equal(jobStore.get(res1.body.jobId)?.status, 'success');

  // Second apply for the same host+mid (-> same vmid, per resolveMid),
  // checkbox left unchecked this time (field omitted from the request
  // body entirely, matching how the real form never includes an
  // untouched checkbox's key). Without the existing.insecureBackendTls
  // fallback in upsertGuestEntry, the plain `{ ...existing, ...entry }`
  // spread would silently overwrite the previously-recorded `true` with
  // `undefined`.
  const res2 = await request(app)
    .post('/api/provisioning/create-lxc/apply')
    .send({ host: 'pve1', mid: 24, hostname: 'reused-vmid', template: 'debian-13-standard' });
  await waitForFinished(jobStore, res2.body.jobId);
  assert.equal(jobStore.get(res2.body.jobId)?.status, 'success');

  const invRes = await request(app).get('/api/inventory');
  const guest = invRes.body.guests.find((g: any) => g.name === 'reused-vmid');
  assert.ok(guest, 'guest should still be present in inventory after the second apply');
  assert.equal(guest.insecureBackendTls, true);
});

test('POST /api/provisioning/install-app/apply probes the new guest and sets insecureBackendTls from an untrusted-TLS result', async () => {
  const calls: string[] = [];
  const { app, jobStore } = testApp(
    (_t, _u, c) => {
      calls.push(c);
      // install-app's checkVmidAvailable pre-check must see the target vmid
      // as free (nonzero exit), same as fake-ssh-client.ts's defaultResponder
      // -- otherwise it throws "already in use" during preview(), which runs
      // synchronously before any job/jobId exists, and this test's
      // waitForFinished(jobStore, res.body.jobId) would poll an undefined id
      // forever.
      if (c.startsWith('pct status ')) return { stdout: '', stderr: '', code: 1 };
      if (c.startsWith('curl ')) return { stdout: '', stderr: '', code: 60 };
      return { stdout: '', stderr: '', code: 0 };
    },
    { tlsProbeSleepFn: async () => {} }
  );
  const res = await request(app)
    .post('/api/provisioning/install-app/apply')
    .send({ app: 'authentik', host: 'pve1', mid: 30, hostname: 'authentik-new', subdomains: 'auth', port: '9443' });
  await waitForFinished(jobStore, res.body.jobId);
  assert.equal(jobStore.get(res.body.jobId)?.status, 'success');

  const invRes = await request(app).get('/api/inventory');
  const guest = invRes.body.guests.find((g: any) => g.name === 'authentik-new');
  assert.equal(guest.insecureBackendTls, true);
  assert.ok(
    calls.includes('curl -s -o /dev/null --max-time 5 https://192.168.1.30:9443/'),
    'must curl the new guest ip:port from its parent host'
  );
});

test('POST /api/provisioning/install-app/apply lets a conclusive probe override the submitted checkbox', async () => {
  const { app, jobStore } = testApp(
    // Everything (including a trusted/no-TLS curl probe) succeeds except the
    // vmid pre-check, which must report "free" -- see the previous test's
    // comment on why a code:0 response there would hang this test forever.
    (_t, _u, c) => ({ stdout: '', stderr: '', code: c.startsWith('pct status ') ? 1 : 0 }),
    { tlsProbeSleepFn: async () => {} }
  );
  const res = await request(app)
    .post('/api/provisioning/install-app/apply')
    .send({
      app: 'bentopdf',
      host: 'pve1',
      mid: 31,
      hostname: 'bentopdf-new',
      subdomains: 'bento',
      port: '8443',
      insecureBackendTls: 'true',
    });
  await waitForFinished(jobStore, res.body.jobId);
  assert.equal(jobStore.get(res.body.jobId)?.status, 'success');

  const invRes = await request(app).get('/api/inventory');
  const guest = invRes.body.guests.find((g: any) => g.name === 'bentopdf-new');
  assert.equal(guest.insecureBackendTls, false, 'a trusted/no-TLS probe result must override the submitted "true" checkbox');
});

test('POST /api/provisioning/install-app/apply retries the probe up to the budget, then keeps the submitted checkbox when inconclusive', async () => {
  let curlCalls = 0;
  const { app, jobStore } = testApp(
    (_t, _u, c) => {
      // See the first probe test's comment: the vmid pre-check must report
      // "free" or this test hangs forever on an undefined jobId.
      if (c.startsWith('pct status ')) return { stdout: '', stderr: '', code: 1 };
      if (c.startsWith('curl ')) {
        curlCalls++;
        return { stdout: '', stderr: '', code: 7 };
      }
      return { stdout: '', stderr: '', code: 0 };
    },
    { tlsProbeSleepFn: async () => {} }
  );
  const res = await request(app)
    .post('/api/provisioning/install-app/apply')
    .send({
      app: 'plex',
      host: 'pve1',
      mid: 32,
      // Not 'plex-new' -- that name is already taken by a pre-existing test
      // below ('writes the parsed port into the new guest inventory entry',
      // mid 8) that shares this file's module-level inventory/testApp(), and
      // guests.name has a UNIQUE constraint, so reusing it here fails that
      // later test's save with "UNIQUE constraint failed: guests.name".
      hostname: 'plex-retry-new',
      subdomains: 'plex',
      port: '32400',
      insecureBackendTls: 'true',
    });
  await waitForFinished(jobStore, res.body.jobId);
  assert.equal(jobStore.get(res.body.jobId)?.status, 'success');

  const invRes = await request(app).get('/api/inventory');
  const guest = invRes.body.guests.find((g: any) => g.name === 'plex-retry-new');
  assert.equal(guest.insecureBackendTls, true, 'inconclusive after exhausting retries must leave the submitted value untouched');
  assert.equal(curlCalls, 7, 'one initial attempt plus 6 retries');

  const jobRes = await request(app).get(`/api/jobs/${res.body.jobId}`);
  const probeLines = (jobRes.body.log as string).split('\n').filter((line: string) => line.includes('TLS probe attempt'));
  assert.equal(probeLines.length, 7, 'each probe attempt must log a line into the job log stream, not just stdout');
});

test('POST /api/provisioning/create-lxc/apply never probes, since create-lxc has no port field to make the ip+port+subdomains combo concrete', async () => {
  const calls: string[] = [];
  const { app, jobStore } = testApp((_t, _u, c) => {
    calls.push(c);
    return { stdout: 'created', stderr: '', code: 0 };
  });
  const res = await request(app)
    .post('/api/provisioning/create-lxc/apply')
    .send({ host: 'pve1', mid: 33, hostname: 'no-probe-lxc', template: 'debian-13-standard', subdomains: 'noport' });
  await waitForFinished(jobStore, res.body.jobId);
  assert.equal(jobStore.get(res.body.jobId)?.status, 'success');
  assert.ok(!calls.some((c) => c.startsWith('curl ')), 'create-lxc never sets a port, so there is nothing concrete to probe');
});

test('POST /api/provisioning/create-lxc/apply does not write to inventory when the remote command fails', async () => {
  const { app, jobStore } = testApp(() => ({ stdout: '', stderr: 'boom', code: 1 }));
  const res = await request(app)
    .post('/api/provisioning/create-lxc/apply')
    .send({ host: 'pve1', mid: 9, hostname: 'broken', template: 'debian-13-standard' });
  await waitForFinished(jobStore, res.body.jobId);
  assert.equal(jobStore.get(res.body.jobId)?.status, 'failed');

  const invRes = await request(app).get('/api/inventory');
  assert.ok(!invRes.body.guests.some((g: any) => g.name === 'broken'));
});

test('parseSubdomains splits on ";", trims, dedupes, and drops empties', () => {
  assert.deepEqual(parseSubdomains('tv ; tv ;downloads;  '), ['tv', 'downloads']);
  assert.equal(parseSubdomains(''), undefined);
  assert.equal(parseSubdomains(undefined), undefined);
  assert.equal(parseSubdomains('   '), undefined);
});

test('POST /api/provisioning/attach-nfs-mount/preview surfaces the hostScript', async () => {
  const { app } = testApp((_t, _u, c) => {
    if (c.includes('pvesh get /storage/nas-proxmox'))
      return { stdout: JSON.stringify({ path: '/mnt/pve/nas-proxmox' }), stderr: '', code: 0 };
    if (c.includes('pct config')) return { stdout: '', stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  });
  const res = await request(app)
    .post('/api/provisioning/attach-nfs-mount/preview')
    .send({ guest: 'plex-lxc', storage: 'nas-proxmox', mountPoint: '/mnt/media' });
  assert.equal(res.status, 200);
  assert.match(res.body.preview, /pct set 4003 -mp0/);
});

test('an unknown command id 404s', async () => {
  const { app } = testApp(() => ({ stdout: '', stderr: '', code: 0 }));
  const res = await request(app).post('/api/provisioning/nope/preview').send({});
  assert.equal(res.status, 404);
});

test('a validation error from the command function comes back as 400', async () => {
  const { app } = testApp(() => ({ stdout: '', stderr: '', code: 0 }));
  const res = await request(app)
    .post('/api/provisioning/create-lxc/preview')
    .send({ host: 'unknown-host', mid: 4, hostname: 'media', template: 't' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Not a Proxmox host in inventory/);
});

test('GET /api/provisioning/install-app/check-app resolves ?value and returns {exists, url}', async () => {
  const okFetch = (async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
  const { app } = testApp(() => ({ stdout: '', stderr: '', code: 0 }), { fetchImpl: okFetch });
  const res = await request(app).get('/api/provisioning/install-app/check-app').query({ value: 'plex' });
  assert.equal(res.status, 200);
  assert.equal(res.body.exists, true);
  assert.equal(res.body.url, 'https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/plex.sh');
});

// Guards the injection itself rather than the check's logic: 'plex' is a real
// community-scripts app, so a route that ignored testDeps.fetchImpl and fell
// through to the global fetch would reach raw.githubusercontent.com and report
// exists=true. Asserting exists=false against the injected 404 is what proves
// no real network call happens here.
test('GET /api/provisioning/install-app/check-app uses the injected fetch, not the global one', async () => {
  const { app } = testApp(() => ({ stdout: '', stderr: '', code: 0 }));
  const res = await request(app).get('/api/provisioning/install-app/check-app').query({ value: 'plex' });
  assert.equal(res.status, 200);
  assert.equal(res.body.exists, false);
});

// --- custom script repository (issue #11) ---
// Example values only (constitution Principle I) -- example-user/ProxmoxVED
// on branch my-apps is the same example the spec/plan/data-model/
// test/lib/app-source.test.ts use.

const customFixtureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'github');
const CUSTOM_HEAD_SHA_RAW = readFileSync(path.join(customFixtureDir, 'branch-head-sha.txt'), 'utf8');
const CUSTOM_SHA = CUSTOM_HEAD_SHA_RAW.trim();
const CUSTOM_OWNER = 'example-user';
const CUSTOM_REPO = 'ProxmoxVED';
const CUSTOM_BRANCH = 'my-apps';
const CUSTOM_HEAD_SHA_URL = `https://api.github.com/repos/${CUSTOM_OWNER}/${CUSTOM_REPO}/commits/${CUSTOM_BRANCH}`;
// issue #15: every custom-configured resolution also compares the pinned
// commit against upstream ProxmoxVED main; the captured ahead fixture
// changes demo-shop (among others), so demo-shop resolves to the fork.
const CUSTOM_COMPARE_URL = `https://api.github.com/repos/community-scripts/ProxmoxVED/compare/main...${CUSTOM_OWNER}:${CUSTOM_REPO}:${CUSTOM_SHA}`;
const CUSTOM_COMPARE_AHEAD_BODY = readFileSync(path.join(customFixtureDir, 'compare-ahead-3-apps.json'), 'utf8');
const customCtUrl = (slug: string) => `https://raw.githubusercontent.com/${CUSTOM_OWNER}/${CUSTOM_REPO}/${CUSTOM_SHA}/ct/${slug}.sh`;

function customScriptFetch(slug: string): typeof fetch {
  return (async (url: unknown) => {
    const href = String(url);
    if (href === CUSTOM_HEAD_SHA_URL) return new Response(CUSTOM_HEAD_SHA_RAW, { status: 200 });
    if (href === CUSTOM_COMPARE_URL) return new Response(CUSTOM_COMPARE_AHEAD_BODY, { status: 200 });
    if (href === customCtUrl(slug)) return new Response('#!/usr/bin/env bash\n', { status: 200 });
    // Both upstream shadow probes -- always "not present" for this test.
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
}

test('GET /api/provisioning/install-app/check-app resolves through the custom script repository, returning custom.sha', async () => {
  const customInventory: Inventory = { ...inventory, customScriptsRepo: `${CUSTOM_OWNER}/${CUSTOM_REPO}`, customScriptsBranch: CUSTOM_BRANCH };
  const { app } = isolatedApp(customInventory, () => ({ stdout: '', stderr: '', code: 0 }), { fetchImpl: customScriptFetch('demo-shop') });
  const res = await request(app).get('/api/provisioning/install-app/check-app').query({ value: 'demo-shop' });
  assert.equal(res.status, 200);
  assert.equal(res.body.exists, true);
  assert.equal(res.body.url, customCtUrl('demo-shop'));
  assert.deepEqual(res.body.custom, { label: `${CUSTOM_OWNER}/${CUSTOM_REPO}@${CUSTOM_BRANCH}`, sha: CUSTOM_SHA });
  assert.equal(res.body.shadows, undefined);
  assert.equal(res.body.conflict, undefined, 'conflict is absent unless the app conflicts');
});

// Same as customScriptFetch, but the ProxmoxVE shadow probe hits -- used to
// prove check-app's `shadows` field (research R6) reflects a real upstream
// collision rather than always being empty/undefined the way the test above
// exercises.
function customScriptFetchWithStableShadow(slug: string): typeof fetch {
  return (async (url: unknown) => {
    const href = String(url);
    if (href === CUSTOM_HEAD_SHA_URL) return new Response(CUSTOM_HEAD_SHA_RAW, { status: 200 });
    if (href === CUSTOM_COMPARE_URL) return new Response(CUSTOM_COMPARE_AHEAD_BODY, { status: 200 });
    if (href === customCtUrl(slug)) return new Response('#!/usr/bin/env bash\n', { status: 200 });
    if (href === `${UPSTREAM_STABLE_BASE}/ct/${slug}.sh`) return new Response('#!/usr/bin/env bash\n', { status: 200 });
    // The ProxmoxVED shadow probe -- "not present" for this test.
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
}

test('GET /api/provisioning/install-app/check-app reports shadows for a slug present upstream', async () => {
  const customInventory: Inventory = { ...inventory, customScriptsRepo: `${CUSTOM_OWNER}/${CUSTOM_REPO}`, customScriptsBranch: CUSTOM_BRANCH };
  const { app } = isolatedApp(customInventory, () => ({ stdout: '', stderr: '', code: 0 }), {
    fetchImpl: customScriptFetchWithStableShadow('demo-shop'),
  });
  const res = await request(app).get('/api/provisioning/install-app/check-app').query({ value: 'demo-shop' });
  assert.equal(res.status, 200);
  assert.equal(res.body.exists, true);
  assert.deepEqual(res.body.shadows, ['ProxmoxVE']);
});

// issue #15 US2: the captured diverged fixture's demo-wiki was added upstream
// after the branch point too (absent at the merge base, present on
// ProxmoxVED main), so check-app reports conflict: true -- and still
// resolves to the fork.
test('GET /api/provisioning/install-app/check-app reports conflict: true for an app upstream also changed', async () => {
  const customInventory: Inventory = { ...inventory, customScriptsRepo: `${CUSTOM_OWNER}/${CUSTOM_REPO}`, customScriptsBranch: CUSTOM_BRANCH };
  const divergedBody = readFileSync(path.join(customFixtureDir, 'compare-diverged-conflict.json'), 'utf8');
  const mergeBase = (JSON.parse(divergedBody) as { merge_base_commit: { sha: string } }).merge_base_commit.sha;
  const vedRaw = (ref: string, file: string) => `https://raw.githubusercontent.com/community-scripts/ProxmoxVED/${ref}/${file}`;
  const fetchImpl = (async (url: unknown) => {
    const href = String(url);
    if (href === CUSTOM_HEAD_SHA_URL) return new Response(CUSTOM_HEAD_SHA_RAW, { status: 200 });
    if (href === CUSTOM_COMPARE_URL) return new Response(divergedBody, { status: 200 });
    if (href === customCtUrl('demo-wiki')) return new Response('#!/usr/bin/env bash\n', { status: 200 });
    if (href === vedRaw('main', 'ct/demo-wiki.sh')) return new Response('#!/usr/bin/env bash\n', { status: 200 });
    if (href === vedRaw('main', 'install/demo-wiki-install.sh')) return new Response('#!/usr/bin/env bash\n', { status: 200 });
    if (href.startsWith(vedRaw(mergeBase, ''))) return new Response(null, { status: 404 });
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
  const { app } = isolatedApp(customInventory, () => ({ stdout: '', stderr: '', code: 0 }), { fetchImpl });
  const res = await request(app).get('/api/provisioning/install-app/check-app').query({ value: 'demo-wiki' });
  assert.equal(res.status, 200);
  assert.equal(res.body.exists, true);
  assert.equal(res.body.url, customCtUrl('demo-wiki'));
  assert.equal(res.body.conflict, true);
  assert.deepEqual(res.body.shadows, ['ProxmoxVED']);
});

// issue #15 US1: an app the branch doesn't change resolves to upstream even
// with the custom repository configured -- no `custom`, no `shadows`.
test('GET /api/provisioning/install-app/check-app resolves an unchanged upstream app to upstream with the feature on', async () => {
  const customInventory: Inventory = { ...inventory, customScriptsRepo: `${CUSTOM_OWNER}/${CUSTOM_REPO}`, customScriptsBranch: CUSTOM_BRANCH };
  const fetchImpl = (async (url: unknown) => {
    const href = String(url);
    if (href === CUSTOM_HEAD_SHA_URL) return new Response(CUSTOM_HEAD_SHA_RAW, { status: 200 });
    if (href === CUSTOM_COMPARE_URL) return new Response(CUSTOM_COMPARE_AHEAD_BODY, { status: 200 });
    if (href === `${UPSTREAM_STABLE_BASE}/ct/plex.sh`) return new Response('#!/usr/bin/env bash\n', { status: 200 });
    if (href.startsWith(`https://raw.githubusercontent.com/${CUSTOM_OWNER}/`)) throw new Error(`fork fetched: ${href}`);
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
  const { app } = isolatedApp(customInventory, () => ({ stdout: '', stderr: '', code: 0 }), { fetchImpl });
  const res = await request(app).get('/api/provisioning/install-app/check-app').query({ value: 'plex' });
  assert.equal(res.status, 200);
  assert.equal(res.body.exists, true);
  assert.equal(res.body.url, `${UPSTREAM_STABLE_BASE}/ct/plex.sh`);
  assert.equal(res.body.custom, undefined);
  assert.equal(res.body.shadows, undefined);
});

test('GET /api/provisioning/install-app/check-app reports error and exists=false when the custom settings are half-configured', async () => {
  const halfConfiguredInventory: Inventory = { ...inventory, customScriptsRepo: `${CUSTOM_OWNER}/${CUSTOM_REPO}` };
  const { app } = isolatedApp(halfConfiguredInventory, () => ({ stdout: '', stderr: '', code: 0 }));
  const res = await request(app).get('/api/provisioning/install-app/check-app').query({ value: 'demo-shop' });
  assert.equal(res.status, 200);
  assert.equal(res.body.exists, false);
  assert.equal(res.body.url, '');
  assert.match(res.body.error, /customScriptsBranch is not set \(customScriptsRepo is\)/);
});

test('GET /api/provisioning/install-app/apps returns the two catalog groups', async () => {
  const catalogFetch = (async (url: unknown) => {
    const names = String(url).includes('ProxmoxVED') ? ['budget-board.sh'] : ['jellyfin.sh', 'plex.sh'];
    return new Response(JSON.stringify(names.map((name) => ({ name, type: 'file' }))), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  const { app } = testApp(() => ({ stdout: '', stderr: '', code: 0 }), { fetchImpl: catalogFetch });
  const res = await request(app).get('/api/provisioning/install-app/apps');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.stable, ['jellyfin', 'plex']);
  assert.deepEqual(res.body.dev, ['budget-board']);
  assert.equal(res.body.stale, false);
  assert.ok(res.body.fetchedAt);
});

test('GET /api/provisioning/install-app/apps degrades to empty lists when GitHub is unreachable', async () => {
  const failingFetch = (async () => {
    throw new Error('ENOTFOUND api.github.com');
  }) as unknown as typeof fetch;

  const { app } = testApp(() => ({ stdout: '', stderr: '', code: 0 }), { fetchImpl: failingFetch });
  const res = await request(app).get('/api/provisioning/install-app/apps');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.stable, []);
  assert.deepEqual(res.body.dev, []);
  assert.equal(res.body.stale, true);
  assert.equal(res.body.fetchedAt, null);
});

test('checkAppUrl reports exists=true when the resolved URL responds ok', async () => {
  const fakeFetch = (async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
  const result = await checkAppUrl('plex', fakeFetch);
  assert.equal(result.exists, true);
  assert.equal(result.url, 'https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/plex.sh');
});

test('checkAppUrl reports exists=false on a non-ok response, without rewriting a full URL', async () => {
  const fakeFetch = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
  const result = await checkAppUrl('https://example.com/nope.sh', fakeFetch);
  assert.equal(result.exists, false);
  assert.equal(result.url, 'https://example.com/nope.sh');
});

test('checkAppUrl falls back to the dev-repo (ProxmoxVED) URL when the main repo 404s', async () => {
  const requestedUrls: string[] = [];
  const fakeFetch = (async (url: unknown) => {
    requestedUrls.push(String(url));
    const isDev = String(url).includes('ProxmoxVED');
    return new Response(null, { status: isDev ? 200 : 404 });
  }) as unknown as typeof fetch;
  const result = await checkAppUrl('budget-board', fakeFetch);
  assert.equal(result.exists, true);
  assert.equal(result.url, 'https://raw.githubusercontent.com/community-scripts/ProxmoxVED/main/ct/budget-board.sh');
  // A third request follows the successful dev ct fetch: checkAppUrl now
  // also pre-scans the dev repo's install/<slug>-install.sh for prompts
  // (issue #160), derived from whichever repo the ct script resolved in.
  assert.deepEqual(requestedUrls, [
    'https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/budget-board.sh',
    'https://raw.githubusercontent.com/community-scripts/ProxmoxVED/main/ct/budget-board.sh',
    'https://raw.githubusercontent.com/community-scripts/ProxmoxVED/main/install/budget-board-install.sh',
  ]);
});

test('checkAppUrl reports exists=false when neither the main nor the dev repo has the app', async () => {
  const fakeFetch = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
  const result = await checkAppUrl('totally-made-up-app', fakeFetch);
  assert.equal(result.exists, false);
  assert.equal(result.url, 'https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/totally-made-up-app.sh');
});

test('checkAppUrl reports exists=false when the fetch itself throws', async () => {
  const fakeFetch = (async () => {
    throw new Error('network down');
  }) as unknown as typeof fetch;
  const result = await checkAppUrl('plex', fakeFetch);
  assert.equal(result.exists, false);
});

test('parseAppDefaults extracts var_cpu/var_ram/var_disk from a community-scripts ct/<app>.sh body', () => {
  const script = [
    'APP="Plex"',
    'var_tags="${var_tags:-media}"',
    'var_cpu="${var_cpu:-2}"',
    'var_ram="${var_ram:-2048}"',
    'var_disk="${var_disk:-8}"',
    'var_os="${var_os:-ubuntu}"',
  ].join('\n');
  assert.deepEqual(parseAppDefaults(script), { cores: 2, memory: 2048, disk: 8 });
});

test('parseAppDefaults omits fields the script text doesn\'t declare', () => {
  assert.deepEqual(parseAppDefaults('APP="Custom"\nvar_cpu="${var_cpu:-1}"\n'), { cores: 1 });
  assert.deepEqual(parseAppDefaults('not a community-scripts file at all'), {});
});

test('checkAppUrl attaches defaults parsed from the fetched script body when the app exists', async () => {
  const script = 'var_cpu="${var_cpu:-4}"\nvar_ram="${var_ram:-4096}"\nvar_disk="${var_disk:-16}"\n';
  const fakeFetch = (async () => new Response(script, { status: 200 })) as unknown as typeof fetch;
  const result = await checkAppUrl('plex', fakeFetch);
  assert.equal(result.exists, true);
  assert.deepEqual(result.defaults, { cores: 4, memory: 4096, disk: 16 });
});

test('checkAppUrl omits defaults when the app does not exist', async () => {
  const fakeFetch = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
  const result = await checkAppUrl('nope', fakeFetch);
  assert.equal(result.exists, false);
  assert.equal(result.defaults, undefined);
});

test('parsePromptHints extracts read -rp prompt text (paperless-gpt style)', () => {
  const script = [
    '#!/usr/bin/env bash',
    'read -rp "Enter the Paperless local URL now? (y/n) " USE_URL',
    'read -rp "Enter the Paperless API token now? (y/n) " USE_TOKEN',
  ].join('\n');
  assert.deepEqual(parsePromptHints(script), [
    'Enter the Paperless local URL now? (y/n) ',
    'Enter the Paperless API token now? (y/n) ',
  ]);
});

test('parsePromptHints extracts read -r -p prompt text (paperless-ngx style)', () => {
  const script = 'read -r -p "Would you like to add Adminer? <y/N> " ADD_ADMINER';
  assert.deepEqual(parsePromptHints(script), ['Would you like to add Adminer? <y/N> ']);
});

test('parsePromptHints returns an empty array for a script with no read -p prompts', () => {
  assert.deepEqual(parsePromptHints('APP="Plex"\nvar_cpu="${var_cpu:-2}"\n'), []);
});

test('checkAppUrl attaches prompt hints parsed from the fetched script body', async () => {
  const script = 'read -rp "Add Adminer? (y/N) " ADD_ADMINER\n';
  const fakeFetch = (async () => new Response(script, { status: 200 })) as unknown as typeof fetch;
  const result = await checkAppUrl('paperless-ngx', fakeFetch);
  assert.equal(result.exists, true);
  assert.deepEqual(result.prompts, ['Add Adminer? (y/N) ']);
});

test('checkAppUrl omits prompts when the app does not exist', async () => {
  const fakeFetch = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
  const result = await checkAppUrl('nope', fakeFetch);
  assert.equal(result.prompts, undefined);
});

test('parseAppDefaults extracts the port from the "Access it" URL, with and without an explicit port', () => {
  assert.equal(
    parseAppDefaults('echo -e "${GATEWAY}${BGN}http://${IP}:32400/web${CL}"').port,
    32400
  );
  assert.equal(
    parseAppDefaults('echo -e "${GATEWAY}${BGN}https://${IP}:8000${CL}"').port,
    8000
  );
});

test('parseAppDefaults defaults the port to 80/443 when the URL has no explicit port', () => {
  assert.equal(parseAppDefaults('echo -e "${GATEWAY}${BGN}http://${IP}/admin${CL}"').port, 80);
  assert.equal(parseAppDefaults('echo -e "${GATEWAY}${BGN}https://${IP}${CL}"').port, 443);
});

test('parseAppDefaults omits port when the script never echoes an ${IP} URL', () => {
  assert.equal(parseAppDefaults('APP="Custom"\nvar_cpu="${var_cpu:-1}"\n').port, undefined);
});

test('parseAppDefaults picks the first ${IP} URL when a script lists more than one (e.g. a bundled add-on)', () => {
  const script = [
    'echo -e "${GATEWAY}${BGN}HA: http://${IP}:8123${CL}"',
    'echo -e "${GATEWAY}${BGN}Portainer: https://${IP}:9443${CL}"',
  ].join('\n');
  assert.equal(parseAppDefaults(script).port, 8123);
});

test('POST /api/provisioning/install-app/apply writes the parsed port into the new guest inventory entry', async () => {
  const { app, jobStore } = testApp(defaultResponder);
  const res = await request(app)
    .post('/api/provisioning/install-app/apply')
    .send({ app: 'plex', host: 'pve1', mid: 8, hostname: 'plex-new', port: '32400' });
  await waitForFinished(jobStore, res.body.jobId);
  assert.equal(jobStore.get(res.body.jobId)?.status, 'success');

  const invRes = await request(app).get('/api/inventory');
  const guest = invRes.body.guests.find((g: any) => g.name === 'plex-new');
  assert.ok(guest, 'new guest should be present in inventory');
  assert.equal(guest.port, 32400);
});

test('POST /api/provisioning/install-app/apply records the app slug on the new guest inventory entry', async () => {
  const { app: server, jobStore, inventoryPath } = testApp(defaultResponder);
  const res = await request(server)
    .post('/api/provisioning/install-app/apply')
    .send({ app: 'plex', host: 'pve1', mid: 11, hostname: 'plex-app-test' });
  await waitForFinished(jobStore, res.body.jobId);
  assert.equal(jobStore.get(res.body.jobId)?.status, 'success');

  const invRes = await request(server).get('/api/inventory');
  const guest = invRes.body.guests.find((g: any) => g.name === 'plex-app-test');
  assert.ok(guest, 'new guest should be present in inventory');
  assert.equal(guest.app, 'plex');

  // GET /api/inventory serves in-memory state, not a re-parse of the written
  // file -- also load the actual hosts.yaml this apply wrote to, to confirm
  // `app` survives the real YAML write+reparse round trip (not just the
  // in-memory upsertGuestEntry merge).
  const reloaded = loadInventory(inventoryPath);
  const reloadedGuest = reloaded.guests.find((g) => g.name === 'plex-app-test');
  assert.ok(reloadedGuest, 'new guest should be present after reloading hosts.yaml from disk');
  assert.equal(reloadedGuest?.app, 'plex');
});

test('POST /api/provisioning/install-app/apply does not clobber an existing app slug on a repeat apply for the same host+vmid', async () => {
  // The FakeSSHClient responder here is stateless (a pure function of the
  // command string, not a simulator of real Proxmox state), so it always
  // reports the target vmid as free -- this test exercises upsertGuestEntry's
  // metadata-merge behavior across two applies at the same vmid, a concern
  // orthogonal to the vmid-collision check itself.
  const { app: server, jobStore } = testApp(defaultResponder);

  // First apply: bare community-scripts slug, records app: 'plex'.
  const res1 = await request(server)
    .post('/api/provisioning/install-app/apply')
    .send({ app: 'plex', host: 'pve1', mid: 13, hostname: 'plex-repeat' });
  await waitForFinished(jobStore, res1.body.jobId);
  assert.equal(jobStore.get(res1.body.jobId)?.status, 'success');

  // Second apply for the same host+mid (-> same vmid, per resolveMid), this
  // time with a full script URL pasted instead of a bare slug -- appSlugFor
  // resolves that to undefined. Without the existing.app fallback in
  // upsertGuestEntry, the plain `{ ...existing, ...entry }` spread would
  // silently overwrite the previously-recorded 'plex' slug with undefined.
  const res2 = await request(server)
    .post('/api/provisioning/install-app/apply')
    .send({ app: 'https://example.com/custom.sh', host: 'pve1', mid: 13, hostname: 'plex-repeat' });
  await waitForFinished(jobStore, res2.body.jobId);
  assert.equal(jobStore.get(res2.body.jobId)?.status, 'success');

  const invRes = await request(server).get('/api/inventory');
  const guest = invRes.body.guests.find((g: any) => g.name === 'plex-repeat');
  assert.ok(guest, 'guest should still be present in inventory after the second apply');
  assert.equal(guest.app, 'plex');
});

test('POST /api/provisioning/install-app/apply omits app when a full script URL was pasted', async () => {
  const { app: server, jobStore } = testApp(defaultResponder);
  const res = await request(server)
    .post('/api/provisioning/install-app/apply')
    .send({ app: 'https://example.com/custom.sh', host: 'pve1', mid: 12, hostname: 'custom-app-test' });
  await waitForFinished(jobStore, res.body.jobId);
  assert.equal(jobStore.get(res.body.jobId)?.status, 'success');

  const invRes = await request(server).get('/api/inventory');
  const guest = invRes.body.guests.find((g: any) => g.name === 'custom-app-test');
  assert.ok(guest, 'new guest should be present in inventory');
  assert.equal(guest.app, undefined);
});

test('POST /api/provisioning/install-app/apply enqueues its job with expectedPromptsJson parsed from the script', async () => {
  const script = 'read -rp "Add Adminer? (y/N) " ADD_ADMINER\n';
  const fakeFetch = (async () => new Response(script, { status: 200 })) as unknown as typeof fetch;
  const { app, jobStore } = testApp(defaultResponder, { fetchImpl: fakeFetch });
  const res = await request(app)
    .post('/api/provisioning/install-app/apply')
    .send({ app: 'paperless-ngx', host: 'pve1', mid: 30, hostname: 'paperless-ngx-test' });
  await waitForFinished(jobStore, res.body.jobId);
  const row = jobStore.get(res.body.jobId)!;
  assert.equal(row.status, 'success');
  assert.deepEqual(JSON.parse(row.expectedPromptsJson ?? '[]'), ['Add Adminer? (y/N) ']);
});

test('POST /api/provisioning/create-lxc/apply does not set expectedPromptsJson -- only install-app watches for prompts', async () => {
  const { app, jobStore } = testApp(() => ({ stdout: 'created', stderr: '', code: 0 }));
  const res = await request(app)
    .post('/api/provisioning/create-lxc/apply')
    .send({ host: 'pve1', mid: 40, hostname: 'not-watched', template: 'debian-13-standard' });
  await waitForFinished(jobStore, res.body.jobId);
  assert.equal(jobStore.get(res.body.jobId)?.expectedPromptsJson, null);
});

test('POST /api/provisioning/install-app/apply fails with a 400 and does not write to inventory when the target vmid collides with an existing guest', async () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [
      {
        name: 'pve1',
        ssh_target: 'pve1.local',
        ssh_user: 'root',
        midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' },
        storages: [
          { name: 'local', type: 'dir', content: ['vztmpl'], active: true },
          { name: 'local-lvm', type: 'lvmthin', content: ['rootdir', 'images'], active: true },
        ],
      },
    ],
    guests: [{ name: 'plex-lxc', type: 'lxc', vmid: 4003, host: 'pve1' }],
  };
  const { app } = isolatedApp(inv, (_t, _u, c) => {
    if (c === 'pct status 4003 >/dev/null 2>&1 || qm status 4003 >/dev/null 2>&1') {
      return { stdout: 'status: running', stderr: '', code: 0 };
    }
    return { stdout: 'installed', stderr: '', code: 0 };
  });
  const res = await request(app)
    .post('/api/provisioning/install-app/apply')
    .send({ app: 'plex', host: 'pve1', mid: 3, hostname: 'plex-collision' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /VMID 4003 on 'pve1' is already in use by 'plex-lxc' -- choose a different --mid/);

  const invRes = await request(app).get('/api/inventory');
  assert.ok(!invRes.body.guests.some((g: any) => g.name === 'plex-collision'));
});

test('POST /api/provisioning/delete-guest/preview returns the labeled destroy script without mutating anything', async () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' }, caddy: true }],
    guests: [{ name: 'media', type: 'lxc', vmid: 4020, host: 'pve1' }],
  };
  const calls: string[] = [];
  const { app } = isolatedApp(inv, (_t, _u, c) => {
    calls.push(c);
    return { stdout: 'status: running', stderr: '', code: 0 };
  });
  const res = await request(app).post('/api/provisioning/delete-guest/preview').send({ guest: 'media' });
  assert.equal(res.status, 200);
  assert.match(res.body.preview, /pct stop 4020/);
  assert.match(res.body.preview, /pct destroy 4020/);
  assert.equal(calls.length, 1); // status check only, no mutation
});

test('POST /api/provisioning/delete-guest/apply destroys a stopped guest with no subdomains, removing it from inventory without touching Caddy', async () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' }, caddy: true }],
    guests: [{ name: 'media', type: 'lxc', vmid: 4020, host: 'pve1' }],
  };
  const { app, jobStore } = isolatedApp(inv, (_t, _u, c) => {
    if (c.includes('status')) return { stdout: 'status: stopped', stderr: '', code: 0 };
    if (c.includes('destroy')) return { stdout: '', stderr: '', code: 0 };
    throw new Error(`unexpected command (Caddy should not be touched): ${c}`);
  });
  const res = await request(app).post('/api/provisioning/delete-guest/apply').send({ guest: 'media' });
  await waitForFinished(jobStore, res.body.jobId);
  assert.equal(jobStore.get(res.body.jobId)?.status, 'success');

  const invRes = await request(app).get('/api/inventory');
  assert.ok(!invRes.body.guests.some((g: any) => g.name === 'media'));
});

test('POST /api/provisioning/delete-guest/apply removes a subdomains-bearing guest and re-syncs Caddy', async () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' }, caddy: true }],
    guests: [{ name: 'media', type: 'lxc', vmid: 4020, host: 'pve1', ip: '192.168.1.20', subdomains: ['media'] }],
  };
  const caddyCalls: string[] = [];
  const { app, jobStore } = isolatedApp(inv, (_t, _u, c) => {
    if (c.includes('status')) return { stdout: 'status: stopped', stderr: '', code: 0 };
    if (c.includes('destroy')) return { stdout: '', stderr: '', code: 0 };
    caddyCalls.push(c);
    return { stdout: '', stderr: '', code: 0 };
  });
  const res = await request(app).post('/api/provisioning/delete-guest/apply').send({ guest: 'media' });
  await waitForFinished(jobStore, res.body.jobId);
  assert.equal(jobStore.get(res.body.jobId)?.status, 'success');

  const invRes = await request(app).get('/api/inventory');
  assert.ok(!invRes.body.guests.some((g: any) => g.name === 'media'));
  assert.ok(caddyCalls.some((c) => c.includes('BEGIN bellhop-managed')), 'Caddy managed block must be regenerated');
});

test('POST /api/provisioning/delete-guest/apply removes a gated guest\'s Authentik Application instead of orphaning it', async () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [
      { name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' }, caddy: true },
      { name: 'auth-lxc', ssh_target: 'auth.local', ssh_user: 'root', authentik: true, ip: '192.168.1.5' },
    ],
    guests: [
      {
        name: 'sonarr',
        type: 'lxc',
        vmid: 4020,
        host: 'pve1',
        ip: '192.168.1.20',
        subdomains: ['sonarr'],
        authGroup: 'bellhop-users',
      },
    ],
  };
  const { app, jobStore, authentik } = isolatedApp(inv, (_t, _u, c) => {
    if (c.includes('status')) return { stdout: 'status: stopped', stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  });

  // Seed inventory's current gated state into Authentik first, the same way
  // a real prior syncCaddyLive would have.
  await runSyncAuthentik({ apply: true }, { authentik, inventory: inv });
  assert.equal((await authentik.listApplications()).length, 1, 'sanity check: the Application must exist before deletion');

  const res = await request(app).post('/api/provisioning/delete-guest/apply').send({ guest: 'sonarr' });
  await waitForFinished(jobStore, res.body.jobId);
  assert.equal(jobStore.get(res.body.jobId)?.status, 'success');

  const invRes = await request(app).get('/api/inventory');
  assert.ok(!invRes.body.guests.some((g: any) => g.name === 'sonarr'));

  assert.deepEqual(
    await authentik.listApplications(),
    [],
    'deleting a gated guest must remove its Authentik Application, not orphan it'
  );
  assert.deepEqual(await authentik.listProxyProviders(), [], 'and its Provider too');
});

test('POST /api/provisioning/delete-guest/apply succeeds for a gated guest when no Authentik API is configured', async () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [
      { name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' }, caddy: true },
      { name: 'auth-lxc', ssh_target: 'auth.local', ssh_user: 'root', authentik: true, ip: '192.168.1.5' },
    ],
    guests: [
      {
        name: 'sonarr',
        type: 'lxc',
        vmid: 4020,
        host: 'pve1',
        ip: '192.168.1.20',
        subdomains: ['sonarr'],
        authGroup: 'bellhop-users',
      },
    ],
  };
  // Before issue #123's fix wave, this call site called runSyncAuthentik
  // unconditionally -- UnconfiguredAuthentikClient.listApplications() then
  // rejects, failing the whole delete job even though the guest's Caddy
  // config still needs to be torn down. Mirrors syncCaddyLive's own
  // isConfigured() guard in src/web/caddy-sync.ts.
  const { app, jobStore } = isolatedApp(
    inv,
    (_t, _u, c) => {
      if (c.includes('status')) return { stdout: 'status: stopped', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    },
    { authentik: new UnconfiguredAuthentikClient() }
  );

  const res = await request(app).post('/api/provisioning/delete-guest/apply').send({ guest: 'sonarr' });
  await waitForFinished(jobStore, res.body.jobId);
  assert.equal(jobStore.get(res.body.jobId)?.status, 'success');

  const invRes = await request(app).get('/api/inventory');
  assert.ok(!invRes.body.guests.some((g: any) => g.name === 'sonarr'));
});

test('POST /api/provisioning/delete-guest/apply refuses to delete the caddy: true guest', async () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' } }],
    guests: [{ name: 'caddy-lxc', type: 'lxc', vmid: 4010, host: 'pve1', caddy: true, ip: '192.168.1.10' }],
  };
  const { app, jobStore } = isolatedApp(inv, () => ({ stdout: 'status: stopped', stderr: '', code: 0 }));
  const res = await request(app).post('/api/provisioning/delete-guest/apply').send({ guest: 'caddy-lxc' });
  await waitForFinished(jobStore, res.body.jobId);
  assert.equal(jobStore.get(res.body.jobId)?.status, 'failed');

  const invRes = await request(app).get('/api/inventory');
  assert.ok(invRes.body.guests.some((g: any) => g.name === 'caddy-lxc'), 'guest must not be removed');
});

test('POST /api/provisioning/deploy-vpn-gateway/preview returns 400 when NordVPN access token is unset', async (t) => {
  const prevToken = process.env.NORDVPN_ACCESS_TOKEN;
  delete process.env.NORDVPN_ACCESS_TOKEN;
  t.after(() => {
    if (prevToken === undefined) delete process.env.NORDVPN_ACCESS_TOKEN;
    else process.env.NORDVPN_ACCESS_TOKEN = prevToken;
  });

  const { app } = testApp(() => ({ stdout: '', stderr: '', code: 0 }));
  const res = await request(app)
    .post('/api/provisioning/deploy-vpn-gateway/preview')
    .send({ host: 'pve1', mid: 15, name: 'nordvpn-gateway-lxc', vpn: 'nordvpn' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /NordVPN access token is not set -- fill in the Access Token field on the Deploy VPN Gateway form, or set NORDVPN_ACCESS_TOKEN for CLI use/);
});

test('POST /api/provisioning/deploy-vpn-gateway/apply creates the gateway and records vpnGateway in inventory', async (t) => {
  const prevToken = process.env.NORDVPN_ACCESS_TOKEN;
  process.env.NORDVPN_ACCESS_TOKEN = 'test-token';
  t.after(() => {
    if (prevToken === undefined) delete process.env.NORDVPN_ACCESS_TOKEN;
    else process.env.NORDVPN_ACCESS_TOKEN = prevToken;
  });

  // isolatedApp rather than testApp: runDeployVpnGateway mutates its caller's
  // inventory object in place, and testApp shares one module-level `inventory`
  // fixture across the whole file -- a fresh copy here keeps this test from
  // depending on run order.
  const { app, jobStore } = isolatedApp(
    { ...inventory, guests: [...inventory.guests] },
    () => ({ stdout: '', stderr: '', code: 0 }),
    { goBuilder: new FakeGoBuilder(), fetchImpl: fakeNordVpnFetch() }
  );
  const res = await request(app)
    .post('/api/provisioning/deploy-vpn-gateway/apply')
    .send({ host: 'pve1', mid: 15, name: 'nordvpn-gateway-lxc', vpn: 'nordvpn', connectPollAttempts: 1, connectPollDelayMs: 0 });
  assert.equal(res.status, 200);
  await waitForFinished(jobStore, res.body.jobId);
  assert.equal(jobStore.get(res.body.jobId)?.status, 'success');

  const invRes = await request(app).get('/api/inventory');
  const gateway = invRes.body.guests.find((g: any) => g.name === 'nordvpn-gateway-lxc');
  assert.ok(gateway, 'gateway guest should be present in inventory');
  assert.equal(gateway.vpnGateway, 'nordvpn');
  assert.equal(gateway.vmid, 4015);
});

test('POST /api/provisioning/deploy-vpn-gateway/apply uses the operator-chosen storage over the automatic pick', async (t) => {
  const prevUsername = process.env.PIA_USERNAME;
  const prevPassword = process.env.PIA_PASSWORD;
  process.env.PIA_USERNAME = 'p0123456';
  process.env.PIA_PASSWORD = 'hunter2';
  t.after(() => {
    if (prevUsername === undefined) delete process.env.PIA_USERNAME;
    else process.env.PIA_USERNAME = prevUsername;
    if (prevPassword === undefined) delete process.env.PIA_PASSWORD;
    else process.env.PIA_PASSWORD = prevPassword;
  });

  const { app, jobStore } = isolatedApp(
    { ...inventory, guests: [...inventory.guests] },
    () => ({ stdout: '', stderr: '', code: 0 }),
    { goBuilder: new FakeGoBuilder(), fetchImpl: fakePiaFetch() }
  );
  const res = await request(app)
    .post('/api/provisioning/deploy-vpn-gateway/apply')
    .send({ host: 'pve1', mid: 16, name: 'pia-gateway-lxc', vpn: 'pia', storage: 'nas-proxmox', connectPollAttempts: 1, connectPollDelayMs: 0 });
  await waitForFinished(jobStore, res.body.jobId);
  assert.equal(jobStore.get(res.body.jobId)?.status, 'success');

  const jobRes = await request(app).get(`/api/jobs/${res.body.jobId}`);
  assert.match(jobRes.body.log, /--rootfs 'nas-proxmox':8/);
});

test('POST /api/provisioning/deploy-vpn-gateway/apply redacts secret fields in the stored job record, while still applying the real value', async (t) => {
  const prevToken = process.env.NORDVPN_ACCESS_TOKEN;
  delete process.env.NORDVPN_ACCESS_TOKEN;
  t.after(() => {
    if (prevToken === undefined) delete process.env.NORDVPN_ACCESS_TOKEN;
    else process.env.NORDVPN_ACCESS_TOKEN = prevToken;
  });

  // Capture the actual Authorization header sent to NordVPN's API so we can
  // prove the REAL accessToken (not the redacted copy stored in the job
  // record) is what resolveNordVpnPreviewServer's fetch call used. A fake
  // that only branches on URL substring (like the shared fakeNordVpnFetch)
  // would accept '[redacted]' just as happily as the real token, so it can't
  // catch a regression where handler.apply is fed the redacted body instead
  // of the real req.body.
  let capturedAuthHeader: string | undefined;
  const capturingNordVpnFetch = (async (url: string, init?: RequestInit) => {
    if (String(url).includes('users/services/credentials')) {
      capturedAuthHeader = (init?.headers as Record<string, string> | undefined)?.Authorization;
      return { ok: true, status: 200, json: async () => ({ nordlynx_private_key: 'priv' }) } as Response;
    }
    if (String(url).includes('servers/recommendations')) {
      return {
        ok: true,
        status: 200,
        json: async () => [{ hostname: 'nl123.nordvpn.com', locations: [{ country: { name: 'Netherlands' } }] }],
      } as Response;
    }
    if (String(url).includes('/status')) {
      return { ok: true, status: 200, json: async () => ({ connected: true, dns: '103.86.96.100' }) } as Response;
    }
    throw new Error(`unexpected fetch url: ${url}`);
  }) as typeof fetch;

  const { app, jobStore } = isolatedApp(
    { ...inventory, guests: [...inventory.guests] },
    () => ({ stdout: '', stderr: '', code: 0 }),
    { goBuilder: new FakeGoBuilder(), fetchImpl: capturingNordVpnFetch }
  );
  const res = await request(app)
    .post('/api/provisioning/deploy-vpn-gateway/apply')
    .send({
      host: 'pve1',
      mid: 15,
      name: 'nordvpn-gateway-lxc',
      vpn: 'nordvpn',
      accessToken: 'super-secret-token',
      connectPollAttempts: 1,
      connectPollDelayMs: 0,
    });
  assert.equal(res.status, 200);
  await waitForFinished(jobStore, res.body.jobId);
  assert.equal(jobStore.get(res.body.jobId)?.status, 'success');

  const storedArgs = JSON.parse(jobStore.get(res.body.jobId)!.argsJson);
  assert.equal(storedArgs.accessToken, '[redacted]');
  assert.equal(storedArgs.host, 'pve1', 'non-secret fields must survive redaction untouched');

  // The decisive assertion: decode the Authorization header actually sent
  // over the (fake) wire and confirm it carries the real token, not the
  // redacted placeholder and not a leftover env var (which was deleted above).
  assert.ok(capturedAuthHeader, 'expected an Authorization header to have been captured');
  const decoded = Buffer.from(capturedAuthHeader!.replace(/^Basic /, ''), 'base64').toString('utf8');
  assert.equal(decoded, 'token:super-secret-token');
});

test('POST /api/provisioning/deploy-vpn-gateway/apply redacts piaPassword but not piaUsername (not kind: secret) in the stored job record', async (t) => {
  const prevUsername = process.env.PIA_USERNAME;
  const prevPassword = process.env.PIA_PASSWORD;
  delete process.env.PIA_USERNAME;
  delete process.env.PIA_PASSWORD;
  t.after(() => {
    if (prevUsername === undefined) delete process.env.PIA_USERNAME;
    else process.env.PIA_USERNAME = prevUsername;
    if (prevPassword === undefined) delete process.env.PIA_PASSWORD;
    else process.env.PIA_PASSWORD = prevPassword;
  });

  const { app, jobStore } = isolatedApp(
    { ...inventory, guests: [...inventory.guests] },
    () => ({ stdout: '', stderr: '', code: 0 }),
    { goBuilder: new FakeGoBuilder(), fetchImpl: fakePiaFetch() }
  );
  const res = await request(app)
    .post('/api/provisioning/deploy-vpn-gateway/apply')
    .send({
      host: 'pve1',
      mid: 16,
      name: 'pia-gateway-lxc',
      vpn: 'pia',
      piaUsername: 'p0123456',
      piaPassword: 'hunter2',
      connectPollAttempts: 1,
      connectPollDelayMs: 0,
    });
  assert.equal(res.status, 200);
  await waitForFinished(jobStore, res.body.jobId);
  assert.equal(jobStore.get(res.body.jobId)?.status, 'success');

  const storedArgs = JSON.parse(jobStore.get(res.body.jobId)!.argsJson);
  assert.equal(storedArgs.piaPassword, '[redacted]', 'piaPassword is kind: secret and must be redacted');
  assert.equal(storedArgs.piaUsername, 'p0123456', 'piaUsername is not kind: secret and must survive untouched');
  assert.equal(storedArgs.host, 'pve1', 'non-secret fields must survive redaction untouched');
});

test('POST /api/provisioning/deploy-vpn-gateway/apply does not rewrite a blank hidden credential field to [redacted]', async (t) => {
  const prevToken = process.env.NORDVPN_ACCESS_TOKEN;
  process.env.NORDVPN_ACCESS_TOKEN = 'test-token';
  t.after(() => {
    if (prevToken === undefined) delete process.env.NORDVPN_ACCESS_TOKEN;
    else process.env.NORDVPN_ACCESS_TOKEN = prevToken;
  });

  // Simulates the real form's behavior: every field key is submitted
  // regardless of visibility, so a NordVPN deploy still sends the (hidden,
  // untouched) PIA fields as empty strings rather than omitting them. A
  // blank secret field must be left as '' -- rewriting it to '[redacted]'
  // would misleadingly imply a credential was actually supplied.
  const { app, jobStore } = isolatedApp(
    { ...inventory, guests: [...inventory.guests] },
    () => ({ stdout: '', stderr: '', code: 0 }),
    { goBuilder: new FakeGoBuilder(), fetchImpl: fakeNordVpnFetch() }
  );
  const res = await request(app)
    .post('/api/provisioning/deploy-vpn-gateway/apply')
    .send({
      host: 'pve1',
      mid: 15,
      name: 'nordvpn-gateway-lxc',
      vpn: 'nordvpn',
      piaUsername: '',
      piaPassword: '',
      connectPollAttempts: 1,
      connectPollDelayMs: 0,
    });
  assert.equal(res.status, 200);
  await waitForFinished(jobStore, res.body.jobId);
  assert.equal(jobStore.get(res.body.jobId)?.status, 'success');

  const storedArgs = JSON.parse(jobStore.get(res.body.jobId)!.argsJson);
  assert.equal(storedArgs.piaPassword, '', 'a blank secret field must not be rewritten to [redacted]');
  assert.equal(storedArgs.piaUsername, '');
});

function asAdmin(req: request.Test): request.Test {
  return req.set('x-authentik-username', 'admin').set('x-authentik-groups', 'bellhop-admins');
}

test('POST /api/provisioning/create-lxc/preview returns 403 for a restricted group targeting a blocked host', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' } }],
    guests: [],
  };
  const inventoryPath = path.join(mkdtempSync(path.join(tmpdir(), 'inventory-')), 'bellhop.db');
  saveInventory(inventoryPath, inventory);
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const jobRunner = new JobRunner(jobStore, jobLog, ssh);
  const app = buildApp({ inventory, baseSsh: ssh, jobStore, jobLog, jobRunner, inventoryPath, authentik: new FakeAuthentikClient() });

  await asAdmin(request(app).put('/api/permissions/family')).send({
    mode: 'block-list',
    resources: [{ type: 'host', name: 'pve1' }],
  });

  const res = await request(app)
    .post('/api/provisioning/create-lxc/preview')
    .set('x-authentik-username', 'kid')
    .set('x-authentik-groups', 'family')
    .send({ host: 'pve1', mid: 4, hostname: 'test-lxc' });
  assert.equal(res.status, 403);
});

test('POST /api/provisioning/delete-guest/preview returns 403 for a restricted group targeting a blocked guest', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' } }],
    guests: [{ name: 'plex-lxc', type: 'lxc', vmid: 4002, host: 'pve1' }],
  };
  const inventoryPath = path.join(mkdtempSync(path.join(tmpdir(), 'inventory-')), 'bellhop.db');
  saveInventory(inventoryPath, inventory);
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const jobRunner = new JobRunner(jobStore, jobLog, ssh);
  const app = buildApp({ inventory, baseSsh: ssh, jobStore, jobLog, jobRunner, inventoryPath, authentik: new FakeAuthentikClient() });

  await asAdmin(request(app).put('/api/permissions/family')).send({
    mode: 'block-list',
    resources: [{ type: 'guest', name: 'plex-lxc' }],
  });

  const res = await request(app)
    .post('/api/provisioning/delete-guest/preview')
    .set('x-authentik-username', 'kid')
    .set('x-authentik-groups', 'family')
    .send({ guest: 'plex-lxc' });
  assert.equal(res.status, 403);
});

// #16: request bodies are now schema-parsed by the shared operation layer.
test('POST /api/provisioning/create-lxc/preview returns 400 naming the field when mid is not numeric', async () => {
  const { app } = testApp(() => ({ stdout: '', stderr: '', code: 0 }));
  const res = await request(app)
    .post('/api/provisioning/create-lxc/preview')
    .send({ host: 'pve1', mid: 'abc', hostname: 'media', template: 't' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /mid/);
});

// #16: the permission check must run before schema parsing, so a blocked
// caller gets 403 rather than a 400 describing the operation's input shape.
test('POST /api/provisioning/create-lxc/preview returns 403, not 400, for a blocked caller sending a malformed body', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' } }],
    guests: [],
  };
  const inventoryPath = path.join(mkdtempSync(path.join(tmpdir(), 'inventory-')), 'bellhop.db');
  saveInventory(inventoryPath, inventory);
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const jobRunner = new JobRunner(jobStore, jobLog, ssh);
  const app = buildApp({ inventory, baseSsh: ssh, jobStore, jobLog, jobRunner, inventoryPath, authentik: new FakeAuthentikClient() });

  await asAdmin(request(app).put('/api/permissions/family')).send({
    mode: 'block-list',
    resources: [{ type: 'host', name: 'pve1' }],
  });

  const res = await request(app)
    .post('/api/provisioning/create-lxc/preview')
    .set('x-authentik-username', 'kid')
    .set('x-authentik-groups', 'family')
    .send({ host: 'pve1', mid: 'abc', hostname: 42 });
  assert.equal(res.status, 403);
  assert.equal(ssh.history.length, 0);
});

test('POST /api/provisioning/migrate-guest/preview returns the source and target scripts', async () => {
  const inv: Inventory = {
    domain: 'example.com',
    backupStorage: 'nas-proxmox',
    hosts: [
      {
        name: 'pve-main',
        ssh_target: 'pve-main.local',
        ssh_user: 'root',
        midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' },
        storages: [
          { name: 'local-lvm', type: 'lvmthin', content: ['rootdir', 'images'], active: true },
          { name: 'nas-proxmox', type: 'nfs', content: ['backup', 'rootdir', 'images'], active: true },
        ],
      },
      {
        name: 'pve-secondary',
        ssh_target: 'pve-secondary.local',
        ssh_user: 'root',
        midScheme: { vmidBase: 5000, ipPrefix: '192.168.2.', gateway: '192.168.3.1' },
        storages: [
          { name: 'local-lvm', type: 'lvmthin', content: ['rootdir', 'images'], active: true },
          { name: 'nas-proxmox', type: 'nfs', content: ['backup', 'rootdir', 'images'], active: true },
        ],
      },
    ],
    guests: [{ name: 'media', type: 'lxc', vmid: 4012, host: 'pve-main', ip: '192.168.1.12' }],
  };
  const { app } = isolatedApp(inv, () => ({ stdout: '', stderr: '', code: 1 }));
  const res = await request(app).post('/api/provisioning/migrate-guest/preview').send({ guest: 'media', toHost: 'pve-secondary' });
  assert.equal(res.status, 200);
  assert.match(res.body.preview, /vzdump 4012 --storage nas-proxmox/);
  assert.match(res.body.preview, /pct restore 5012/);
});

test('POST /api/provisioning/migrate-guest/apply migrates the guest, updates inventory, and re-syncs Caddy for a subdomains-bearing guest', async () => {
  const VZDUMP_STDOUT =
    "INFO: creating vzdump archive '/mnt/pve/nas-proxmox/dump/vzdump-lxc-4012-2026_08_11-12_00_00.tar.zst'\nINFO: Finished Backup";
  const inv: Inventory = {
    domain: 'example.com',
    backupStorage: 'nas-proxmox',
    // Set so this apply's final runRenderStatusPage step is actually
    // exercised (see the caddyCalls assertions below) rather than skipped
    // as a no-op -- statusPagePath is opt-in as of issue #124.
    statusPagePath: '/usr/share/caddy/index.html',
    hosts: [
      {
        name: 'pve-main',
        ssh_target: 'pve-main.local',
        ssh_user: 'root',
        midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' },
        caddy: true,
        storages: [
          { name: 'local-lvm', type: 'lvmthin', content: ['rootdir', 'images'], active: true },
          { name: 'nas-proxmox', type: 'nfs', content: ['backup', 'rootdir', 'images'], active: true },
        ],
      },
      {
        name: 'pve-secondary',
        ssh_target: 'pve-secondary.local',
        ssh_user: 'root',
        midScheme: { vmidBase: 5000, ipPrefix: '192.168.2.', gateway: '192.168.3.1' },
        storages: [
          { name: 'local-lvm', type: 'lvmthin', content: ['rootdir', 'images'], active: true },
          { name: 'nas-proxmox', type: 'nfs', content: ['backup', 'rootdir', 'images'], active: true },
        ],
      },
    ],
    guests: [{ name: 'media', type: 'lxc', vmid: 4012, host: 'pve-main', ip: '192.168.1.12', subdomains: ['media'] }],
  };
  let statusCalls = 0;
  const caddyCalls: string[] = [];
  const { app, jobStore } = isolatedApp(inv, (_t, _u, cmd) => {
    // Exact match, not a generic `cmd.includes('status')` -- the route
    // handler calls runMigrateGuest (and so checkVmidAvailable's compound
    // `pct status ... || qm status ...` probe) twice for one apply request:
    // once synchronously via handler.preview() to build the job's logged
    // preview text, and again for real inside handler.apply() once the job
    // runs. A single shared counter keyed on any "status"-containing command
    // treats that extra preview-time probe as the first of two expected
    // waitForGuestRunning polls, so the real in-job checkVmidAvailable call
    // sees the "already running" response and wrongly aborts the whole
    // migration as a VMID collision before anything is backed up. Matching
    // only the exact bare command waitForGuestRunning issues keeps
    // checkVmidAvailable's own (possibly repeated) probe always reporting
    // "free" instead.
    if (cmd === 'pct status 5012') {
      statusCalls += 1;
      return statusCalls === 1 ? { stdout: '', stderr: '', code: 1 } : { stdout: 'status: running', stderr: '', code: 0 };
    }
    // I1: Fix 1's post-vzdump source-guest status check (`pct status 4012`)
    // needs a genuine successful "stopped" report (exit 0) -- a bare
    // non-zero exit now means "the probe itself failed" and makes
    // runMigrateGuest refuse to proceed, per I1's fix. Checked before the
    // broader `cmd.includes('pct status')` fallback below so this exact
    // command doesn't fall into that "free" (code: 1) branch.
    if (cmd === 'pct status 4012') return { stdout: 'status: stopped', stderr: '', code: 0 };
    // Scoped to the actual pct/qm status probe commands, not a bare
    // `cmd.includes('status')` -- render-status-page's generated HTML body
    // (below) literally contains the word "status" in its page title
    // ("Homelab status"), so a bare substring check here would also swallow
    // that write command and make it look like a checkVmidAvailable probe,
    // returning an unearned code:1 that render-status-page then reports as
    // a failed write.
    if (cmd.includes('pct status') || cmd.includes('qm status')) return { stdout: '', stderr: '', code: 1 };
    // Fix 2: reconfigureGuestIp reads the restored guest's own net0 before
    // rewriting only its ip= -- without a real net0 line here, that step
    // would throw "no net0 in its config" instead of exercising the rest of
    // the pipeline this test actually cares about.
    if (cmd.startsWith('pct config') || cmd.startsWith('qm config')) {
      return { stdout: 'net0: name=eth0,bridge=vmbr0,gw=192.168.3.1,ip=192.168.1.12/16,type=veth', stderr: '', code: 0 };
    }
    if (cmd.startsWith('vzdump')) return { stdout: VZDUMP_STDOUT, stderr: '', code: 0 };
    if (cmd.includes('BEGIN bellhop-managed') || cmd.includes('Caddyfile') || cmd.includes('index.html')) {
      caddyCalls.push(cmd);
      return { stdout: '', stderr: '', code: 0 };
    }
    return { stdout: '', stderr: '', code: 0 };
  });

  const res = await request(app).post('/api/provisioning/migrate-guest/apply').send({ guest: 'media', toHost: 'pve-secondary' });
  assert.equal(res.status, 200);
  await waitForFinished(jobStore, res.body.jobId);
  assert.equal(jobStore.get(res.body.jobId)?.status, 'success');

  const invRes = await request(app).get('/api/inventory');
  const guest = invRes.body.guests.find((g: any) => g.name === 'media');
  assert.equal(guest.host, 'pve-secondary');
  assert.equal(guest.vmid, 5012);
  assert.equal(guest.ip, '192.168.2.12');
  assert.deepEqual(guest.subdomains, ['media']);
  assert.ok(caddyCalls.some((c) => c.includes('BEGIN bellhop-managed')), 'Caddy managed block must be regenerated');
});

test('POST /api/provisioning/migrate-guest/apply fails the job and leaves the source guest in inventory when the restored guest never reports running', async () => {
  const VZDUMP_STDOUT =
    "INFO: creating vzdump archive '/mnt/pve/nas-proxmox/dump/vzdump-lxc-4012-2026_08_11-12_00_00.tar.zst'\nINFO: Finished Backup";
  const inv: Inventory = {
    domain: 'example.com',
    backupStorage: 'nas-proxmox',
    hosts: [
      {
        name: 'pve-main',
        ssh_target: 'pve-main.local',
        ssh_user: 'root',
        midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' },
        storages: [
          { name: 'local-lvm', type: 'lvmthin', content: ['rootdir', 'images'], active: true },
          { name: 'nas-proxmox', type: 'nfs', content: ['backup', 'rootdir', 'images'], active: true },
        ],
      },
      {
        name: 'pve-secondary',
        ssh_target: 'pve-secondary.local',
        ssh_user: 'root',
        midScheme: { vmidBase: 5000, ipPrefix: '192.168.2.', gateway: '192.168.3.1' },
        storages: [
          { name: 'local-lvm', type: 'lvmthin', content: ['rootdir', 'images'], active: true },
          { name: 'nas-proxmox', type: 'nfs', content: ['backup', 'rootdir', 'images'], active: true },
        ],
      },
    ],
    guests: [{ name: 'media', type: 'lxc', vmid: 4012, host: 'pve-main', ip: '192.168.1.12' }],
  };
  const { app, jobStore } = isolatedApp(inv, (_t, _u, cmd) => {
    // Exact match, not startsWith -- see Task 3's "exhausts verify-running
    // retry budget" test for why startsWith would misclassify
    // checkVmidAvailable's own compound probe command here.
    if (cmd === 'pct status 5012') return { stdout: 'status: stopped', stderr: '', code: 0 }; // never running
    // I1: Fix 1's post-vzdump source-guest status check needs a genuine
    // successful "stopped" report (exit 0) so this test actually reaches
    // (and exhausts) the verify-running retry loop, rather than failing
    // earlier at the source-status check with an unrelated error -- a bare
    // non-zero exit now means "the probe itself failed", not "not running".
    if (cmd === 'pct status 4012') return { stdout: 'status: stopped', stderr: '', code: 0 };
    if (cmd.includes('status')) return { stdout: '', stderr: '', code: 1 }; // checkVmidAvailable probe: free
    if (cmd.startsWith('pct config')) {
      return { stdout: 'net0: name=eth0,bridge=vmbr0,gw=192.168.3.1,ip=192.168.1.12/16,type=veth', stderr: '', code: 0 };
    }
    if (cmd.startsWith('vzdump')) return { stdout: VZDUMP_STDOUT, stderr: '', code: 0 };
    if (cmd.startsWith('pct destroy')) throw new Error('destroy must never be called');
    return { stdout: '', stderr: '', code: 0 };
  });

  const res = await request(app).post('/api/provisioning/migrate-guest/apply').send({ guest: 'media', toHost: 'pve-secondary' });
  // Asserted before waitForFinished (unlike a naive first draft of this test)
  // -- without a registered route, res.body.jobId is undefined and
  // waitForFinished(jobStore, undefined) polls jobStore.get(undefined)
  // forever, since that status is never 'success'/'failed'. Failing fast
  // here instead of hanging matches every other apply test in this file.
  assert.equal(res.status, 200);
  await waitForFinished(jobStore, res.body.jobId);
  assert.equal(jobStore.get(res.body.jobId)?.status, 'failed');

  const invRes = await request(app).get('/api/inventory');
  const guest = invRes.body.guests.find((g: any) => g.name === 'media');
  assert.equal(guest.host, 'pve-main', 'source guest must remain untouched in inventory');
  assert.equal(guest.vmid, 4012);
});

test('resolveInstallScriptUrl derives the install script from a ct script URL', () => {
  assert.equal(
    resolveInstallScriptUrl('https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/cloudflare-ddns.sh'),
    'https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/install/cloudflare-ddns-install.sh'
  );
  assert.equal(
    resolveInstallScriptUrl('https://raw.githubusercontent.com/community-scripts/ProxmoxVED/main/ct/budget-board.sh'),
    'https://raw.githubusercontent.com/community-scripts/ProxmoxVED/main/install/budget-board-install.sh'
  );
});

test('resolveInstallScriptUrl returns undefined for a URL that is not shaped like a ct script', () => {
  assert.equal(resolveInstallScriptUrl('https://example.com/my-installer.sh'), undefined);
  assert.equal(resolveInstallScriptUrl('https://example.com/install/thing-install.sh'), undefined);
});

test('checkAppUrl reports the install script prompts and ignores the ct script ones', async () => {
  // All 20 ct/ scripts that carry a read prompt have it inside
  // update_script(), which install-app never reaches -- so a ct prompt in the
  // list would only inflate the operator-facing count. Issue #160.
  const fetchImpl = (async (url: string) => {
    if (url.endsWith('/ct/cloudflare-ddns.sh')) {
      return new Response('var_cpu="${var_cpu:-1}"\nread -rp "Do you want to continue with the update? (y/N): " GO\n');
    }
    if (url.endsWith('/install/cloudflare-ddns-install.sh')) {
      return new Response('read -rp "${TAB3}Enter the Cloudflare API token: " tok\nread -rp "${TAB3}Proxied? (y/n): " ans\n');
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;

  const result = await checkAppUrl('cloudflare-ddns', fetchImpl);

  assert.equal(result.exists, true);
  assert.deepEqual(result.prompts, ['${TAB3}Enter the Cloudflare API token: ', '${TAB3}Proxied? (y/n): ']);
  assert.equal(result.defaults?.cores, 1);
});

test('checkAppUrl degrades to no prompts when the install script 404s, without affecting exists', async () => {
  // 14 of 597 ct scripts have no conventionally-named install script.
  const fetchImpl = (async (url: string) => {
    if (url.endsWith('/ct/dockge.sh')) return new Response('var_ram="${var_ram:-1024}"\n');
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;

  const result = await checkAppUrl('dockge', fetchImpl);

  assert.equal(result.exists, true);
  assert.deepEqual(result.prompts, []);
  assert.equal(result.defaults?.memory, 1024);
});

test('checkAppUrl fetches the install script from the dev repo when the ct script resolved there', async () => {
  const requested: string[] = [];
  const fetchImpl = (async (url: string) => {
    requested.push(url);
    if (url.includes('/ProxmoxVED/') && url.endsWith('/ct/budget-board.sh')) return new Response('var_cpu="${var_cpu:-2}"\n');
    if (url.includes('/ProxmoxVED/') && url.endsWith('/install/budget-board-install.sh')) {
      return new Response('read -rp "Enter the budget API key: " key\n');
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;

  const result = await checkAppUrl('budget-board', fetchImpl);

  assert.equal(result.dev, true);
  assert.deepEqual(result.prompts, ['Enter the budget API key: ']);
  assert.ok(
    requested.some((url) => url === 'https://raw.githubusercontent.com/community-scripts/ProxmoxVED/main/install/budget-board-install.sh'),
    'install script must be fetched from the same repo the ct script resolved in'
  );
});

test('checkAppUrl reports no prompts for a pasted full URL, which has no derivable install script', async () => {
  const fetchImpl = (async () => new Response('read -rp "Enter something: " x\n')) as unknown as typeof fetch;

  const result = await checkAppUrl('https://example.com/my-installer.sh', fetchImpl);

  assert.equal(result.exists, true);
  assert.deepEqual(result.prompts, []);
});

test('POST /api/provisioning/:id/preview 404s for an inherited prototype key like toString', async () => {
  const { app } = testApp(() => ({ stdout: '', stderr: '', code: 0 }));
  for (const action of ['preview', 'apply']) {
    const res = await request(app).post(`/api/provisioning/toString/${action}`).send({});
    assert.equal(res.status, 404, `${action} should 404`);
  }
});
