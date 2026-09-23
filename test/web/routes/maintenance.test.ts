import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { buildApp } from '../../../src/web/app.ts';
import { JobStore } from '../../../src/web/jobs/job-store.ts';
import { createJobLog } from '../../../src/web/jobs/job-log.ts';
import { JobRunner } from '../../../src/web/jobs/job-runner.ts';
import { FakeSSHClient } from '../../support/fake-ssh-client.ts';
import { FakeAuthentikClient } from '../../support/fake-authentik-client.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { saveInventory, type Inventory } from '../../../src/lib/inventory.ts';
import type { ImpersonationStore } from '../../../src/web/impersonation.ts';

const inventory: Inventory = {
  domain: 'example.com',
  dnsServer: '10.0.0.53',
  hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' } }],
  guests: [{ name: 'plex-lxc', type: 'lxc', vmid: 4003, host: 'pve1' }],
};

function seededInventoryPath(): string {
  const dest = path.join(mkdtempSync(path.join(tmpdir(), 'inventory-')), 'bellhop.db');
  saveInventory(dest, inventory);
  return dest;
}

function testApp(
  respond: (t: string, u: string, c: string) => { stdout: string; stderr: string; code: number },
  inventoryFile: string,
  impersonationStore: ImpersonationStore = new Map()
) {
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
  const ssh = new FakeSSHClient(respond);
  const jobRunner = new JobRunner(jobStore, jobLog, ssh);
  return {
    app: buildApp({
      inventory,
      baseSsh: ssh,
      jobStore,
      jobLog,
      jobRunner,
      inventoryPath: inventoryFile,
      authentik: new FakeAuthentikClient(),
      impersonationStore,
    }),
    jobStore,
  };
}

function asAdmin(req: request.Test): request.Test {
  return req.set('x-authentik-username', 'admin').set('x-authentik-groups', 'bellhop-admins');
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

test('GET /api/maintenance returns the 3 action definitions', async () => {
  const { app } = testApp(() => ({ stdout: '', stderr: '', code: 0 }), seededInventoryPath());
  const res = await request(app).get('/api/maintenance');
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 3);
});

test('POST /api/maintenance/audit-nfs-mounts/run reports directly, not as a job', async () => {
  const { app, jobStore } = testApp(() => ({ stdout: '', stderr: '', code: 0 }), seededInventoryPath());
  const res = await asAdmin(request(app).post('/api/maintenance/audit-nfs-mounts/run')).send({});
  assert.equal(res.status, 200);
  assert.match(res.body.report, /No NFS shares found/);
  assert.equal(jobStore.list().length, 0);
});

test('POST /api/maintenance/update-all/run enqueues a job', async () => {
  const { app, jobStore } = testApp(
    (_t, _u, cmd) => ({ stdout: cmd.includes('command -v apt-get') ? 'apt' : 'ok', stderr: '', code: 0 }),
    seededInventoryPath()
  );
  const res = await asAdmin(request(app).post('/api/maintenance/update-all/run')).send({ selector: { host: 'pve1' } });
  assert.equal(res.status, 200);
  await waitForFinished(jobStore, res.body.jobId);
  assert.equal(jobStore.get(res.body.jobId)?.status, 'success');
});

test('POST /api/maintenance/update-all/run marks the job failed when every target fails to connect', async () => {
  const { app, jobStore } = testApp(
    () => {
      throw new Error('connection refused');
    },
    seededInventoryPath()
  );
  const res = await asAdmin(request(app).post('/api/maintenance/update-all/run')).send({ selector: { host: 'pve1' } });
  assert.equal(res.status, 200);
  await waitForFinished(jobStore, res.body.jobId);
  assert.equal(jobStore.get(res.body.jobId)?.status, 'failed');
});

