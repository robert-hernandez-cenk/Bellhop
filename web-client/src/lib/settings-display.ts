// Framework-free (no React/DOM imports) so it compiles under the root
// NodeNext config and is testable with plain node --test, same rationale as
// admin-nav.ts/whoami-store.ts. Text for the Settings page's derived-values
// section: a fresh inventory with no host `midScheme` should read as an
// explained empty state, never a bare "none" or nothing at all -- see
// contracts/ui-and-messages.md ("Settings page text").

import type {
  SettingsResponse,
  SettingsValues,
  ProxyDriverInfo,
  SecretSettingKey,
  SecretStatus,
  WebLoginStatus,
} from '../api/types.ts';

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

// The Settings page's ACME DNS provider <select> options (issue #72): the
// server's provider list in its order, only the default suffixed
// " (default)" -- same convention as proxyDriverOptions above.
export function acmeDnsProviderOptions(
  providers: readonly string[],
  defaultProvider: string,
): Array<{ value: string; label: string }> {
  return providers.map((provider) => ({
    value: provider,
    label: provider === defaultProvider ? `${provider} (default)` : provider,
  }));
}

// The Settings page's TLS source <select> options (issue #72): the
// selected driver's own tlsSources, in the server's order, with only its
// defaultTlsSource suffixed " (default)" -- same convention as
// proxyDriverOptions above. A shown source the driver does not support
// (stored before a driver switch, say) is appended as
// "<value> (not supported)" so the <select> can still display it.
export function tlsSourceOptions(
  driver: ProxyDriverInfo,
  shownSource: string,
): Array<{ value: string; label: string }> {
  const options = driver.tlsSources.map((source) => ({
    value: source,
    label: source === driver.defaultTlsSource ? `${source} (default)` : source,
  }));
  if (!driver.tlsSources.includes(shownSource)) {
    options.push({ value: shownSource, label: `${shownSource} (not supported)` });
  }
  return options;
}

// What the Settings page's Proxy tab shows for whichever driver is currently
// selected in the (possibly unsaved) dropdown -- issue #33's US3. `selectedId`
// is the caller's already-resolved choice (`drafts.proxyDriver ||
// data.defaultProxyDriver`, so it tracks the unsaved selection per
// FR-006/FR-007's acceptance scenario 5), not looked up against a separate
// default here. A driver that manages no proxy (only "No proxy" today) hides
// every driver-dependent field. A managed driver with a config file shows the
// config path field with its defaultConfigPath as the placeholder and help
// text naming that default (plus its configPathNote, if any); a managed
// driver with no config file at all (defaultConfigPath: null -- issue #31,
// e.g. a REST-managed driver like Nginx Proxy Manager) hides it, since there
// is no file for the field to override. Either way the status page field
// shows only when the driver suggests a status page path. An id with no
// matching entry in `drivers` at all (never reachable through the dropdown
// itself, but defensive against a stale selection) hides everything, same as
// FR-006's "unknown means nothing to show". Hiding is display-only (R6):
// callers must not clear the field's draft/stored value just because it
// stopped being shown (FR-008).
export interface ProxyFieldView {
  showConfigPath: boolean;
  configPathPlaceholder?: string;
  configPathHelp?: string;
  showStatusPagePath: boolean;
  statusPagePlaceholder?: string;
  // Issue #72: the TLS source the page shows -- the drafted/stored tlsSource,
  // else the selected driver's defaultTlsSource. Absent for an unmanaged or
  // unknown driver.
  shownTlsSource?: string;
  // TLS source dropdown: shown for every managed driver.
  showTlsSourceField: boolean;
  // ACME DNS provider dropdown: shown while the shown source is 'acme-dns'.
  showAcmeDnsProviderField: boolean;
  // Proxy TLS certificate/key: shown while the shown source is 'files' --
  // the only source that reads proxyTlsCertificate/proxyTlsKey.
  showTlsFields: boolean;
  // Proxy cert resolver (issue #35): shown only for a driver whose metadata
  // says it reads proxyCertResolver (usesCertResolver -- Traefik today) while
  // the shown source is an ACME one ('acme-dns'/'acme-http'), the only sources
  // that use a resolver. Proxy API URL (usesApiUrl) and the Nginx Proxy
  // Manager fields (usesNpmApi, issue #73) follow driver metadata alone --
  // never an id comparison.
  showCertResolverField: boolean;
  showApiUrlField: boolean;
  showNpmApiFields: boolean;
  // The TLS source dropdown's options (tlsSourceOptions); empty when the
  // field is hidden.
  tlsSourceOptions: Array<{ value: string; label: string }>;
  // Shown under the TLS source field when the shown source is not in the
  // selected driver's tlsSources; null otherwise.
  tlsSourceWarning: string | null;
}

