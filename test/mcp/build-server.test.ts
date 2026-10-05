import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { HangingSSHClient } from '../support/hanging-ssh-client.ts';
import { loadInventory, saveInventory, type Inventory } from '../../src/lib/inventory.ts';
import { gatewayStatus } from '../../src/operations/vpn-gateway.ts';
import { FakeAuthentikClient } from '../support/fake-authentik-client.ts';
import { setupMcp as setup, waitForFinished, parse, MCP_TEST_INVENTORY } from '../support/mcp-harness.ts';
import { SECRET_SETTINGS_KEYS } from '../../src/lib/settings-defs.ts';
import { useConfigStore, writeSecret } from '../../src/lib/config.ts';
import { resetConfigStore } from '../support/config-store.ts';

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
    'create_lxc', 'install_app', 'delete_guest', 'update_all', 'guest_power', 'set_config', 'sync_authentik', 'sync_proxy',
    'adopt_oidc_client',
    'edit_guest', 'get_inventory', 'get_guest_status', 'audit_nfs_mounts', 'list_install_apps', 'check_install_app',
    'get_vpn_gateway_status', 'list_vpn_gateway_servers', 'list_vpn_gateway_cities', 'list_vpn_gateway_groups', 'connect_vpn_gateway',
    'list_jobs', 'get_job', 'wait_for_job', 'answer_job_prompt', 'dismiss_job_prompt', 'cancel_job',
  ]) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }
  assert.ok(!names.includes('migrate_nfs_mount'));
  assert.ok(!names.includes('sync_caddy'), 'no sync_caddy alias');
  // list_vpn_gateway_groups legitimately contains "group" (a VPN server
  // group, e.g. Double VPN/P2P) -- excluded here, not a user/group tool.
  assert.ok(!names.filter((n) => !n.startsWith('list_vpn_gateway_groups')).some((n) => /user|group|permission|imperson|import_yaml/.test(n)));
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

// Issue #6 (US3): cancel_job/answer_job_prompt/dismiss_job_prompt now go
// through the same requestJobControl requireOwned's callers used to refuse
// outright with (research.md R5) -- a job owned by another live process (the
// web service, in these fixtures) gets a queued control request instead of
// a flat refusal, applied asynchronously by whichever process owns it.
// wait_for_job is the one tool that keeps requireOwned unchanged (FR-017):
// it needs the job's own in-memory controller/events to block on, which only
// the owning process ever holds, so there is nothing for a queued request to
// help it wait on.
test('cancel_job on a running job owned by another live process queues a control request instead of refusing', async () => {
  const { call, jobStore, jobRunner } = await setup();
  const id = jobStore.createJob({ command: 'sync-caddy', category: 'maintenance', argsJson: '{}', owner: 'web' });
  jobStore.markRunning(id);

  const result = await call('cancel_job', { id });
  assert.equal(result.isError, undefined);
  const body = parse(result);
  assert.equal(body.requested, true);
  assert.equal(body.owner, 'web');
  assert.equal(body.note, 'The owning process applies this within about a second if it is running; check get_job for the result.');

  const pending = jobStore.pendingControlRequests('web');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].jobId, id);
  assert.equal(pending[0].action, 'cancel');
  assert.equal(pending[0].requestedByOwner, jobRunner.owner);
  assert.equal(pending[0].requestedByUsername, null);
});

test('answer_job_prompt on a running (not awaiting-input) job owned by another live process is refused, not queued', async () => {
  const { call, jobStore } = await setup();
  const id = jobStore.createJob({ command: 'sync-caddy', category: 'maintenance', argsJson: '{}', owner: 'web' });
  jobStore.markRunning(id);

  const result = await call('answer_job_prompt', { id, text: 'y' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not awaiting input — nothing to answer/);
  assert.deepEqual(jobStore.pendingControlRequests('web'), []);
});

test('wait_for_job still refuses a job owned by another process outright, never queuing a request', async () => {
  const { call, jobStore } = await setup();
  const id = jobStore.createJob({ command: 'sync-caddy', category: 'maintenance', argsJson: '{}', owner: 'web' });
  jobStore.markRunning(id);

  const result = await call('wait_for_job', { id });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /owned by web/);
  assert.deepEqual(jobStore.pendingControlRequests('web'), []);
});

