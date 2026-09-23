import type { SSHClient } from '../../lib/ssh-client.ts';
import type { Inventory } from '../../lib/inventory.ts';
import { runRemote, selectTargets } from '../../lib/targets.ts';
import { readHostAuthorizedKeys, buildAuthorizedKeysEnsurePresentScript } from '../../lib/authorized-keys.ts';
import { logWarn } from '../../lib/log.ts';
import { errorMessage, formatFailureLines, type TargetFailure } from '../../lib/target-failure.ts';

export interface SyncSshKeysOptions {
  host?: string;
  apply?: boolean;
}

export interface GuestSyncPlan {
  guest: string;
  host: string;
  script?: string;
}

export interface SyncSshKeysResult {
  plans: GuestSyncPlan[];
  applied: boolean;
  pass: string[];
  failConnect: TargetFailure[];
  failCommand: string[];
}

export async function runSyncSshKeys(
  opts: SyncSshKeysOptions,
  deps: { ssh: SSHClient; inventory: Inventory }
): Promise<SyncSshKeysResult> {
  let targets: string[];
  if (opts.host) {
    const guest = deps.inventory.guests.find((g) => g.name === opts.host);
    if (!guest || guest.type !== 'lxc') {
      throw new Error(`'${opts.host}' is not an lxc guest in inventory`);
    }
    targets = [opts.host];
  } else {
    targets = selectTargets(deps.inventory, { group: 'lxc' });
  }
  if (targets.length === 0) {
    throw new Error('No lxc guests found in inventory');
  }

  const hostKeysCache = new Map<string, string | undefined>();
  const plans: GuestSyncPlan[] = [];
  for (const targetName of targets) {
    const guest = deps.inventory.guests.find((g) => g.name === targetName)!;
    if (!hostKeysCache.has(guest.host)) {
      hostKeysCache.set(guest.host, await readHostAuthorizedKeys(deps.ssh, deps.inventory, guest.host));
    }
    const hostKeys = hostKeysCache.get(guest.host);
    plans.push({
      guest: targetName,
      host: guest.host,
      script: hostKeys ? buildAuthorizedKeysEnsurePresentScript(hostKeys) : undefined,
    });
  }

  if (!opts.apply) {
    return { plans, applied: false, pass: [], failConnect: [], failCommand: [] };
  }

  const pass: string[] = [];
  const failConnect: TargetFailure[] = [];
  const failCommand: string[] = [];
  for (const plan of plans) {
    if (!plan.script) continue;
    try {
      const result = await runRemote(deps.ssh, deps.inventory, plan.guest, plan.script);
      if (result.code === 0) {
        pass.push(plan.guest);
      } else {
        failCommand.push(plan.guest);
      }
    } catch (err) {
      const error = errorMessage(err);
      logWarn(`Failed to connect to ${plan.guest}: ${error}`);
      failConnect.push({ target: plan.guest, error });
    }
  }

  return { plans, applied: true, pass, failConnect, failCommand };
}

export function formatSyncSshKeysResult(result: SyncSshKeysResult): string {
  const lines: string[] = [];
  for (const plan of result.plans) {
    if (plan.script) {
      lines.push(`${plan.guest} (${plan.host}): key(s) to ensure present`);
      lines.push(plan.script);
    } else {
      lines.push(`${plan.guest} (${plan.host}): no authorized_keys on ${plan.host} -- skipped`);
    }
  }
  if (result.applied) {
    lines.push('Summary:');
    lines.push(`  OK: ${result.pass.join(' ') || 'none'}`);
    lines.push(...formatFailureLines('Failed to connect', result.failConnect));
    lines.push(`  Command failed: ${result.failCommand.join(' ') || 'none'}`);
    if (result.failCommand.length > 0 || result.failConnect.length > 0) {
      lines.push(
        'Note: a guest in "Command failed" or "Failed to connect" may simply be stopped -- pct exec/qm guest exec against a stopped guest always fails.'
      );
    }
  } else {
    const pending = result.plans.filter((p) => p.script).length;
    const skipped = result.plans.length - pending;
    lines.push(`Summary: ${pending} guest(s) would be updated, ${skipped} skipped (no host keys)`);
  }
  return lines.join('\n');
}
