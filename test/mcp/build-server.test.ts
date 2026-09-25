import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { HangingSSHClient } from '../support/hanging-ssh-client.ts';
import { loadInventory, type Inventory } from '../../src/lib/inventory.ts';
import { FakeAuthentikClient } from '../support/fake-authentik-client.ts';
import { setupMcp as setup, waitForFinished, parse, MCP_TEST_INVENTORY } from '../support/mcp-harness.ts';

// Mirrors sync-authentik.test.ts's/oidc-credentials.test.ts's own OIDC
// fixture shape -- an OIDC-gated 'media' guest and a matching owned OpenID
// client for issue #1's get_oidc_client tool.
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

test('tool list covers the registry, read-only, and job tools, and nothing excluded', async () => {
  const { client } = await setup();
  const names = (await client.listTools()).tools.map((t) => t.name);
  for (const expected of [
    'create_lxc', 'install_app', 'delete_guest', 'update_all', 'guest_power', 'set_config', 'sync_authentik',
    'adopt_oidc_client',
    'edit_guest', 'get_inventory', 'get_guest_status', 'audit_nfs_mounts', 'list_install_apps', 'check_install_app',
    'list_jobs', 'get_job', 'wait_for_job', 'answer_job_prompt', 'dismiss_job_prompt', 'cancel_job',
  ]) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }
  assert.ok(!names.includes('migrate_nfs_mount'));
  assert.ok(!names.some((n) => /user|group|permission|imperson|import_yaml/.test(n)));
});

test('operation tool schemas mark required fields and default apply to false', async () => {
  const { client } = await setup();
  const tool = (await client.listTools()).tools.find((t) => t.name === 'create_lxc')!;
  const schema = tool.inputSchema as { required?: string[]; properties: Record<string, any> };
  assert.deepEqual([...(schema.required ?? [])].sort(), ['host', 'hostname', 'mid', 'template']);
  assert.equal(schema.properties.apply.default, false);
});

test('an operation tool without apply returns a preview and changes nothing', async () => {
  const { call, ssh, jobStore } = await setup();
  const result = await call('create_lxc', { host: 'pve1', mid: 5, hostname: 'new-lxc', template: 'debian-12' });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /4005/);
  assert.ok(!ssh.history.some((c) => c.command.includes('pct create')));
  assert.equal(jobStore.list().length, 0);
});

test('apply: true enqueues a job that get_job reports through to success with paged log output', async () => {
  const { call, jobStore, inventoryPath } = await setup();
  const started = JSON.parse(
    (await call('create_lxc', { host: 'pve1', mid: 5, hostname: 'new-lxc', template: 'debian-12', apply: true })).content[0].text
  );
  assert.equal(typeof started.jobId, 'number');
  await waitForFinished(jobStore, started.jobId);

  const job = JSON.parse((await call('get_job', { id: started.jobId })).content[0].text);
  assert.equal(job.job.status, 'success');
  assert.equal(job.job.owner, 'mcp:test');
  assert.match(job.log, /dry-run preview/);
  const again = JSON.parse((await call('get_job', { id: started.jobId, logOffset: job.nextOffset })).content[0].text);
  assert.equal(again.log, '');
  assert.ok(loadInventory(inventoryPath).guests.some((g) => g.name === 'new-lxc'));
});

