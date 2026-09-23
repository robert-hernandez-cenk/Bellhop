import type { z } from 'zod';
import type { SSHClient } from '../lib/ssh-client.ts';
import type { Inventory } from '../lib/inventory.ts';
import type { AuthentikClient } from '../lib/authentik-client.ts';
import type { CloudflareClient } from '../lib/cloudflare-client.ts';
import type { GoBuilder } from '../lib/go-build.ts';

// Everything any operation's preview/apply may need -- the union of what the
// web routes' separate Deps types carried before #16 moved these handlers
// here. goBuilder/fetchImpl/tlsProbeSleepFn are test-only injection points,
// undefined in production.
export interface OperationDeps {
  ssh: SSHClient;
  inventory: Inventory;
  inventoryPath: string;
  authentik: AuthentikClient;
  // Required, not optional: syncCaddyLive treats a missing client as
  // unconfigured and silently skips the stale _acme-challenge prune (#162),
  // so every place that builds OperationDeps must pass one explicitly.
  cloudflare: CloudflareClient;
  goBuilder?: GoBuilder;
  fetchImpl?: typeof fetch;
  tlsProbeSleepFn?: (ms: number) => Promise<void>;
}

// One toolkit action with a dry-run preview and a real apply, shared by the
// web routes and the MCP server (#16). `shape` is the single definition of
// its inputs: the web adapters parse request bodies through it and the MCP
// server publishes it as the tool's input schema. Field builders in
// fields.ts accept both the web form's string encoding and typed values.
export interface Operation {
  id: string;
  category: 'provisioning' | 'maintenance';
  description: string;
  shape: z.ZodRawShape;
  // Called with either a raw request body or parsed input -- target fields
  // are plain strings either way, which lets the web adapters run their
  // permission check before parsing (same ordering as before #16).
  target(input: Record<string, any>): string | undefined;
  targetType?: 'host' | 'guest';
  // No single target: admin-only on the web (sync-inventory, sync-caddy, ...).
  fleetWide?: boolean;
  // Input fields holding credentials -- redacted from stored job args and
  // scrubbed from MCP tool results.
  secretFields?: string[];
  // Fields accepted from the web route (test-speed knobs) that the MCP
  // server leaves out of the tool's input schema.
  internalFields?: string[];
  // install-app only: its job watches for interactive prompts (#57/#160).
  watchForPrompts?: boolean;
  preview(input: Record<string, any>, deps: OperationDeps): Promise<string>;
  // Runs inside a job; deps.ssh is that job's JobSSHClient.
  apply(input: Record<string, any>, deps: OperationDeps): Promise<void>;
}
