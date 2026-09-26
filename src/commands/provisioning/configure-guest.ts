import type { SSHClient } from '../../lib/ssh-client.ts';
import type { Inventory } from '../../lib/inventory.ts';
import { runRemote } from '../../lib/targets.ts';
import { confirmOrDryRun } from '../../lib/dry-run.ts';
import { shellQuote } from '../../lib/ssh-client.ts';
import { buildAuthorizedKeysEnsurePresentScript } from '../../lib/authorized-keys.ts';
import { detectPackageManager, INSTALL_COMMANDS, UnknownPackageManagerError } from '../../lib/package-manager.ts';

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
    // Detection runs in dry run too (like create-lxc/install-app's own live
    // previews), so the preview names the exact command apply would send.
    const detection = await detectPackageManager(deps.ssh, deps.inventory, opts.guest);
    if (detection.kind === 'unknown') {
      throw new UnknownPackageManagerError(opts.guest);
    }
    if (detection.kind === 'probe-failed') {
      const probe = detection.result;
      throw new Error(
        `Package-manager probe failed on ${opts.guest} (exit ${probe.code}): ${probe.stderr.trim() || 'no output'}`
      );
    }
    const pm = detection.pm;
    const quoted = opts.packages.trim().split(/\s+/).map(shellQuote).join(' ');
    const cmd = INSTALL_COMMANDS[pm](quoted);
    if (confirmOrDryRun(`Would install on ${opts.guest} (${pm}): ${cmd}`, opts.apply ?? false)) {
      const result = await runRemote(deps.ssh, deps.inventory, opts.guest, cmd);
      if (result.code !== 0) {
        throw new Error(
          `Package install failed on ${opts.guest} (${pm}, exit ${result.code}): ${result.stderr.trim() || 'no output'}`
        );
      }
    }
  }

  if (opts.sshKey) {
    const cmd = buildAuthorizedKeysEnsurePresentScript(opts.sshKey);
    if (confirmOrDryRun(`Would ensure SSH key present on ${opts.guest}`, opts.apply ?? false)) {
      await runRemote(deps.ssh, deps.inventory, opts.guest, cmd);
    }
  }
}
