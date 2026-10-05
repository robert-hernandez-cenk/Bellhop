import type { Inventory } from './inventory.ts';

// The guest Bellhop itself runs in, named by the bellhopGuest setting (issue
// #67). Updating its app, deleting, migrating, starting or shutting it down
// would cut off the service performing the action, so those commands refuse
// it outright -- in a dry run too, and with no override -- and update-all
// skips it. Checked inside each command's run* function, so the CLI, the web
// UI and the MCP server all refuse the same way.
export type BellhopGuestAction = 'update' | 'delete' | 'migrate' | 'start' | 'shut down';

export function isBellhopGuest(inventory: Inventory, name: string): boolean {
  return inventory.bellhopGuest !== undefined && inventory.bellhopGuest === name;
}

export function assertNotBellhopGuest(inventory: Inventory, name: string, action: BellhopGuestAction): void {
  if (!isBellhopGuest(inventory, name)) return;
  throw new Error(
    `Refusing to ${action} '${name}': it is Bellhop's own guest (the bellhopGuest setting), so doing that would disrupt the running Bellhop service. ` +
      'Act on it in Proxmox directly, or update Bellhop with its own update script. ' +
      'If the setting names the wrong guest, change it with "bellhop set-config bellhopGuest <name> --apply" or on the Settings page.'
  );
}