test('edit_guest writes inventory and reports the proxy sync outcome', async () => {
  const { call, inventoryPath } = await setup();
  const result = JSON.parse((await call('edit_guest', { name: 'app-lxc', subdomains: ['app'], port: 8080 })).content[0].text);
  assert.equal(result.proxySynced, true);
  assert.deepEqual(loadInventory(inventoryPath).guests.find((g) => g.name === 'app-lxc')?.subdomains, ['app']);
});

// T007 (issue #22): edit_guest also saves the distinct
// oidcMobileRedirectUris field, mirroring the oidcRedirectUris edit above.
test('edit_guest saves oidcMobileRedirectUris', async () => {
  const { call, inventoryPath } = await setup();
  const result = JSON.parse(
    (await call('edit_guest', { name: 'app-lxc', oidcMobileRedirectUris: ['app.example:///oauth-callback'] })).content[0].text
  );
  assert.equal(result.proxySynced, true);
  assert.deepEqual(loadInventory(inventoryPath).guests.find((g) => g.name === 'app-lxc')?.oidcMobileRedirectUris, [
    'app.example:///oauth-callback',
  ]);
});

test('set_config accepts the proxyDriver and proxyConfigPath keys', async () => {
  const { client } = await setup();
  const tool = (await client.listTools()).tools.find((t) => t.name === 'set_config')!;
  const key = (tool.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties.key;
  assert.ok(key.enum?.includes('proxyDriver'));
  assert.ok(key.enum?.includes('proxyConfigPath'));
});

test('edit_guest takes proxyManual (not caddyManual), and ignores an old caddyManual argument', async () => {
  const { client, call, inventoryPath } = await setup();
  const tool = (await client.listTools()).tools.find((t) => t.name === 'edit_guest')!;
  const props = (tool.inputSchema as { properties: Record<string, { description?: string }> }).properties;
  assert.equal(props.proxyManual?.description, 'Proxy config for this entry is hand-authored outside the managed section');
  assert.ok(!('caddyManual' in props));
  assert.match(tool.description ?? '', /proxyManual/);
  assert.doesNotMatch(tool.description ?? '', /caddyManual/);

  await call('edit_guest', { name: 'app-lxc', caddyManual: true });
  assert.equal(loadInventory(inventoryPath).guests.find((g) => g.name === 'app-lxc')?.proxyManual, undefined);
  await call('edit_guest', { name: 'app-lxc', proxyManual: true });
  assert.equal(loadInventory(inventoryPath).guests.find((g) => g.name === 'app-lxc')?.proxyManual, true);
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

// --- VPN gateway tools (issue #7) ---
// Mirrors test/operations/vpn-gateway.test.ts's fixture shape -- example
// data only (constitution I): RFC 5737 addresses, *-example-gw-lxc names.
const NORDVPN_GW = 'nordvpn-example-gw-lxc';
const PIA_GW = 'pia-example-gw-lxc';
const NO_IP_GW = 'no-ip-gw-lxc';

function vpnGatewayInventory(): Inventory {
  return {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
    guests: [
      { name: NORDVPN_GW, type: 'lxc', vmid: 4015, host: 'pve1', ip: '192.0.2.15', vpnGateway: 'nordvpn' },
      { name: PIA_GW, type: 'lxc', vmid: 4016, host: 'pve1', ip: '192.0.2.20', vpnGateway: 'pia' },
      { name: 'app-lxc', type: 'lxc', vmid: 4003, host: 'pve1', ip: '192.168.1.3' },
      { name: NO_IP_GW, type: 'lxc', vmid: 4017, host: 'pve1', vpnGateway: 'nordvpn' },
    ],
  };
}

test('get_vpn_gateway_status returns the gateway body on success, matching the shared operation', async () => {
  const statusBody = { connected: true, country: 'Germany', resolvedCountry: 'Germany', server: 'de123.nordvpn.com' };
  const fetchImpl = (async (url: string) => {
    assert.equal(url, 'http://192.0.2.15:8080/status');
    return { ok: true, status: 200, json: async () => statusBody } as Response;
  }) as unknown as typeof fetch;
  const { call } = await setup({ inventory: vpnGatewayInventory(), fetchImpl });
  const result = await call('get_vpn_gateway_status', { name: NORDVPN_GW });
  assert.equal(result.isError, undefined);
  assert.deepEqual(parse(result), statusBody);

  // Parity (SC-003): the same fake fetch fed to the shared operation
  // directly returns the identical body the tool just returned.
  const direct = await gatewayStatus(vpnGatewayInventory(), NORDVPN_GW, fetchImpl);
  assert.ok(direct.ok);
  assert.deepEqual(parse(result), direct.body);
});

test('get_vpn_gateway_status is an isError with the shared module\'s message for an unknown gateway', async () => {
  const { call } = await setup({ inventory: vpnGatewayInventory() });
  const result = await call('get_vpn_gateway_status', { name: 'nope' });
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, 'Unknown VPN gateway: nope');
});

test('get_vpn_gateway_status is an isError for a gateway guest with no ip', async () => {
  const { call } = await setup({ inventory: vpnGatewayInventory() });
  const result = await call('get_vpn_gateway_status', { name: NO_IP_GW });
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, `VPN gateway ${NO_IP_GW} has no ip in inventory`);
});

test('get_vpn_gateway_status is an isError with the unreachable-gateway message when fetch throws', async () => {
  const fetchImpl = (async () => {
    throw new Error('connect ECONNREFUSED');
  }) as unknown as typeof fetch;
  const { call } = await setup({ inventory: vpnGatewayInventory(), fetchImpl });
  const result = await call('get_vpn_gateway_status', { name: NORDVPN_GW });
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, 'Failed to reach gateway at 192.0.2.15:8080 -- connect ECONNREFUSED');
});

