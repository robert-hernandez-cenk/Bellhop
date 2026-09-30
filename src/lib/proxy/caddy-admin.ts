import type { Inventory } from '../inventory.ts';
import type { SSHClient } from '../ssh-client.ts';
import { runRemote } from '../targets.ts';
import { singleQuote } from './file-driver.ts';
import { CaddyConfigSchema, type CaddyConfig, type CaddyConfigObject } from './caddy-json.ts';

// Remote half of the admin-API Caddy driver (issue #26): reads and writes
// Caddy's JSON configuration through its admin API on the proxy host,
// always via runRemote + curl, so the admin endpoint is never reached over
// the network (FR-002, research R3). Every command here is POSIX sh -- the
// proxy host may be a guest.

// Caddy's default admin address. Not configurable: one of the
// single-operator assumptions recorded in CLAUDE.md.
export const CADDY_ADMIN_ADDRESS = 'localhost:2019';
const CONFIG_URL = `http://${CADDY_ADMIN_ADDRESS}/config/`;

// Distinct exit codes the read command uses before ever calling curl.
export const CADDYFILE_MODE_EXIT = 3;
export const NO_CURL_EXIT = 4;

const STATUS_MARKER = 'BELLHOP_HTTP_STATUS=';
const HEREDOC_TAG = 'BELLHOP_CADDY_CONFIG';

export interface CaddyAdminDeps {
  ssh: SSHClient;
  inventory: Inventory;
  proxyHost: string;
}

// checkService: refuse (exit 3) while the packaged Caddyfile unit is
// active, since `systemctl reload caddy` would discard every API change
// (FR-010, research R4). Off for the read-only snapshot and for
// convert-caddyfile, which starts from exactly that state.
export function buildReadCommand(opts: { checkService: boolean }): string {
  const lines: string[] = [];
  if (opts.checkService) {
    lines.push(`if systemctl is-active --quiet caddy.service 2>/dev/null; then exit ${CADDYFILE_MODE_EXIT}; fi`);
  }
  lines.push(`command -v curl >/dev/null 2>&1 || exit ${NO_CURL_EXIT}`);
  lines.push(`curl -sS -D - ${CONFIG_URL}`);
  return lines.join('\n');
}

// One conditional PATCH of the whole configuration (research R2): atomic,
// and refused with 412 if the configuration changed since the read that
// produced `etag`. The compact JSON is a single line in a quoted heredoc,
// so it can never equal the delimiter and nothing in it is expanded.
export function buildWriteCommand(config: CaddyConfigObject, etag: string): string {
  return [
    `command -v curl >/dev/null 2>&1 || exit ${NO_CURL_EXIT}`,
    `curl -sS -X PATCH -H 'Content-Type: application/json' -H ${singleQuote(`If-Match: ${etag}`)} ` +
      `--data-binary @- -w '\\n${STATUS_MARKER}%{http_code}\\n' ${CONFIG_URL} <<'${HEREDOC_TAG}'`,
    JSON.stringify(config),
    HEREDOC_TAG,
  ].join('\n');
}

export interface AdminResponse {
  status: number;
  etag: string | null;
  body: string;
}

// `curl -D -` output: the status line and headers (CRLF), a blank line,
// then the body. Tolerates LF-only line endings too.
export function parseReadOutput(stdout: string): AdminResponse {
  const split = stdout.search(/\r?\n\r?\n/);
  const head = split === -1 ? stdout : stdout.slice(0, split);
  const body = split === -1 ? '' : stdout.slice(split).replace(/^\r?\n\r?\n/, '');
  const [statusLine = '', ...headers] = head.split(/\r?\n/);
  const status = Number(/^HTTP\/[\d.]+ (\d{3})/.exec(statusLine)?.[1] ?? 0);
  const etagLine = headers.find((h) => /^etag:/i.test(h));
  return { status, etag: etagLine ? etagLine.replace(/^etag:\s*/i, '').trim() : null, body };
}