// `tlsSource` is the drafted-or-stored value (`drafts.tlsSource ||
// data.settings.tlsSource`), undefined/empty when neither is set -- the
// driver default is resolved here, since it depends on the selected driver.
// Required rather than optional (as with issue #51's final review F9): a
// caller that forgot the unsaved value would quietly show the wrong fields.
export function proxyFieldView(
  selectedId: string,
  drivers: ProxyDriverInfo[],
  tlsSource: string | undefined,
): ProxyFieldView {
  const driver = drivers.find((d) => d.id === selectedId);
  if (!driver || !driver.managesProxy) {
    return {
      showConfigPath: false,
      showStatusPagePath: false,
      showTlsSourceField: false,
      showAcmeDnsProviderField: false,
      showTlsFields: false,
      showCertResolverField: false,
      showApiUrlField: false,
      showNpmApiFields: false,
      tlsSourceOptions: [],
      tlsSourceWarning: null,
    };
  }
  const shownTlsSource = tlsSource || driver.defaultTlsSource;
  const shared = {
    showStatusPagePath: driver.suggestedStatusPagePath !== null,
    statusPagePlaceholder: driver.suggestedStatusPagePath ?? undefined,
    shownTlsSource,
    showTlsSourceField: true,
    showAcmeDnsProviderField: shownTlsSource === 'acme-dns',
    showTlsFields: shownTlsSource === 'files',
    showCertResolverField:
      driver.usesCertResolver && (shownTlsSource === 'acme-dns' || shownTlsSource === 'acme-http'),
    showApiUrlField: driver.usesApiUrl,
    showNpmApiFields: driver.usesNpmApi,
    tlsSourceOptions: tlsSourceOptions(driver, shownTlsSource),
    tlsSourceWarning: driver.tlsSources.includes(shownTlsSource)
      ? null
      : `The ${driver.label} driver does not support '${shownTlsSource}'. It supports: ${driver.tlsSources.join(', ')}.`,
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

// Issue #64: the Settings page groups every setting by integration, one
// tab each, in this order (FR-014). Each secret sits in the same tab as
// the integration settings it is used with. Issue #73 dropped the Nginx
// Proxy Manager tab -- its three fields now sit at the end of the Proxy
// tab instead, shown only while that driver is selected (proxyFieldView's
// showNpmApiFields).
export type SettingsTab = 'general' | 'proxy' | 'authentik' | 'weblogin' | 'cloudflare' | 'github' | 'mcp';

export const SETTINGS_TABS: ReadonlyArray<{ id: SettingsTab; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'proxy', label: 'Proxy' },
  { id: 'authentik', label: 'Authentik' },
  // #85: the custom OIDC web login values, for installs Bellhop does not manage in Proxmox.
  { id: 'weblogin', label: 'Web login' },
  { id: 'cloudflare', label: 'Cloudflare' },
  { id: 'github', label: 'GitHub' },
  // #65/#66: the HTTP MCP endpoint's API key.
  { id: 'mcp', label: 'MCP' },
];

// Every field the page can show: each stored non-secret setting plus each
// secret (status-only).
export type SettingsFieldKey = keyof SettingsValues | SecretSettingKey;

// Field order within a tab is display order. The Proxy tab keeps the
// driver-dependent fields together so proxyFieldView's show/hide rules
// apply inside it unchanged.
const TAB_FIELDS: Record<SettingsTab, readonly SettingsFieldKey[]> = {
  general: [
    'nfsServer',
    'backupStorage',
    'dnsServer',
    'customScriptsRepo',
    'customScriptsBranch',
    'pveUserRealm',
    'pveCreatorRole',
    'webUiAuthMode',
  ],
  proxy: [
    'proxyDriver',
    'proxyConfigPath',
    'statusPagePath',
    // issue #72: the TLS source and its ACME DNS provider, shown by
    // proxyFieldView (showTlsSourceField/showAcmeDnsProviderField).
    'tlsSource',
    'acmeDnsProvider',
    'proxyTlsCertificate',
    'proxyTlsKey',
    'proxyCertResolver',
    'proxyApiUrl',
    // issue #73: the Nginx Proxy Manager fields, moved off their own tab
    // and onto the end of this one.
    'npmApiUrl',
    'npmApiEmail',
    'npmApiPassword',
  ],
  // #69/#85: custom values for installs not managed by Bellhop in Proxmox.
  weblogin: ['webUiOidcIssuer', 'webUiOidcClientId', 'webUiOidcRedirectUri', 'webUiOidcClientSecret'],
  authentik: [
    'authentikApiUrl',
    'authentikApiToken',
    'authentikAdminGroup',
    'authentikBuiltinAdminGroup',
    'authentikGroupLadder',
    'authentikOutpostName',
    'authentikOutpostPort',
    'authentikAuthorizationFlowSlug',
    'authentikInvalidationFlowSlug',
    'authentikOidcSigningKeyName',
  ],
  cloudflare: ['cloudflareDnsApiToken'],
  github: ['githubApiToken'],
  mcp: ['mcpApiKey'],
};

export function fieldsForTab(tab: SettingsTab): readonly SettingsFieldKey[] {
  return TAB_FIELDS[tab];
}

const SECRET_KEYS: readonly SecretSettingKey[] = ['authentikApiToken', 'cloudflareDnsApiToken', 'npmApiPassword', 'githubApiToken', 'webUiOidcClientSecret', 'mcpApiKey'];

// #66: the MCP API key's Generate button. Made here in the browser, so the
// server never has to send a secret back: 32 random bytes, base64url
// without padding (43 characters, over the server's 32-character minimum).
export function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function isSecretField(key: SettingsFieldKey): key is SecretSettingKey {
  return (SECRET_KEYS as readonly string[]).includes(key);
}

// Whether a field can be edited here, or is pinned by an environment
// variable and so shown read-only, labelled with that variable (FR-015).
// `value` is the pinned effective value -- present for a non-secret only,
// since the API never returns a secret's value. `stored`/`storedValue`
// describe the store's own copy underneath the pin (storedValue again for a
// non-secret only).
export type EnvPinnedState = {
  kind: 'env-pinned';
  variable: string;
  value?: string;
  stored: boolean;
  storedValue?: string;
};
export type FieldState = EnvPinnedState | { kind: 'editable' };

export function fieldState(key: SettingsFieldKey, data: Pick<SettingsResponse, 'environment'>): FieldState {
  const pin = data.environment[key];
  if (!pin) return { kind: 'editable' };
  const state: EnvPinnedState = { kind: 'env-pinned', variable: pin.variable, stored: pin.stored };
  if (pin.value !== undefined) state.value = pin.value;
  if (pin.storedValue !== undefined) state.storedValue = pin.storedValue;
  return state;
}

// The line under a pinned field saying whether the store holds its own
// copy -- what an operator checks before deleting the data/*.env file that
// pins it, since the stored copy is what takes over once the file is gone
// and the service restarts. A secret's copy is only ever "set".
export function storedCopyText(state: EnvPinnedState): string {
  if (!state.stored) return 'Stored copy: not set';
  return state.storedValue === undefined ? 'Stored copy: set' : `Stored copy: ${state.storedValue}`;
}

// The auth mode actually in force: the environment's value when pinned,
// else the stored one, else the server's own default, none (#69).
export function effectiveWebUiAuthMode(data: Pick<SettingsResponse, 'settings' | 'environment'>): string {
  return data.environment.webUiAuthMode?.value ?? data.settings.webUiAuthMode ?? 'none';
}

const ADMIN_GROUP_KEYS: readonly SettingsFieldKey[] = ['authentikAdminGroup', 'authentikBuiltinAdminGroup'];

// Whether saving `next` over `current` needs a confirmation first (FR-023):
// any change to either admin-group field (a clear included, since that
// falls back to the default group), and a webUiAuthMode change that leaves
// oidc. `current` is the stored value for the admin groups and the
// effective mode (effectiveWebUiAuthMode) for webUiAuthMode; `next` is
// null for a clear.
export function needsConfirmation(
  key: SettingsFieldKey,
  current: string | undefined,
  next: string | null | undefined,
): boolean {
  if (ADMIN_GROUP_KEYS.includes(key)) return (current ?? '') !== (next ?? '');
  if (key === 'webUiAuthMode') return current === 'oidc' && (next || 'none') !== current;
  return false;
}

// The confirmation dialog's text for a guarded field.
export function confirmationMessage(key: SettingsFieldKey): string {
  if (key === 'webUiAuthMode') {
    return 'Leaving oidc means the web UI will be reachable without signing in: every request is served as the local operator. Save anyway?';
  }
  return 'This changes who counts as an administrator in Bellhop. Saving is refused if it would remove your own administrator access. Save anyway?';
}

// A secret's status line: whether it has an effective value and where that
// comes from -- never the value itself (FR-009/FR-010). `variable` names
// the pinning environment variable when the source is the environment.
export function secretStatusText(status: SecretStatus, variable?: string): string {
  if (!status.set) return 'Not set';
  if (status.source === 'environment') return `Set -- set by environment ${variable ?? 'variable'}`;
  return 'Set -- from settings';
}

// Folds a PATCH response into the page's current state for the one key
// that save targeted. Each field's Save/Clear only disables itself, so two
// saves can resolve out of request order; taking the whole response would
// visually revert a field that was in fact saved. `derived` does not depend
// on which key changed, so it is taken from every response, as is `webLogin` (#85), which
// depends on the guest flag and all four custom values, not on one key.
export function mergeSettingsResponse(prev: SettingsResponse, res: SettingsResponse, key: SettingsFieldKey): SettingsResponse {
  const environment = { ...prev.environment };
  const pin = res.environment[key];
  if (pin) environment[key] = pin;
  else delete environment[key];
  if (isSecretField(key)) {
    return { ...prev, environment, secrets: { ...prev.secrets, [key]: res.secrets[key] }, derived: res.derived, webLogin: res.webLogin };
  }
  return {
    ...prev,
    settings: { ...prev.settings, [key]: res.settings[key] },
    sources: { ...prev.sources, [key]: res.sources[key] },
    environment,
    derived: res.derived,
    webLogin: res.webLogin,
  };
}

// The Web login tab's line saying which source signs people in (#85). Fixed
// text assembled from the server's status; the status carries no secret.
export function webLoginSummary(status: WebLoginStatus): string {
  if (status.source === 'custom') return 'Custom values are in effect: the settings below sign people in.';
  if (status.source === 'managed') {
    return `Managed by ${status.entry}: people sign in through that guest's OpenID client (${status.redirectUri}). Setting all four values below overrides it.`;
  }
  if (status.invalid) return `Not configured. ${status.invalid}.`;
  const missing = status.missing.join(', ');
  if (status.managedProblem) {
    return `Not configured. Bellhop's own guest cannot be used: ${status.managedProblem}. Or set the missing custom values: ${missing}.`;
  }
  return `Not configured. Flag Bellhop's own guest, or set the missing custom values: ${missing}.`;
}
