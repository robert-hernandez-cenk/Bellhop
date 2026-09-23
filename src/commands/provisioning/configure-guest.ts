import type { SSHClient } from '../../lib/ssh-client.ts';
import type { Inventory } from '../../lib/inventory.ts';
import { runRemote } from '../../lib/targets.ts';
import { confirmOrDryRun } from '../../lib/dry-run.ts';
import { shellQuote } from '../../lib/ssh-client.ts';
import { buildAuthorizedKeysEnsurePresentScript } from '../../lib/authorized-keys.ts';

export interface ConfigureGuestOptions {
  guest: string;
  packages?: string;
  sshKey?: string;
  apply?: boolean;
}

export async function runConfigureGuest(
  opts: ConfigureGuestOptions,
  deps: { ssh: SSHClient; inventory: Inventory }
): Promise<void> {
  if (!opts.packages && !opts.sshKey) {
    throw new Error('Specify at least one of --packages or --ssh-key');
  }
  const entryExists =
    deps.inventory.hosts.some((h) => h.name === opts.guest) || deps.inventory.guests.some((g) => g.name === opts.guest);
  if (!entryExists) {
    throw new Error(`Unknown inventory entry: ${opts.guest}`);
  }

  if (opts.packages) {
    const quoted = opts.packages.trim().split(/\s+/).map(shellQuote).join(' ');
    const cmd = `DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y ${quoted}`;
    if (confirmOrDryRun(`Would install on ${opts.guest}: ${opts.packages}`, opts.apply ?? false)) {
      await runRemote(deps.ssh, deps.inventory, opts.guest, cmd);
    }
  }

  if (opts.sshKey) {
    const cmd = buildAuthorizedKeysEnsurePresentScript(opts.sshKey);
    if (confirmOrDryRun(`Would ensure SSH key present on ${opts.guest}`, opts.apply ?? false)) {
      await runRemote(deps.ssh, deps.inventory, opts.guest, cmd);
    }
  }
}
