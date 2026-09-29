import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The Traefik driver's live-verified API fixtures (research.md, captured
// against a real Traefik 3.7.13 instance and redacted to example values
// per the constitution's Principle I) -- this file only checks the
// fixtures themselves are well-formed and example-only; the driver that
// reads them lands in a later phase.
const fixtureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'traefik');

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(fixtureDir, name), 'utf8'));
}

function fixtureFiles(): string[] {
  return readdirSync(fixtureDir).filter((f) => f.endsWith('.json'));
}

test('every fixture in test/fixtures/traefik/ parses as JSON', () => {
  const files = fixtureFiles();
  assert.ok(files.length > 0, 'expected at least one fixture file');
  for (const file of files) {
    assert.doesNotThrow(() => JSON.parse(readFileSync(path.join(fixtureDir, file), 'utf8')), `${file} must parse as JSON`);
  }
});

test('router-enabled.json reports status "enabled"', () => {
  const fixture = readFixture('router-enabled.json') as Record<string, unknown>;
  assert.equal(fixture.status, 'enabled');
});

test('router-disabled.json reports status "disabled" with a non-empty error array', () => {
  const fixture = readFixture('router-disabled.json') as Record<string, unknown>;
  assert.equal(fixture.status, 'disabled');
  assert.ok(Array.isArray(fixture.error), 'expected an error array');
  assert.ok((fixture.error as unknown[]).length > 0, 'expected the error array to be non-empty');
});

test('marker-present.json names a middleware starting with "bellhop-generation-"', () => {
  const fixture = readFixture('marker-present.json') as Record<string, unknown>;
  assert.equal(typeof fixture.name, 'string');
  assert.ok(
    (fixture.name as string).startsWith('bellhop-generation-'),
    `expected name to start with 'bellhop-generation-', got ${fixture.name}`
  );
});

// Constitution Principle I: no fixture may carry a real address or domain.
// Every IPv4-looking token must fall inside 192.0.2.0/24 (TEST-NET-1) or be
// the loopback address, and every FQDN-looking token must be example.com or
// a subdomain of it.
test('no fixture contains an address outside 192.0.2.0/24/127.0.0.1 or a domain other than example.com', () => {
  const ipPattern = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;
  const domainPattern = /\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.(?:com|net|org|io)\b/gi;

  for (const file of fixtureFiles()) {
    const raw = readFileSync(path.join(fixtureDir, file), 'utf8');

    for (const match of raw.matchAll(ipPattern)) {
      const ip = match[0];
      const ok = ip === '127.0.0.1' || ip.startsWith('192.0.2.');
      assert.ok(ok, `${file} contains a non-example address: ${ip}`);
    }

    for (const match of raw.matchAll(domainPattern)) {
      const domain = match[0].toLowerCase();
      const ok = domain === 'example.com' || domain.endsWith('.example.com');
      assert.ok(ok, `${file} contains a non-example domain: ${domain}`);
    }
  }
});
