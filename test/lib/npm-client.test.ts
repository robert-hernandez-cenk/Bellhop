import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Inventory } from '../../src/lib/inventory.ts';
import {
  RealNpmClient,
  buildNpmClient,
  NPM_UNCONFIGURED_MESSAGE,
  NPM_REQUEST_TIMEOUT_MS,
  NPM_CERTIFICATE_TIMEOUT_MS,
} from '../../src/lib/npm-client.ts';

const fixtureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'nginx-proxy-manager');
function fixture(name: string): any {
  return JSON.parse(readFileSync(path.join(fixtureDir, name), 'utf8'));
}

// T001: these fixtures were captured from a real, live NPM instance and
// redacted per constitution Principle I. This assertion is what keeps that
// true as fixtures are added to or edited later -- a token, a PEM body, or a
// loopback address slipping back into a fixture fails the suite immediately
// rather than silently shipping real/local data in a public repo.
test('every nginx-proxy-manager fixture parses as JSON and carries no secret-shaped or loopback content', () => {
  const files = readdirSync(fixtureDir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length > 0, 'fixture directory must not be empty');
  for (const file of files) {
    const raw = readFileSync(path.join(fixtureDir, file), 'utf8');
    assert.doesNotThrow(() => JSON.parse(raw), `${file} must parse as JSON`);
    assert.ok(!raw.includes('-----BEGIN'), `${file} must not embed a PEM block`);
    assert.ok(!raw.includes('eyJ'), `${file} must not embed a JWT`);
    assert.ok(!raw.includes('127.0.0.1'), `${file} must not embed a loopback address`);
  }
});

const BASE_URL = 'http://192.0.2.30:81';

interface RecordedCall {
  url: string;
  method: string;
  authorization: string | null;
  body: unknown;
}

