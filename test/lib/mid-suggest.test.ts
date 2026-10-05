import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MidSchemeSchema, type HostEntry } from '../../src/lib/inventory.ts';
import { suggestMidScheme } from '../../src/lib/mid-suggest.ts';

function host(name: string, midScheme?: HostEntry['midScheme']): HostEntry {
  return { name, ssh_target: `${name}.example.test`, ssh_user: 'root', ...(midScheme ? { midScheme } : {}) };
}

test('suggests the bridge network: prefix, CIDR and gateway, with vmidBase 1000 on the first host', () => {
  const suggestion = suggestMidScheme({ address: '192.0.2.10', prefixLength: 24, gateway: '192.0.2.1' }, []);
  assert.deepEqual(suggestion, { vmidBase: 1000, ipPrefix: '192.0.2.', cidrSuffix: 24, gateway: '192.0.2.1' });
  assert.equal(MidSchemeSchema.safeParse(suggestion).success, true);
});

test('vmidBase is the smallest multiple of 1000 no other host uses', () => {
  const others = [
    host('pve1', { vmidBase: 1000, ipPrefix: '10.0.1.', gateway: '10.0.0.1' }),
    host('pve2', { vmidBase: 3000, ipPrefix: '10.0.3.', gateway: '10.0.0.1' }),
  ];
  const suggestion = suggestMidScheme({ address: '10.0.0.12', prefixLength: 16, gateway: '10.0.0.1' }, others);
  assert.equal(suggestion?.vmidBase, 2000);
});

test('in a network wider than /24, a prefix another host uses moves to the next free third octet', () => {
  const others = [host('pve1', { vmidBase: 1000, ipPrefix: '10.0.0.', gateway: '10.0.0.1' })];
  const suggestion = suggestMidScheme({ address: '10.0.0.12', prefixLength: 16, gateway: '10.0.0.1' }, others);
  assert.equal(suggestion?.ipPrefix, '10.0.1.');
  assert.equal(suggestion?.cidrSuffix, 16);
});

test('in a /24, a prefix another host uses is still suggested (saving it names the clash)', () => {
  const others = [host('pve1', { vmidBase: 1000, ipPrefix: '192.0.2.', gateway: '192.0.2.1' })];
  const suggestion = suggestMidScheme({ address: '192.0.2.11', prefixLength: 24, gateway: '192.0.2.1' }, others);
  assert.equal(suggestion?.ipPrefix, '192.0.2.');
});

test('no bridge address means no suggestion', () => {
  assert.equal(suggestMidScheme(undefined, []), undefined);
});
