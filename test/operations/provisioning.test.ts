import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PROVISIONING_OPERATIONS } from '../../src/operations/provisioning.ts';
import { MAINTENANCE_OPERATIONS } from '../../src/operations/maintenance.ts';
import { UPSTREAM_STABLE_BASE, type AppSource } from '../../src/lib/app-source.ts';
import { UnknownPackageManagerError } from '../../src/lib/package-manager.ts';
import { PROVISIONING_COMMANDS } from '../../src/web/commands-meta.ts';
import { parseOperationInput, previewAndEnqueue } from '../../src/operations/core.ts';
import { FakeSSHClient, defaultResponder } from '../support/fake-ssh-client.ts';
import { UnconfiguredCloudflareClient } from '../../src/lib/cloudflare-client.ts';
import { FakeAuthentikClient } from '../support/fake-authentik-client.ts';
import { loadInventory, saveInventory, type Inventory } from '../../src/lib/inventory.ts';
import type { OperationDeps } from '../../src/operations/types.ts';
import { withCapturedConsole } from '../../src/web/console-capture.ts';
import { JobStore } from '../../src/web/jobs/job-store.ts';
import { createJobLog } from '../../src/web/jobs/job-log.ts';
import { JobRunner } from '../../src/web/jobs/job-runner.ts';

const inventory: Inventory = {
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
  guests: [
    { name: 'caddy-lxc', type: 'lxc', vmid: 4002, host: 'pve1', ip: '192.168.1.2', caddy: true },
    { name: 'media', type: 'lxc', vmid: 4003, host: 'pve1' },
  ],
};

function deps(): OperationDeps {
  const inventoryPath = path.join(mkdtempSync(path.join(tmpdir(), 'opprov-')), 'bellhop.db');
  saveInventory(inventoryPath, inventory);
  return {
    ssh: new FakeSSHClient(defaultResponder),
    inventory: structuredClone(inventory),
    inventoryPath,
    authentik: new FakeAuthentikClient(), cloudflare: new UnconfiguredCloudflareClient(),
  };
}

test('every web form field for a provisioning command is part of its operation shape', () => {
  for (const cmd of PROVISIONING_COMMANDS) {
    const op = PROVISIONING_OPERATIONS[cmd.id];
    assert.ok(op, `no operation for ${cmd.id}`);
    for (const field of cmd.fields) {
      assert.ok(field.name in op.shape, `${cmd.id}: form field '${field.name}' missing from operation shape`);
    }
  }
});

test('secretFields match the web form fields declared kind secret', () => {
  for (const cmd of PROVISIONING_COMMANDS) {
    const secrets = cmd.fields.filter((f) => f.kind === 'secret').map((f) => f.name).sort();
    assert.deepEqual([...(PROVISIONING_OPERATIONS[cmd.id].secretFields ?? [])].sort(), secrets, cmd.id);
  }
});

test('create-lxc apply records the new guest in inventory', async () => {
  const d = deps();
  const op = PROVISIONING_OPERATIONS['create-lxc'];
  const input = parseOperationInput(op, { host: 'pve1', mid: 5, hostname: 'new-lxc', template: 'debian-12' });
  await op.apply(input, d);
  const saved = loadInventory(d.inventoryPath).guests.find((g) => g.name === 'new-lxc');
  assert.equal(saved?.vmid, 4005);
  assert.equal(saved?.ip, '192.168.1.5');
  assert.ok(d.inventory.guests.some((g) => g.name === 'new-lxc'));
});

// #16: a job can apply long after the in-memory inventory was last loaded
// (queued behind another job, or a minutes-long install). An edit written to
// disk meanwhile must survive the apply's own saveInventory.
test('create-lxc apply does not clobber inventory edits made after deps.inventory was loaded', async () => {
  const d = deps();
  saveInventory(d.inventoryPath, { ...structuredClone(inventory), dnsServer: '192.168.3.53' });
  const op = PROVISIONING_OPERATIONS['create-lxc'];
  // Captured only to keep the create-lxc apply's own log lines out of test output.
  await withCapturedConsole(() =>
    op.apply(parseOperationInput(op, { host: 'pve1', mid: 5, hostname: 'new-lxc', template: 'debian-12' }), d)
  );
  const saved = loadInventory(d.inventoryPath);
  assert.equal(saved.dnsServer, '192.168.3.53');
  assert.ok(saved.guests.some((g) => g.name === 'new-lxc'));
});