// Routes a stubbed fetch by "METHOD url" against a fixed table of canned
// responses -- unlike a queue, the same route can be hit more than once
// (needed to prove login runs only on the first call), and an unscripted
// call fails loudly instead of silently returning undefined.
function tableFetch(table: Record<string, { status: number; body: unknown }>) {
  const calls: RecordedCall[] = [];
  const impl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    calls.push({
      url,
      method,
      authorization: headers.get('Authorization'),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    const key = `${method} ${url}`;
    const entry = table[key];
    if (!entry) throw new Error(`unscripted fetch: ${key}`);
    return new Response(JSON.stringify(entry.body), { status: entry.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { impl, calls };
}

function loginOk(): Record<string, { status: number; body: unknown }> {
  return { [`POST ${BASE_URL}/api/tokens`]: fixture('token-create.json') };
}

test('RealNpmClient logs in once and sends Authorization: Bearer <token> on every later call', async () => {
  const { impl, calls } = tableFetch({
    ...loginOk(),
    [`GET ${BASE_URL}/api/nginx/proxy-hosts`]: fixture('proxy-hosts-list.json'),
  });
  const client = new RealNpmClient(BASE_URL, 'ops@example.com', 'secret', impl);
  await client.listProxyHosts();
  await client.listProxyHosts();

  const tokenCalls = calls.filter((c) => c.url.endsWith('/api/tokens'));
  assert.equal(tokenCalls.length, 1, 'login must happen once per client, not once per call');
  assert.deepEqual(tokenCalls[0].body, { identity: 'ops@example.com', secret: 'secret' });

  const listCalls = calls.filter((c) => c.url.endsWith('/api/nginx/proxy-hosts'));
  assert.equal(listCalls.length, 2);
  for (const call of listCalls) {
    assert.equal(call.authorization, `Bearer ${fixture('token-create.json').body.token}`);
  }
});

test('listProxyHosts parses the captured list, normalising locations: null to [] and reducing meta', async () => {
  const { impl } = tableFetch({
    ...loginOk(),
    [`GET ${BASE_URL}/api/nginx/proxy-hosts`]: fixture('proxy-hosts-list.json'),
  });
  const client = new RealNpmClient(BASE_URL, 'ops@example.com', 'secret', impl);
  const hosts = await client.listProxyHosts();
  assert.equal(hosts.length, 4);

  const plain = hosts.find((h) => h.id === 4)!;
  assert.deepEqual(plain.locations, [], 'locations: null must normalise to []');
  assert.deepEqual(plain.meta, { nginx_online: true, nginx_err: null });

  const owned = hosts.find((h) => h.id === 1)!;
  assert.deepEqual(owned.locations, []);
  // The raw fixture's meta also carries `bellhop: true`; the schema keeps
  // only nginx_online/nginx_err.
  assert.deepEqual(owned.meta, { nginx_online: true, nginx_err: null });
  assert.equal(Object.keys(owned.meta).includes('bellhop'), false);
});

test('listCertificates parses the captured list and drops meta entirely (never surfaces the private key)', async () => {
  const { impl } = tableFetch({
    ...loginOk(),
    [`GET ${BASE_URL}/api/nginx/certificates`]: fixture('certificates-list.json'),
  });
  const client = new RealNpmClient(BASE_URL, 'ops@example.com', 'secret', impl);
  const certs = await client.listCertificates();
  assert.equal(certs.length, 1);
  assert.deepEqual(certs[0], {
    id: 1,
    provider: 'other',
    nice_name: 'Wildcard example.test',
    domain_names: ['*.example.test'],
    expires_on: '2027-09-29 20:52:25',
  });
  assert.equal(Object.keys(certs[0]).includes('meta'), false, 'meta (which carries the private key) must never be parsed through');
});

test('createProxyHost returns the new id from the captured create response', async () => {
  const { impl, calls } = tableFetch({
    ...loginOk(),
    [`POST ${BASE_URL}/api/nginx/proxy-hosts`]: fixture('proxy-host-create.json'),
  });
  const client = new RealNpmClient(BASE_URL, 'ops@example.com', 'secret', impl);
  const result = await client.createProxyHost({
    domain_names: ['app.example.test', 'app2.example.test'],
    forward_scheme: 'http',
    forward_host: '192.0.2.20',
    forward_port: 81,
    certificate_id: 1,
    ssl_forced: true,
    http2_support: true,
    allow_websocket_upgrade: true,
    block_exploits: false,
    caching_enabled: false,
    hsts_enabled: false,
    hsts_subdomains: false,
    trust_forwarded_proto: false,
    access_list_id: 0,
    advanced_config: '# Managed by Bellhop sync-proxy. Do not edit: changes here are replaced on the next sync.',
    enabled: true,
    locations: [],
  });
  assert.deepEqual(result, { id: 1 });
  const createCall = calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/nginx/proxy-hosts'))!;
  assert.equal(createCall.authorization, `Bearer ${fixture('token-create.json').body.token}`);
});

test('deleteProxyHost accepts the captured delete response', async () => {
  const { impl } = tableFetch({
    ...loginOk(),
    [`DELETE ${BASE_URL}/api/nginx/proxy-hosts/1`]: fixture('proxy-host-delete.json'),
  });
  const client = new RealNpmClient(BASE_URL, 'ops@example.com', 'secret', impl);
  await assert.doesNotReject(client.deleteProxyHost(1));
});

test('a login 400 is reported with the contract message naming NPM_API_EMAIL/NPM_API_PASSWORD', async () => {
  const { impl } = tableFetch({ [`POST ${BASE_URL}/api/tokens`]: fixture('token-create-bad-password.json') });
  const client = new RealNpmClient(BASE_URL, 'ops@example.com', 'wrong', impl);
  await assert.rejects(
    client.listProxyHosts(),
    (err: Error) =>
      err.message ===
      `Nginx Proxy Manager at ${BASE_URL} rejected the login for ops@example.com: Invalid email or password -- check NPM_API_EMAIL/NPM_API_PASSWORD in data/nginx-proxy-manager.env`
  );
});

test('a duplicate-domain create failure maps to the exact contract error message', async () => {
  const { impl } = tableFetch({
    ...loginOk(),
    [`POST ${BASE_URL}/api/nginx/proxy-hosts`]: fixture('proxy-host-create-duplicate-domain.json'),
  });
  const client = new RealNpmClient(BASE_URL, 'ops@example.com', 'secret', impl);
  await assert.rejects(
    client.createProxyHost({
      domain_names: ['app.example.test'],
      forward_scheme: 'http',
      forward_host: '192.0.2.20',
      forward_port: 81,
      certificate_id: 0,
      ssl_forced: false,
      http2_support: false,
      allow_websocket_upgrade: false,
      block_exploits: false,
      caching_enabled: false,
      hsts_enabled: false,
      hsts_subdomains: false,
      trust_forwarded_proto: false,
      access_list_id: 0,
      advanced_config: '',
      enabled: true,
      locations: [],
    }),
    { message: 'Nginx Proxy Manager API 400 POST /api/nginx/proxy-hosts: app.example.test is already in use' }
  );
});

test('a failed Let\'s Encrypt certificate request includes the certbot debug.stack reason', async () => {
  const { impl } = tableFetch({
    ...loginOk(),
    [`POST ${BASE_URL}/api/nginx/certificates`]: fixture('certificate-request-letsencrypt-failure.json'),
  });
  const client = new RealNpmClient(BASE_URL, 'ops@example.com', 'secret', impl);
  await assert.rejects(
    client.requestCertificate(['le2.example.test']),
    /Unable to register an account with ACME server\. The ACME server believes admin@example\.com is an invalid email address\./
  );
});

test('a rejected fetch is reported as "Could not reach Nginx Proxy Manager at <baseUrl>: ..."', async () => {
  const impl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith('/api/tokens')) {
      return new Response(JSON.stringify(fixture('token-create.json').body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error('ECONNREFUSED');
  }) as typeof fetch;
  const client = new RealNpmClient(BASE_URL, 'ops@example.com', 'secret', impl);
  await assert.rejects(client.listProxyHosts(), (err: Error) => err.message === `Could not reach Nginx Proxy Manager at ${BASE_URL}: ECONNREFUSED`);
});

test('NPM_REQUEST_TIMEOUT_MS/NPM_CERTIFICATE_TIMEOUT_MS match the contract', () => {
  assert.equal(NPM_REQUEST_TIMEOUT_MS, 10_000);
  assert.equal(NPM_CERTIFICATE_TIMEOUT_MS, 180_000);
});

// -- buildNpmClient --------------------------------------------------------

function fixtureInventory(overrides: Partial<Inventory> = {}): Inventory {
  return {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: '192.0.2.1', ssh_user: 'root', ip: '192.0.2.30', proxy: true }],
    guests: [],
    ...overrides,
  };
}

const ENV_KEYS = ['NPM_API_URL', 'NPM_API_EMAIL', 'NPM_API_PASSWORD'] as const;

function withEnv(overrides: Partial<Record<(typeof ENV_KEYS)[number], string>>, fn: () => void): void {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  for (const key of ENV_KEYS) {
    const value = overrides[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('buildNpmClient throws NPM_UNCONFIGURED_MESSAGE when NPM_API_EMAIL or NPM_API_PASSWORD is missing', () => {
  withEnv({}, () => {
    assert.throws(() => buildNpmClient(fixtureInventory()), { message: NPM_UNCONFIGURED_MESSAGE });
  });
  withEnv({ NPM_API_EMAIL: 'ops@example.com' }, () => {
    assert.throws(() => buildNpmClient(fixtureInventory()), { message: NPM_UNCONFIGURED_MESSAGE });
  });
  withEnv({ NPM_API_PASSWORD: 'secret' }, () => {
    assert.throws(() => buildNpmClient(fixtureInventory()), { message: NPM_UNCONFIGURED_MESSAGE });
  });
});

test('buildNpmClient derives http://<proxy ip>:81 when NPM_API_URL is unset', () => {
  withEnv({ NPM_API_EMAIL: 'ops@example.com', NPM_API_PASSWORD: 'secret' }, () => {
    const client = buildNpmClient(fixtureInventory());
    assert.equal(client.baseUrl, 'http://192.0.2.30:81');
  });
});

test("buildNpmClient throws naming NPM_API_URL when no entry has 'proxy: true' with an ip", () => {
  withEnv({ NPM_API_EMAIL: 'ops@example.com', NPM_API_PASSWORD: 'secret' }, () => {
    assert.throws(
      () => buildNpmClient(fixtureInventory({ hosts: [{ name: 'pve1', ssh_target: '192.0.2.1', ssh_user: 'root' }] })),
      {
        message:
          "No NPM_API_URL is set and no inventory entry has 'proxy: true' with an ip -- set NPM_API_URL in data/nginx-proxy-manager.env",
      }
    );
  });
});

test('buildNpmClient strips a trailing / or /api from NPM_API_URL', () => {
  withEnv({ NPM_API_EMAIL: 'ops@example.com', NPM_API_PASSWORD: 'secret', NPM_API_URL: 'http://198.51.100.5:81/' }, () => {
    assert.equal(buildNpmClient(fixtureInventory()).baseUrl, 'http://198.51.100.5:81');
  });
  withEnv({ NPM_API_EMAIL: 'ops@example.com', NPM_API_PASSWORD: 'secret', NPM_API_URL: 'http://198.51.100.5:81/api' }, () => {
    assert.equal(buildNpmClient(fixtureInventory()).baseUrl, 'http://198.51.100.5:81');
  });
  withEnv({ NPM_API_EMAIL: 'ops@example.com', NPM_API_PASSWORD: 'secret', NPM_API_URL: 'http://198.51.100.5:81/api/' }, () => {
    assert.equal(buildNpmClient(fixtureInventory()).baseUrl, 'http://198.51.100.5:81');
  });
  withEnv({ NPM_API_EMAIL: 'ops@example.com', NPM_API_PASSWORD: 'secret', NPM_API_URL: 'http://198.51.100.5:81' }, () => {
    assert.equal(buildNpmClient(fixtureInventory()).baseUrl, 'http://198.51.100.5:81');
  });
});
