import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextAvailableMid, isMidUsed, MID_MIN, MID_MAX } from '../../web-client/src/lib/mid.ts';
import type { HostEntry } from '../../web-client/src/api/types.ts';

const pve1 = {
  name: 'pve1',
  ssh_target: 'pve1.local',
  ssh_user: 'root',
  midScheme: { vmidBase: 4000, ipPrefix: '192.168.1.', gateway: '192.168.1.1' },
} as HostEntry;
const noScheme = { name: 'pve2', ssh_target: 'pve2.local', ssh_user: 'root' } as HostEntry;

test('nextAvailableMid returns the lowest MID in range not in the occupied list', () => {
  assert.equal(nextAvailableMid(pve1, []), MID_MIN);
  assert.equal(nextAvailableMid(pve1, [2, 3]), 4);
  assert.equal(nextAvailableMid(pve1, [1, 3, 254]), 2);
});

test('nextAvailableMid returns null with no host, no midScheme, or an unknown occupied list', () => {
  assert.equal(nextAvailableMid(undefined, []), null);
  assert.equal(nextAvailableMid(noScheme, []), null);
  assert.equal(nextAvailableMid(pve1, undefined), null);
});

test('nextAvailableMid returns null when every MID in range is occupied', () => {
  const all = Array.from({ length: MID_MAX - MID_MIN + 1 }, (_, i) => MID_MIN + i);
  assert.equal(nextAvailableMid(pve1, all), null);
});

test('isMidUsed is true only for an MID in a known occupied list', () => {
  assert.equal(isMidUsed([2, 3], 2), true);
  assert.equal(isMidUsed([2, 3], 4), false);
  assert.equal(isMidUsed(undefined, 2), false);
});
