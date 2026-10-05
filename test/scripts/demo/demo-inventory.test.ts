import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadInventory, saveInventory, effectiveAuth } from '../../../src/lib/inventory.ts';
import { buildDemoInventory, DEMO_SECRET_SETTINGS } from '../../../scripts/demo/demo-inventory.ts';
import { DEMO_JOB_DEFS, DEMO_JOB_LOGS } from '../../../scripts/demo/demo-jobs.ts';
import { DEMO_IDENTITY } from '../../../scripts/demo/demo-server.ts';
import { DemoSSHClient, DEMO_AUTHORIZED_KEY, DEMO_PACKAGE_MANAGER, demoSimulatedOutput } from '../../../scripts/demo/demo-ssh.ts';
import { demoFetch, DEMO_CATALOG_SLUGS } from '../../../scripts/demo/demo-fetch.ts';

function tempDbPath(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'bellhop-demo-inventory-')), 'bellhop.db');
}

test('buildDemoInventory saves and loads back through the real inventory schema', () => {
  const inv = buildDemoInventory();
  const dbPath = tempDbPath();
  // saveInventory/loadInventory both run validateInventory (loadInventory
  // does so on every read) -- a thrown error here means the demo inventory
  // itself is invalid, which should fail this test rather than surface only
  // once someone runs `npm run demo`.
  assert.doesNotThrow(() => saveInventory(dbPath, inv));
  const reloaded = loadInventory(dbPath);
  assert.ok(reloaded.hosts.length >= 2);
});

test('buildDemoInventory covers at least two Proxmox hosts', () => {
  const inv = buildDemoInventory();
  assert.ok(inv.hosts.length >= 2, `expected at least 2 hosts, got ${inv.hosts.length}`);
});

test('buildDemoInventory covers at least eight guests across both lxc and vm types', () => {
  const inv = buildDemoInventory();
  assert.ok(inv.guests.length >= 8, `expected at least 8 guests, got ${inv.guests.length}`);
  const types = new Set(inv.guests.map((g) => g.type));
  assert.ok(types.has('lxc'), 'expected at least one lxc guest');
  assert.ok(types.has('vm'), 'expected at least one vm guest');
});

test('buildDemoInventory has several guests with subdomains, some with more than one', () => {
  const inv = buildDemoInventory();
  const withSubdomains = inv.guests.filter((g) => (g.subdomains?.length ?? 0) > 0);
  assert.ok(withSubdomains.length >= 3, `expected several guests with subdomains, got ${withSubdomains.length}`);
  const withMultiple = inv.guests.filter((g) => (g.subdomains?.length ?? 0) > 1);
  assert.ok(withMultiple.length >= 1, 'expected at least one guest with more than one subdomain');
  for (const guest of withSubdomains) {
    assert.ok(guest.port !== undefined, `guest '${guest.name}' has subdomains but no port`);
  }
});

test('buildDemoInventory gates guests at two or more different authGroup rungs', () => {
  const inv = buildDemoInventory();
  const rungs = new Set(inv.guests.filter((g) => g.authGroup).map((g) => g.authGroup));
  assert.ok(rungs.size >= 2, `expected at least 2 distinct authGroup rungs, got ${[...rungs].join(', ')}`);
});

test('buildDemoInventory has exactly one guest in OIDC mode with redirect URIs', () => {
  const inv = buildDemoInventory();
  const oidcGuests = inv.guests.filter((g) => effectiveAuth(g) === 'oidc');
  assert.equal(oidcGuests.length, 1, `expected exactly one OIDC guest, got ${oidcGuests.length}`);
  const [oidcGuest] = oidcGuests;
  assert.ok(oidcGuest.authGroup, 'the OIDC guest must have authGroup set');
  assert.ok((oidcGuest.oidcRedirectUris?.length ?? 0) > 0, 'the OIDC guest must have oidcRedirectUris set');
});

test('buildDemoInventory has several guests with an app slug set', () => {
  const inv = buildDemoInventory();
  const withApp = inv.guests.filter((g) => g.app);
  assert.ok(withApp.length >= 3, `expected several guests with 'app' set, got ${withApp.length}`);
});

test('buildDemoInventory has exactly one proxy:true and one authentik:true guest', () => {
  const inv = buildDemoInventory();
  const proxyEntries = [...inv.hosts.filter((h) => h.proxy), ...inv.guests.filter((g) => g.proxy)];
  assert.equal(proxyEntries.length, 1, `expected exactly one proxy:true entry, got ${proxyEntries.length}`);
  const authentikEntries = [...inv.hosts.filter((h) => h.authentik), ...inv.guests.filter((g) => g.authentik)];
  assert.equal(authentikEntries.length, 1, `expected exactly one authentik:true entry, got ${authentikEntries.length}`);
});

