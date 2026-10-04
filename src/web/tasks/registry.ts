import type { Inventory } from '../../lib/inventory.ts';
import { refreshInventory } from '../../lib/inventory.ts';
import type { SSHClient } from '../../lib/ssh-client.ts';
import { formatCheckAppUpdates, runCheckAppUpdates } from '../../commands/maintenance/check-app-updates.ts';

// What a task's run receives (data-model.md). `ssh` is the job's own
// JobSSHClient, so remote output streams into the job log; `inventory` is
// the web service's shared, mutable copy.
export interface TaskRunContext {
  ssh: SSHClient;
  inventory: Inventory;
  inventoryPath: string;
  fetchImpl?: typeof fetch;
  now: () => Date;
  // The job's cancellation signal (JobDefinition.run's second argument).
  signal?: AbortSignal;
}

// One scheduled task (FR-001). `command` is the job's command name in Job
// History; `defaultTime` is what a never-configured task uses (FR-002).
export interface TaskDefinition {
  id: string;
  label: string;
  description: string;
  defaultTime: string;
  command: string;
  run: (ctx: TaskRunContext) => Promise<void>;
}

export const TASKS: readonly TaskDefinition[] = [
  {
    id: 'check-app-updates',
    label: 'App update check',
    description: "Checks each LXC guest's community-scripts app for a newer upstream release.",
    defaultTime: '04:00',
    command: 'check-app-updates',
    run: async (ctx) => {
      // A queued job can start long after it was enqueued, and the scheduler
      // enqueues from a timer with no request to have reloaded inventory
      // first -- reload in place, same as src/operations/core.ts's enqueue().
      refreshInventory(ctx.inventory, ctx.inventoryPath);
      // Per-guest failures are results, not exceptions (research R9), so
      // the job only fails on something unexpected.
      const result = await runCheckAppUpdates(
        { apply: true },
        { ssh: ctx.ssh, inventory: ctx.inventory, inventoryPath: ctx.inventoryPath, fetchImpl: ctx.fetchImpl, now: ctx.now, signal: ctx.signal }
      );
      const lines = formatCheckAppUpdates(result);
      console.log(lines === '' ? 'No LXC guests with a community-scripts app recorded -- nothing to check.' : lines);
    },
  },
];
