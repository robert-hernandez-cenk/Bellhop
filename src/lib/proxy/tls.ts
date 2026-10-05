import type { Inventory } from '../inventory.ts';
import { settingFix } from '../settings-hint.ts';
// driver.ts reaches routes.ts (which imports this file) only through a
// type-only import, so this value import creates no runtime cycle.
import { managesProxy, type ReverseProxyDriver } from './driver.ts';
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
// unsets tlsSource rather than pinning the driver's default (always
// supported), so a later driver switch falls back to that driver's own
// default instead of being refused again. Only ever
// called where configuration is produced -- never on load or on a settings
// write -- so switching drivers can't make the database unusable.
export function checkTlsSource(inventory: Inventory, driver: TlsDriver): string | null {
  const source = effectiveTlsSource(inventory, driver);
  const { tlsSources, defaultTlsSource } = driver.capabilities;
  if (tlsSources.includes(source)) return null;
  return `tlsSource '${source}' is not supported by the '${driver.id}' proxy driver (it supports: ${tlsSources.join(', ')}) -- to use its default (${defaultTlsSource}), ${settingFix('tlsSource', '--unset')}`;
}

// Whether Bellhop's proxy obtains certificates over DNS-01 through
// Cloudflare -- the only case that leaves _acme-challenge TXT records behind
// for prune-acme-challenges to clean up. Decided from the TLS source, not
// the driver's identity, but only for a managed proxy that can serve that
// source: under 'none' a stored acme-dns describes the operator's own proxy
// (whose records Bellhop must not touch), and an unsupported source is one
// sync-proxy refuses, so nothing ever obtained a certificate with it.
export function usesCloudflareDns01(inventory: Inventory, driver: TlsDriver): boolean {
  if (!managesProxy(driver) || checkTlsSource(inventory, driver) !== null) return false;
  return effectiveTlsSource(inventory, driver) === 'acme-dns' && acmeDnsProvider(inventory) === 'cloudflare';
}
