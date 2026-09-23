// Cloudflare REST access for prune-acme-challenges (issue #162). Modeled on
// authentik-client.ts: an interface, a real fetch-backed implementation, and
// a null object used when no token is configured, so callers never need a
// null check.

const API_BASE = 'https://api.cloudflare.com/client/v4';

export const CLOUDFLARE_UNCONFIGURED_MESSAGE =
  'Cloudflare API not configured (set CLOUDFLARE_DNS_API_TOKEN in data/cloudflare-api.env)';

// Applied to every request via AbortSignal.timeout(): syncCaddyLive awaits
// this client inside the Dashboard guest-PATCH handler, so a Cloudflare
// endpoint that accepts the connection and then stalls must not hang that
// request for minutes.
export const CLOUDFLARE_REQUEST_TIMEOUT_MS = 10_000;

export interface CloudflareDnsRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  createdOn?: string;
  modifiedOn?: string;
  // True when Cloudflare itself created/owns this record (meta.read_only or
  // meta.auto_added -- e.g. its own Universal/Advanced cert validation TXT
  // records). Never this command's to delete, however old it gets.
  managedByCloudflare: boolean;
}

export interface CloudflareClient {
  // Whether there is a real token behind this client -- checked by
  // syncCaddyLive so an unconfigured operator gets a skip line, not a warning.
  isConfigured(): boolean;
  findZoneId(domain: string): Promise<string | undefined>;
  listTxtRecords(zoneId: string): Promise<CloudflareDnsRecord[]>;
  deleteDnsRecord(zoneId: string, recordId: string): Promise<void>;
}

interface RawEnvelope<T> {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result: T;
  result_info?: { page?: number; total_pages?: number };
}

interface RawDnsRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  created_on?: string;
  modified_on?: string;
  meta?: { read_only?: boolean; auto_added?: boolean };
}

export class RealCloudflareClient implements CloudflareClient {
  constructor(
    private token: string,
    private fetchImpl: typeof fetch = fetch
  ) {}

  isConfigured(): boolean {
    return true;
  }

  // Cloudflare reports failures both as non-2xx statuses and as 2xx bodies
  // with success: false, so both are checked. The first error message is what
  // makes a bad token read as "Cloudflare API 403: ..." instead of a bare
  // status code.
  private async request<T>(method: string, pathAndQuery: string): Promise<RawEnvelope<T>> {
    const res = await this.fetchImpl(`${API_BASE}${pathAndQuery}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(CLOUDFLARE_REQUEST_TIMEOUT_MS),
    });
    let body: RawEnvelope<T> | undefined;
    try {
      body = (await res.json()) as RawEnvelope<T>;
    } catch {
      body = undefined;
    }
    if (!res.ok || !body || body.success !== true) {
      const message = body?.errors?.[0]?.message ?? res.statusText;
      throw new Error(`Cloudflare API ${res.status}: ${message} (${method} ${pathAndQuery})`);
    }
    return body;
  }

  async findZoneId(domain: string): Promise<string | undefined> {
    const body = await this.request<Array<{ id: string }>>('GET', `/zones?name=${encodeURIComponent(domain)}`);
    return body.result[0]?.id;
  }

  // Every TXT record in the zone, all pages. Deliberately no server-side name
  // filter: the live zone had no _acme-challenge records to verify one
  // against, and name matching belongs to the command.
  async listTxtRecords(zoneId: string): Promise<CloudflareDnsRecord[]> {
    const records: CloudflareDnsRecord[] = [];
    let page = 1;
    let totalPages = 1;
    do {
      const body = await this.request<RawDnsRecord[]>(
        'GET',
        `/zones/${encodeURIComponent(zoneId)}/dns_records?type=TXT&per_page=100&page=${page}`
      );
      for (const raw of body.result) {
        records.push({
          id: raw.id,
          name: raw.name,
          type: raw.type,
          content: raw.content,
          createdOn: raw.created_on,
          modifiedOn: raw.modified_on,
          managedByCloudflare: raw.meta?.read_only === true || raw.meta?.auto_added === true,
        });
      }
      totalPages = body.result_info?.total_pages ?? 1;
      page++;
    } while (page <= totalPages);
    return records;
  }

  async deleteDnsRecord(zoneId: string, recordId: string): Promise<void> {
    await this.request<{ id: string }>(
      'DELETE',
      `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`
    );
  }
}

export class UnconfiguredCloudflareClient implements CloudflareClient {
  isConfigured(): boolean {
    return false;
  }
  findZoneId(_domain: string): Promise<string | undefined> {
    return Promise.reject(new Error(CLOUDFLARE_UNCONFIGURED_MESSAGE));
  }
  listTxtRecords(_zoneId: string): Promise<CloudflareDnsRecord[]> {
    return Promise.reject(new Error(CLOUDFLARE_UNCONFIGURED_MESSAGE));
  }
  deleteDnsRecord(_zoneId: string, _recordId: string): Promise<void> {
    return Promise.reject(new Error(CLOUDFLARE_UNCONFIGURED_MESSAGE));
  }
}

// The one place the configured/unconfigured decision lives; src/cli.ts and
// src/web/server.ts both call it after dotenv-loading data/cloudflare-api.env.
// An empty value counts as unset, same as authentik-config.ts. Deliberately a
// different variable from the CLOUDFLARE_API_TOKEN that Caddy and
// cloudflare-ddns use, so a shell exporting theirs can't silently stand in.
export function buildCloudflareClient(env: NodeJS.ProcessEnv = process.env): CloudflareClient {
  const token = env.CLOUDFLARE_DNS_API_TOKEN;
  if (!token) return new UnconfiguredCloudflareClient();
  return new RealCloudflareClient(token);
}
