import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Inventory } from '../../src/lib/inventory.ts';
import {
  STALE_AFTER_MS,
  isAcmeChallengeName,
  runPruneAcmeChallenges,
  formatPruneAcmeChallenges,
} from '../../src/commands/networking/prune-acme-challenges.ts';
import { FakeCloudflareClient, txtRecord } from '../support/fake-cloudflare-client.ts';

const inventory: Inventory = { domain: 'example.com', hosts: [], guests: [] };
const NOW = new Date('2026-09-12T12:00:00.000000Z');
const ZONES = { 'example.com': 'zone-1' };

// Microsecond precision, matching the captured fixture's timestamp format.
function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * 3_600_000).toISOString().replace('Z', '123Z');
}

test('STALE_AFTER_MS is 24 hours', () => {
  assert.equal(STALE_AFTER_MS, 24 * 60 * 60 * 1000);
});

test('isAcmeChallengeName accepts apex and subdomain challenge names, case-insensitively', () => {
  assert.equal(isAcmeChallengeName('_acme-challenge.example.com', 'example.com'), true);
  assert.equal(isAcmeChallengeName('_acme-challenge.sonarr.example.com', 'example.com'), true);
  assert.equal(isAcmeChallengeName('_acme-challenge.a.b.example.com', 'example.com'), true);
  assert.equal(isAcmeChallengeName('_ACME-Challenge.Sonarr.Example.COM', 'example.com'), true);
});

test('isAcmeChallengeName rejects lookalikes and other zones', () => {
  assert.equal(isAcmeChallengeName('x_acme-challenge.example.com', 'example.com'), false);
  assert.equal(isAcmeChallengeName('sonarr._acme-challenge.example.com', 'example.com'), false);
  assert.equal(isAcmeChallengeName('_acme-challenge.sonarr.notexample.com', 'example.com'), false);
  assert.equal(isAcmeChallengeName('_acme-challenge.example.com.evil.test', 'example.com'), false);
  assert.equal(isAcmeChallengeName('_acme-challengeexample.com', 'example.com'), false);
  assert.equal(isAcmeChallengeName('_dmarc.example.com', 'example.com'), false);
  assert.equal(isAcmeChallengeName('example.com', 'example.com'), false);
  // A regex metacharacter in the domain must be literal.
  assert.equal(isAcmeChallengeName('_acme-challenge.exampleXcom', 'example.com'), false);
});

test('--apply deletes challenge records older than 24h and leaves newer ones', async () => {
  const cloudflare = new FakeCloudflareClient({
    zones: ZONES,
    records: [
      txtRecord('old', '_acme-challenge.sonarr.example.com', hoursAgo(30)),
      txtRecord('new', '_acme-challenge.plex.example.com', hoursAgo(1)),
    ],
  });
  const result = await runPruneAcmeChallenges({ apply: true, now: NOW }, { cloudflare, inventory });

  assert.equal(result.applied, true);
  assert.deepEqual(result.deleted, ['_acme-challenge.sonarr.example.com']);
  assert.deepEqual(result.stale.map((s) => s.name), ['_acme-challenge.sonarr.example.com']);
  assert.deepEqual(result.tooRecent.map((s) => s.name), ['_acme-challenge.plex.example.com']);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(cloudflare.records.map((r) => r.id), ['new']);
});

test('dry run reports the same stale list and deletes nothing', async () => {
  const cloudflare = new FakeCloudflareClient({
    zones: ZONES,
    records: [txtRecord('old', '_acme-challenge.sonarr.example.com', hoursAgo(30))],
  });
  const result = await runPruneAcmeChallenges({ now: NOW }, { cloudflare, inventory });

  assert.equal(result.applied, false);
  assert.deepEqual(result.stale.map((s) => s.name), ['_acme-challenge.sonarr.example.com']);
  assert.deepEqual(result.deleted, []);
  assert.equal(cloudflare.history.some((h) => h.startsWith('deleteDnsRecord')), false);
});

test('the 24h boundary is exclusive: exactly 24h old is left alone, just over is stale', async () => {
  const cloudflare = new FakeCloudflareClient({
    zones: ZONES,
    records: [
      txtRecord('exact', '_acme-challenge.a.example.com', new Date(NOW.getTime() - STALE_AFTER_MS).toISOString()),
      txtRecord('over', '_acme-challenge.b.example.com', new Date(NOW.getTime() - STALE_AFTER_MS - 1000).toISOString()),
    ],
  });
  const result = await runPruneAcmeChallenges({ now: NOW }, { cloudflare, inventory });
  assert.deepEqual(result.stale.map((s) => s.name), ['_acme-challenge.b.example.com']);
  assert.deepEqual(result.tooRecent.map((s) => s.name), ['_acme-challenge.a.example.com']);
});

test('records that are not _acme-challenge names are never reported or deleted', async () => {
  const cloudflare = new FakeCloudflareClient({
    zones: ZONES,
    records: [
      txtRecord('dmarc', '_dmarc.example.com', hoursAgo(5000)),
      txtRecord('apex', 'example.com', hoursAgo(5000)),
      txtRecord('other-zone', '_acme-challenge.sonarr.other.test', hoursAgo(5000)),
    ],
  });
  const result = await runPruneAcmeChallenges({ apply: true, now: NOW }, { cloudflare, inventory });
  assert.deepEqual(result.stale, []);
  assert.deepEqual(result.tooRecent, []);
  assert.equal(cloudflare.records.length, 3);
});

