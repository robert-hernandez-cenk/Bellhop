import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import path from 'node:path';
import { startDemoServer } from '../../../scripts/demo/demo-server.ts';
import { DEMO_CATALOG_SLUGS } from '../../../scripts/demo/demo-fetch.ts';

// startDemoServer mutates process.env (WEB_UI_AUTH_MODE, INVENTORY_FILE,
// WEB_DATA_DIR, and deletes WEB_UI_DEV_USER -- which `npm test` itself sets --
// plus every AUTHENTIK_* variable). node --test runs each test file in its
// own process, so that never leaks into another file's tests.

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(realpathSync(parent), realpathSync(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

test('demo server answers every screenshotted page request as a signed-in admin, entirely from its temp dir', async () => {
  // A stray Authentik credential in the developer's environment must be ignored.
  process.env.AUTHENTIK_API_URL = 'https://auth.example.invalid';
  process.env.AUTHENTIK_API_TOKEN = 'not-a-real-token';

  const demo = await startDemoServer({ port: 0, serveClient: false });
  let closed = false;
  try {
    assert.ok(demo.port > 0);
    // Loopback only: every request is served as an admin, so nothing off
    // this machine may reach it (and no firewall prompt on Windows).
    assert.equal(demo.url, `http://127.0.0.1:${demo.port}`);
    // Actually bound to loopback, not just advertised as it: this machine's
    // own non-loopback IPv4 address (if it has one) must not answer.
    const lanAddress = Object.values(networkInterfaces())
      .flat()
      .find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
    if (lanAddress) {
      await assert.rejects(fetch(`http://${lanAddress}:${demo.port}/api/whoami`, { signal: AbortSignal.timeout(3000) }));
    }
    assert.ok(isInside(demo.dir, tmpdir()), `demo dir ${demo.dir} is not inside ${tmpdir()}`);
    assert.ok(isInside(demo.inventoryPath, demo.dir), 'inventory path must be inside the demo dir');
    assert.equal(process.env.INVENTORY_FILE, demo.inventoryPath);
    assert.ok(process.env.WEB_DATA_DIR && isInside(process.env.WEB_DATA_DIR, tmpdir()), 'WEB_DATA_DIR must be inside the temp dir');
    assert.equal(process.env.AUTHENTIK_API_URL, undefined);
    assert.equal(process.env.WEB_UI_DEV_USER, undefined);

    // No identity headers of our own -- the demo supplies them.
    const get = async (p: string) => {
      const res = await fetch(`${demo.url}${p}`);
      assert.equal(res.status, 200, `${p} returned ${res.status}: ${await res.clone().text()}`);
      return res.json();
    };

    const whoami = await get('/api/whoami');
    assert.equal(whoami.username, 'admin');
    assert.equal(whoami.email, 'admin@example.com');
    assert.equal(whoami.isAdmin, true);
    assert.equal(whoami.localOperator, false);
    assert.equal(whoami.capabilities.userDirectory, false);

    const inventory = await get('/api/inventory');
    assert.deepEqual(inventory.hosts.map((h: { name: string }) => h.name).sort(), ['pve1', 'pve2']);
    assert.ok(inventory.guests.some((g: { name: string }) => g.name === 'jellyfin'));
    assert.ok(inventory.guests.length >= 8);

    const status = await get('/api/guests/status');
    const states = new Set(Object.values(status.statuses));
    assert.ok(states.has('running'), 'expected some running guests');
    assert.ok(states.has('stopped'), 'expected some stopped guests');
    assert.deepEqual(status.failures, []);

    const provisioning = await get('/api/provisioning');
    assert.ok(Object.keys(provisioning).length > 0 || provisioning.length > 0);

    const apps = await get('/api/provisioning/install-app/apps');
    assert.ok(apps.stable.length > 0, 'expected a non-empty stable catalog group');
    assert.ok(apps.stable.includes('jellyfin'));

    const check = await get(`/api/provisioning/install-app/check-app?value=${DEMO_CATALOG_SLUGS.stable[2]}`);
    assert.equal(check.exists, true, `check-app: ${JSON.stringify(check)}`);

    const jobs = await get('/api/jobs');
    assert.equal(jobs.length, 4);
    assert.equal(jobs.filter((j: { status: string }) => j.status === 'failed').length, 1);
    const installJob = jobs.find((j: { command: string }) => j.command === 'install-app');
    assert.ok(installJob, 'expected the seeded install-app job');
    assert.equal(installJob.target, 'pve1');
    // Fixed timestamps (the jobs table has no created_at column).
    assert.equal(installJob.startedAt, '2026-09-14T09:05:00.000Z');
    assert.equal(installJob.finishedAt, '2026-09-14T09:08:32.000Z');
    for (const job of jobs) assert.match(job.startedAt, /^2026-09-14T/);

    const jobDetail = await get(`/api/jobs/${installJob.id}`);
    assert.ok(jobDetail.log.includes('install-app completed successfully.'));

    await get('/api/maintenance');
    const settings = await get('/api/settings');
    assert.equal(settings.settings.dnsServer, '198.51.100.53');
    assert.ok(settings.proxyDrivers.length > 0);

    const dir = demo.dir;
    await demo.close();
    closed = true;
    assert.equal(existsSync(dir), false, 'the temp dir must be removed after close()');
  } finally {
    if (!closed) await demo.close();
  }
});
