import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextAvailableMid, isMidUsed, midCollisionMessage, MID_MIN, MID_MAX } from '../../web-client/src/lib/mid.ts';
import type { HostEntry, GuestEntry } from '../../web-client/src/api/types.ts';

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

const media = { name: 'media', type: 'lxc', host: 'pve1', vmid: 4003 } as GuestEntry;

test('midCollisionMessage names a visible guest holding the MID', () => {
  assert.equal(
    midCollisionMessage(pve1, '3', [2, 3], [media]),
    'MID 3 is already used by media (vmid 4003) on pve1.',
  );
});

test('midCollisionMessage warns without a name when no visible guest holds the occupied MID', () => {
  assert.equal(midCollisionMessage(pve1, '2', [2, 3], [media]), 'MID 2 is already in use on pve1.');
  // A guest on another host with the same vmid is not a match.
  const elsewhere = { ...media, host: 'pve2' } as GuestEntry;
  assert.equal(midCollisionMessage(pve1, '3', [3], [elsewhere]), 'MID 3 is already in use on pve1.');
});

test('midCollisionMessage is null when the MID is free or the answer is unknown', () => {
  assert.equal(midCollisionMessage(pve1, '4', [2, 3], [media]), null);
  assert.equal(midCollisionMessage(pve1, '3', undefined, [media]), null);
  assert.equal(midCollisionMessage(undefined, '3', [3], [media]), null);
  assert.equal(midCollisionMessage(noScheme, '3', [3], [media]), null);
  assert.equal(midCollisionMessage(pve1, '', [0, 3], [media]), null);
  assert.equal(midCollisionMessage(pve1, '3.5', [3], [media]), null);
});