// #16: get_job caps each log chunk so a long install log can't flood the
// client in one result; the client pages with nextOffset while hasMore.
test('get_job pages a log longer than the chunk cap', async () => {
  const { call, jobStore, jobLog } = await setup();
  const id = jobStore.createJob({ command: 'install-app', category: 'provisioning', argsJson: '{}', owner: 'mcp:test' });
  const full = Array.from({ length: 45_000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');
  jobLog.append(jobStore.get(id)!.logFile, full);

  let offset = 0;
  let collected = '';
  const chunkLengths: number[] = [];
  for (let page = 0; page < 10; page++) {
    const res = JSON.parse((await call('get_job', { id, logOffset: offset })).content[0].text);
    chunkLengths.push(res.log.length);
    collected += res.log;
    assert.equal(res.nextOffset, offset + res.log.length);
    offset = res.nextOffset;
    if (!res.hasMore) break;
  }
  assert.deepEqual(chunkLengths, [20_000, 20_000, 5_000]);
  assert.equal(collected, full);
  const tail = JSON.parse((await call('get_job', { id, logOffset: offset })).content[0].text);
  assert.equal(tail.log, '');
  assert.equal(tail.hasMore, false);
});

test('schema and preview failures come back as isError results', async () => {
  const { call } = await setup();
  const badInput = await call('create_lxc', { host: 'pve1', mid: 'x', hostname: 'h', template: 't' });
  assert.equal(badInput.isError, true);
  const badPreview = await call('create_lxc', { host: 'nope', mid: 5, hostname: 'h', template: 't' });
  assert.equal(badPreview.isError, true);
  assert.match(badPreview.content[0].text, /nope/);
});

test('a detected prompt shows in get_job and answer_job_prompt resumes the job', async () => {
  const hanging = new HangingSSHClient();
  let fireCheck: (() => void) | undefined;
  const { call, jobStore, jobRunner } = await setup({
    jobSsh: hanging,
    runnerOptions: { promptScheduleCheck: (fn) => { fireCheck = fn; return { cancel: () => { fireCheck = undefined; } }; } },
  });
  const id = jobRunner.enqueue({
    command: 'install-app',
    category: 'provisioning',
    argsJson: '{}',
    watchForPrompts: true,
    expectedPrompts: ['Add Adminer?'],
    run: async (jobSsh) => {
      await jobSsh.exec({ host: 'pve1.local', user: 'root' }, 'bash install.sh');
    },
  });
  await new Promise((r) => setTimeout(r, 10));
  fireCheck?.();

  const waiting = JSON.parse((await call('get_job', { id })).content[0].text);
  assert.equal(waiting.job.status, 'awaiting_input');
  assert.equal(waiting.prompt.text, 'Add Adminer? (y/N) ');

  await call('answer_job_prompt', { id, text: 'y' });
  assert.deepEqual(hanging.writes, ['y\n']);
  hanging.finish({ stdout: 'done', stderr: '', code: 0 });
  await waitForFinished(jobStore, id);
  assert.equal(jobStore.get(id)?.status, 'success');
});

test('job control on another process\'s job is refused with the owner named', async () => {
  const { call, jobStore } = await setup();
  const id = jobStore.createJob({ command: 'sync-caddy', category: 'maintenance', argsJson: '{}', owner: 'web' });
  jobStore.markRunning(id);
  const result = await call('cancel_job', { id });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /owned by web/);
});

test('edit_guest writes inventory and reports the caddy sync outcome', async () => {
  const { call, inventoryPath } = await setup();
  const result = JSON.parse((await call('edit_guest', { name: 'app-lxc', subdomains: ['app'], port: 8080 })).content[0].text);
  assert.equal(result.caddySynced, true);
  assert.deepEqual(loadInventory(inventoryPath).guests.find((g) => g.name === 'app-lxc')?.subdomains, ['app']);
});

test('secret field values never appear in a tool result', async () => {
  const { call } = await setup();
  const result = await call('deploy_vpn_gateway', {
    vpn: 'nordvpn', host: 'pve1', mid: 9, name: 'nordvpn-test-gw-lxc', accessToken: 'SUPERSECRET',
  });
  assert.ok(!result.content.map((c) => c.text).join('\n').includes('SUPERSECRET'));
});

test("deploy_vpn_gateway's tool schema hides the internal test-speed knobs", async () => {
  const { client } = await setup();
  const tool = (await client.listTools()).tools.find((t) => t.name === 'deploy_vpn_gateway')!;
  const schema = tool.inputSchema as { properties: Record<string, any> };
  assert.ok(!('connectPollAttempts' in schema.properties));
  assert.ok(!('connectPollDelayMs' in schema.properties));
});

test('operation tools point at wait_for_job, and prompt-watching ones mention questions', async () => {
  const { client } = await setup();
  const tools = (await client.listTools()).tools;
  const createLxc = tools.find((t) => t.name === 'create_lxc')!;
  const installApp = tools.find((t) => t.name === 'install_app')!;
  assert.match(createLxc.description!, /wait_for_job/);
  assert.doesNotMatch(createLxc.description!, /poll get_job/);
  assert.doesNotMatch(createLxc.description!, /installer question/);
  assert.match(installApp.description!, /installer question/);
  assert.match(installApp.description!, /elicitation/);
});

test('get_oidc_client returns issuer, client ID, and secretAvailableFrom, and never the secret', async () => {
  const { call } = await setup({ inventory: oidcInventory(), authentik: ownedAuthentik() });
  const result = JSON.parse((await call('get_oidc_client', { entry: 'media' })).content[0].text);
  assert.deepEqual(result, {
    issuer: 'https://auth.example.com/application/o/media/',
    clientId: 'client-50',
    secretAvailableFrom: 'the Dashboard (admin) or `bellhop oidc-credentials media`',
  });
});

test('get_oidc_client\'s serialized result never contains the fake secret string, and neither does get_inventory or edit_guest', async () => {
  const { call } = await setup({ inventory: oidcInventory(), authentik: ownedAuthentik() });
  const oidcResult = await call('get_oidc_client', { entry: 'media' });
  assert.ok(!oidcResult.content.map((c) => c.text).join('\n').includes('secret-50'));

  const inventoryResult = await call('get_inventory');
  assert.ok(!inventoryResult.content.map((c) => c.text).join('\n').includes('secret-50'));

  const editResult = await call('edit_guest', { name: 'media', port: 8080 });
  assert.ok(!editResult.content.map((c) => c.text).join('\n').includes('secret-50'));
});

// T038: adopt_oidc_client is a plain generated Operation tool (registered
// from NETWORKING_OPERATIONS via MCP_OPERATIONS, like sync_authentik), so it
// previews by default and only mutates with apply: true -- same contract
// every other operation tool tested above already gets, exercised here
// against an unmarked (hand-made) OpenID client so the preview text has
// something real to report.
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

test('adopt_oidc_client previews by default and mutates nothing', async () => {
  const authentik = handMadeAuthentik();
  const { call } = await setup({ inventory: oidcInventory(), authentik });
  const result = await call('adopt_oidc_client', { entry: 'media' });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /meta_publisher -> bellhop/);
  assert.equal((await authentik.listApplications())[0].metaPublisher, undefined, 'a preview must not mutate anything');
});

