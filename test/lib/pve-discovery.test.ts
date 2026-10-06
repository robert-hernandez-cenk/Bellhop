import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clusterPeers, parseVersion, primaryBridgeAddress } from '../../src/lib/pve-discovery.ts';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/proxmox/${name}.json`, import.meta.url), 'utf8');

test('parseVersion returns the version from a captured /version response', () => {
  assert.equal(parseVersion(fixture('version')), '9.2.10');
});

test('parseVersion rejects non-JSON and JSON without a version', () => {
  assert.throws(() => parseVersion('command not found: pvesh'), /Proxmox/);
  assert.throws(() => parseVersion('{"release":"9.2"}'), /Proxmox/);
});

test('clusterPeers returns the non-local nodes with name and address', () => {
  assert.deepEqual(clusterPeers(fixture('cluster-status')), [{ name: 'pve2', address: '192.0.2.11' }]);
});

test('clusterPeers returns none for a standalone node', () => {
  assert.deepEqual(clusterPeers(fixture('cluster-status-standalone')), []);
});

test('primaryBridgeAddress picks the active bridge carrying an address and a gateway', () => {
  assert.deepEqual(primaryBridgeAddress(fixture('network')), {
    address: '192.0.2.10',
    prefixLength: 24,
    gateway: '192.0.2.1',
  });
});

test('primaryBridgeAddress is undefined when no bridge has an IPv4 address and gateway', () => {
  assert.equal(primaryBridgeAddress(JSON.stringify([{ iface: 'enp1s0', type: 'eth', active: 1 }])), undefined);
  const noGateway = [{ iface: 'vmbr1', type: 'bridge', active: 1, address: '198.51.100.2', cidr: '198.51.100.2/24' }];
  assert.equal(primaryBridgeAddress(JSON.stringify(noGateway)), undefined);
});

test('primaryBridgeAddress prefers an active bridge with a gateway', () => {
  const network = JSON.stringify([
    { iface: 'vmbr1', type: 'bridge', active: 0, address: '198.51.100.2', cidr: '198.51.100.2/24', gateway: '198.51.100.1' },
    { iface: 'vmbr0', type: 'bridge', active: 1, address: '192.0.2.10', cidr: '192.0.2.10/24', gateway: '192.0.2.1' },
  ]);
  assert.equal(primaryBridgeAddress(network)?.address, '192.0.2.10');
});
