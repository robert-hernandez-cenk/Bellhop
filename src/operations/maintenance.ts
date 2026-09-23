import { z } from 'zod';
import { saveInventory, refreshInventory } from '../lib/inventory.ts';
import { selectTargets, type TargetSelector } from '../lib/targets.ts';
import { withCapturedConsole } from '../web/console-capture.ts';
import { runSyncInventory, formatSyncInventory } from '../commands/maintenance/sync-inventory.ts';
import { runUpdateAll } from '../commands/maintenance/update-all.ts';
import { runUpdateApp } from '../commands/maintenance/update-app.ts';
import { runGuestPower } from '../commands/maintenance/guest-power.ts';
import { runSetGuestVpn } from '../commands/provisioning/set-guest-vpn.ts';
import { runSyncSshKeys, formatSyncSshKeysResult } from '../commands/maintenance/sync-ssh-keys.ts';
import { runPushSshKey, formatPushSshKeyResult } from '../commands/maintenance/push-ssh-key.ts';
import { runSyncCaddy } from '../commands/networking/sync-caddy.ts';
import { formatFailureList } from '../lib/target-failure.ts';
import type { Operation } from './types.ts';
import { reqStr, optStr, flag } from './fields.ts';

// The web route has always received update-all's selector as one of three
// object shapes; MCP flattens them into optional fields, so exactly one must
// be set.
export function toTargetSelector(input: Record<string, any>): TargetSelector {
  const given = [input.host ? 1 : 0, input.all ? 1 : 0, input.group ? 1 : 0].reduce((a, b) => a + b, 0);
  if (given !== 1) throw new Error('Specify exactly one of host, all, or group');
  if (input.host) return { host: input.host };
  if (input.all) return { all: true };
  return { group: input.group };
}

