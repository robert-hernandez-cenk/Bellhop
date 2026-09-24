import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Inventory } from '../../src/lib/inventory.ts';
import { runUpdateApp, buildUpdateAppScript } from '../../src/commands/maintenance/update-app.ts';
import { FakeSSHClient, defaultResponder } from '../support/fake-ssh-client.ts';
import { shellQuote } from '../../src/lib/ssh-client.ts';
import { UPSTREAM_STABLE_BASE, UPSTREAM_DEV_BASE, type AppSource } from '../../src/lib/app-source.ts';

const inventory: Inventory = {
  domain: 'example.com',
  hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
  guests: [{ name: 'plex', type: 'lxc', vmid: 105, host: 'pve1' }],
};

test('buildUpdateAppScript embeds the community-scripts URL for the app', () => {
  const script = buildUpdateAppScript('plex');
  assert.match(script, /raw\.githubusercontent\.com\/community-scripts\/ProxmoxVE\/main\/ct\/plex\.sh/);
});

test('buildUpdateAppScript exports TERM before anything else, so build.func\'s clear call does not abort the update', () => {
  const script = buildUpdateAppScript('plex');
  assert.equal(script.split('\n')[0], 'export TERM=xterm');
});

test('buildUpdateAppScript exports PHS_SILENT=1 so build.func runs update_script instead of showing its menu', () => {
  const script = buildUpdateAppScript('plex');
  assert.match(script, /^export PHS_SILENT=1$/m);
});

test('runUpdateApp rejects an invalid app name', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  await assert.rejects(
    () => runUpdateApp({ guest: 'plex', app: 'Plex Media' }, { ssh, inventory }),
    /--app must contain only lowercase letters/
  );
});

test('runUpdateApp rejects an unknown guest', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  await assert.rejects(
    () => runUpdateApp({ guest: 'nope', app: 'plex' }, { ssh, inventory }),
    /Unknown inventory entry: nope/
  );
});

test('runUpdateApp does not call ssh when apply is not set', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const result = await runUpdateApp({ guest: 'plex', app: 'plex' }, { ssh, inventory });
  assert.equal(result.ran, false);
  assert.equal(ssh.history.length, 0);
});

test('runUpdateApp runs the script on the guest when apply is set', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const result = await runUpdateApp({ guest: 'plex', app: 'plex', apply: true }, { ssh, inventory });
  assert.equal(result.ran, true);
  assert.equal(ssh.history.length, 1);
  assert.match(ssh.history[0].command, /pct exec 105/);
});

test('runUpdateApp surfaces a non-zero exit code from the remote script', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: 'CTID not set', code: 1 }));
  const result = await runUpdateApp({ guest: 'plex', app: 'plex', apply: true }, { ssh, inventory });
  assert.equal(result.ran, true);
  assert.equal(result.result?.code, 1);
  assert.equal(result.result?.stderr, 'CTID not set');
});

// --- custom script repository (issue #11), update-app mirrors install-app ---
// Example values only (constitution Principle I) -- example-user/ProxmoxVED
// on branch my-apps is the same example the spec/plan/data-model/
// test/commands/install-app.test.ts use.

const fixtureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'github');
const HEAD_SHA_RAW = readFileSync(path.join(fixtureDir, 'branch-head-sha.txt'), 'utf8');
const SHA = HEAD_SHA_RAW.trim();

const CUSTOM_OWNER = 'example-user';
const CUSTOM_REPO = 'ProxmoxVED';
const CUSTOM_BRANCH = 'my-apps';
const CUSTOM_LABEL = `${CUSTOM_OWNER}/${CUSTOM_REPO}@${CUSTOM_BRANCH}`;
const HEAD_SHA_URL = `https://api.github.com/repos/${CUSTOM_OWNER}/${CUSTOM_REPO}/commits/${CUSTOM_BRANCH}`;
const customCtUrl = (slug: string) => `https://raw.githubusercontent.com/${CUSTOM_OWNER}/${CUSTOM_REPO}/${SHA}/ct/${slug}.sh`;
const customScriptsBaseUrl = `https://raw.githubusercontent.com/${CUSTOM_OWNER}/${CUSTOM_REPO}/${SHA}`;
const shadowUrl = (base: string, slug: string) => `${base}/ct/${slug}.sh`;