test('get_vpn_gateway_status reloads inventory before each call', async () => {
  const seen: string[] = [];
  const fetchImpl = (async (url: string) => {
    seen.push(url);
    return { ok: true, status: 200, json: async () => ({ connected: true }) } as Response;
  }) as unknown as typeof fetch;
  const initial = vpnGatewayInventory();
  const { call, inventoryPath } = await setup({ inventory: initial, fetchImpl });
  await call('get_vpn_gateway_status', { name: NORDVPN_GW });
  assert.equal(seen[0], 'http://192.0.2.15:8080/status');

  const moved: Inventory = {
    ...initial,
    guests: initial.guests.map((g) => (g.name === NORDVPN_GW ? { ...g, ip: '192.0.2.16' } : g)),
  };
  saveInventory(inventoryPath, moved);

  await call('get_vpn_gateway_status', { name: NORDVPN_GW });
  assert.equal(seen[1], 'http://192.0.2.16:8080/status');
});

test('list_vpn_gateway_servers returns the fake /servers array', async () => {
  const servers = [{ name: 'Germany', code: 'DE' }, { name: 'Netherlands', code: 'NL' }];
  const fetchImpl = (async (url: string) => {
    assert.equal(url, 'http://192.0.2.15:8080/servers');
    return { ok: true, status: 200, json: async () => servers } as Response;
  }) as unknown as typeof fetch;
  const { call } = await setup({ inventory: vpnGatewayInventory(), fetchImpl });
  const result = await call('list_vpn_gateway_servers', { name: NORDVPN_GW });
  assert.equal(result.isError, undefined);
  assert.deepEqual(parse(result), servers);
});

