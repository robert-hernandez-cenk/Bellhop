import type { SSHClient, ExecResult } from '../../lib/ssh-client.ts';
import type { Inventory } from '../../lib/inventory.ts';
import { runRemote } from '../../lib/targets.ts';

export interface GuestPowerOptions {
  guest: string;
  state: 'start' | 'shutdown';
  apply?: boolean;
}

export interface GuestPowerResult {
  command: string;
  ran: boolean;
  result?: ExecResult;
}

function pctOrQm(type: 'lxc' | 'vm'): string {
  return type === 'lxc' ? 'pct' : 'qm';
}

export async function runGuestPower(
  opts: GuestPowerOptions,
  deps: { ssh: SSHClient; inventory: Inventory }
): Promise<GuestPowerResult> {
  if (opts.state !== 'start' && opts.state !== 'shutdown') {
    throw new Error(`--state must be 'start' or 'shutdown', got: ${opts.state}`);
  }

  const guest = deps.inventory.guests.find((g) => g.name === opts.guest);
  if (!guest || (guest.type !== 'lxc' && guest.type !== 'vm')) {
    throw new Error(`'${opts.guest}' is not an lxc/vm guest in inventory`);
  }

  const tool = pctOrQm(guest.type);
  const command =
    opts.state === 'shutdown' ? `${tool} shutdown ${guest.vmid} --timeout 120` : `${tool} start ${guest.vmid}`;

  if (!opts.apply) {
    return { command, ran: false };
  }

  const result = await runRemote(deps.ssh, deps.inventory, guest.host, command);
  return { command, ran: true, result };
}