const inventoryWithCustomSource: Inventory = {
  ...inventory,
  customScriptsRepo: `${CUSTOM_OWNER}/${CUSTOM_REPO}`,
  customScriptsBranch: CUSTOM_BRANCH,
};

// Mirrors install-app.test.ts's own customFetch -- routes a full
// custom-repository resolution: head-SHA lookup, the custom ct/<slug>.sh
// script itself (always a hit), and both upstream shadow probes (always
// "not present" -- a plain 404).
function customFetch(slug: string): typeof fetch {
  return (async (url: unknown) => {
    const href = String(url);
    if (href === HEAD_SHA_URL) return new Response(HEAD_SHA_RAW, { status: 200 });
    if (href === customCtUrl(slug)) return new Response('#!/usr/bin/env bash\n', { status: 200 });
    if (href === shadowUrl(UPSTREAM_STABLE_BASE, slug)) return new Response(null, { status: 404 });
    if (href === shadowUrl(UPSTREAM_DEV_BASE, slug)) return new Response(null, { status: 404 });
    throw new Error(`unexpected fetch: ${href}`);
  }) as unknown as typeof fetch;
}

test('buildUpdateAppScript with an upstream (or omitted) source produces byte-identical output to before this feature existed', () => {
  const expected = [
    'export TERM=xterm',
    'export PHS_SILENT=1',
    'DEBIAN_FRONTEND=noninteractive apt-get update',
    'DEBIAN_FRONTEND=noninteractive apt-get install -y curl',
    `bash -c "$(curl -fsSL 'https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/plex.sh' 2>/dev/null || curl -fsSL 'https://raw.githubusercontent.com/community-scripts/ProxmoxVED/main/ct/plex.sh')"`,
  ].join('\n');

  assert.equal(buildUpdateAppScript('plex'), expected);
  assert.equal(buildUpdateAppScript('plex', { kind: 'upstream', slug: 'plex', shadows: [] }), expected);
});

test('buildUpdateAppScript exports COMMUNITY_SCRIPTS_URL immediately before the curl line and has no upstream fallback for a custom source', () => {
  const source: AppSource = {
    kind: 'custom',
    slug: 'myapp',
    custom: { owner: CUSTOM_OWNER, repo: CUSTOM_REPO, branch: CUSTOM_BRANCH, label: CUSTOM_LABEL, sha: SHA },
    ctUrl: customCtUrl('myapp'),
    scriptsBaseUrl: customScriptsBaseUrl,
    shadows: [],
  };
  const script = buildUpdateAppScript('myapp', source);
  const lines = script.split('\n');
  const exportLine = `export COMMUNITY_SCRIPTS_URL=${shellQuote(customScriptsBaseUrl)}`;
  const curlLine = `bash -c "$(curl -fsSL ${shellQuote(customCtUrl('myapp'))})"`;
  assert.equal(lines[lines.length - 2], exportLine);
  assert.equal(lines[lines.length - 1], curlLine);
  assert.doesNotMatch(script, /\|\|/);
});

test('runUpdateApp resolves a custom source via fetchImpl and curls the pinned ctUrl', async () => {
  const inventoryWithMyapp: Inventory = { ...inventoryWithCustomSource, guests: [{ name: 'myapp', type: 'lxc', vmid: 105, host: 'pve1' }] };
  const ssh = new FakeSSHClient(defaultResponder);
  const fetchImpl = customFetch('myapp');
  const result = await runUpdateApp(
    { guest: 'myapp', app: 'myapp', apply: true, fetchImpl },
    { ssh, inventory: inventoryWithMyapp }
  );
  assert.equal(result.source.kind, 'custom');
  // result.script is the unwrapped script (what buildUpdateAppScript's own
  // export-line test already pins byte-for-byte) -- runRemote's guest path
  // (`pct exec ... -- sh -c '<shellQuote-escaped script>'`) re-escapes the
  // script's own embedded single quotes, so asserting the exact quoted
  // export/curl substrings against the wrapped ssh.history command (as
  // install-app.test.ts does for its direct-to-pve-host exec) would not
  // match here; check the pct exec call carries the same script instead.
  assert.ok(result.script.includes(`export COMMUNITY_SCRIPTS_URL=${shellQuote(customScriptsBaseUrl)}`));
  assert.ok(result.script.includes(`bash -c "$(curl -fsSL ${shellQuote(customCtUrl('myapp'))})"`));
  assert.doesNotMatch(result.script, /\|\|/, 'a custom resolution must not fall back to upstream');
  assert.ok(ssh.history[0].command.includes('pct exec 105'));
  assert.ok(ssh.history[0].command.includes('COMMUNITY_SCRIPTS_URL'));
});