// The write command's output: the response body, then the status marker
// line curl's -w appends.
export function parseWriteOutput(stdout: string): { status: number; body: string } {
  const match = new RegExp(`\\n?${STATUS_MARKER}(\\d{3})\\s*$`).exec(stdout);
  if (!match) return { status: 0, body: stdout.trim() };
  return { status: Number(match[1]), body: stdout.slice(0, match.index).trim() };
}

// Caddy's error body is {"error": "..."}; fall back to the raw text.
function adminError(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed.error === 'string') return parsed.error;
  } catch {
    // Not JSON -- report it as-is.
  }
  return body;
}

function noCurlMessage(host: string): string {
  return `curl is not installed on '${host}'; the caddy-api proxy driver needs it to reach Caddy's admin API at ${CADDY_ADMIN_ADDRESS}.`;
}

export function caddyfileModeMessage(host: string): string {
  return (
    `Caddy on '${host}' is running from a Caddyfile (caddy.service is active); changes made through its admin API would be ` +
    `lost on the next reload. Convert with 'bellhop convert-caddyfile --apply', then run ` +
    `'systemctl disable --now caddy && systemctl enable --now caddy-api' on '${host}'.`
  );
}

export interface LiveCaddyConfig {
  config: CaddyConfig;
  etag: string;
}

// GET /config/ plus its Etag, validated with zod (constitution Principle
// II). Every failure names the proxy host and what to do (FR-011).
export async function readCaddyConfig(deps: CaddyAdminDeps, opts: { checkService: boolean }): Promise<LiveCaddyConfig> {
  const host = deps.proxyHost;
  const result = await runRemote(deps.ssh, deps.inventory, host, buildReadCommand(opts));
  if (result.code === CADDYFILE_MODE_EXIT && opts.checkService) throw new Error(caddyfileModeMessage(host));
  if (result.code === NO_CURL_EXIT) throw new Error(noCurlMessage(host));
  if (result.code !== 0) {
    throw new Error(
      `Could not read Caddy's configuration from the admin API at ${CADDY_ADMIN_ADDRESS} on '${host}': ` +
        (result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`)
    );
  }
  const response = parseReadOutput(result.stdout);
  if (response.status !== 200) {
    throw new Error(`Caddy's admin API on '${host}' answered ${response.status} reading /config/: ${adminError(response.body)}`);
  }
  if (!response.etag) {
    throw new Error(`Caddy's admin API on '${host}' sent no Etag; the caddy-api proxy driver needs Caddy 2.6 or newer.`);
  }
  let json: unknown;
  try {
    json = JSON.parse(response.body);
  } catch {
    throw new Error(`Caddy's admin API on '${host}' returned a configuration that is not JSON: ${response.body.slice(0, 200)}`);
  }
  const parsed = CaddyConfigSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`Caddy's configuration on '${host}' has an unexpected shape: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  }
  return { config: parsed.data, etag: response.etag };
}

// PATCH /config/ with If-Match: all-or-nothing (FR-004), refused if the
// configuration changed since the read (FR-005).
export async function writeCaddyConfig(deps: CaddyAdminDeps, config: CaddyConfigObject, etag: string): Promise<void> {
  const host = deps.proxyHost;
  const result = await runRemote(deps.ssh, deps.inventory, host, buildWriteCommand(config, etag));
  if (result.code === NO_CURL_EXIT) throw new Error(noCurlMessage(host));
  if (result.code !== 0) {
    throw new Error(
      `Could not write Caddy's configuration through the admin API at ${CADDY_ADMIN_ADDRESS} on '${host}': ` +
        (result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`)
    );
  }
  const response = parseWriteOutput(result.stdout);
  if (response.status === 200) return;
  if (response.status === 412) {
    throw new Error(`Caddy's configuration on '${host}' changed after it was read; nothing was written. Run the sync again.`);
  }
  throw new Error(
    `Caddy on '${host}' rejected the new configuration (${response.status}); its previous configuration is still running: ` +
      adminError(response.body)
  );
}