test('list_vpn_gateway_cities forwards the country query and returns the fake array', async () => {
  const cities = [{ name: 'Berlin', id: '1' }];
  const seen: string[] = [];
  const fetchImpl = (async (url: string) => {
    seen.push(url);
    return { ok: true, status: 200, json: async () => cities } as Response;
  }) as unknown as typeof fetch;
  const { call } = await setup({ inventory: vpnGatewayInventory(), fetchImpl });
  const result = await call('list_vpn_gateway_cities', { name: NORDVPN_GW, country: 'Germany' });
  assert.deepEqual(parse(result), cities);
  assert.equal(seen[0], 'http://192.0.2.15:8080/cities?country=Germany');
});

test('list_vpn_gateway_cities without a country sends an empty query value', async () => {
  const seen: string[] = [];
  const fetchImpl = (async (url: string) => {
    seen.push(url);
    return { ok: true, status: 200, json: async () => [] } as Response;
  }) as unknown as typeof fetch;
  const { call } = await setup({ inventory: vpnGatewayInventory(), fetchImpl });
  await call('list_vpn_gateway_cities', { name: NORDVPN_GW });
  assert.equal(seen[0], 'http://192.0.2.15:8080/cities?country=');
});

test('list_vpn_gateway_groups returns the fake /groups array', async () => {
  const groups = [{ name: 'Double VPN', identifier: 'legacy_double_vpn' }];
  const fetchImpl = (async (url: string) => {
    assert.equal(url, 'http://192.0.2.15:8080/groups');
    return { ok: true, status: 200, json: async () => groups } as Response;
  }) as unknown as typeof fetch;
  const { call } = await setup({ inventory: vpnGatewayInventory(), fetchImpl });
  const result = await call('list_vpn_gateway_groups', { name: NORDVPN_GW });
  assert.deepEqual(parse(result), groups);
});

test('list_vpn_gateway_groups on a PIA gateway answering 404 is an isError with the provider message', async () => {
  const fetchImpl = (async () =>
    ({ ok: false, status: 404, json: async () => ({ error: 'server-group selection not supported by this provider' }) }) as Response
  ) as unknown as typeof fetch;
  const { call } = await setup({ inventory: vpnGatewayInventory(), fetchImpl });
  const result = await call('list_vpn_gateway_groups', { name: PIA_GW });
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, 'server-group selection not supported by this provider');
});

test('connect_vpn_gateway POSTs the full selection and returns the fake connect body', async () => {
  const connectBody = { connected: true, country: 'Germany', resolvedCountry: 'Germany', city: 'Berlin', server: 'de123.nordvpn.com' };
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => connectBody } as Response;
  }) as unknown as typeof fetch;
  const { call, jobStore } = await setup({ inventory: vpnGatewayInventory(), fetchImpl });
  const result = await call('connect_vpn_gateway', { name: NORDVPN_GW, country: 'Germany', city: 'Berlin', group: 'P2P' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(parse(result), connectBody);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://192.0.2.15:8080/connect');
  assert.equal(calls[0].init?.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init!.body as string), { country: 'Germany', city: 'Berlin', group: 'P2P' });
  // No job/preview -- connect acts immediately (research R1).
  assert.deepEqual(jobStore.list(), []);
});

test('connect_vpn_gateway with only a country sends empty city and group', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ connected: true }) } as Response;
  }) as unknown as typeof fetch;
  const { call } = await setup({ inventory: vpnGatewayInventory(), fetchImpl });
  await call('connect_vpn_gateway', { name: NORDVPN_GW, country: 'Germany' });
  assert.deepEqual(JSON.parse(calls[0].init!.body as string), { country: 'Germany', city: '', group: '' });
});

