// Framework-free (no React/DOM imports) so it compiles under the root
// NodeNext config and is testable with plain node --test, same rationale as
// admin-nav.ts/whoami-store.ts. Text for the Settings page's derived-values
// section: a fresh inventory with no `proxy: true` entry and no host
// `midScheme` should read as an explained empty state, never a bare "none"
// or nothing at all -- see contracts/ui-and-messages.md ("Settings page
// text").

import type { SettingsResponse, ProxyDriverInfo } from '../api/types.ts';

export type ProxyHost = NonNullable<SettingsResponse['derived']['proxy']>;

export function proxyHostText(proxy: ProxyHost | null): string {
  if (!proxy) return 'not set — no inventory entry has proxy: true with an IP yet';
  return `${proxy.name} (${proxy.ip})`;
}

export const LAN_GATEWAYS_EMPTY_TEXT = 'LAN gateways: none yet — no host has a midScheme';

// The Settings page's Proxy driver <select> options, in the server's own
// registration order (issue #33) -- only the default driver's label gets
// the " (default)" suffix, so an operator can tell which id an unset
// setting actually resolves to without a separate "(unset)" option.
export function proxyDriverOptions(
  drivers: ProxyDriverInfo[],
  defaultId: string,
): Array<{ value: string; label: string }> {
  return drivers.map((driver) => ({
    value: driver.id,
    label: driver.id === defaultId ? `${driver.label} (default)` : driver.label,
  }));
}

// What the Settings page's Proxy config path/Status page path fields show
// for whichever driver is currently selected in the (possibly unsaved)
// dropdown -- issue #33's US3. `selectedId` is the caller's already-resolved
// choice (`drafts.proxyDriver || data.defaultProxyDriver`, so it tracks the
// unsaved selection per FR-006/FR-007's acceptance scenario 5), not looked
// up against a separate default here. A driver whose `defaultConfigPath`/
// `suggestedStatusPagePath` is `null` (only "No proxy" today) hides the
// matching field; an id with no matching entry in `drivers` at all (never
// reachable through the dropdown itself, but defensive against a stale
// selection) is treated the same as one with no metadata -- both fields
// hidden, same as FR-006's "unknown means nothing to show". Hiding is
// display-only (R6): callers must not clear the field's draft/stored value
// just because it stopped being shown (FR-008).
export interface ProxyFieldView {
  showConfigPath: boolean;
  configPathPlaceholder?: string;
  configPathHelp?: string;
  showStatusPagePath: boolean;
  statusPagePlaceholder?: string;
}

export function proxyFieldView(selectedId: string, drivers: ProxyDriverInfo[]): ProxyFieldView {
  const driver = drivers.find((d) => d.id === selectedId);
  if (!driver || driver.defaultConfigPath === null) {
    return { showConfigPath: false, showStatusPagePath: driver?.suggestedStatusPagePath != null };
  }
  return {
    showConfigPath: true,
    configPathPlaceholder: driver.defaultConfigPath,
    configPathHelp: `Overrides the ${driver.label} driver's default config path (${driver.defaultConfigPath}). Unset: that default.`,
    showStatusPagePath: driver.suggestedStatusPagePath != null,
    statusPagePlaceholder: driver.suggestedStatusPagePath ?? undefined,
  };
}