test('a non-TXT record at an _acme-challenge name (DNS-01 delegation CNAME) is never touched', async () => {
  const cname = { ...txtRecord('cname', '_acme-challenge.nas.example.com', hoursAgo(5000)), type: 'CNAME' };
  // Bypass the fake's own TXT filter to prove the command checks type itself.
  const cloudflare = new FakeCloudflareClient({ zones: ZONES });
  cloudflare.listTxtRecords = async () => [cname];
  const result = await runPruneAcmeChallenges({ apply: true, now: NOW }, { cloudflare, inventory });
  assert.deepEqual(result.stale, []);
  assert.equal(cloudflare.history.some((h) => h.startsWith('deleteDnsRecord')), false);
});

test('a stale record managed by Cloudflare (meta.read_only/auto_added) is never reported or deleted', async () => {
  const cloudflare = new FakeCloudflareClient({
    zones: ZONES,
    records: [{ ...txtRecord('managed', '_acme-challenge.sonarr.example.com', hoursAgo(5000)), managedByCloudflare: true }],
  });
  const result = await runPruneAcmeChallenges({ apply: true, now: NOW }, { cloudflare, inventory });
  assert.deepEqual(result.stale, []);
  assert.deepEqual(result.tooRecent, []);
  assert.equal(cloudflare.history.some((h) => h.startsWith('deleteDnsRecord')), false);
});

test('a record with no parseable modifiedOn is reported as too recent and never deleted', async () => {
  const cloudflare = new FakeCloudflareClient({
    zones: ZONES,
    records: [
      txtRecord('missing', '_acme-challenge.a.example.com', undefined),
      txtRecord('garbage', '_acme-challenge.b.example.com', 'not-a-date'),
    ],
  });
  const result = await runPruneAcmeChallenges({ apply: true, now: NOW }, { cloudflare, inventory });
  assert.deepEqual(result.stale, []);
  assert.deepEqual(result.tooRecent, [
    { name: '_acme-challenge.a.example.com', ageHours: undefined },
    { name: '_acme-challenge.b.example.com', ageHours: undefined },
  ]);
  assert.equal(cloudflare.records.length, 2);
});

test('a failed delete is recorded and later deletes still happen', async () => {
  const cloudflare = new FakeCloudflareClient({
    zones: ZONES,
    records: [
      txtRecord('bad', '_acme-challenge.a.example.com', hoursAgo(30)),
      txtRecord('good', '_acme-challenge.b.example.com', hoursAgo(30)),
    ],
    failDeleteIds: ['bad'],
  });
  const result = await runPruneAcmeChallenges({ apply: true, now: NOW }, { cloudflare, inventory });
  assert.deepEqual(result.failed, [{ name: '_acme-challenge.a.example.com', error: 'simulated delete failure for bad' }]);
  assert.deepEqual(result.deleted, ['_acme-challenge.b.example.com']);
});

test('ageHours is rounded to one decimal place', async () => {
  const cloudflare = new FakeCloudflareClient({
    zones: ZONES,
    records: [txtRecord('old', '_acme-challenge.a.example.com', new Date(NOW.getTime() - 30.26 * 3_600_000).toISOString())],
  });
  const result = await runPruneAcmeChallenges({ now: NOW }, { cloudflare, inventory });
  assert.deepEqual(result.stale, [{ name: '_acme-challenge.a.example.com', ageHours: 30.3 }]);
});

test('throws naming the domain and required scopes when the zone is not found', async () => {
  const cloudflare = new FakeCloudflareClient({ zones: {} });
  await assert.rejects(
    runPruneAcmeChallenges({ now: NOW }, { cloudflare, inventory }),
    /Cloudflare zone 'example\.com' not found.*Zone:Read and DNS:Edit/
  );
});

test('a listing error propagates', async () => {
  const cloudflare = new FakeCloudflareClient({ zones: ZONES, listError: new Error('Cloudflare API 403: Authentication error') });
  await assert.rejects(runPruneAcmeChallenges({ now: NOW }, { cloudflare, inventory }), /Cloudflare API 403/);
});

test('formatPruneAcmeChallenges prints stale, recent, deleted, and failed sections', () => {
  const text = formatPruneAcmeChallenges({
    domain: 'example.com',
    stale: [{ name: '_acme-challenge.a.example.com', ageHours: 30.3 }, { name: '_acme-challenge.b.example.com', ageHours: 48 }],
    tooRecent: [{ name: '_acme-challenge.c.example.com', ageHours: 0.5 }, { name: '_acme-challenge.d.example.com' }],
    deleted: ['_acme-challenge.b.example.com'],
    failed: [{ name: '_acme-challenge.a.example.com', error: 'boom' }],
    applied: true,
  });
  assert.equal(
    text,
    [
      'Zone: example.com',
      'Stale _acme-challenge TXT records (older than 24h): 2',
      '  - _acme-challenge.a.example.com (30.3h old)',
      '  - _acme-challenge.b.example.com (48h old)',
      'Recent _acme-challenge TXT records left alone: 2',
      '  = _acme-challenge.c.example.com (0.5h old)',
      '  = _acme-challenge.d.example.com (age unknown)',
      'Deleted: 1',
      'Failed: 1',
      '  ! _acme-challenge.a.example.com — boom',
    ].join('\n')
  );
});

test('formatPruneAcmeChallenges omits empty optional sections on a dry run', () => {
  const text = formatPruneAcmeChallenges({
    domain: 'example.com',
    stale: [],
    tooRecent: [],
    deleted: [],
    failed: [],
    applied: false,
  });
  assert.equal(text, ['Zone: example.com', 'Stale _acme-challenge TXT records (older than 24h): 0'].join('\n'));
});
