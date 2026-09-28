import type { SSHClient } from '../../lib/ssh-client.ts';
import type { Inventory } from '../../lib/inventory.ts';
import { runRemote, selectTargets, type TargetSelector } from '../../lib/targets.ts';
import { logInfo, logWarn } from '../../lib/log.ts';
import { UPDATE_COMMANDS, detectPackageManager, PROBED_COMMANDS } from '../../lib/package-manager.ts';
import { errorMessage, formatFailureLines, type TargetFailure } from '../../lib/target-failure.ts';

export interface UpdateAllResult {
  pass: string[];
  failConnect: TargetFailure[];
  failCommand: string[];
  failUnknownPm: string[];
}

// The one place update-all's targets are decided (operator PR feedback,
// issue #2: the package update/install mechanism must never act on VMs).
// `{ all: true }` silently excludes every vm guest rather than erroring --
// an operator running --all wants "everything this toolkit can safely
// update", not a failure over a VM that happens to also be in inventory.
// `{ group: 'vm' }` and `{ host: <vm-name> }` are explicit operator
// requests to target a VM, so those reject outright instead of silently
// doing nothing. Every other selector shape delegates to the generic
// selectTargets unchanged (including its unknown-host error).
export function selectUpdateTargets(inv: Inventory, selector: TargetSelector): string[] {
  if ('all' in selector) {
    return [...inv.hosts.map((h) => h.name), ...inv.guests.filter((g) => g.type !== 'vm').map((g) => g.name)];
  }
  if ('group' in selector && selector.group === 'vm') {
    throw new Error('update-all does not update VMs; update packages inside the VM itself');
  }
  if ('host' in selector) {
    const guest = inv.guests.find((g) => g.name === selector.host);
    if (guest?.type === 'vm') {
      throw new Error(
        `update-all does not update VMs (${selector.host} is a VM); update packages inside the VM itself`
      );
    }
  }
  return selectTargets(inv, selector);
}

export async function runUpdateAll(
  selector: TargetSelector,
  deps: { ssh: SSHClient; inventory: Inventory }
): Promise<UpdateAllResult> {
  const targets = selectUpdateTargets(deps.inventory, selector);
  if (targets.length === 0) {
    throw new Error('No targets matched');
  }

  const pass: string[] = [];
  const failConnect: TargetFailure[] = [];
  const failCommand: string[] = [];
  const failUnknownPm: string[] = [];

  for (const target of targets) {
    try {
      // Probe first, so nothing is ever attempted against a target whose
      // package manager we could not identify -- a `failCommand` caused by
      // running the wrong manager is exactly the bug this replaces.
      const detection = await detectPackageManager(deps.ssh, deps.inventory, target);
      if (detection.kind === 'probe-failed') {
        // The shell ran but the probe itself broke. Not the same thing as an
        // unrecognized OS, so it belongs in failCommand rather than
        // failUnknownPm.
        const probe = detection.result;
        logWarn(
          `Package-manager probe failed on ${target} (exit ${probe.code}): ${probe.stderr.trim() || 'no output'}`
        );
        failCommand.push(target);
        continue;
      }

      if (detection.kind === 'unknown') {
        logWarn(`No known package manager on ${target} (tried ${PROBED_COMMANDS})`);
        failUnknownPm.push(target);
        continue;
      }

      const pm = detection.pm;
      logInfo(`Updating ${target} (${pm})...`);
      const result = await runRemote(deps.ssh, deps.inventory, target, UPDATE_COMMANDS[pm]);
      if (result.code === 0) {
        pass.push(target);
      } else {
        failCommand.push(target);
      }
    } catch (err) {
      const error = errorMessage(err);
      logWarn(`Failed to connect to ${target}: ${error}`);
      failConnect.push({ target, error });
    }
  }

  return { pass, failConnect, failCommand, failUnknownPm };
}

export function formatUpdateAll(result: UpdateAllResult): string {
  return [
    'Summary:',
    `  OK: ${result.pass.join(' ') || 'none'}`,
    ...formatFailureLines('Failed to connect', result.failConnect),
    `  Command failed: ${result.failCommand.join(' ') || 'none'}`,
    `  Unknown package manager: ${result.failUnknownPm.join(' ') || 'none'}`,
  ].join('\n');
}
