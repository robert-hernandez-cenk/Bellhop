// Nginx Proxy Manager REST access for the nginx-proxy-manager proxy driver
// (issue #31). Modeled on cloudflare-client.ts/authentik-client.ts: an
// interface, a fetch-backed real implementation, zod-validated responses
// (constitution: never trust a third-party response body without
// validating it), and a build function that fails the same clear way
// whichever caller (CLI/web/MCP) is missing credentials. The driver that
// uses this client is src/lib/proxy/drivers/nginx-proxy-manager.ts; this
// file has no proxy-driver-shaped logic in it, only "talk to NPM."

import { z } from 'zod';
import { findProxyEntry, type Inventory } from './inventory.ts';
import { configValue } from './config.ts';
import { settingFix } from './settings-hint.ts';

// Every request except a certificate request. A sync takes seconds against a
// one-day token (research R1), so there is no refresh path to time-bound
// separately -- this bound is purely "don't hang the caller."
export const NPM_REQUEST_TIMEOUT_MS = 10_000;

// POST /api/nginx/certificates runs certbot synchronously inside the request
// (research R3): a successful HTTP-01 issuance takes tens of seconds, well
// past the ordinary request timeout above.
export const NPM_CERTIFICATE_TIMEOUT_MS = 180_000;

// Names the settings (issue #64), never a value -- the password is a secret.
export const NPM_UNCONFIGURED_MESSAGE =
  `Nginx Proxy Manager API not configured -- set npmApiEmail (${settingFix('npmApiEmail', '<email>')}) ` +
  `and npmApiPassword (${settingFix('npmApiPassword')})`;

// -- Response shapes ---------------------------------------------------
//
// Plain z.object() schemas (not .strict()) are deliberate: an unknown field
// on either shape is ignored, per data-model.md. For NpmCertificate this is
// also the security boundary (research R8's "Security note") -- meta is
// never listed in the schema, so a certificate's PEM/private key never
// survives parsing into an NpmCertificate, whichever caller reads one.

const NpmProxyHostMetaSchema = z.object({
  nginx_online: z.boolean().optional(),
  nginx_err: z.string().nullable().optional(),
});

// Only what ownership and matching read is required (id, domain_names, the
// forward_* target, enabled); every other flag and id defaults, so a row from
// an older NPM release, or a hand-made one missing a newer field (e.g.
// trust_forwarded_proto), still parses -- and, if owned, simply shows up as
// drift and is rewritten with the full R9 body (final review F4).
const flag = () => z.boolean().optional().default(false);

export const NpmProxyHostSchema = z.object({
  id: z.number(),
  domain_names: z.array(z.string()),
  forward_scheme: z.enum(['http', 'https']),
  forward_host: z.string(),
  forward_port: z.number(),
  certificate_id: z.number().optional().default(0),
  ssl_forced: flag(),
  http2_support: flag(),
  allow_websocket_upgrade: flag(),
  block_exploits: flag(),
  caching_enabled: flag(),
  hsts_enabled: flag(),
  hsts_subdomains: flag(),
  trust_forwarded_proto: flag(),
  enabled: z.boolean(),
  access_list_id: z.number().optional().default(0),
  advanced_config: z.string().optional().default(''),
  // NPM reads back null on a host created without locations, and [] when
  // sent (research R7) -- both mean "none," so both normalise to [] here.
  locations: z
    .array(z.unknown())
    .nullable()
    .transform((v) => v ?? []),
  meta: NpmProxyHostMetaSchema.optional().default({}),
});
export type NpmProxyHost = z.infer<typeof NpmProxyHostSchema>;

export const NpmCertificateSchema = z.object({
  id: z.number(),
  provider: z.string(),
  nice_name: z.string(),
  domain_names: z.array(z.string()),
  // UTC `YYYY-MM-DD HH:MM:SS`; null (no expiry recorded) or an unparseable
  // value is treated as expired by the driver's certificate selection, not
  // by this schema.
  expires_on: z.string().nullable(),
});
export type NpmCertificate = z.infer<typeof NpmCertificateSchema>;

// A redirection host or a 404 ("dead") host. Bellhop never creates, edits or
// deletes either kind; it only reads which hostnames they hold, because NPM
// refuses a proxy host naming a hostname a host of any kind already holds
// (research R13). Every other field is ignored.
export const NpmNameHolderSchema = z.object({
  id: z.number(),
  domain_names: z.array(z.string()),
});
export type NpmNameHolder = z.infer<typeof NpmNameHolderSchema>;

const TokenResponseSchema = z.object({
  token: z.string(),
  expires: z.string(),
});

const CreatedSchema = z.object({ id: z.number() });