test('delete-guest apply refuses the caddy guest', async () => {
  const d = deps();
  const op = PROVISIONING_OPERATIONS['delete-guest'];
  await assert.rejects(op.apply(parseOperationInput(op, { guest: 'caddy-lxc' }), d), /caddy: true/);
});

test('install-app is the only provisioning operation that watches for prompts', () => {
  const watching = Object.values(PROVISIONING_OPERATIONS).filter((op) => op.watchForPrompts).map((op) => op.id);
  assert.deepEqual(watching, ['install-app']);
});

// Final fix wave F4: nothing previously exercised
// PROVISIONING_OPERATIONS['configure-guest'] (FR-009 -- the web UI/MCP
// operation must pick up issue #2's package-manager detection with no
// interface change of its own). These run the real operation's preview
// through a custom FakeSSHClient responder, the same pattern the
// install-app/update-app tests above use for their own custom ssh.
test("configure-guest operation preview resolves a live probe result into the manager-specific install command", async () => {
  const d = deps();
  d.ssh = new FakeSSHClient((_target, _user, cmd) => {
    if (cmd.includes('command -v apt-get')) return { stdout: 'apk\n', stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  });
  const op = PROVISIONING_OPERATIONS['configure-guest'];
  const preview = await op.preview(parseOperationInput(op, { guest: 'media', packages: 'curl' }), d);
  assert.match(preview, /Would install on media \(apk\): apk update && apk add 'curl'/);
});

test('configure-guest operation preview rejects with UnknownPackageManagerError on an unrecognized OS', async () => {
  const d = deps();
  d.ssh = new FakeSSHClient(() => ({ stdout: 'unknown\n', stderr: '', code: 0 }));
  const op = PROVISIONING_OPERATIONS['configure-guest'];
  await assert.rejects(
    () => op.preview(parseOperationInput(op, { guest: 'media', packages: 'curl' }), d),
    (err: unknown) => err instanceof UnknownPackageManagerError
  );
});

// --- custom script repository (issue #11), real install-app wiring ---
// Fix round 1: T010's original coverage used a stand-in demo operation
// (test/operations/core.test.ts), which never exercised
// PROVISIONING_OPERATIONS['install-app']'s own resolvesApp: true and
// `source: i.appSource` plumbing (src/operations/provisioning.ts). This runs
// previewAndEnqueue against the real operation, a real FakeSSHClient, and a
// real JobRunner, the same way the web/MCP front ends do.
// Example values only (constitution Principle I) -- example-user/ProxmoxVED
// on branch my-apps is the same example the spec/plan/data-model/
// test/lib/app-source.test.ts use.

const fixtureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'github');
const HEAD_SHA_RAW = readFileSync(path.join(fixtureDir, 'branch-head-sha.txt'), 'utf8');
const SHA = HEAD_SHA_RAW.trim();
const CUSTOM_OWNER = 'example-user';
const CUSTOM_REPO = 'ProxmoxVED';
const CUSTOM_BRANCH = 'my-apps';
const HEAD_SHA_URL = `https://api.github.com/repos/${CUSTOM_OWNER}/${CUSTOM_REPO}/commits/${CUSTOM_BRANCH}`;
const customCtUrl = (slug: string) => `https://raw.githubusercontent.com/${CUSTOM_OWNER}/${CUSTOM_REPO}/${SHA}/ct/${slug}.sh`;
const customScriptsBaseUrl = `https://raw.githubusercontent.com/${CUSTOM_OWNER}/${CUSTOM_REPO}/${SHA}`;
const customInstallUrl = (slug: string) => `${customScriptsBaseUrl}/install/${slug}-install.sh`;
// issue #15: every custom-configured resolution also compares the pinned
// commit against upstream ProxmoxVED main; the captured ahead fixture
// changes demo-shop (among others), so demo-shop resolves to the fork.
const COMPARE_URL = `https://api.github.com/repos/community-scripts/ProxmoxVED/compare/main...${CUSTOM_OWNER}:${CUSTOM_REPO}:${SHA}`;
const COMPARE_AHEAD_BODY = readFileSync(path.join(fixtureDir, 'compare-ahead-3-apps.json'), 'utf8');
const MERGE_BASE = (JSON.parse(COMPARE_AHEAD_BODY) as { merge_base_commit: { sha: string } }).merge_base_commit.sha;

