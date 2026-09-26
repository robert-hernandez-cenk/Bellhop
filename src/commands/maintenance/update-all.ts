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

export async function runUpdateAll(
  selector: TargetSelector,
  deps: { ssh: SSHClient; inventory: Inventory }
): Promise<UpdateAllResult> {
  const targets = selectTargets(deps.inventory, selector);
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
