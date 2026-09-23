import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RealCloudflareClient,
  UnconfiguredCloudflareClient,
  buildCloudflareClient,
  CLOUDFLARE_UNCONFIGURED_MESSAGE,
  CLOUDFLARE_REQUEST_TIMEOUT_MS,
} from '../../src/lib/cloudflare-client.ts';

const fixtureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'cloudflare');
function fixture(name: string): any {
  return JSON.parse(readFileSync(path.join(fixtureDir, name), 'utf8'));
}

interface RecordedCall {
  url: string;
  method: string;
  authorization: string | null;
  signal: AbortSignal | null | undefined;
}

// Replays one canned response per call, in order, recording what was asked.
function scriptedFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: RecordedCall[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      authorization: headers.get('Authorization'),
      signal: init?.signal,
    });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected extra fetch: ${String(input)}`);
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { impl, calls };
}

test('UnconfiguredCloudflareClient reports unconfigured and rejects every call', async () => {
  const client = new UnconfiguredCloudflareClient();
  assert.equal(client.isConfigured(), false);
  await assert.rejects(client.findZoneId('example.com'), { message: CLOUDFLARE_UNCONFIGURED_MESSAGE });
  await assert.rejects(client.listTxtRecords('z'), { message: CLOUDFLARE_UNCONFIGURED_MESSAGE });
  await assert.rejects(client.deleteDnsRecord('z', 'r'), { message: CLOUDFLARE_UNCONFIGURED_MESSAGE });
});

test('CLOUDFLARE_UNCONFIGURED_MESSAGE names the env var and the file', () => {
  assert.equal(
    CLOUDFLARE_UNCONFIGURED_MESSAGE,
    'Cloudflare API not configured (set CLOUDFLARE_DNS_API_TOKEN in data/cloudflare-api.env)'
  );
});

test('buildCloudflareClient picks the real client only when CLOUDFLARE_DNS_API_TOKEN is non-empty', () => {
  assert.equal(buildCloudflareClient({}).isConfigured(), false);
  assert.equal(buildCloudflareClient({ CLOUDFLARE_DNS_API_TOKEN: '' }).isConfigured(), false);
  // Caddy's and cloudflare-ddns's variable must not stand in for this one.
  assert.equal(buildCloudflareClient({ CLOUDFLARE_API_TOKEN: 'caddy-token' }).isConfigured(), false);
  assert.equal(buildCloudflareClient({ CLOUDFLARE_DNS_API_TOKEN: 'tok' }).isConfigured(), true);
});

test('RealCloudflareClient.findZoneId looks the zone up by name with a bearer token', async () => {
  const { impl, calls } = scriptedFetch([{ status: 200, body: fixture('zones-by-name.json') }]);
  const client = new RealCloudflareClient('secret-token', impl);
  assert.equal(await client.findZoneId('example.com'), '023e105f4ecef8ad9ca31a8372d0c353');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url, 'https://api.cloudflare.com/client/v4/zones?name=example.com');
  assert.equal(calls[0].authorization, 'Bearer secret-token');
});

test('CLOUDFLARE_REQUEST_TIMEOUT_MS is 10 seconds', () => {
  assert.equal(CLOUDFLARE_REQUEST_TIMEOUT_MS, 10_000);
});

test('every request passes an AbortSignal so a stalled connection cannot hang forever', async () => {
  const { impl, calls } = scriptedFetch([{ status: 200, body: fixture('zones-by-name.json') }]);
  await new RealCloudflareClient('t', impl).findZoneId('example.com');
  assert.ok(calls[0].signal instanceof AbortSignal);
  assert.equal(calls[0].signal!.aborted, false);
});

test('RealCloudflareClient.findZoneId returns undefined when no zone matches', async () => {
  const empty = { ...fixture('zones-by-name.json'), result: [] };
  const { impl } = scriptedFetch([{ status: 200, body: empty }]);
  assert.equal(await new RealCloudflareClient('t', impl).findZoneId('missing.test'), undefined);
});

test('RealCloudflareClient.listTxtRecords maps the captured record shape to camelCase', async () => {
  const { impl, calls } = scriptedFetch([{ status: 200, body: fixture('dns-records-txt.json') }]);
  const records = await new RealCloudflareClient('t', impl).listTxtRecords('zone-1');
  assert.equal(calls[0].url, 'https://api.cloudflare.com/client/v4/zones/zone-1/dns_records?type=TXT&per_page=100&page=1');
  assert.equal(records.length, 3);
  assert.deepEqual(records[1], {
    id: '372e67954025e0ba6aaa6d586b9e0b60',
    name: '_dmarc.example.com',
    type: 'TXT',
    content: '"redacted-txt-value-2"',
    createdOn: '2026-09-06T12:42:14.681375Z',
    modifiedOn: '2026-09-06T12:42:14.681375Z',
    managedByCloudflare: false,
  });
  // The captured microsecond-precision timestamp must parse.
  assert.equal(Number.isNaN(Date.parse(records[1].modifiedOn!)), false);
});

test('RealCloudflareClient.listTxtRecords marks a record with meta.read_only as managed by Cloudflare', async () => {
  const { impl } = scriptedFetch([{ status: 200, body: fixture('dns-records-txt.json') }]);
  const records = await new RealCloudflareClient('t', impl).listTxtRecords('zone-1');
  // The captured fixture's first record carries meta: { email_routing: true, read_only: true }.
  assert.equal(records[0].id, '372e67954025e0ba6aaa6d586b9e0b59');
  assert.equal(records[0].managedByCloudflare, true);
});

test('RealCloudflareClient.listTxtRecords marks a record with meta.auto_added as managed by Cloudflare', async () => {
  const body = fixture('dns-records-txt.json');
  body.result = [{ ...body.result[1], meta: { auto_added: true } }];
  const { impl } = scriptedFetch([{ status: 200, body }]);
  const records = await new RealCloudflareClient('t', impl).listTxtRecords('zone-1');
  assert.equal(records[0].managedByCloudflare, true);
});

test('RealCloudflareClient.listTxtRecords follows result_info.total_pages', async () => {
  const page1 = fixture('dns-records-txt.json');
  page1.result_info = { ...page1.result_info, total_pages: 2 };
  const page2 = fixture('dns-records-txt.json');
  page2.result = [{ ...page2.result[0], id: 'page-two-record', name: '_acme-challenge.example.com' }];
  page2.result_info = { ...page2.result_info, page: 2, count: 1, total_pages: 2 };
  const { impl, calls } = scriptedFetch([
    { status: 200, body: page1 },
    { status: 200, body: page2 },
  ]);
  const records = await new RealCloudflareClient('t', impl).listTxtRecords('zone-1');
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /&page=2$/);
  assert.equal(records.length, 4);
  assert.equal(records[3].id, 'page-two-record');
});

test('RealCloudflareClient.deleteDnsRecord sends DELETE to the record URL', async () => {
  const { impl, calls } = scriptedFetch([
    { status: 200, body: { result: { id: 'rec-1' }, success: true, errors: [], messages: [] } },
  ]);
  await new RealCloudflareClient('t', impl).deleteDnsRecord('zone-1', 'rec-1');
  assert.equal(calls[0].method, 'DELETE');
  assert.equal(calls[0].url, 'https://api.cloudflare.com/client/v4/zones/zone-1/dns_records/rec-1');
});

test('RealCloudflareClient turns a captured success:false error into a readable message', async () => {
  const { impl } = scriptedFetch([{ status: 400, body: fixture('error-no-route.json') }]);
  await assert.rejects(new RealCloudflareClient('t', impl).deleteDnsRecord('zone-1', 'nope'), /^Error: Cloudflare API 400: No route for that URI/);
});

test('RealCloudflareClient treats a 200 with success:false as an error', async () => {
  const { impl } = scriptedFetch([{ status: 200, body: fixture('error-no-route.json') }]);
  await assert.rejects(new RealCloudflareClient('t', impl).findZoneId('example.com'), /Cloudflare API 200: No route for that URI/);
});

test('RealCloudflareClient reports a non-JSON error body by status alone', async () => {
  const impl = (async () => new Response('<html>bad gateway</html>', { status: 502 })) as typeof fetch;
  await assert.rejects(new RealCloudflareClient('t', impl).findZoneId('example.com'), /Cloudflare API 502:/);
});