test('POST /api/maintenance/update-all/run marks the job failed when a target has no known package manager', async () => {
  const { app, jobStore } = testApp(() => ({ stdout: 'unknown', stderr: '', code: 0 }), seededInventoryPath());
  const res = await asAdmin(request(app).post('/api/maintenance/update-all/run')).send({ selector: { host: 'pve1' } });
  assert.equal(res.status, 200);
  await waitForFinished(jobStore, res.body.jobId);
  const job = jobStore.get(res.body.jobId);
  assert.equal(job?.status, 'failed');
  assert.match(job?.errorMessage ?? '', /unknown package manager: pve1/);
});

test('POST /api/maintenance/sync-caddy/preview returns the generated block without applying', async () => {
  const inventoryWithCaddy: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' }, caddy: true }],
    guests: [],
  };
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const jobRunner = new JobRunner(jobStore, jobLog, ssh);
  const inventoryPath = path.join(mkdtempSync(path.join(tmpdir(), 'inventory-')), 'bellhop.db');
  saveInventory(inventoryPath, inventoryWithCaddy);
  const app = buildApp({
    inventory: inventoryWithCaddy,
    baseSsh: ssh,
    jobStore,
    jobLog,
    jobRunner,
    inventoryPath,
    authentik: new FakeAuthentikClient(),
  });
  const res = await asAdmin(request(app).post('/api/maintenance/sync-caddy/preview')).send({});
  assert.equal(res.status, 200);
  assert.match(res.body.preview, /BEGIN bellhop-managed/);
});

test('POST /api/maintenance/guest-power enqueues a job that runs pct start on the parent host', async () => {
  const invPath = seededInventoryPath();
  const { app, jobStore } = testApp(() => ({ stdout: '', stderr: '', code: 0 }), invPath);
  const res = await request(app).post('/api/maintenance/guest-power').send({ guest: 'plex-lxc', state: 'start' });
  assert.equal(res.status, 200);
  await waitForFinished(jobStore, res.body.jobId);
  const job = jobStore.get(res.body.jobId);
  assert.equal(job?.status, 'success');
  assert.equal(job?.target, 'plex-lxc');
});

test('POST /api/maintenance/guest-power records the real admin identity even while impersonating', async () => {
  const invPath = seededInventoryPath();
  const impersonationStore: ImpersonationStore = new Map([['admin', 'bellhop-viewers']]);
  const { app, jobStore } = testApp(() => ({ stdout: '', stderr: '', code: 0 }), invPath, impersonationStore);
  const res = await asAdmin(request(app).post('/api/maintenance/guest-power')).send({ guest: 'plex-lxc', state: 'start' });
  assert.equal(res.status, 200);
  await waitForFinished(jobStore, res.body.jobId);
  const job = jobStore.get(res.body.jobId);
  assert.equal(job?.triggeredByUsername, 'admin');
  assert.equal(job?.triggeredByImpersonating, 'bellhop-viewers');
});

test('POST /api/maintenance/guest-power marks the job failed when the remote command exits non-zero', async () => {
  const invPath = seededInventoryPath();
  const { app, jobStore } = testApp(() => ({ stdout: '', stderr: 'CT is locked', code: 1 }), invPath);
  const res = await request(app).post('/api/maintenance/guest-power').send({ guest: 'plex-lxc', state: 'shutdown' });
  assert.equal(res.status, 200);
  await waitForFinished(jobStore, res.body.jobId);
  assert.equal(jobStore.get(res.body.jobId)?.status, 'failed');
});

