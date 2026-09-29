// In-memory NpmClient for the Nginx Proxy Manager driver's tests (issue
// #31). Stores proxy hosts and certificates, assigns ids the way NPM does
// (increasing integers), records every call in order, and can be told to
// mark the next writes offline (meta.nginx_online: false, as NPM does when
// nginx rejects a host's advanced_config -- research R6) or to fail a
// certificate request (research R8's certbot failure). Like NPM, it rejects a
// create/update naming a hostname another proxy host already holds.
import type { NpmCertificate, NpmClient, NpmProxyHost, NpmProxyHostBody } from '../../src/lib/npm-client.ts';

export interface FakeNpmCall {
  method: 'listProxyHosts' | 'getProxyHost' | 'createProxyHost' | 'updateProxyHost' | 'deleteProxyHost' | 'listCertificates' | 'requestCertificate';
  id?: number;
  body?: NpmProxyHostBody;
  domainNames?: string[];
}

const WRITE_METHODS: FakeNpmCall['method'][] = ['createProxyHost', 'updateProxyHost', 'deleteProxyHost', 'requestCertificate'];

// Every field NPM returns for a host, defaulted the way NPM's own UI
// creates one; a test overrides what it cares about.
export function npmHost(overrides: Partial<NpmProxyHost> & { id: number; domain_names: string[] }): NpmProxyHost {
  return {
    forward_scheme: 'http',
    forward_host: '192.0.2.99',
    forward_port: 80,
    certificate_id: 0,
    ssl_forced: false,
    http2_support: false,
    allow_websocket_upgrade: false,
    block_exploits: false,
    caching_enabled: false,
    hsts_enabled: false,
    hsts_subdomains: false,
    trust_forwarded_proto: false,
    enabled: true,
    access_list_id: 0,
    advanced_config: '',
    locations: [],
    meta: { nginx_online: true, nginx_err: null },
    ...overrides,
  };
}

export class FakeNpmClient implements NpmClient {
  readonly baseUrl: string;
  readonly hosts = new Map<number, NpmProxyHost>();
  certificates: NpmCertificate[] = [];
  readonly calls: FakeNpmCall[] = [];
  // When set, every create/update is stored with nginx_online: false and
  // this nginx_err, as NPM does after nginx fails to load the host.
  offlineError: string | undefined;
  // When set, requestCertificate rejects with this message and stores nothing.
  certificateFailure: string | undefined;
  private nextHostId = 1;
  private nextCertificateId = 1;

  constructor(opts: { baseUrl?: string; hosts?: NpmProxyHost[]; certificates?: NpmCertificate[] } = {}) {
    this.baseUrl = opts.baseUrl ?? 'http://192.0.2.30:81';
    for (const host of opts.hosts ?? []) this.seedHost(host);
    for (const cert of opts.certificates ?? []) {
      this.certificates.push(cert);
      this.nextCertificateId = Math.max(this.nextCertificateId, cert.id + 1);
    }
  }

  seedHost(host: NpmProxyHost): void {
    this.hosts.set(host.id, structuredClone(host));
    this.nextHostId = Math.max(this.nextHostId, host.id + 1);
  }

  writes(): FakeNpmCall[] {
    return this.calls.filter((c) => WRITE_METHODS.includes(c.method));
  }

  clearCalls(): void {
    this.calls.length = 0;
  }

  // NPM refuses a create/update naming a hostname another proxy host already
  // holds (fixture proxy-host-create-duplicate-domain.json), so a write
  // order that claims a name before its old holder released it fails here
  // the way it does live.
  private assertNamesFree(method: string, path: string, body: NpmProxyHostBody, selfId?: number): void {
    for (const name of body.domain_names) {
      const holder = [...this.hosts.values()].find(
        (h) => h.id !== selfId && h.domain_names.some((d) => d.toLowerCase() === name.toLowerCase())
      );
      if (holder) throw new Error(`Nginx Proxy Manager API 400 ${method} ${path}: ${name} is already in use`);
    }
  }

  private stored(id: number, body: NpmProxyHostBody): NpmProxyHost {
    return {
      id,
      ...structuredClone(body),
      meta: this.offlineError === undefined ? { nginx_online: true, nginx_err: null } : { nginx_online: false, nginx_err: this.offlineError },
    };
  }

  async listProxyHosts(): Promise<NpmProxyHost[]> {
    this.calls.push({ method: 'listProxyHosts' });
    return [...this.hosts.values()].map((h) => structuredClone(h));
  }

  async getProxyHost(id: number): Promise<NpmProxyHost> {
    this.calls.push({ method: 'getProxyHost', id });
    const host = this.hosts.get(id);
    if (!host) throw new Error(`Nginx Proxy Manager API 404 GET /api/nginx/proxy-hosts/${id}: Not Found - ${id}`);
    return structuredClone(host);
  }

  async createProxyHost(body: NpmProxyHostBody): Promise<{ id: number }> {
    this.calls.push({ method: 'createProxyHost', body: structuredClone(body) });
    this.assertNamesFree('POST', '/api/nginx/proxy-hosts', body);
    const id = this.nextHostId++;
    this.hosts.set(id, this.stored(id, body));
    return { id };
  }

  async updateProxyHost(id: number, body: NpmProxyHostBody): Promise<void> {
    this.calls.push({ method: 'updateProxyHost', id, body: structuredClone(body) });
    if (!this.hosts.has(id)) throw new Error(`Nginx Proxy Manager API 404 PUT /api/nginx/proxy-hosts/${id}: Not Found - ${id}`);
    this.assertNamesFree('PUT', `/api/nginx/proxy-hosts/${id}`, body, id);
    this.hosts.set(id, this.stored(id, body));
  }

  async deleteProxyHost(id: number): Promise<void> {
    this.calls.push({ method: 'deleteProxyHost', id });
    if (!this.hosts.delete(id)) throw new Error(`Nginx Proxy Manager API 404 DELETE /api/nginx/proxy-hosts/${id}: Not Found - ${id}`);
  }

  async listCertificates(): Promise<NpmCertificate[]> {
    this.calls.push({ method: 'listCertificates' });
    return this.certificates.map((c) => structuredClone(c));
  }

  async requestCertificate(domainNames: string[]): Promise<{ id: number }> {
    this.calls.push({ method: 'requestCertificate', domainNames: [...domainNames] });
    if (this.certificateFailure !== undefined) {
      throw new Error(`Nginx Proxy Manager API 500 POST /api/nginx/certificates: Internal Error -- ${this.certificateFailure}`);
    }
    const id = this.nextCertificateId++;
    this.certificates.push({
      id,
      provider: 'letsencrypt',
      nice_name: domainNames.join(', '),
      domain_names: [...domainNames],
      expires_on: '2099-01-01 00:00:00',
    });
    return { id };
  }
}