// The writable body a create/update sends -- every field the driver derives
// per research R9, `locations` always `[]` (Bellhop never templates NPM's
// own per-location UI).
export interface NpmProxyHostBody {
  domain_names: string[];
  forward_scheme: 'http' | 'https';
  forward_host: string;
  forward_port: number;
  certificate_id: number;
  ssl_forced: boolean;
  http2_support: boolean;
  allow_websocket_upgrade: boolean;
  block_exploits: boolean;
  caching_enabled: boolean;
  hsts_enabled: boolean;
  hsts_subdomains: boolean;
  trust_forwarded_proto: boolean;
  access_list_id: number;
  advanced_config: string;
  enabled: boolean;
  locations: unknown[];
}

export interface NpmClient {
  // Normalised (no trailing slash or /api); used in preview/snapshot/error
  // text, never re-derived by a caller.
  readonly baseUrl: string;
  listProxyHosts(): Promise<NpmProxyHost[]>;
  getProxyHost(id: number): Promise<NpmProxyHost>;
  createProxyHost(body: NpmProxyHostBody): Promise<{ id: number }>;
  updateProxyHost(id: number, body: NpmProxyHostBody): Promise<void>;
  deleteProxyHost(id: number): Promise<void>;
  listCertificates(): Promise<NpmCertificate[]>;
  requestCertificate(domainNames: string[]): Promise<{ id: number }>;
  // Read only -- Bellhop never writes either kind (research R13).
  listRedirectionHosts(): Promise<NpmNameHolder[]>;
  listDeadHosts(): Promise<NpmNameHolder[]>;
}

// -- Error mapping -------------------------------------------------------

function errorMessageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Every NPM error body observed (research R1/R7/R8) has the shape
// { error: { code, message } }, optionally alongside a { debug: { stack } }
// carrying certbot's own failure reason for a certificate request.
function extractErrorMessage(body: unknown): string {
  if (body && typeof body === 'object' && 'error' in body) {
    const err = (body as { error?: unknown }).error;
    if (err && typeof err === 'object' && 'message' in err) {
      const message = (err as { message?: unknown }).message;
      if (typeof message === 'string') return message;
    }
  }
  return 'Unknown error';
}

function extractDebugStackLines(body: unknown): string[] {
  if (body && typeof body === 'object' && 'debug' in body) {
    const debug = (body as { debug?: unknown }).debug;
    if (debug && typeof debug === 'object' && 'stack' in debug) {
      const stack = (debug as { stack?: unknown }).stack;
      if (Array.isArray(stack)) {
        return stack.filter((line): line is string => typeof line === 'string' && line.trim().length > 0);
      }
    }
  }
  return [];
}

function npmErrorMessage(status: number, method: string, pathAndQuery: string, body: unknown): string {
  let message = `Nginx Proxy Manager API ${status} ${method} ${pathAndQuery}: ${extractErrorMessage(body)}`;
  const stackLines = extractDebugStackLines(body);
  if (stackLines.length > 0) {
    message += ` -- ${stackLines.join(' / ')}`;
  }
  return message;
}

async function parseJsonBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

// -- Base URL normalisation -----------------------------------------------

