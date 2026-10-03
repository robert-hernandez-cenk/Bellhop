// The only module that knows how a Bellhop user maps to a Proxmox user and
// how per-guest Proxmox ACLs are read and written (issue #53). Its callers
// are the create-vm operation (granting a newly created guest's creator
// access to it) and runMigrateGuest (copying an existing guest's ACLs onto
// its new VMID after a migration) -- see
// specs/016-pve-creator-acl/contracts/pve-acl.md. Every remote call goes
// through runRemote against a pve host.
import { z } from 'zod';
import type { Inventory } from './inventory.ts';
import type { SSHClient } from './ssh-client.ts';
import { shellQuote } from './ssh-client.ts';
import { runRemote } from './targets.ts';
import { logInfo, logWarn } from './log.ts';

export const DEFAULT_CREATOR_ROLE = 'PVEVMAdmin';

export interface Actor {
  username: string;
  email?: string;
}

// Only the two fields buildRealmReadCommand's host-side filter prints. A
// pve/pam realm has no username claim at all, which the filter prints as
// null.
export const RealmInfoSchema = z.object({
  type: z.string(),
  'username-claim': z.string().nullable().optional(),
});
export type RealmInfo = z.infer<typeof RealmInfoSchema>;

// The realm response carries the OIDC client secret (`client-key`) in clear
// text, and every exec inside a job streams its stdout into the job log, so
// the filtering happens on the host: only `type` and `username-claim` are
// ever printed (research R2). Targets a pve host, so it runs in the host's
// bash login shell, where pipefail is available.
export function buildRealmReadCommand(realm: string): string {
  return (
    `set -o pipefail; pvesh get ${shellQuote(`/access/domains/${realm}`)} --output-format json | ` +
    `perl -MJSON::PP -e 'my $d = decode_json(join "", <STDIN>); print encode_json({ type => $d->{type}, "username-claim" => $d->{"username-claim"} }), "\\n"'`
  );
}

// The user part of a Proxmox user ID can't contain whitespace, ':' or '/'
// (research R8).
const UNSAFE_USER_PART = /[\s:/]/;

// Maps the creator onto the Proxmox user ID the realm itself will give them
// on their first OIDC login (research R1). Anything this can't map is a
// `skip` carrying the full warning text, naming the fix.
export function pveUserIdFor(realm: string, info: RealmInfo, actor: Actor): { userid: string } | { skip: string } {
  if (info.type !== 'openid') {
    return {
      skip: `Skipping Proxmox creator grant: realm '${realm}' is type '${info.type}', not openid -- set pveUserRealm to an OpenID realm`,
    };
  }
  const claim = info['username-claim'];
  let name: string;
  if (claim === 'username') {
    name = actor.username;
  } else if (claim === 'email') {
    if (!actor.email) {
      return {
        skip: `Skipping Proxmox creator grant: realm '${realm}' names users by email, but no email is known for '${actor.username}'`,
      };
    }
    name = actor.email;
  } else {
    return {
      skip: `Skipping Proxmox creator grant: realm '${realm}' names users by '${claim ?? 'subject (default)'}' -- set its username claim to 'username' or 'email' in Proxmox (Datacenter > Permissions > Realms)`,
    };
  }
  if (UNSAFE_USER_PART.test(name)) {
    return {
      skip: `Skipping Proxmox creator grant: '${name}' can't be part of a Proxmox user ID (contains whitespace, ':' or '/')`,
    };
  }
  return { userid: `${name}@${realm}` };
}

// Pre-creates the user when missing (an OpenID realm's autocreate only does
// so on first login), then grants the role on the guest's own path
// (research R3). Also the manual commands a failed grant's warning prints.
export function buildGrantScript(userid: string, vmid: number, role: string): string {
  return [
    `pvesh get ${shellQuote(`/access/users/${userid}`)} >/dev/null 2>&1 || pveum user add ${shellQuote(userid)} --comment ${shellQuote(`Created by Bellhop for VM ${vmid}`)}`,
    `pveum acl modify ${shellQuote(`/vms/${vmid}`)} --users ${shellQuote(userid)} --roles ${shellQuote(role)}`,
  ].join('\n');
}