test('buildDemoInventory has at least one guest with unauthenticatedPaths', () => {
  const inv = buildDemoInventory();
  const withPaths = inv.guests.filter((g) => (g.unauthenticatedPaths?.length ?? 0) > 0);
  assert.ok(withPaths.length >= 1, 'expected at least one guest with unauthenticatedPaths set');
});

test('buildDemoInventory hosts cover midScheme ranges, bridges, and storages (vztmpl/rootdir|images/nfs)', () => {
  const inv = buildDemoInventory();
  for (const host of inv.hosts) {
    assert.ok(host.midScheme, `host '${host.name}' is missing a midScheme`);
    assert.ok((host.bridges?.length ?? 0) > 0, `host '${host.name}' is missing bridges`);
    assert.ok((host.storages?.length ?? 0) > 0, `host '${host.name}' is missing storages`);
  }
  const allContentTypes = new Set(inv.hosts.flatMap((h) => h.storages ?? []).flatMap((s) => s.content));
  assert.ok(allContentTypes.has('vztmpl'), 'expected some storage with vztmpl content');
  assert.ok(allContentTypes.has('rootdir') || allContentTypes.has('images'), 'expected some storage with rootdir or images content');
  const nfsStorages = (inv.hosts.flatMap((h) => h.storages ?? [])).filter((s) => s.type === 'nfs');
  assert.ok(nfsStorages.length >= 1, 'expected at least one nfs storage');
});

test('buildDemoInventory returns a fresh, independent object on every call', () => {
  const first = buildDemoInventory();
  const second = buildDemoInventory();
  assert.notEqual(first, second);
  assert.notEqual(first.hosts, second.hosts);
  assert.notEqual(first.guests, second.guests);

  // Mutate the first result deeply and confirm the second is untouched.
  first.domain = 'mutated.example';
  first.hosts.push({ name: 'mutated-host', ssh_target: '192.0.2.99', ssh_user: 'root' });
  first.guests[0].name = 'mutated-guest';
  if (first.guests[0].subdomains) {
    first.guests[0].subdomains.push('mutated.example.com');
  }

  const third = buildDemoInventory();
  assert.notEqual(third.domain, 'mutated.example');
  assert.notEqual(third.hosts.length, first.hosts.length);
  assert.notEqual(third.guests[0].name, 'mutated-guest');
  assert.notEqual(second.domain, 'mutated.example');
  assert.notEqual(second.guests[0].name, 'mutated-guest');
});

test('buildDemoInventory settings match the brief: domain and the three settings values', () => {
  const inv = buildDemoInventory();
  assert.equal(inv.domain, 'example.com');
  assert.equal(inv.backupStorage, 'nas-backup');
  assert.equal(inv.dnsServer, '198.51.100.53');
  assert.equal(inv.nfsServer, '198.51.100.50');
});

test('buildDemoInventory hosts use pve1/pve2, root ssh_user, and 192.0.2.0/24 ssh_target', () => {
  const inv = buildDemoInventory();
  const names = inv.hosts.map((h) => h.name).sort();
  assert.deepEqual(names, ['pve1', 'pve2']);
  for (const host of inv.hosts) {
    assert.equal(host.ssh_user, 'root');
    assert.match(host.ssh_target, /^192\.0\.2\.\d{1,3}$/, `host '${host.name}' ssh_target not in 192.0.2.0/24`);
  }
});

// --- Example-data guard (FR-019, research R8) -------------------------------
// Everything the demo can ever show -- the inventory, every seeded job (its
// log, argsJson, and triggering user), the identity headers the demo server
// injects, every canned DemoSSHClient output, and the demo catalog -- must use
// only documentation address ranges, example domains, and Constitution I's
// example users (admin, test-user) and @example.com email addresses.

const EXAMPLE_USERNAMES = new Set(['admin', 'test-user']);
// An email needs an alphabetic TLD, so an ssh target like root@198.51.100.3
// (in a seeded job log) is not mistaken for one.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b/g;

const EXAMPLE_IPV4_PREFIXES = ['192.0.2.', '198.51.100.', '203.0.113.'];
const EXAMPLE_DOMAINS = new Set(['example.com', 'example.net', 'example.org']);
const EXAMPLE_DOMAIN_SUFFIXES = ['.example', '.test', '.invalid'];
// A dotted token ending in one of these is a file name, not a domain
// (`inventory/bellhop.db`, `ct/jellyfin.sh`, `jellyfin.service`, ...).
const FILE_EXTENSIONS = new Set(['sh', 'db', 'service', 'sqlite3', 'json', 'ts', 'js', 'log', 'conf', 'txt', 'yaml', 'yml']);