// #16: guest-power's body is schema-parsed by the shared operation layer, so
// an unsupported state is rejected up front rather than enqueued as a job.
test('POST /api/maintenance/guest-power returns 400 for an unsupported state and enqueues no job', async () => {
  const { app, jobStore } = testApp(() => ({ stdout: '', stderr: '', code: 0 }), seededInventoryPath());
  const res = await request(app).post('/api/maintenance/guest-power').send({ guest: 'plex-lxc', state: 'reboot' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /state/);
  assert.equal(jobStore.list().length, 0);
});

test('POST /api/maintenance/sync-ssh-keys/preview returns a preview without applying', async () => {
  const { app } = testApp(() => ({ stdout: 'ssh-ed25519 AAAA user@host\n', stderr: '', code: 0 }), seededInventoryPath());
  const res = await asAdmin(request(app).post('/api/maintenance/sync-ssh-keys/preview')).send({ host: 'plex-lxc' });
  assert.equal(res.status, 200);
  assert.match(res.body.preview, /plex-lxc \(pve1\)/);
  assert.match(res.body.preview, /would be updated/);
});

test('POST /api/maintenance/sync-ssh-keys/apply enqueues a job and reports success', async () => {
  const { app, jobStore } = testApp(() => ({ stdout: 'ssh-ed25519 AAAA user@host\n', stderr: '', code: 0 }), seededInventoryPath());
  const res = await asAdmin(request(app).post('/api/maintenance/sync-ssh-keys/apply')).send({ host: 'plex-lxc' });
  assert.equal(res.status, 200);
  await waitForFinished(jobStore, res.body.jobId);
  assert.equal(jobStore.get(res.body.jobId)?.status, 'success');
});

test('POST /api/maintenance/sync-ssh-keys/apply omitting host targets every lxc guest and fails the job on any command failure', async () => {
  const { app, jobStore } = testApp((_t, _u, cmd) => {
    if (cmd === 'cat ~/.ssh/authorized_keys 2>/dev/null') return { stdout: 'ssh-ed25519 AAAA user@host\n', stderr: '', code: 0 };
    return { stdout: '', stderr: 'permission denied', code: 1 };
  }, seededInventoryPath());
  const res = await asAdmin(request(app).post('/api/maintenance/sync-ssh-keys/apply')).send({});
  assert.equal(res.status, 200);
  await waitForFinished(jobStore, res.body.jobId);
  assert.equal(jobStore.get(res.body.jobId)?.status, 'failed');
});

test('POST /api/maintenance/push-ssh-key/apply enqueues a job with no single target and reports success', async () => {
  const { app, jobStore } = testApp(() => ({ stdout: '', stderr: '', code: 0 }), seededInventoryPath());
  const res = await asAdmin(request(app).post('/api/maintenance/push-ssh-key/apply')).send({
    key: 'ssh-ed25519 AAAA test',
    guests: ['plex-lxc'],
  });
  assert.equal(res.status, 200);
  await waitForFinished(jobStore, res.body.jobId);
  const job = jobStore.get(res.body.jobId);
  assert.equal(job?.status, 'success');
  // No single resource target -- a comma-joined guest list would never
  // match a permission rule, so this is left null (fleet-wide/admin-only),
  // same as update-all/sync-inventory/sync-caddy. See isJobVisible.
  assert.equal(job?.target, null);
});

test('POST /api/maintenance/push-ssh-key/apply fails the job when a target guest is unreachable', async () => {
  const { app, jobStore } = testApp(() => {
    throw new Error('connection refused');
  }, seededInventoryPath());
  const res = await asAdmin(request(app).post('/api/maintenance/push-ssh-key/apply')).send({
    key: 'ssh-ed25519 AAAA test',
    guests: ['plex-lxc'],
  });
  assert.equal(res.status, 200);
  await waitForFinished(jobStore, res.body.jobId);
  const job = jobStore.get(res.body.jobId);
  assert.equal(job?.status, 'failed');
  assert.match(job?.errorMessage ?? '', /failed to connect: plex-lxc \(connection refused\)/);
});

test('POST /api/maintenance/set-guest-vpn enqueues a job targeting the guest and reports success', async () => {
  const invPath = seededInventoryPath();
  const { app, jobStore } = testApp((_t, _u, cmd) => {
    if (cmd === 'pct config 4003') {
      return { stdout: 'net0: name=eth0,bridge=vmbr0,gw=192.168.1.15,ip=192.168.1.3/16,type=veth', stderr: '', code: 0 };
    }
    return { stdout: '', stderr: '', code: 0 };
  }, invPath);
  const res = await request(app).post('/api/maintenance/set-guest-vpn').send({ guest: 'plex-lxc', vpn: 'none' });
  assert.equal(res.status, 200);
  await waitForFinished(jobStore, res.body.jobId);
  const job = jobStore.get(res.body.jobId);
  assert.equal(job?.status, 'success');
  assert.equal(job?.target, 'plex-lxc');
});

test('POST /api/maintenance/set-guest-vpn marks the job failed when the remote command exits non-zero', async () => {
  const invPath = seededInventoryPath();
  const { app, jobStore } = testApp(() => ({ stdout: '', stderr: 'CT is locked', code: 1 }), invPath);
  const res = await request(app).post('/api/maintenance/set-guest-vpn').send({ guest: 'plex-lxc', vpn: 'none' });
  assert.equal(res.status, 200);
  await waitForFinished(jobStore, res.body.jobId);
  assert.equal(jobStore.get(res.body.jobId)?.status, 'failed');
});

test('POST /api/maintenance/sync-inventory/apply updates the shared in-memory inventory so a later preview does not re-report the same guest as new', async () => {
  const inventoryWithNoGuests: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.3.1' } }],
    guests: [],
  };
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'joblog-')));
  const respond = (_t: string, _u: string, cmd: string) => {
    if (cmd === 'pvesh get /nodes/$(hostname)/network --output-format json') {
      return { stdout: '[]', stderr: '', code: 0 };
    }
    if (cmd === 'pvesh get /nodes/$(hostname)/storage --output-format json') {
      return { stdout: '[]', stderr: '', code: 0 };
    }
    if (cmd === "cat '/etc/fstab' 2>/dev/null") {
      return { stdout: '', stderr: '', code: 0 };
    }
    if (cmd === 'pvesh get /nodes/$(hostname)/lxc --output-format json') {
      return { stdout: '[{"vmid":4010,"name":"new-guest-lxc"}]', stderr: '', code: 0 };
    }
    if (cmd === 'pvesh get /nodes/$(hostname)/qemu --output-format json') {
      return { stdout: '[]', stderr: '', code: 0 };
    }
    if (cmd === 'pvesh get /nodes/$(hostname)/lxc/4010/config --output-format json') {
      return {
        stdout: '{"net0":"name=eth0,bridge=vmbr0,gw=192.168.1.15,ip=192.168.1.10/16,type=veth"}',
        stderr: '',
        code: 0,
      };
    }
    return { stdout: '', stderr: '', code: 0 };
  };
  const ssh = new FakeSSHClient(respond);
  const jobRunner = new JobRunner(jobStore, jobLog, ssh);
  const invPath = path.join(mkdtempSync(path.join(tmpdir(), 'inventory-')), 'bellhop.db');
  saveInventory(invPath, inventoryWithNoGuests);
  const app = buildApp({
    inventory: inventoryWithNoGuests,
    baseSsh: ssh,
    jobStore,
    jobLog,
    jobRunner,
    inventoryPath: invPath,
    authentik: new FakeAuthentikClient(),
  });

  const applyRes = await asAdmin(request(app).post('/api/maintenance/sync-inventory/apply')).send({});
  assert.equal(applyRes.status, 200);
  await waitForFinished(jobStore, applyRes.body.jobId);
  assert.equal(jobStore.get(applyRes.body.jobId)?.status, 'success');

  const previewRes = await asAdmin(request(app).post('/api/maintenance/sync-inventory/preview')).send({});
  assert.equal(previewRes.status, 200);
  assert.match(previewRes.body.preview, /New guests: 0/);
});

