import { DEFAULT_PROXY_DRIVER_ID, type ProxyDriverId, type TlsSource } from './ids.ts';

// One-time conversion of the pre-#72 TLS settings into tlsSource (issue
// #72, research R2). Pure: it reads the legacy values and says what to
// write and remove; the caller (the database open path) applies it and logs
// `description`. Imports only ids.ts so inventory.ts can use it without a
// cycle.
//
//   caddy / caddy-api / unset driver, proxyCaddyTls:
//       cloudflare -> tlsSource left unset (Caddy's default, acme-dns),
//       letsencrypt -> acme-http, internal -> internal, files -> files
//                                                    (removes proxyCaddyTls)
//   traefik, proxyCertResolver 'none' -> external   (removes proxyCertResolver)
//   any other driver: proxyCaddyTls is removed with no tlsSource;
//   proxyCertResolver 'none' is removed with no tlsSource (any non-traefik
//   driver); a named proxyCertResolver is never touched.
//
// 'cloudflare' (proxyCaddyTls's own default) is not pinned as 'acme-dns':
// the output is identical either way, and a pinned acme-dns would make a
// later switch to a driver without it (nginx, HAProxy, NPM) be refused.
//
// An existing tlsSource is never overwritten, though the legacy values are
// still removed.
export interface LegacyTlsInput {
  proxyDriver?: ProxyDriverId;
  proxyCaddyTls?: string;
  proxyCertResolver?: string;
  tlsSource?: TlsSource;
}

export interface LegacyTlsConversion {
  tlsSource?: TlsSource;
  remove: Array<'proxyCaddyTls' | 'proxyCertResolver'>;
  // The <details> of the 'Migrated TLS settings to tlsSource' log line;
  // absent when there is nothing to convert.
  description?: string;
}

// What a legacy value converts to: a tlsSource to write, or 'default' to
// leave tlsSource unset because the value was the driver's own default.
type LegacyTarget = TlsSource | 'default';

// A Map, not an object literal: the migration runs on raw database/YAML
// strings before any validation, and a stray legacy value like
// 'constructor' or 'toString' must not resolve to an Object.prototype member.
const CADDY_TLS_TO_SOURCE = new Map<string, LegacyTarget>([
  ['cloudflare', 'default'],
  ['letsencrypt', 'acme-http'],
  ['internal', 'internal'],
  ['files', 'files'],
]);

export function convertLegacyTlsSettings(input: LegacyTlsInput): LegacyTlsConversion {
  const driver = input.proxyDriver ?? DEFAULT_PROXY_DRIVER_ID;
  const remove: LegacyTlsConversion['remove'] = [];
  const conversions: string[] = [];
  const removals: string[] = [];
  let tlsSource: TlsSource | undefined;

  // Records one legacy key as removed and, when it names a target and no
  // tlsSource is set yet, the conversion.
  function convert(key: 'proxyCaddyTls' | 'proxyCertResolver', value: string, mapped: LegacyTarget | undefined): void {
    remove.push(key);
    let removal = `removed ${key}`;
    if (mapped && input.tlsSource === undefined) {
      if (mapped === 'default') {
        conversions.push(`${key} '${value}' -> tlsSource left unset (Caddy's default, acme-dns)`);
      } else {
        tlsSource = mapped;
        conversions.push(`${key} '${value}' -> tlsSource '${mapped}'`);
      }
    } else if (mapped) {
      removal += ' (tlsSource already set)';
    }
    removals.push(removal);
  }

  if (input.proxyCaddyTls !== undefined) {
    const isCaddy = driver === 'caddy' || driver === 'caddy-api';
    convert('proxyCaddyTls', input.proxyCaddyTls, isCaddy ? CADDY_TLS_TO_SOURCE.get(input.proxyCaddyTls) : undefined);
  }
  if (input.proxyCertResolver === 'none') {
    convert('proxyCertResolver', 'none', driver === 'traefik' ? 'external' : undefined);
  }

  const parts = [...conversions, ...removals];
  return { ...(tlsSource ? { tlsSource } : {}), remove, ...(parts.length ? { description: parts.join('; ') } : {}) };
}
