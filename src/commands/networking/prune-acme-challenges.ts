import type { CloudflareClient } from '../../lib/cloudflare-client.ts';
import type { Inventory } from '../../lib/inventory.ts';

// A DNS-01 challenge record only matters for the minutes a challenge is being
// validated, so anything untouched for a day is not in use by Caddy or by any
// other ACME client on the zone. Age -- not inventory membership -- is the
// ownership rule (issue #162): a removed or renamed subdomain's leftover
// record matches nothing in inventory, and is exactly what this exists to
// clean up. Not configurable.
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export interface PruneAcmeChallengesOptions {
  apply?: boolean;
  // Injected by tests so the age boundary is deterministic.
  now?: Date;
}

export interface AcmeChallengeRecordSummary {
  name: string;
  // Undefined when the record carries no parseable modifiedOn.
  ageHours?: number;
}

export interface PruneAcmeChallengesResult {
  domain: string;
  stale: AcmeChallengeRecordSummary[];
  tooRecent: AcmeChallengeRecordSummary[];
  deleted: string[];
  failed: { name: string; error: string }[];
  applied: boolean;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// `_acme-challenge.<domain>` (a wildcard or apex cert) or
// `_acme-challenge.<labels>.<domain>`. The single place names are matched --
// the client lists every TXT record unfiltered.
export function isAcmeChallengeName(name: string, domain: string): boolean {
  return new RegExp(`^_acme-challenge\\.(?:[^.]+\\.)*${escapeRegExp(domain)}$`, 'i').test(name);
}

function roundHours(ms: number): number {
  return Math.round((ms / 3_600_000) * 10) / 10;
}

export async function runPruneAcmeChallenges(
  opts: PruneAcmeChallengesOptions,
  deps: { cloudflare: CloudflareClient; inventory: Inventory }
): Promise<PruneAcmeChallengesResult> {
  const now = (opts.now ?? new Date()).getTime();
  const domain = deps.inventory.domain;
  const zoneId = await deps.cloudflare.findZoneId(domain);
  if (!zoneId) {
    throw new Error(`Cloudflare zone '${domain}' not found -- the token needs Zone:Read and DNS:Edit on that zone`);
  }

  const stale: AcmeChallengeRecordSummary[] = [];
  const tooRecent: AcmeChallengeRecordSummary[] = [];
  const staleIds: Array<{ id: string; name: string }> = [];
  for (const record of await deps.cloudflare.listTxtRecords(zoneId)) {
    // Checked here too, not only by the client's type=TXT query: a CNAME at
    // _acme-challenge is DNS-01 delegation, a permanent record.
    if (record.type !== 'TXT' || !isAcmeChallengeName(record.name, domain)) continue;
    // Cloudflare's own records (its Universal/Advanced cert validation TXT
    // records, meta.read_only/auto_added) are never this command's to
    // delete, however old they get.
    if (record.managedByCloudflare) continue;
    const modified = record.modifiedOn ? Date.parse(record.modifiedOn) : Number.NaN;
    if (Number.isNaN(modified)) {
      tooRecent.push({ name: record.name, ageHours: undefined });
      continue;
    }
    const age = now - modified;
    if (age > STALE_AFTER_MS) {
      stale.push({ name: record.name, ageHours: roundHours(age) });
      staleIds.push({ id: record.id, name: record.name });
    } else {
      tooRecent.push({ name: record.name, ageHours: roundHours(age) });
    }
  }

  const deleted: string[] = [];
  const failed: { name: string; error: string }[] = [];
  if (opts.apply) {
    for (const { id, name } of staleIds) {
      try {
        await deps.cloudflare.deleteDnsRecord(zoneId, id);
        deleted.push(name);
      } catch (err) {
        failed.push({ name, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  return { domain, stale, tooRecent, deleted, failed, applied: !!opts.apply };
}

function describeAge(summary: AcmeChallengeRecordSummary): string {
  return summary.ageHours === undefined ? 'age unknown' : `${summary.ageHours}h old`;
}

export function formatPruneAcmeChallenges(result: PruneAcmeChallengesResult): string {
  const lines: string[] = [`Zone: ${result.domain}`];
  lines.push(`Stale _acme-challenge TXT records (older than 24h): ${result.stale.length}`);
  for (const s of result.stale) lines.push(`  - ${s.name} (${describeAge(s)})`);
  // Printed only when non-empty, so ordinary output stays short.
  if (result.tooRecent.length > 0) {
    lines.push(`Recent _acme-challenge TXT records left alone: ${result.tooRecent.length}`);
    for (const s of result.tooRecent) lines.push(`  = ${s.name} (${describeAge(s)})`);
  }
  if (result.applied) {
    lines.push(`Deleted: ${result.deleted.length}`);
    if (result.failed.length > 0) {
      lines.push(`Failed: ${result.failed.length}`);
      for (const f of result.failed) lines.push(`  ! ${f.name} — ${f.error}`);
    }
  }
  return lines.join('\n');
}