function waitForJobFinished(store: JobStore, id: number): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      const status = store.get(id)?.status;
      if (status && status !== 'queued' && status !== 'running') resolve();
      else setTimeout(check, 10);
    };
    check();
  });
}

test("previewAndEnqueue on the real install-app operation pins one custom-repository resolution across preview and the job's apply, and the applied script exports COMMUNITY_SCRIPTS_URL at the pinned commit", async () => {
  const customInventory: Inventory = {
    ...inventory,
    customScriptsRepo: `${CUSTOM_OWNER}/${CUSTOM_REPO}`,
    customScriptsBranch: CUSTOM_BRANCH,
  };
  const inventoryPath = path.join(mkdtempSync(path.join(tmpdir(), 'opprov-install-')), 'bellhop.db');
  saveInventory(inventoryPath, customInventory);

  const ssh = new FakeSSHClient(defaultResponder);
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'opprov-install-log-')));
  const jobRunner = new JobRunner(jobStore, jobLog, ssh, { owner: 'test' });

  let headShaCalls = 0;
  const fetchImpl = (async (url: unknown) => {
    const href = String(url);
    if (href === HEAD_SHA_URL) {
      headShaCalls++;
      return new Response(HEAD_SHA_RAW, { status: 200 });
    }
    if (href === COMPARE_URL) return new Response(COMPARE_AHEAD_BODY, { status: 200 });
    if (href === customInstallUrl('demo-shop')) return new Response('no prompts here\n', { status: 200 });
    // T016 (US2): the ProxmoxVE shadow probe hits, so the resolved source
    // shadows an upstream copy and the R7 override notice is emitted --
    // the ProxmoxVED shadow probe still "not present" (falls through below).
    if (href === `${UPSTREAM_STABLE_BASE}/ct/demo-shop.sh`) return new Response('#!/usr/bin/env bash\n', { status: 200 });
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;

  const d: OperationDeps = {
    ssh,
    inventory: structuredClone(customInventory),
    inventoryPath,
    authentik: new FakeAuthentikClient(),
    cloudflare: new UnconfiguredCloudflareClient(),
    fetchImpl,
  };

  const op = PROVISIONING_OPERATIONS['install-app'];
  const { jobId, preview } = await previewAndEnqueue(
    op,
    { app: 'demo-shop', host: 'pve1', mid: 5, hostname: 'demo-shop-lxc' },
    d,
    jobRunner,
    {}
  );
  assert.equal(headShaCalls, 1, 'resolveHeadSha should run exactly once, during preview');

  // T016 (US2): the R7 override notice is logged before anything else
  // runInstallApp prints during preview, so it must lead the preview text
  // previewAndEnqueue returns -- which is also what enqueue() logs first
  // into the job log under its own "----- dry-run preview -----" header.
  assert.match(
    preview,
    /^\[INFO\s+\S+ \S+\] "demo-shop" comes from the custom script repository example-user\/ProxmoxVED@my-apps \(commit [0-9a-f]{7}\) in place of the upstream copy in ProxmoxVE\./
  );

  await waitForJobFinished(jobStore, jobId);
  assert.equal(jobStore.get(jobId)!.status, 'success');
  assert.equal(
    headShaCalls,
    1,
    "apply must not re-resolve -- it reuses the source previewAndEnqueue already pinned onto input.appSource"
  );

  const installCall = ssh.history.find((c) => c.command.includes('COMMUNITY_SCRIPTS_URL'));
  assert.ok(installCall, 'the applied install-app exec should be recorded on the FakeSSHClient');
  assert.ok(
    installCall!.command.includes(`export COMMUNITY_SCRIPTS_URL='${customScriptsBaseUrl}'`),
    `expected COMMUNITY_SCRIPTS_URL at the pinned SHA in: ${installCall!.command}`
  );
});