const IPV4_RE = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
// A three-octet prefix ending in a dot, like a midScheme's ipPrefix.
const IPV4_PREFIX_RE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.(?!\d)/g;
const DOMAIN_RE = /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z](?:[a-z0-9-]*[a-z0-9])?\b/gi;

function isExampleIpv4(token: string): boolean {
  return EXAMPLE_IPV4_PREFIXES.some((prefix) => token.startsWith(prefix));
}

function isExampleDomain(token: string): boolean {
  const lower = token.toLowerCase();
  for (const domain of EXAMPLE_DOMAINS) {
    if (lower === domain || lower.endsWith(`.${domain}`)) return true;
  }
  return EXAMPLE_DOMAIN_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

function findNonExampleValues(text: string): string[] {
  const bad: string[] = [];
  for (const ip of text.match(IPV4_RE) ?? []) {
    if (!isExampleIpv4(ip)) bad.push(`IPv4 ${ip}`);
  }
  for (const prefix of text.match(IPV4_PREFIX_RE) ?? []) {
    if (!isExampleIpv4(prefix)) bad.push(`IPv4 prefix ${prefix}`);
  }
  for (const domain of text.match(DOMAIN_RE) ?? []) {
    const lastLabel = domain.slice(domain.lastIndexOf('.') + 1).toLowerCase();
    if (FILE_EXTENSIONS.has(lastLabel)) continue;
    if (!isExampleDomain(domain)) bad.push(`domain ${domain}`);
  }
  return bad;
}

// Drives a DemoSSHClient through every command shape it has a canned answer
// for, against every demo host and guest, and returns everything it printed.
async function allDemoSshOutputs(): Promise<string[]> {
  const inv = buildDemoInventory();
  const ssh = new DemoSSHClient(inv);
  const outputs: string[] = [DEMO_AUTHORIZED_KEY, DEMO_PACKAGE_MANAGER, demoSimulatedOutput('some unknown command')];
  const commands: string[] = [
    'pvesh get /nodes/$(hostname)/lxc --output-format json',
    'pvesh get /nodes/$(hostname)/qemu --output-format json',
    'pvesh get /nodes/$(hostname)/network --output-format json',
    'pvesh get /nodes/$(hostname)/storage --output-format json',
    'pct status 1003',
    'cat ~/.ssh/authorized_keys',
    'if command -v apt-get >/dev/null 2>&1; then echo apt; fi',
  ];
  for (const guest of inv.guests) {
    const pveType = guest.type === 'vm' ? 'qemu' : 'lxc';
    commands.push(`pvesh get /nodes/$(hostname)/${pveType}/${guest.vmid}/config --output-format json`);
  }
  for (const host of inv.hosts) {
    const target = { host: host.ssh_target, user: host.ssh_user };
    for (const command of commands) {
      const result = await ssh.exec(target, command);
      outputs.push(result.stdout, result.stderr);
    }
  }
  return outputs;
}

async function allDemoCatalogText(): Promise<string[]> {
  const slugs = [...DEMO_CATALOG_SLUGS.stable, ...DEMO_CATALOG_SLUGS.dev];
  const texts: string[] = [JSON.stringify(DEMO_CATALOG_SLUGS)];
  for (const slug of DEMO_CATALOG_SLUGS.stable) {
    texts.push(await (await demoFetch(`https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/${slug}.sh`)).text());
  }
  for (const slug of DEMO_CATALOG_SLUGS.dev) {
    texts.push(await (await demoFetch(`https://raw.githubusercontent.com/community-scripts/ProxmoxVED/main/ct/${slug}.sh`)).text());
  }
  assert.ok(slugs.length > 0);
  return texts;
}

test('example-data guard: the scanner flags a non-example IPv4 address and domain', () => {
  const bad = findNonExampleValues('reach 10.0.0.5 at nas.home.lan, prefix 172.16.0., also 192.0.2.7 and app.example.com');
  assert.ok(bad.includes('IPv4 10.0.0.5'), `expected 10.0.0.5 to be flagged, got ${bad.join('; ')}`);
  assert.ok(bad.includes('domain nas.home.lan'), `expected nas.home.lan to be flagged, got ${bad.join('; ')}`);
  assert.ok(bad.includes('IPv4 prefix 172.16.0.'), `expected 172.16.0. to be flagged, got ${bad.join('; ')}`);
  assert.equal(bad.length, 3, `expected only the three non-example values, got ${bad.join('; ')}`);
});

test('example-data guard: every demo value uses documentation IPs and example domains only', async () => {
  const sources: Array<[string, string]> = [
    ['demo inventory', JSON.stringify(buildDemoInventory())],
    ...Object.entries(DEMO_JOB_LOGS).map(([name, log]): [string, string] => [`job log ${name}`, log]),
    ...DEMO_JOB_DEFS.map((job): [string, string] => [`seeded job ${job.command}`, JSON.stringify(job)]),
    ['demo identity', JSON.stringify(DEMO_IDENTITY)],
    ['demo secret settings', JSON.stringify(DEMO_SECRET_SETTINGS)],
    ...(await allDemoSshOutputs()).map((out, i): [string, string] => [`DemoSSHClient output #${i}`, out]),
    ...(await allDemoCatalogText()).map((text, i): [string, string] => [`demo catalog #${i}`, text]),
  ];
  // Not a vacuous scan: the per-guest config answers really carry addresses.
  assert.ok(
    sources.some(([name, text]) => name.startsWith('DemoSSHClient') && text.includes('198.51.100.3/24')),
    'expected a DemoSSHClient config output carrying a guest IP'
  );
  const problems: string[] = [];
  for (const [name, text] of sources) {
    for (const bad of findNonExampleValues(text)) problems.push(`${name}: ${bad}`);
  }
  assert.deepEqual(problems, []);
});

test('example-data guard: every demo username and email is an example one', async () => {
  const usernames: Array<[string, string]> = [
    ...DEMO_JOB_DEFS.map((job): [string, string] => [`seeded job ${job.command} triggeredByUsername`, job.triggeredByUsername]),
    ['demo identity username', DEMO_IDENTITY.username],
  ];
  const badUsers = usernames.filter(([, user]) => !EXAMPLE_USERNAMES.has(user)).map(([where, user]) => `${where}: ${user}`);
  assert.deepEqual(badUsers, []);

  const texts = [
    JSON.stringify(buildDemoInventory()),
    JSON.stringify(DEMO_JOB_DEFS),
    JSON.stringify(DEMO_IDENTITY),
    ...(await allDemoSshOutputs()),
  ];
  const emails = texts.flatMap((text) => text.match(EMAIL_RE) ?? []);
  // The matcher itself: an ssh target is not an email, a real-looking one is.
  assert.deepEqual('ssh root@198.51.100.3 or me@home.lan'.match(EMAIL_RE), ['me@home.lan']);
  // Not vacuous: the demo identity carries the signed-in admin's email.
  assert.ok(emails.includes(DEMO_IDENTITY.email));
  const badEmails = emails.filter((email) => !email.toLowerCase().endsWith('@example.com'));
  assert.deepEqual(badEmails, []);
});

// Issue #64 (FR-027): the demo stores example secrets in the "set" state.
// Each must be obviously fake -- a recognisable demo-example- prefix rather
// than anything shaped like a real credential -- and the Authentik API
// token must stay unset, since the demo's injected Authentik client is
// unconfigured and a stored token plus URL would contradict it.
test('example-data guard: every demo secret is an obviously fake demo-example- value', () => {
  const entries = Object.entries(DEMO_SECRET_SETTINGS);
  assert.ok(entries.length >= 3, `expected the three seeded secrets, got ${entries.length}`);
  for (const [key, value] of entries) {
    assert.match(value ?? '', /^demo-example-[a-z-]+$/, `${key} is not an obviously fake demo-example- value`);
  }
  assert.equal(DEMO_SECRET_SETTINGS.authentikApiToken, undefined);
  assert.equal(buildDemoInventory().authentikApiUrl, undefined);
});

test('buildDemoInventory stores webUiAuthMode oidc rather than relying on WEB_UI_AUTH_MODE', () => {
  assert.equal(buildDemoInventory().webUiAuthMode, 'oidc');
});

test('buildDemoInventory stores example-only OIDC web login settings', () => {
  const inv = buildDemoInventory();
  assert.equal(inv.webUiOidcIssuer, 'https://authentik.example.com/application/o/bellhop/');
  assert.equal(inv.webUiOidcClientId, 'example-client-id');
  assert.equal(inv.webUiOidcRedirectUri, 'https://bellhop.example.com/auth/callback');
  assert.equal(DEMO_SECRET_SETTINGS.webUiOidcClientSecret, 'demo-example-client-secret');
});
