// Framework-free (no React/DOM imports) so it compiles under the root
// NodeNext config and is testable with plain node --test, same rationale as
// admin-nav.ts/whoami-store.ts. Text for the Settings page's derived-values
// section: a fresh inventory with no `proxy: true` entry and no host
// `midScheme` should read as an explained empty state, never a bare "none"
// or nothing at all -- see contracts/ui-and-messages.md ("Settings page
// text").

import type { SettingsResponse } from '../api/types.ts';

export type ProxyHost = NonNullable<SettingsResponse['derived']['proxy']>;

export function proxyHostText(proxy: ProxyHost | null): string {
  if (!proxy) return 'not set — no inventory entry has proxy: true with an IP yet';
  return `${proxy.name} (${proxy.ip})`;
}

export const LAN_GATEWAYS_EMPTY_TEXT = 'LAN gateways: none yet — no host has a midScheme';