function creatorRole(inventory: Inventory): string {
  return inventory.pveCreatorRole ?? DEFAULT_CREATOR_ROLE;
}

// A preview makes no remote call, so it can't know the user ID yet (that
// needs the realm read) -- it names the person and realm instead.
export function creatorGrantPreview(inventory: Inventory, actor: Actor | undefined, vmid: number): string | undefined {
  const realm = inventory.pveUserRealm;
  if (!realm) return undefined;
  if (!actor) return 'No Proxmox creator grant: no signed-in user (only web UI jobs carry one)';
  return `Would grant ${creatorRole(inventory)} on /vms/${vmid} to ${actor.username}'s Proxmox account (realm ${realm})`;
}

// Never throws and logs exactly one line, so a caller can run it in a
// `finally` without masking an earlier error (research R7).
export async function grantCreatorAccess(
  ssh: SSHClient,
  inventory: Inventory,
  host: string,
  vmid: number,
  actor: Actor | undefined
): Promise<'granted' | 'off' | 'no-actor' | 'skipped' | 'failed'> {
  const realm = inventory.pveUserRealm;
  if (!realm) {
    logInfo(
      'Proxmox creator grant is off -- set pveUserRealm (bellhop set-config pveUserRealm <realm> --apply, or the web UI\'s Settings page) to grant VM creators access in Proxmox'
    );
    return 'off';
  }
  if (!actor) {
    logInfo(`No Proxmox creator grant for VM ${vmid}: no signed-in user (only web UI jobs carry one)`);
    return 'no-actor';
  }
  const role = creatorRole(inventory);
  let script: string | undefined;
  let userid: string | undefined;
  try {
    const read = await runRemote(ssh, inventory, host, buildRealmReadCommand(realm));
    const parsed = read.code === 0 ? RealmInfoSchema.safeParse(safeJson(read.stdout)) : undefined;
    if (!parsed?.success) {
      const detail = read.code !== 0 ? (read.stderr || read.stdout).trim() : 'unexpected output';
      logWarn(
        `Skipping Proxmox creator grant: couldn't read realm '${realm}' (exit ${read.code}): ${detail} -- check that pveUserRealm names an existing OpenID realm (bellhop set-config pveUserRealm <realm> --apply, or the web UI's Settings page)`
      );
      return 'skipped';
    }
    const id = pveUserIdFor(realm, parsed.data, actor);
    if ('skip' in id) {
      logWarn(id.skip);
      return 'skipped';
    }
    userid = id.userid;
    script = buildGrantScript(userid, vmid, role);
    const result = await runRemote(ssh, inventory, host, script);
    if (result.code !== 0) {
      logWarn(
        `Failed to grant ${role} on VM ${vmid} to ${userid} (exit ${result.code}): ${(result.stderr || result.stdout).trim()} -- run on ${host} by hand:\n${script}`
      );
      return 'failed';
    }
    logInfo(`Granted ${role} on VM ${vmid} to ${userid}`);
    return 'granted';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (script && userid) {
      logWarn(`Failed to grant ${role} on VM ${vmid} to ${userid}: ${message} -- run on ${host} by hand:\n${script}`);
      return 'failed';
    }
    logWarn(
      `Skipping Proxmox creator grant: couldn't read realm '${realm}': ${message} -- check that pveUserRealm names an existing OpenID realm (bellhop set-config pveUserRealm <realm> --apply, or the web UI's Settings page)`
    );
    return 'skipped';
  }
}

// One entry of `pvesh get /access/acl` (research R5).
export const AclEntrySchema = z.object({
  path: z.string(),
  type: z.enum(['user', 'group', 'token']),
  ugid: z.string(),
  roleid: z.string(),
  propagate: z.union([z.literal(0), z.literal(1)]),
});
export type AclEntry = z.infer<typeof AclEntrySchema>;