test('adopt_oidc_client with apply: true enqueues a job that adopts the client', async () => {
  const authentik = handMadeAuthentik();
  const { call, jobStore } = await setup({ inventory: oidcInventory(), authentik });
  const started = JSON.parse((await call('adopt_oidc_client', { entry: 'media', apply: true })).content[0].text);
  assert.equal(typeof started.jobId, 'number');
  await waitForFinished(jobStore, started.jobId);
  assert.equal((await authentik.listApplications())[0].metaPublisher, 'bellhop');
});

// T032: edit_guest enforces the same OpenID-client-deletion confirmation
// as the Dashboard (FR-022a) -- the MCP server's admin trust does not waive it.
test('edit_guest rejects leaving OIDC gating without confirmOidcClientDeletion, and accepts it with true', async () => {
  // A forward-auth entry needs an 'authentik: true' entry to validate, so
  // the fixture's host carries one here.
  const base = oidcInventory();
  const inventory = { ...base, hosts: base.hosts.map((h) => ({ ...h, authentik: true, ip: '192.0.2.5' })) };
  const { client, call, inventoryPath } = await setup({ inventory, authentik: ownedAuthentik() });
  const describe = (await client.listTools()).tools.find((t) => t.name === 'edit_guest')!;
  assert.match(describe.description ?? '', /confirmOidcClientDeletion/);
  assert.ok('confirmOidcClientDeletion' in (describe.inputSchema.properties ?? {}));

  const refused = await call('edit_guest', { name: 'media', authMode: 'forward' });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /confirmOidcClientDeletion: true/);
  assert.equal(loadInventory(inventoryPath).guests.find((g) => g.name === 'media')?.authMode, 'oidc');

  const refusedClear = await call('edit_guest', { name: 'media', authGroup: null });
  assert.equal(refusedClear.isError, true);

  const accepted = await call('edit_guest', { name: 'media', authMode: 'forward', confirmOidcClientDeletion: true });
  assert.notEqual(accepted.isError, true, accepted.content[0].text);
  const saved = loadInventory(inventoryPath).guests.find((g) => g.name === 'media')!;
  assert.equal(saved.authMode, 'forward');
  assert.equal('confirmOidcClientDeletion' in saved, false);
});

