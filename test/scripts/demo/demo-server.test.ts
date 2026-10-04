import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import path from 'node:path';
import { startDemoServer } from '../../../scripts/demo/demo-server.ts';
import { loadInventory, saveInventory } from '../../../src/lib/inventory.ts';

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
    assert.ok(
      provisioning.some((c: { id: string }) => c.id === 'install-app'),
      'expected the install-app provisioning command'
    );

    const apps = await get('/api/provisioning/install-app/apps');
    assert.ok(apps.stable.length > 0, 'expected a non-empty stable catalog group');
    assert.ok(apps.stable.includes('jellyfin'));

    const check = await get(`/api/provisioning/install-app/check-app?value=jellyfin`);
    assert.equal(check.exists, true, `check-app: ${JSON.stringify(check)}`);

    const jobs = await get('/api/jobs');
    // demo-jobs.ts's four, plus demo-tasks.ts's seeded check-app-updates run.
    assert.equal(jobs.length, 5);
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

    // Issue #61: the Tasks page's scheduler is wired (not started), and its
    // one task's last run points at demo-tasks.ts's seeded job.
    const tasks = await get('/api/tasks');
    assert.equal(tasks.tasks.length, 1);
    const checkAppUpdatesTask = tasks.tasks[0];
    assert.equal(checkAppUpdatesTask.id, 'check-app-updates');
    assert.ok(checkAppUpdatesTask.lastRun, 'expected a seeded last run');
    assert.equal(checkAppUpdatesTask.lastRun.status, 'success');
    const taskJob = jobs.find((j: { id: number }) => j.id === checkAppUpdatesTask.lastRun.jobId);
    assert.ok(taskJob, "expected the task's lastRun.jobId to be one of the seeded jobs");
    assert.equal(taskJob.command, 'check-app-updates');

    await get('/api/maintenance');
    const authGroups = await get('/api/auth-groups');
    assert.ok(Array.isArray(authGroups.rungs) && authGroups.rungs.length > 0, 'expected an auth-group ladder');
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

test('demo server never reaches the network through global fetch, even with a custom script repo set or a VPN gateway in inventory', async () => {
  // Every request not addressed to the demo itself is recorded and refused,
  // so a code path that falls back to global fetch (instead of the demo's
  // demoFetch) shows up here rather than as a real outbound call. Installed
  // before startDemoServer, so a default-parameter `= fetch` captures it too.
  const realFetch = globalThis.fetch;
  const outbound: string[] = [];
  let demoUrl = '';
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (demoUrl && url.startsWith(demoUrl)) return realFetch(input, init);
    outbound.push(url);
    throw new Error(`test: outbound request refused: ${url}`);
  }) as typeof fetch;

  const demo = await startDemoServer({ port: 0, serveClient: false });
  demoUrl = demo.url;
  try {
    const send = (p: string, method: string, body?: unknown) =>
      fetch(`${demo.url}${p}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    const saved = await send('/api/settings', 'PATCH', { customScriptsRepo: 'example/ProxmoxVED', customScriptsBranch: 'demo' });
    assert.equal(saved.status, 200, await saved.clone().text());

    const preview = await send('/api/maintenance/update-app/preview', 'POST', { guest: 'jellyfin', app: 'jellyfin' });
    const previewBody = await preview.json();
    assert.equal(preview.status, 400, JSON.stringify(previewBody));
    // demoFetch answers GitHub with a 404, so resolution fails naming the
    // configured repository -- not with the test stub's "refused" error.
    assert.match(previewBody.error, /example\/ProxmoxVED/);
    assert.doesNotMatch(previewBody.error, /outbound request refused/);

    // Networking routes proxy to http://<gateway-ip>:8080; mark one demo
    // guest as a gateway (inventory reloads from disk on every /api request).
    const inv = loadInventory(demo.inventoryPath);
    const gateway = inv.guests.find((g) => g.name === 'pihole');
    assert.ok(gateway);
    gateway.vpnGateway = 'nordvpn';
    saveInventory(demo.inventoryPath, inv);
    const status = await send('/api/networking/gateways/pihole/status', 'GET');
    const statusBody = await status.json();
    assert.doesNotMatch(statusBody.error ?? '', /outbound request refused/, JSON.stringify(statusBody));

    assert.deepEqual(outbound, [], `the demo reached the network through global fetch: ${outbound.join(', ')}`);
  } finally {
    await demo.close();
    globalThis.fetch = realFetch;
  }
});