test('connect_vpn_gateway is an isError with the provider message on a 502', async () => {
  const fetchImpl = (async () => ({ ok: false, status: 502, json: async () => ({ error: 'no servers matched' }) }) as Response) as unknown as typeof fetch;
  const { call, jobStore } = await setup({ inventory: vpnGatewayInventory(), fetchImpl });
  const result = await call('connect_vpn_gateway', { name: NORDVPN_GW, country: 'Germany' });
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, 'no servers matched');
  assert.deepEqual(jobStore.list(), []);
});

// -- Issue #64 US2: no MCP tool writes or returns a secret --------------------

test('set_config accepts no secret key, in its schema or at call time', async () => {
  const { client, call } = await setup();
  const tool = (await client.listTools()).tools.find((t) => t.name === 'set_config')!;
  const key = (tool.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties.key;
  for (const secret of SECRET_SETTINGS_KEYS) {
    assert.ok(!key.enum?.includes(secret), `set_config must not accept ${secret}`);
    const result = await call('set_config', { key: secret, value: 'example-token', apply: true });
    assert.equal(result.isError, true, `set_config(${secret}) must be refused`);
  }
});

test('no tool output contains a stored secret', async () => {
  const h = await setup();
  // Padded to clear mcpApiKey's 32-character minimum (#66).
  const markers = SECRET_SETTINGS_KEYS.map((key) => `leak-marker-${key}-7f3a-0123456789`);
  SECRET_SETTINGS_KEYS.forEach((key, i) => writeSecret(h.inventoryPath, key, markers[i]));
  // Registered so every consumer that reads a secret through the accessor
  // sees the stored ones, as in the real MCP server.
  useConfigStore(h.inventoryPath);
  try {
    const outputs: string[] = [JSON.stringify((await h.client.listTools()).tools)];
    const record = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await h.call(name, args);
      outputs.push(result.content.map((c) => c.text).join('\n'));
      return result;
    };
    await record('get_inventory');
    await record('set_config', { key: 'dnsServer', value: '192.0.2.53' });
    const started = JSON.parse((await record('set_config', { key: 'dnsServer', value: '192.0.2.53', apply: true })).content[0].text);
    await waitForFinished(h.jobStore, started.jobId);
    await record('get_job', { id: started.jobId });
    await record('list_jobs');
    const job = h.jobStore.get(started.jobId)!;
    outputs.push(job.argsJson, h.jobLog.read(job.logFile));
    const all = outputs.join('\n');
    for (const marker of markers) assert.ok(!all.includes(marker), `${marker} leaked into a tool output`);
  } finally {
    resetConfigStore();
  }
});

// #65/#66: a server built for a known caller (an HTTP MCP session's
// signed-in admin, or the stdio server's OS user) records that caller on
// every job it starts; without one it keeps the old generic 'mcp'.
test('apply records the server actor as the job triggeredByUsername', async () => {
  const { call, jobStore } = await setup({ serverOptions: { actor: { username: 'admin' } } });
  const started = parse(await call('create_lxc', { host: 'pve1', mid: 5, hostname: 'new-lxc', template: 'debian-12', apply: true }));
  await waitForFinished(jobStore, started.jobId);
  assert.equal(jobStore.get(started.jobId)?.triggeredByUsername, 'admin');
  assert.equal(jobStore.get(started.jobId)?.triggeredVia, 'mcp');
  // ...and the job tools report both.
  const job = parse(await call('get_job', { id: started.jobId }));
  assert.equal(job.job.triggeredByUsername, 'admin');
  assert.equal(job.job.triggeredVia, 'mcp');
});

test('apply without an actor still records mcp', async () => {
  const { call, jobStore } = await setup();
  const started = parse(await call('create_lxc', { host: 'pve1', mid: 5, hostname: 'new-lxc', template: 'debian-12', apply: true }));
  await waitForFinished(jobStore, started.jobId);
  assert.equal(jobStore.get(started.jobId)?.triggeredByUsername, 'mcp');
});