// --- check_install_app / custom script repository (issue #11) ---
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
// issue #15: every custom-configured resolution also compares the pinned
// commit against upstream ProxmoxVED main; the captured ahead fixture
// changes demo-shop (among others), so demo-shop resolves to the fork.
const COMPARE_URL = `https://api.github.com/repos/community-scripts/ProxmoxVED/compare/main...${CUSTOM_OWNER}:${CUSTOM_REPO}:${SHA}`;
const COMPARE_AHEAD_BODY = readFileSync(path.join(fixtureDir, 'compare-ahead-3-apps.json'), 'utf8');
const customCtUrl = (slug: string) => `https://raw.githubusercontent.com/${CUSTOM_OWNER}/${CUSTOM_REPO}/${SHA}/ct/${slug}.sh`;

function customScriptFetch(slug: string): typeof fetch {
  return (async (url: unknown) => {
    const href = String(url);
    if (href === HEAD_SHA_URL) return new Response(HEAD_SHA_RAW, { status: 200 });
    if (href === COMPARE_URL) return new Response(COMPARE_AHEAD_BODY, { status: 200 });
    if (href === customCtUrl(slug)) return new Response('#!/usr/bin/env bash\n', { status: 200 });
    // Both upstream shadow probes -- always "not present" for this test.
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
}

test('check_install_app resolves through the custom script repository and returns custom.sha', async () => {
  const inventory: Inventory = {
    ...MCP_TEST_INVENTORY,
    customScriptsRepo: `${CUSTOM_OWNER}/${CUSTOM_REPO}`,
    customScriptsBranch: CUSTOM_BRANCH,
  };
  const { call } = await setup({ inventory, fetchImpl: customScriptFetch('demo-shop') });
  const result = parse(await call('check_install_app', { app: 'demo-shop' }));
  assert.equal(result.exists, true);
  assert.equal(result.url, customCtUrl('demo-shop'));
  assert.deepEqual(result.custom, { label: `${CUSTOM_OWNER}/${CUSTOM_REPO}@${CUSTOM_BRANCH}`, sha: SHA });
  assert.equal(result.shadows, undefined);
});

// issue #15 US1: an app the branch doesn't change resolves to upstream even
// with the custom repository configured -- no `custom` in the result.
test('check_install_app resolves an unchanged upstream app to upstream with the feature on', async () => {
  const inventory: Inventory = {
    ...MCP_TEST_INVENTORY,
    customScriptsRepo: `${CUSTOM_OWNER}/${CUSTOM_REPO}`,
    customScriptsBranch: CUSTOM_BRANCH,
  };
  const stableCt = 'https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/plex.sh';
  const fetchImpl = (async (url: unknown) => {
    const href = String(url);
    if (href === HEAD_SHA_URL) return new Response(HEAD_SHA_RAW, { status: 200 });
    if (href === COMPARE_URL) return new Response(COMPARE_AHEAD_BODY, { status: 200 });
    if (href === stableCt) return new Response('#!/usr/bin/env bash\n', { status: 200 });
    if (href.startsWith(`https://raw.githubusercontent.com/${CUSTOM_OWNER}/`)) throw new Error(`fork fetched: ${href}`);
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
  const { call } = await setup({ inventory, fetchImpl });
  const result = parse(await call('check_install_app', { app: 'plex' }));
  assert.equal(result.exists, true);
  assert.equal(result.url, stableCt);
  assert.equal(result.custom, undefined);
});

test('check_install_app reports error and exists=false when the custom settings are half-configured', async () => {
  const inventory: Inventory = { ...MCP_TEST_INVENTORY, customScriptsRepo: `${CUSTOM_OWNER}/${CUSTOM_REPO}` };
  const { call } = await setup({ inventory });
  const result = parse(await call('check_install_app', { app: 'demo-shop' }));
  assert.equal(result.exists, false);
  assert.equal(result.url, '');
  assert.match(result.error, /customScriptsBranch is not set \(customScriptsRepo is\)/);
});