test('POST /api/maintenance/guest-power returns 403 for a restricted group targeting a blocked guest', async () => {
  const inventoryPath = seededInventoryPath();
  const { app } = testApp(() => ({ stdout: '[]', stderr: '', code: 0 }), inventoryPath);
  await asAdmin(request(app).put('/api/permissions/family')).send({
    mode: 'block-list',
    resources: [{ type: 'guest', name: 'plex-lxc' }],
  });

  const res = await request(app)
    .post('/api/maintenance/guest-power')
    .set('x-authentik-username', 'kid')
    .set('x-authentik-groups', 'family')
    .send({ guest: 'plex-lxc', state: 'stop' });
  assert.equal(res.status, 403);
});

test('POST /api/maintenance/set-guest-vpn returns 403 for a restricted group targeting a blocked guest', async () => {
  const inventoryPath = seededInventoryPath();
  const { app } = testApp(() => ({ stdout: '[]', stderr: '', code: 0 }), inventoryPath);
  await asAdmin(request(app).put('/api/permissions/family')).send({
    mode: 'block-list',
    resources: [{ type: 'guest', name: 'plex-lxc' }],
  });

  const res = await request(app)
    .post('/api/maintenance/set-guest-vpn')
    .set('x-authentik-username', 'kid')
    .set('x-authentik-groups', 'family')
    .send({ guest: 'plex-lxc', vpn: 'none' });
  assert.equal(res.status, 403);
});

