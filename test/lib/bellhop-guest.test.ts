import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Inventory } from '../../src/lib/inventory.ts';
import { assertNotBellhopGuest, isBellhopGuest } from '../../src/lib/bellhop-guest.ts';

const base: Inventory = {
  domain: 'example.com',
  hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
  guests: [
    { name: 'bellhop', type: 'lxc', vmid: 110, host: 'pve1' },
    { name: 'media', type: 'lxc', vmid: 105, host: 'pve1' },
  ],
};
const guarded: Inventory = { ...base, bellhopGuest: 'bellhop' };

test('isBellhopGuest is false for every name when bellhopGuest is unset', () => {
  assert.equal(isBellhopGuest(base, 'bellhop'), false);
  assert.equal(isBellhopGuest(base, 'media'), false);
});

test('isBellhopGuest matches only the exact name bellhopGuest holds', () => {
  assert.equal(isBellhopGuest(guarded, 'bellhop'), true);
  assert.equal(isBellhopGuest(guarded, 'media'), false);
  assert.equal(isBellhopGuest(guarded, 'Bellhop'), false);
});

test('a bellhopGuest naming no inventory entry guards nothing', () => {
  const inv: Inventory = { ...base, bellhopGuest: 'not-in-inventory' };
  assert.equal(isBellhopGuest(inv, 'bellhop'), false);
  assert.doesNotThrow(() => assertNotBellhopGuest(inv, 'bellhop', 'delete'));
});

test('assertNotBellhopGuest refuses the own guest, naming the setting and how to change it', () => {
  assert.throws(
    () => assertNotBellhopGuest(guarded, 'bellhop', 'shut down'),
    (err: Error) => {
      assert.equal(
        err.message,
        "Refusing to shut down 'bellhop': it is Bellhop's own guest (the bellhopGuest setting), so doing that would disrupt the running Bellhop service. " +
          'Act on it in Proxmox directly, or update Bellhop with its own update script. ' +
          'If the setting names the wrong guest, change it with "bellhop set-config bellhopGuest <name> --apply" or on the Settings page.'
      );
      return true;
    }
  );
});

test('assertNotBellhopGuest lets every other guest through', () => {
  assert.doesNotThrow(() => assertNotBellhopGuest(guarded, 'media', 'update'));
  assert.doesNotThrow(() => assertNotBellhopGuest(base, 'bellhop', 'migrate'));
});
