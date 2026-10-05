import type { Inventory } from '../inventory.ts';
import { settingFix } from '../settings-hint.ts';
// Type-only, so routes.ts can import this file later without a cycle.
import type { ReverseProxyDriver } from './driver.ts';
import { DEFAULT_ACME_DNS_PROVIDER, type AcmeDnsProvider, type TlsSource } from './ids.ts';

// The slice of a driver these helpers read -- narrower than the full
// ReverseProxyDriver so a caller (or test) needs only an id and capabilities.
type TlsDriver = Pick<ReverseProxyDriver, 'id' | 'capabilities'>;

// The TLS source in force for this inventory and driver (issue #72): the
// tlsSource setting, or the driver's own default when unset.
export function effectiveTlsSource(inventory: Inventory, driver: TlsDriver): TlsSource {
  return inventory.tlsSource ?? driver.capabilities.defaultTlsSource;
}

// The DNS provider 'acme-dns' uses: acmeDnsProvider, or the default.
export function acmeDnsProvider(inventory: Inventory): AcmeDnsProvider {
  return inventory.acmeDnsProvider ?? DEFAULT_ACME_DNS_PROVIDER;
}

// Null when the effective source is one the driver supports, else the
// refusal message (contracts/rendering-and-messages.md "Refusal"). The fix
// names the driver's own default, which is always supported. Only ever
// called where configuration is produced -- never on load or on a settings
// write -- so switching drivers can't make the database unusable.
export function checkTlsSource(inventory: Inventory, driver: TlsDriver): string | null {
  const source = effectiveTlsSource(inventory, driver);
  const { tlsSources, defaultTlsSource } = driver.capabilities;
  if (tlsSources.includes(source)) return null;
  return `tlsSource '${source}' is not supported by the '${driver.id}' proxy driver (it supports: ${tlsSources.join(', ')}) -- ${settingFix('tlsSource', defaultTlsSource)}`;
}

// Whether certificates are obtained over DNS-01 through Cloudflare -- the
// only case that leaves _acme-challenge TXT records behind for
// prune-acme-challenges to clean up (replaces the per-driver
// acmeDns01ViaCloudflare capability).
export function usesCloudflareDns01(inventory: Inventory, driver: TlsDriver): boolean {
  return effectiveTlsSource(inventory, driver) === 'acme-dns' && acmeDnsProvider(inventory) === 'cloudflare';
}