// `pvesh get /access/acl` returns every permission in the cluster, other
// people's user IDs included, and a job streams stdout into its log -- so the
// host prints only the entries on exactly /vms/<vmid> (research R5). The
// vmid goes into the perl program unquoted, so it must be a plain integer.
export function buildGuestAclReadCommand(vmid: number): string {
  if (!Number.isInteger(vmid) || vmid < 0) {
    throw new Error(`buildGuestAclReadCommand needs a non-negative integer vmid, got: ${vmid}`);
  }
  return (
    `set -o pipefail; pvesh get /access/acl --output-format json | ` +
    `perl -MJSON::PP -e 'my $d = decode_json(join "", <STDIN>); print encode_json([grep { $_->{path} eq "/vms/${vmid}" } @$d]), "\\n"'`
  );
}

// Filters again in Node, so a misbehaving host-side filter can't widen the
// copy (research R5).
export function aclsForVmid(entries: AclEntry[], vmid: number): AclEntry[] {
  return entries.filter((e) => e.path === `/vms/${vmid}`);
}

const ACL_TYPE_FLAG: Record<AclEntry['type'], string> = { user: '--users', group: '--groups', token: '--tokens' };

// Re-creates each entry on the new VMID. `set -e` stops at the first
// failure. Also the manual commands a failed copy's warning prints.
export function buildAclCopyScript(entries: AclEntry[], newVmid: number): string {
  return [
    'set -e',
    ...entries.map(
      (e) =>
        `pveum acl modify ${shellQuote(`/vms/${newVmid}`)} ${ACL_TYPE_FLAG[e.type]} ${shellQuote(e.ugid)} --roles ${shellQuote(e.roleid)} --propagate ${e.propagate}`
    ),
  ].join('\n');
}

// Never throws and logs exactly one line, so a migration that has already
// verified its new guest is never failed by a permission copy.
export async function copyGuestAcls(
  ssh: SSHClient,
  inventory: Inventory,
  host: string,
  oldVmid: number,
  newVmid: number
): Promise<'copied' | 'none' | 'failed'> {
  const from = `/vms/${oldVmid}`;
  const to = `/vms/${newVmid}`;
  const readFix = `-- check pveum acl list on ${host} and re-create any permissions on ${to} by hand`;
  let script: string | undefined;
  try {
    const read = await runRemote(ssh, inventory, host, buildGuestAclReadCommand(oldVmid));
    const parsed = read.code === 0 ? z.array(AclEntrySchema).safeParse(safeJson(read.stdout)) : undefined;
    if (!parsed?.success) {
      const detail = read.code !== 0 ? (read.stderr || read.stdout).trim() : 'unexpected output';
      logWarn(`Couldn't read the permissions on ${from} on ${host} (exit ${read.code}): ${detail} ${readFix}`);
      return 'failed';
    }
    const entries = aclsForVmid(parsed.data, oldVmid);
    if (entries.length === 0) {
      logInfo(`No permissions on ${from} to copy`);
      return 'none';
    }
    script = buildAclCopyScript(entries, newVmid);
    const result = await runRemote(ssh, inventory, host, script);
    if (result.code !== 0) {
      logWarn(
        `Failed to copy permissions from ${from} to ${to} (exit ${result.code}): ${(result.stderr || result.stdout).trim()} -- run on ${host} by hand:\n${script}`
      );
      return 'failed';
    }
    logInfo(`Copied ${entries.length} permission(s) from ${from} to ${to}`);
    return 'copied';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (script) {
      logWarn(`Failed to copy permissions from ${from} to ${to}: ${message} -- run on ${host} by hand:\n${script}`);
    } else {
      logWarn(`Couldn't read the permissions on ${from} on ${host}: ${message} ${readFix}`);
    }
    return 'failed';
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
