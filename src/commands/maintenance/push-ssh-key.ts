import type { SSHClient } from '../../lib/ssh-client.ts';
import type { Inventory } from '../../lib/inventory.ts';
import { runRemote } from '../../lib/targets.ts';
import { buildAuthorizedKeysEnsurePresentScript } from '../../lib/authorized-keys.ts';
import { logWarn } from '../../lib/log.ts';
import { errorMessage, formatFailureLines, type TargetFailure } from '../../lib/target-failure.ts';

export interface PushSshKeyOptions {
  guests: string[];
  key: string;
  apply?: boolean;
}

export interface PushSshKeyResult {
  key: string;
  targets: string[];
  applied: boolean;
  pass: string[];
  failConnect: TargetFailure[];
  failCommand: string[];
}

export async function runPushSshKey(
  opts: PushSshKeyOptions,
  deps: { ssh: SSHClient; inventory: Inventory }
): Promise<PushSshKeyResult> {
  if (!opts.key.trim()) {
    throw new Error('--key must not be empty');
  }
  if (opts.guests.length === 0) {
    throw new Error('Specify at least one guest');
  }
  for (const name of opts.guests) {
    const guest = deps.inventory.guests.find((g) => g.name === name);
    if (!guest || guest.type !== 'lxc') {
      throw new Error(`'${name}' is not an lxc guest in inventory`);
    }
  }

  const trimmedKey = opts.key.trim();

  if (!opts.apply) {
    return { key: trimmedKey, targets: opts.guests, applied: false, pass: [], failConnect: [], failCommand: [] };
  }

  const script = buildAuthorizedKeysEnsurePresentScript(trimmedKey);
  const pass: string[] = [];
  const failConnect: TargetFailure[] = [];
  const failCommand: string[] = [];
  for (const guestName of opts.guests) {
    try {
      const result = await runRemote(deps.ssh, deps.inventory, guestName, script);
      if (result.code === 0) {
        pass.push(guestName);
      } else {
        failCommand.push(guestName);
      }
    } catch (err) {
      const error = errorMessage(err);
      logWarn(`Failed to connect to ${guestName}: ${error}`);
      failConnect.push({ target: guestName, error });
    }
  }

  return { key: trimmedKey, targets: opts.guests, applied: true, pass, failConnect, failCommand };
}

export function formatPushSshKeyResult(result: PushSshKeyResult): string {
  if (!result.applied) {
    return `Would ensure '${result.key}' present on: ${result.targets.join(', ')}`;
  }
  return [
    'Summary:',
    `  OK: ${result.pass.join(' ') || 'none'}`,
    ...formatFailureLines('Failed to connect', result.failConnect),
    `  Command failed: ${result.failCommand.join(' ') || 'none'}`,
  ].join('\n');
}
