import type { Operation } from './types.ts';
import { PROVISIONING_OPERATIONS } from './provisioning.ts';
import { MAINTENANCE_OPERATIONS } from './maintenance.ts';
import { NETWORKING_OPERATIONS } from './networking.ts';

export const OPERATIONS: Operation[] = [
  ...Object.values(PROVISIONING_OPERATIONS),
  ...Object.values(MAINTENANCE_OPERATIONS),
  ...Object.values(NETWORKING_OPERATIONS),
];

// migrate-nfs-mount has no remaining use (every guest is already migrated);
// the web UI hides it for the same reason and the CLI keeps it (#16).
export const MCP_EXCLUDED_OPERATION_IDS = ['migrate-nfs-mount'];

export const MCP_OPERATIONS: Operation[] = OPERATIONS.filter((op) => !MCP_EXCLUDED_OPERATION_IDS.includes(op.id));