test('runUpdateApp throws a resolution failure before any exec is recorded', async () => {
  const inventoryWithMyapp: Inventory = { ...inventoryWithCustomSource, guests: [{ name: 'myapp', type: 'lxc', vmid: 105, host: 'pve1' }] };
  const ssh = new FakeSSHClient(defaultResponder);
  const failingFetch = (async () => new Response('rate limited', { status: 403 })) as unknown as typeof fetch;
  await assert.rejects(
    () => runUpdateApp({ guest: 'myapp', app: 'myapp', apply: true, fetchImpl: failingFetch }, { ssh, inventory: inventoryWithMyapp }),
    /Custom script repository example-user\/ProxmoxVED@my-apps: GitHub returned 403/
  );
  assert.equal(ssh.history.length, 0, 'no remote exec should have been recorded');
});

// T016's install-app equivalent (R6): the override warning must be logged
// before the remote update exec runs, whenever the resolved source also
// shadows an upstream copy of the same slug.
test('runUpdateApp logs the R6 override warning when the custom source shadows an upstream copy', async () => {
  const slug = 'myapp';
  const inventoryWithMyapp: Inventory = { ...inventoryWithCustomSource, guests: [{ name: slug, type: 'lxc', vmid: 105, host: 'pve1' }] };
  const fetchImpl = (async (url: unknown) => {
    const href = String(url);
    if (href === HEAD_SHA_URL) return new Response(HEAD_SHA_RAW, { status: 200 });
    if (href === customCtUrl(slug)) return new Response('#!/usr/bin/env bash\n', { status: 200 });
    if (href === shadowUrl(UPSTREAM_STABLE_BASE, slug)) return new Response('#!/usr/bin/env bash\n', { status: 200 });
    if (href === shadowUrl(UPSTREAM_DEV_BASE, slug)) return new Response(null, { status: 404 });
    throw new Error(`unexpected fetch: ${href}`);
  }) as unknown as typeof fetch;

  const lines: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  try {
    await runUpdateApp({ guest: slug, app: slug, fetchImpl }, { ssh: new FakeSSHClient(defaultResponder), inventory: inventoryWithMyapp });
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  assert.ok(lines.length > 0, 'expected the override warning to be logged');
  assert.match(
    lines[0],
    /^\[WARN\s+\S+ \S+\] "myapp" is installing from the custom script repository example-user\/ProxmoxVED@my-apps \(commit [0-9a-f]{7}\), which overrides the upstream copy in ProxmoxVE\. Unset customScriptsRepo\/customScriptsBranch with set-config to use upstream\.$/
  );
});

test('runUpdateApp uses a passed-in opts.source without ever calling fetch', async () => {
  const ssh = new FakeSSHClient(defaultResponder);
  const throwingFetch = (async () => {
    throw new Error('runUpdateApp should not have called fetch when opts.source is already given');
  }) as unknown as typeof fetch;
  const source: AppSource = { kind: 'upstream', slug: 'plex', shadows: [] };
  const result = await runUpdateApp(
    { guest: 'plex', app: 'plex', source, fetchImpl: throwingFetch },
    { ssh, inventory: inventoryWithCustomSource }
  );
  assert.equal(result.ran, false);
  assert.equal(result.source, source);
});
