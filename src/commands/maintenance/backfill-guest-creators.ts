import { refreshInventory, saveInventory, type GuestCreator, type GuestEntry, type Inventory } from '../../lib/inventory.ts';
import { resolveMid } from '../../lib/targets.ts';
import type { AuthentikClient, AuthentikUser } from '../../lib/authentik-client.ts';
import type { JobRow, JobStore } from '../../web/jobs/job-store.ts';

// One-time migration (issue #58, research.md R8): attributes guests that
// predate the `creator` field to whoever triggered the successful web-UI
// create job that made them, read from data/jobs.sqlite3. CLI-only by design.

// Which job commands create a guest, and which args_json key holds the
// guest's name for each (the raw form/tool input the job recorded).
const NAME_KEY: Record<string, 'hostname' | 'name'> = {
  'create-lxc': 'hostname',
  'install-app': 'hostname',
  'create-vm': 'name',
  'deploy-vpn-gateway': 'name',
};

// MCP jobs record this literal instead of a person (FR-014).
const MCP_ACTOR = 'mcp';

export type BackfillSkipReason =
  | 'unknown-user'
  | 'no-matching-guest'
  | 'already-has-creator'
  | 'unparseable-args'
  | 'superseded';

export interface BackfillUpdate {
  guest: string;
  host: string;
  vmid: number;
  username: string;
  // Absent when Authentik reported no uid for the user -- the creator is
  // then recorded by username alone.
  uid?: string;
  jobId: number;
}

export interface BackfillSkip {
  jobId: number;
  command: string;
  reason: BackfillSkipReason;
  detail: string;
}

export interface BackfillReport {
  updates: BackfillUpdate[];
  skipped: BackfillSkip[];
  applied: boolean;
}

export interface BackfillOptions {
  // Raw `--map old=new` values, in the order given.
  maps: string[];
  apply: boolean;
}

export interface BackfillDeps {
  inventory: Inventory;
  inventoryPath: string;
  jobStore: JobStore;
  authentik: AuthentikClient;
}

export function parseLoginMaps(maps: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const pair of maps) {
    const eq = pair.indexOf('=');
    const from = eq === -1 ? '' : pair.slice(0, eq);
    const to = eq === -1 ? '' : pair.slice(eq + 1);
    if (!from || !to) {
      throw new Error(`Invalid --map '${pair}' (expected old=new, with both sides non-empty)`);
    }
    result.set(from, to);
  }
  return result;
}

type ParsedJob = { host: string; vmid: number; name: string };

function parseJobArgs(job: JobRow, inventory: Inventory): ParsedJob | string {
  let args: unknown;
  try {
    args = JSON.parse(job.argsJson);
  } catch {
    return 'args are not valid JSON';
  }
  if (!args || typeof args !== 'object') return 'args are not an object';
  const record = args as Record<string, unknown>;
  const nameKey = NAME_KEY[job.command];
  const host = record.host;
  const name = record[nameKey];
  const mid = record.mid;
  if (typeof host !== 'string' || !host) return 'missing host';
  if (typeof name !== 'string' || !name) return `missing ${nameKey}`;
  if ((typeof mid !== 'string' && typeof mid !== 'number') || mid === '') return 'missing mid';
  try {
    return { host, name, vmid: resolveMid(inventory, host, Number(mid)).vmid };
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

const guestKey = (g: { host: string; vmid: number; name: string }) => `${g.host}\u0000${g.vmid}\u0000${g.name}`;

export async function runBackfillGuestCreators(opts: BackfillOptions, deps: BackfillDeps): Promise<BackfillReport> {
  const loginMaps = parseLoginMaps(opts.maps);
  // Fails first, with the client's own "not configured" message, when
  // Authentik isn't set up -- a username-only record would reintroduce the
  // rename problem the uid exists to solve (research.md R8).
  const directory = await deps.authentik.listUsers();
  const byUsername = new Map<string, AuthentikUser>(directory.map((u) => [u.username, u]));

  const guestsByKey = new Map<string, GuestEntry>(deps.inventory.guests.map((g) => [guestKey(g), g]));
  // Guest key -> the newest job that claimed it, so older ones report
  // which job superseded them.
  const claimedBy = new Map<string, number>();
  const updates: BackfillUpdate[] = [];
  const skipped: BackfillSkip[] = [];
  const skip = (job: JobRow, reason: BackfillSkipReason, detail: string) =>
    skipped.push({ jobId: job.id, command: job.command, reason, detail });

  // Newest first (FR-012): the first job to match a guest wins it.
  const candidates = deps.jobStore
    .listSuccessfulByCommands(Object.keys(NAME_KEY))
    .filter((job) => job.triggeredByUsername !== null && job.triggeredByUsername !== MCP_ACTOR);

  for (const job of candidates) {
    const parsed = parseJobArgs(job, deps.inventory);
    if (typeof parsed === 'string') {
      skip(job, 'unparseable-args', parsed);
      continue;
    }
    const key = guestKey(parsed);
    const target = guestsByKey.get(key);
    if (!target) {
      skip(job, 'no-matching-guest', `${parsed.name} on ${parsed.host}, vmid ${parsed.vmid}`);
      continue;
    }
    if (target.creator) {
      skip(job, 'already-has-creator', target.name);
      continue;
    }
    const newer = claimedBy.get(key);
    if (newer !== undefined) {
      skip(job, 'superseded', `${target.name} (newer job ${newer})`);
      continue;
    }
    claimedBy.set(key, job.id);

    const recorded = job.triggeredByUsername!;
    const login = loginMaps.get(recorded) ?? recorded;
    const user = byUsername.get(login);
    if (!user) {
      const via = login === recorded ? recorded : `${recorded} -> ${login}`;
      skip(job, 'unknown-user', `${via}; pass --map ${recorded}=<current username>`);
      continue;
    }
    updates.push({
      guest: target.name,
      host: target.host,
      vmid: target.vmid,
      username: user.username,
      ...(user.uid ? { uid: user.uid } : {}),
      jobId: job.id,
    });
  }

  if (opts.apply && updates.length > 0) {
    refreshInventory(deps.inventory, deps.inventoryPath);
    const pending = new Map(updates.map((u) => [guestKey({ host: u.host, vmid: u.vmid, name: u.guest }), u]));
    const guests = deps.inventory.guests.map((g) => {
      const u = pending.get(guestKey(g));
      // Re-checked against the freshly reloaded inventory: never overwrite a
      // creator that appeared since planning (FR-014).
      if (!u || g.creator) return g;
      const creator: GuestCreator = { username: u.username, ...(u.uid ? { uid: u.uid } : {}) };
      return { ...g, creator };
    });
    saveInventory(deps.inventoryPath, { ...deps.inventory, guests });
  }

  return { updates, skipped, applied: opts.apply };
}

export function formatBackfillGuestCreators(report: BackfillReport): string {
  const lines = [
    `${report.applied ? 'Recorded' : 'Would record'} creators for ${report.updates.length} guest(s):`,
    ...report.updates.map((u) => `  + ${u.guest} (${u.host}, vmid ${u.vmid}): ${u.username}  [job ${u.jobId}]`),
  ];
  if (report.skipped.length > 0) {
    lines.push(
      `Skipped ${report.skipped.length} job(s):`,
      ...report.skipped.map((s) => `  - job ${s.jobId} ${s.command}: ${s.reason} (${s.detail})`)
    );
  }
  if (!report.applied) lines.push('Dry run -- re-run with --apply to write these.');
  return lines.join('\n');
}