export const MAINTENANCE_OPERATIONS: Record<string, Operation> = {
  'sync-inventory': {
    id: 'sync-inventory',
    category: 'maintenance',
    description: "Reconcile the inventory's guests, bridges, and storages with live Proxmox state.",
    shape: {},
    target: () => undefined,
    fleetWide: true,
    preview: async (_i, deps) => {
      const { text, result } = await withCapturedConsole(() => runSyncInventory({ apply: false }, deps));
      return [text, formatSyncInventory(result)].filter(Boolean).join('\n');
    },
    apply: async (_i, deps) => {
      const result = await runSyncInventory({ apply: true }, deps);
      // Issue #16: hosts/guests are deliberately replaced wholesale from the
      // live Proxmox state just queried, but the settings scalars (meta) are
      // not this command's to touch. Reload from disk before saving so a
      // setting another process changed while the SSH queries ran isn't
      // reverted to the job-start snapshot.
      refreshInventory(deps.inventory, deps.inventoryPath);
      saveInventory(deps.inventoryPath, { ...deps.inventory, guests: result.guests, hosts: result.hosts });
      // saveInventory only touches disk -- also refresh the shared in-memory
      // object so the next read doesn't re-diff a stale snapshot.
      deps.inventory.guests = result.guests;
      deps.inventory.hosts = result.hosts;
    },
  },
  'sync-caddy': {
    id: 'sync-caddy',
    category: 'maintenance',
    description: 'Generate and write Caddy reverse_proxy blocks from inventory subdomains, then reload Caddy.',
    shape: {},
    target: () => undefined,
    fleetWide: true,
    preview: async (_i, deps) => {
      const { text, result } = await withCapturedConsole(() => runSyncCaddy({ apply: false }, deps));
      return [text, result.block].filter(Boolean).join('\n');
    },
    apply: async (_i, deps) => {
      await runSyncCaddy({ apply: true }, deps);
    },
  },
  'update-app': {
    id: 'update-app',
    category: 'maintenance',
    description: "Re-run a guest's community-scripts ct/<app>.sh script inside it to update the app.",
    shape: { guest: reqStr('Guest name'), app: reqStr('community-scripts app slug') },
    target: (i) => i.guest,
    targetType: 'guest',
    preview: async (i, deps) => {
      const { text, result } = await withCapturedConsole(() => runUpdateApp({ ...(i as any), apply: false }, deps));
      return [text, result.script].filter(Boolean).join('\n');
    },
    apply: async (i, deps) => {
      await runUpdateApp({ ...(i as any), apply: true }, deps);
    },
  },
  'sync-ssh-keys': {
    id: 'sync-ssh-keys',
    category: 'maintenance',
    description: "Ensure each lxc guest's authorized_keys contains its parent host's keys.",
    shape: { host: optStr('Limit to one guest (optional)') },
    target: (i) => i.host || undefined,
    fleetWide: true,
    preview: async (i, deps) => {
      const { text, result } = await withCapturedConsole(() => runSyncSshKeys({ host: i.host, apply: false }, deps));
      return [text, formatSyncSshKeysResult(result)].filter(Boolean).join('\n');
    },
    apply: async (i, deps) => {
      const result = await runSyncSshKeys({ host: i.host, apply: true }, deps);
      console.log(formatSyncSshKeysResult(result));
      if (result.failConnect.length > 0 || result.failCommand.length > 0) {
        throw new Error(
          `sync-ssh-keys had failures -- failed to connect: ${formatFailureList(result.failConnect)}; command failed: ${result.failCommand.join(', ') || 'none'}`
        );
      }
    },
  },
  'update-all': {
    id: 'update-all',
    category: 'maintenance',
    description: 'Update OS packages on selected hosts/guests. Set exactly one of host, all, or group.',
    shape: {
      host: optStr('One host or guest name'),
      all: flag('Every host and guest'),
      group: z.enum(['pve', 'lxc', 'vm']).optional().describe('Every entry of one type'),
    },
    target: () => undefined,
    fleetWide: true,
    preview: async (i, deps) => {
      const targets = selectTargets(deps.inventory, toTargetSelector(i));
      return `Would update OS packages on: ${targets.join(', ')}`;
    },
    apply: async (i, deps) => {
      const result = await runUpdateAll(toTargetSelector(i), deps);
      if (result.failConnect.length > 0 || result.failCommand.length > 0 || result.failUnknownPm.length > 0) {
        throw new Error(
          `update-all had failures — failed to connect: ${formatFailureList(result.failConnect)}; command failed: ${result.failCommand.join(', ') || 'none'}; unknown package manager: ${result.failUnknownPm.join(', ') || 'none'}`
        );
      }
    },
  },
  'guest-power': {
    id: 'guest-power',
    category: 'maintenance',
    description: 'Start or shut down an lxc/vm guest.',
    shape: { guest: reqStr('Guest name'), state: z.enum(['start', 'shutdown']).describe('start or shutdown') },
    target: (i) => i.guest,
    targetType: 'guest',
    preview: async (i, deps) => {
      const { text, result } = await withCapturedConsole(() =>
        runGuestPower({ guest: i.guest, state: i.state, apply: false }, deps)
      );
      return [text, `Would run on ${i.guest}'s parent host: ${result.command}`].filter(Boolean).join('\n');
    },
    apply: async (i, deps) => {
      const { command, result } = await runGuestPower({ guest: i.guest, state: i.state, apply: true }, deps);
      console.log(`Ran on ${i.guest}'s parent host: ${command}`);
      if (result && result.code !== 0) {
        throw new Error(`guest-power ${i.state} failed on ${i.guest} (exit ${result.code}): ${result.stderr || result.stdout}`);
      }
    },
  },
  'set-guest-vpn': {
    id: 'set-guest-vpn',
    category: 'maintenance',
    description: "Route an lxc guest through a VPN gateway guest by name, or 'none' to restore the LAN gateway.",
    shape: { guest: reqStr('lxc guest name'), vpn: reqStr("VPN gateway guest name, or 'none'") },
    target: (i) => i.guest,
    targetType: 'guest',
    preview: async (i, deps) => {
      const { text, result } = await withCapturedConsole(() =>
        runSetGuestVpn({ guest: i.guest, vpn: i.vpn, apply: false }, deps)
      );
      return [text, result.netScript, result.dnsScript].filter(Boolean).join('\n');
    },
    apply: async (i, deps) => {
      const result = await runSetGuestVpn({ guest: i.guest, vpn: i.vpn, apply: true }, deps);
      console.log(`Ran on ${i.guest}: ${result.netScript}`);
    },
  },
  'push-ssh-key': {
    id: 'push-ssh-key',
    category: 'maintenance',
    description: 'Ensure one SSH public key is present on the listed guests.',
    shape: { key: reqStr('SSH public key'), guests: z.array(z.string()).describe('Guest names') },
    // No single target -- a comma-joined list would never match a permission
    // rule, so the job stays fleet-wide (admin-only visibility).
    target: () => undefined,
    fleetWide: true,
    preview: async (i, deps) => {
      const { text, result } = await withCapturedConsole(() =>
        runPushSshKey({ key: i.key, guests: i.guests, apply: false }, deps)
      );
      return [text, formatPushSshKeyResult(result)].filter(Boolean).join('\n');
    },
    apply: async (i, deps) => {
      const result = await runPushSshKey({ key: i.key, guests: i.guests, apply: true }, deps);
      console.log(formatPushSshKeyResult(result));
      if (result.failConnect.length > 0 || result.failCommand.length > 0) {
        throw new Error(
          `push-ssh-key had failures -- failed to connect: ${formatFailureList(result.failConnect)}; command failed: ${result.failCommand.join(', ') || 'none'}`
        );
      }
    },
  },
};