// Final fix wave item 4: the same pin-once guarantee, but for the real
// MAINTENANCE_OPERATIONS['update-app'] -- mirrors the install-app test
// above, except the applied command reaches a *guest* (runRemote's lxc
// branch), so it's wrapped `pct exec <vmid> -- sh -c <shellQuote(...)>`
// rather than sent directly to a pve host. Asserts the wrapped/re-quoted
// command still contains the pinned COMMUNITY_SCRIPTS_URL base.
test("previewAndEnqueue on the real update-app operation pins one custom-repository resolution across preview and the job's apply, and the applied (sh -c-wrapped) exec contains the pinned COMMUNITY_SCRIPTS_URL base", async () => {
  const customInventory: Inventory = {
    ...inventory,
    customScriptsRepo: `${CUSTOM_OWNER}/${CUSTOM_REPO}`,
    customScriptsBranch: CUSTOM_BRANCH,
  };
  const inventoryPath = path.join(mkdtempSync(path.join(tmpdir(), 'opprov-update-')), 'bellhop.db');
  saveInventory(inventoryPath, customInventory);

  const ssh = new FakeSSHClient(defaultResponder);
  const jobStore = new JobStore(':memory:');
  const jobLog = createJobLog(mkdtempSync(path.join(tmpdir(), 'opprov-update-log-')));
  const jobRunner = new JobRunner(jobStore, jobLog, ssh, { owner: 'test' });

  let headShaCalls = 0;
  const fetchImpl = (async (url: unknown) => {
    const href = String(url);
    if (href === HEAD_SHA_URL) {
      headShaCalls++;
      return new Response(HEAD_SHA_RAW, { status: 200 });
    }
    if (href === COMPARE_URL) return new Response(COMPARE_AHEAD_BODY, { status: 200 });
    if (href === customInstallUrl('demo-shop')) return new Response('no prompts here\n', { status: 200 });
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;

  const d: OperationDeps = {
    ssh,
    inventory: structuredClone(customInventory),
    inventoryPath,
    authentik: new FakeAuthentikClient(),
    cloudflare: new UnconfiguredCloudflareClient(),
    fetchImpl,
  };

  const op = MAINTENANCE_OPERATIONS['update-app'];
  const { jobId } = await previewAndEnqueue(op, { guest: 'caddy-lxc', app: 'demo-shop' }, d, jobRunner, {});
  assert.equal(headShaCalls, 1, 'resolveHeadSha should run exactly once, during preview');

  await waitForJobFinished(jobStore, jobId);
  assert.equal(jobStore.get(jobId)!.status, 'success');
  assert.equal(
    headShaCalls,
    1,
    "apply must not re-resolve -- it reuses the source previewAndEnqueue already pinned onto input.appSource"
  );

  const updateCall = ssh.history.find((c) => c.command.includes('COMMUNITY_SCRIPTS_URL'));
  assert.ok(updateCall, 'the applied update-app exec should be recorded on the FakeSSHClient');
  // runRemote's lxc branch wraps/re-quotes the whole script as one `sh -c`
  // argument (see src/lib/targets.ts's shellQuote, which escapes every `'`
  // in the inner script as `'\''`) rather than sending it verbatim -- so the
  // pinned base URL itself (which contains no quote characters) is still a
  // verbatim substring of the wrapped command, just no longer immediately
  // preceded by a literal `='`.
  assert.ok(
    updateCall!.command.startsWith(`pct exec 4002 -- sh -c `),
    `expected the update-app exec to be pct exec/sh -c-wrapped, got: ${updateCall!.command}`
  );
  assert.ok(
    updateCall!.command.includes(customScriptsBaseUrl),
    `expected the pinned COMMUNITY_SCRIPTS_URL base in the wrapped/re-quoted command: ${updateCall!.command}`
  );
});

// T025/T027, amended by the final fix wave item 2: install-app's apply
// passes appSource: 'custom' into recordProvisionedGuest only when the
// pinned resolution was actually 'custom' (never for 'upstream'/'url'). Once
// entry.app is set (a resolvable slug -- from either a custom or an upstream
// resolution), appSource must be authoritative: an upstream reinstall for
// the same host+vmid must clear a stale 'custom' rather than silently
// leaving it in place, the same way any other field that's actually
// re-resolved on every apply would. appSource is set directly on the parsed
// input here (mirroring what previewAndEnqueue's own pin-once step does,
// covered end-to-end by the test above) so this test can focus purely on
// op.apply's own upsert logic.
test("install-app apply records appSource: 'custom' on the guest, and a repeat upstream apply for the same host+vmid clears it", async () => {
  const d = deps();
  const op = PROVISIONING_OPERATIONS['install-app'];

  const customSource: AppSource = {
    kind: 'custom',
    slug: 'demo-shop',
    custom: { owner: CUSTOM_OWNER, repo: CUSTOM_REPO, branch: CUSTOM_BRANCH, label: `${CUSTOM_OWNER}/${CUSTOM_REPO}@${CUSTOM_BRANCH}`, sha: SHA, mergeBase: MERGE_BASE },
    changed: true,
    conflict: false,
    ctUrl: customCtUrl('demo-shop'),
    scriptsBaseUrl: customScriptsBaseUrl,
    shadows: [],
  };
  const firstInput = parseOperationInput(op, { app: 'demo-shop', host: 'pve1', mid: 5, hostname: 'demo-shop-lxc' }) as Record<string, any>;
  firstInput.appSource = customSource;
  await withCapturedConsole(() => op.apply(firstInput, d));

  const afterFirst = loadInventory(d.inventoryPath).guests.find((g) => g.host === 'pve1' && g.vmid === 4005);
  assert.equal(afterFirst?.appSource, 'custom');

  const upstreamSource: AppSource = { kind: 'upstream', slug: 'demo-shop', shadows: [] };
  const secondInput = parseOperationInput(op, { app: 'demo-shop', host: 'pve1', mid: 5, hostname: 'demo-shop-lxc' }) as Record<string, any>;
  secondInput.appSource = upstreamSource;
  await withCapturedConsole(() => op.apply(secondInput, d));

  const afterSecond = loadInventory(d.inventoryPath).guests.find((g) => g.host === 'pve1' && g.vmid === 4005);
  assert.equal(
    afterSecond?.appSource,
    undefined,
    'a repeat upstream reinstall must clear a stale custom provenance, since appSource is authoritative whenever entry.app (a resolved slug) is set'
  );
});

// The other half of item 2: entry.app is undefined only when the operator
// pasted a full script URL (appSlugFor returns undefined for a URL) --
// resolveAppSource never resolves a URL against the custom repository
// either (kind 'url', appSource undefined), so there is no fresh signal to
// trust. That case must keep carrying the existing recorded provenance
// forward, exactly like it already does for `app` itself.
test('install-app apply preserves a previously-recorded appSource across a repeat apply with a pasted URL (entry.app undefined)', async () => {
  const d = deps();
  const op = PROVISIONING_OPERATIONS['install-app'];

  const customSource: AppSource = {
    kind: 'custom',
    slug: 'demo-shop',
    custom: { owner: CUSTOM_OWNER, repo: CUSTOM_REPO, branch: CUSTOM_BRANCH, label: `${CUSTOM_OWNER}/${CUSTOM_REPO}@${CUSTOM_BRANCH}`, sha: SHA, mergeBase: MERGE_BASE },
    changed: true,
    conflict: false,
    ctUrl: customCtUrl('demo-shop'),
    scriptsBaseUrl: customScriptsBaseUrl,
    shadows: [],
  };
  const firstInput = parseOperationInput(op, { app: 'demo-shop', host: 'pve1', mid: 5, hostname: 'demo-shop-lxc' }) as Record<string, any>;
  firstInput.appSource = customSource;
  await withCapturedConsole(() => op.apply(firstInput, d));

  const urlSource: AppSource = { kind: 'url', shadows: [] };
  const secondInput = parseOperationInput(op, {
    app: 'https://example.com/myapp-install.sh',
    host: 'pve1',
    mid: 5,
    hostname: 'demo-shop-lxc',
  }) as Record<string, any>;
  secondInput.appSource = urlSource;
  await withCapturedConsole(() => op.apply(secondInput, d));

  const afterSecond = loadInventory(d.inventoryPath).guests.find((g) => g.host === 'pve1' && g.vmid === 4005);
  assert.equal(
    afterSecond?.appSource,
    'custom',
    'a repeat apply from a pasted URL (no resolvable slug) must carry the existing provenance forward, same as app'
  );
});
