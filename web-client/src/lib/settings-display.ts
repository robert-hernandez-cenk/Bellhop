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
// up against a separate default here. A driver that manages no proxy (only
// "No proxy" today) hides all of them. A managed driver with a config file
// shows the config path field with its defaultConfigPath as the placeholder
// and help text naming that default (plus its configPathNote, if any); a
// managed driver with no
// config file at all (defaultConfigPath: null -- issue #31, e.g. a
// REST-managed driver like Nginx Proxy Manager) hides it, the same as a
// driver that manages no proxy, since there is no file for the field to
// override. Either way the status page field shows only when the driver
// suggests a status page path. An id with no matching entry in `drivers` at all
// (never reachable through the dropdown itself, but defensive against a
// stale selection) hides both, same as FR-006's "unknown means nothing to
// show". Hiding is display-only (R6): callers must not clear the field's
// draft/stored value just because it stopped being shown (FR-008).
export interface ProxyFieldView {
  showConfigPath: boolean;
  configPathPlaceholder?: string;
  configPathHelp?: string;
  showStatusPagePath: boolean;
  statusPagePlaceholder?: string;
  // Proxy TLS certificate/key (issue #30): shown only for a managed driver
  // whose metadata says it serves the shared certificate those settings
  // name (usesSharedCertificate) -- never an id comparison here.
  showTlsFields: boolean;
  // Proxy cert resolver/API URL (issue #35): shown only for a managed
  // driver whose metadata says it reads proxyCertResolver/proxyApiUrl
  // (usesCertResolver/usesApiUrl) -- Traefik today, same "metadata, never
  // an id comparison" rule as showTlsFields above.
  showCertResolverField: boolean;
  showApiUrlField: boolean;
}

export function proxyFieldView(selectedId: string, drivers: ProxyDriverInfo[]): ProxyFieldView {
  const driver = drivers.find((d) => d.id === selectedId);
  if (!driver || !driver.managesProxy) {
    return {
      showConfigPath: false,
      showStatusPagePath: false,
      showTlsFields: false,
      showCertResolverField: false,
      showApiUrlField: false,
    };
  }
  const shared = {
    showStatusPagePath: driver.suggestedStatusPagePath !== null,
    statusPagePlaceholder: driver.suggestedStatusPagePath ?? undefined,
    showTlsFields: driver.usesSharedCertificate,
    showCertResolverField: driver.usesCertResolver,
    showApiUrlField: driver.usesApiUrl,
  };
  // A managed driver with no config file at all (defaultConfigPath: null --
  // issue #31, e.g. a REST-managed driver like Nginx Proxy Manager) hides
  // the config path field entirely rather than showing it as "required":
  // there is no file for the field to name or override.
  if (driver.defaultConfigPath === null) {
    return { showConfigPath: false, ...shared };
  }
  const baseHelp = `Overrides the ${driver.label} driver's default config path (${driver.defaultConfigPath}). Unset: that default.`;
  return {
    showConfigPath: true,
    configPathPlaceholder: driver.defaultConfigPath,
    configPathHelp: driver.configPathNote ? `${baseHelp} ${driver.configPathNote}` : baseHelp,
    ...shared,
  };
}
