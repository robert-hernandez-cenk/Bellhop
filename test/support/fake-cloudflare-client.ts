import type { CloudflareClient, CloudflareDnsRecord } from '../../src/lib/cloudflare-client.ts';

export interface FakeCloudflareSeed {
  // domain -> zone id
  zones?: Record<string, string>;
  records?: CloudflareDnsRecord[];
  // record ids whose deleteDnsRecord call rejects
  failDeleteIds?: string[];
  // when set, listTxtRecords rejects with this error
  listError?: Error;
}

export class FakeCloudflareClient implements CloudflareClient {
  readonly history: string[] = [];
  records: CloudflareDnsRecord[];
  private zones: Record<string, string>;
  private failDeleteIds: Set<string>;
  private listError?: Error;

  constructor(seed: FakeCloudflareSeed = {}) {
    this.zones = seed.zones ?? {};
    this.records = [...(seed.records ?? [])];
    this.failDeleteIds = new Set(seed.failDeleteIds ?? []);
    this.listError = seed.listError;
  }

  isConfigured(): boolean {
    return true;
  }

  async findZoneId(domain: string): Promise<string | undefined> {
    this.history.push(`findZoneId ${domain}`);
    return this.zones[domain];
  }

  async listTxtRecords(zoneId: string): Promise<CloudflareDnsRecord[]> {
    this.history.push(`listTxtRecords ${zoneId}`);
    if (this.listError) throw this.listError;
    return this.records.filter((r) => r.type === 'TXT');
  }

  async deleteDnsRecord(zoneId: string, recordId: string): Promise<void> {
    this.history.push(`deleteDnsRecord ${zoneId} ${recordId}`);
    if (this.failDeleteIds.has(recordId)) throw new Error(`simulated delete failure for ${recordId}`);
    this.records = this.records.filter((r) => r.id !== recordId);
  }
}

// A record in the shape captured from the live zone (test/fixtures/cloudflare/
// dns-records-txt.json): microsecond ISO timestamps, quoted TXT content.
export function txtRecord(id: string, name: string, modifiedOn: string | undefined): CloudflareDnsRecord {
  return {
    id,
    name,
    type: 'TXT',
    content: '"redacted-txt-value"',
    createdOn: modifiedOn,
    modifiedOn,
    managedByCloudflare: false,
  };
}