test('POST /api/maintenance/update-all/run returns 403 for a non-admin', async () => {
  const inventoryPath = seededInventoryPath();
  const { app } = testApp(() => ({ stdout: '[]', stderr: '', code: 0 }), inventoryPath);

  const res = await request(app)
    .post('/api/maintenance/update-all/run')
    .set('x-authentik-username', 'kid')
    .set('x-authentik-groups', 'family')
    .send({ selector: { all: true } });
  assert.equal(res.status, 403);
});

test('POST /api/maintenance/audit-nfs-mounts/run returns 403 for a non-admin', async () => {
  const inventoryPath = seededInventoryPath();
  const { app } = testApp(() => ({ stdout: '[]', stderr: '', code: 0 }), inventoryPath);

  const res = await request(app)
    .post('/api/maintenance/audit-nfs-mounts/run')
    .set('x-authentik-username', 'kid')
    .set('x-authentik-groups', 'family')
    .send({});
  assert.equal(res.status, 403);
});

test('POST /api/maintenance/sync-inventory/apply returns 403 for a non-admin', async () => {
  const inventoryPath = seededInventoryPath();
  const { app } = testApp(() => ({ stdout: '[]', stderr: '', code: 0 }), inventoryPath);

  const res = await request(app)
    .post('/api/maintenance/sync-inventory/apply')
    .set('x-authentik-username', 'kid')
    .set('x-authentik-groups', 'family')
    .send({});
  assert.equal(res.status, 403);
});

test('POST /api/maintenance/update-app/preview returns 403 for a restricted group targeting a blocked guest', async () => {
  const inventoryPath = seededInventoryPath();
  const { app } = testApp(() => ({ stdout: '', stderr: '', code: 0 }), inventoryPath);
  await asAdmin(request(app).put('/api/permissions/family')).send({
    mode: 'block-list',
    resources: [{ type: 'guest', name: 'plex-lxc' }],
  });

  const res = await request(app)
    .post('/api/maintenance/update-app/preview')
    .set('x-authentik-username', 'kid')
    .set('x-authentik-groups', 'family')
    .send({ guest: 'plex-lxc' });
  assert.equal(res.status, 403);
});

test('POST /api/maintenance/update-all/run 400s on an invalid selector without enqueueing a job', async () => {
  const { app, jobStore } = testApp(() => ({ stdout: 'ok', stderr: '', code: 0 }), seededInventoryPath());
  const res = await asAdmin(request(app).post('/api/maintenance/update-all/run')).send({ selector: {} });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /exactly one/);
  assert.equal(jobStore.list().length, 0);
});