// Strips a trailing slash (repeated) and, if present after that, a trailing
// /api segment (plus any slash left behind by removing it) -- so
// "http://192.0.2.30:81", ".../", ".../api" and ".../api/" all normalise to
// the same base this client builds "<base>/api/<path>" requests against.
function normalizeBaseUrl(url: string): string {
  let normalized = url.trim();
  while (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  if (normalized.endsWith('/api')) normalized = normalized.slice(0, -'/api'.length);
  while (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  return normalized;
}

// -- Real client -----------------------------------------------------------

export class RealNpmClient implements NpmClient {
  private tokenPromise?: Promise<string>;

  constructor(
    readonly baseUrl: string,
    private email: string,
    private password: string,
    private fetchImpl: typeof fetch = fetch
  ) {}

  // A network failure or timeout on any request -- login included -- is
  // reported this same way, naming the base URL rather than a bare fetch
  // error.
  private async rawFetch(
    method: string,
    pathAndQuery: string,
    options: { headers?: Record<string, string>; body?: unknown; timeoutMs?: number } = {}
  ): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.baseUrl}${pathAndQuery}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...options.headers },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(options.timeoutMs ?? NPM_REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(`Could not reach Nginx Proxy Manager at ${this.baseUrl}: ${errorMessageOf(err)}`);
    }
  }

  // Logs in lazily on first call and never refreshes (research R1) -- a
  // second concurrent caller awaits the same in-flight login rather than
  // posting a second /api/tokens request.
  private login(): Promise<string> {
    if (!this.tokenPromise) {
      this.tokenPromise = this.performLogin().catch((err) => {
        this.tokenPromise = undefined;
        throw err;
      });
    }
    return this.tokenPromise;
  }

  private async performLogin(): Promise<string> {
    const res = await this.rawFetch('POST', '/api/tokens', {
      body: { identity: this.email, secret: this.password },
    });
    const body = await parseJsonBody(res);
    if (!res.ok) {
      if (res.status === 400) {
        throw new Error(
          `Nginx Proxy Manager at ${this.baseUrl} rejected the login for ${this.email}: Invalid email or password -- check the npmApiEmail and npmApiPassword settings (NPM_API_EMAIL/NPM_API_PASSWORD override them): ${settingFix('npmApiPassword')}`
        );
      }
      throw new Error(npmErrorMessage(res.status, 'POST', '/api/tokens', body));
    }
    return TokenResponseSchema.parse(body).token;
  }

  private async request(
    method: string,
    pathAndQuery: string,
    options: { body?: unknown; timeoutMs?: number } = {}
  ): Promise<unknown> {
    const token = await this.login();
    const res = await this.rawFetch(method, pathAndQuery, {
      headers: { Authorization: `Bearer ${token}` },
      body: options.body,
      timeoutMs: options.timeoutMs,
    });
    const body = await parseJsonBody(res);
    if (!res.ok) {
      throw new Error(npmErrorMessage(res.status, method, pathAndQuery, body));
    }
    return body;
  }

  async listProxyHosts(): Promise<NpmProxyHost[]> {
    const body = await this.request('GET', '/api/nginx/proxy-hosts');
    return z.array(NpmProxyHostSchema).parse(body);
  }

  async getProxyHost(id: number): Promise<NpmProxyHost> {
    const body = await this.request('GET', `/api/nginx/proxy-hosts/${id}`);
    return NpmProxyHostSchema.parse(body);
  }

  async createProxyHost(body: NpmProxyHostBody): Promise<{ id: number }> {
    const res = await this.request('POST', '/api/nginx/proxy-hosts', { body });
    return CreatedSchema.parse(res);
  }

  async updateProxyHost(id: number, body: NpmProxyHostBody): Promise<void> {
    await this.request('PUT', `/api/nginx/proxy-hosts/${id}`, { body });
  }

  async deleteProxyHost(id: number): Promise<void> {
    await this.request('DELETE', `/api/nginx/proxy-hosts/${id}`);
  }

  async listCertificates(): Promise<NpmCertificate[]> {
    const body = await this.request('GET', '/api/nginx/certificates');
    return z.array(NpmCertificateSchema).parse(body);
  }

  async requestCertificate(domainNames: string[]): Promise<{ id: number }> {
    const res = await this.request('POST', '/api/nginx/certificates', {
      body: { provider: 'letsencrypt', domain_names: domainNames, meta: { dns_challenge: false } },
      timeoutMs: NPM_CERTIFICATE_TIMEOUT_MS,
    });
    return CreatedSchema.parse(res);
  }

  async listRedirectionHosts(): Promise<NpmNameHolder[]> {
    const body = await this.request('GET', '/api/nginx/redirection-hosts');
    return z.array(NpmNameHolderSchema).parse(body);
  }

  async listDeadHosts(): Promise<NpmNameHolder[]> {
    const body = await this.request('GET', '/api/nginx/dead-hosts');
    return z.array(NpmNameHolderSchema).parse(body);
  }
}

// -- Build ------------------------------------------------------------

function resolveBaseUrl(inventory: Inventory): string {
  const configured = configValue('npmApiUrl').value;
  if (configured !== undefined) {
    return normalizeBaseUrl(configured);
  }
  const proxyEntry = findProxyEntry(inventory);
  if (!proxyEntry?.ip) {
    throw new Error(
      `No npmApiUrl is set (or NPM_API_URL) and no inventory entry has 'proxy: true' with an ip -- ${settingFix('npmApiUrl', '<http://host:81>')}`
    );
  }
  return `http://${proxyEntry.ip}:81`;
}

// The one place the configured/unconfigured decision lives. Reads the
// npmApiUrl/npmApiEmail/npmApiPassword settings through the config accessor
// (issue #64), each overridden by its NPM_API_* environment variable. Built
// per plan()/apply()/snapshot() call, so a value saved on the Settings page
// applies to the next sync with no restart.
export function buildNpmClient(inventory: Inventory, fetchImpl: typeof fetch = fetch): NpmClient {
  const email = configValue('npmApiEmail').value;
  const password = configValue('npmApiPassword').value;
  if (email === undefined || password === undefined) {
    throw new Error(NPM_UNCONFIGURED_MESSAGE);
  }
  return new RealNpmClient(resolveBaseUrl(inventory), email, password, fetchImpl);
}
