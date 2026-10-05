// Framework-free (no React/DOM imports) so it compiles under the root
// NodeNext config and is testable with plain node --test, same rationale as
// admin-nav.ts/whoami-store.ts. Text for the Settings page's derived-values
// section: a fresh inventory with no `proxy: true` entry and no host
// `midScheme` should read as an explained empty state, never a bare "none"
// or nothing at all -- see contracts/ui-and-messages.md ("Settings page
// text").

import type {
  SettingsResponse,
  SettingsValues,
  ProxyDriverInfo,
  SecretSettingKey,
  SecretStatus,
} from '../api/types.ts';

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

// The Settings page's Caddy TLS <select> options (issue #51), same
// "only the default mode gets ' (default)'" convention as
// proxyDriverOptions above -- `modes` is the server's own caddyTlsModes
// list (its order), `defaultMode` its defaultCaddyTls.
export function caddyTlsOptions(modes: string[], defaultMode: string): Array<{ value: string; label: string }> {
  return modes.map((mode) => ({
    value: mode,
    label: mode === defaultMode ? `${mode} (default)` : mode,
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
  // Proxy TLS certificate/key: shown for a managed driver whose metadata
  // says it serves the shared certificate those settings name
  // (usesSharedCertificate, nginx -- issue #30), or for a driver whose
  // metadata says it reads proxyCaddyTls (usesCaddyTls, the two Caddy
  // drivers -- issue #51) while its *shown* Caddy TLS mode is 'files' --
  // never an id comparison here.
  showTlsFields: boolean;
  // Caddy TLS dropdown (issue #51): shown only for a driver whose metadata
  // says it reads proxyCaddyTls (usesCaddyTls) -- independent of which mode
  // is currently shown, unlike showTlsFields above.
  showCaddyTlsField: boolean;
  // Proxy cert resolver/API URL (issue #35): shown only for a managed
  // driver whose metadata says it reads proxyCertResolver/proxyApiUrl
  // (usesCertResolver/usesApiUrl) -- Traefik today, same "metadata, never
  // an id comparison" rule as showTlsFields above.
  showCertResolverField: boolean;
  showApiUrlField: boolean;
  // Nginx Proxy Manager API URL/email/password (issue #73): shown only for
  // a managed driver whose metadata says it reads them (usesNpmApi) --
  // the Nginx Proxy Manager driver today, same "metadata, never an id
  // comparison" rule as showTlsFields/showCertResolverField above.
  showNpmApiFields: boolean;
}

// `caddyTls` is the shown (possibly unsaved) Caddy TLS value -- resolved by
// the caller the same way `selectedId` already is
// (`drafts.proxyCaddyTls || data.defaultCaddyTls`). Required rather than
// defaulted (final review F9): a silent default here would let a caller
// forget the unsaved Caddy TLS value and quietly hide the certificate
// fields while 'files' is selected.
export function proxyFieldView(
  selectedId: string,
  drivers: ProxyDriverInfo[],
  caddyTls: string,
): ProxyFieldView {
  const driver = drivers.find((d) => d.id === selectedId);
  if (!driver || !driver.managesProxy) {
    return {
      showConfigPath: false,
      showStatusPagePath: false,
      showTlsFields: false,
      showCaddyTlsField: false,
      showCertResolverField: false,
      showApiUrlField: false,
      showNpmApiFields: false,
    };
  }
  const shared = {
    showStatusPagePath: driver.suggestedStatusPagePath !== null,
    statusPagePlaceholder: driver.suggestedStatusPagePath ?? undefined,
    showTlsFields: driver.usesSharedCertificate || (driver.usesCaddyTls && caddyTls === 'files'),
    showCaddyTlsField: driver.usesCaddyTls,
    showCertResolverField: driver.usesCertResolver,
    showApiUrlField: driver.usesApiUrl,
    showNpmApiFields: driver.usesNpmApi,
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
export type SettingsTab = 'general' | 'proxy' | 'authentik' | 'cloudflare' | 'github';

export const SETTINGS_TABS: ReadonlyArray<{ id: SettingsTab; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'proxy', label: 'Proxy' },
  { id: 'authentik', label: 'Authentik' },
  { id: 'cloudflare', label: 'Cloudflare' },
  { id: 'github', label: 'GitHub' },
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
    // #69: Bellhop's own OIDC web login, beside the mode it feeds.
    'webUiOidcIssuer',
    'webUiOidcClientId',
    'webUiOidcRedirectUri',
    'webUiOidcClientSecret',
  ],
  proxy: [
    'proxyDriver',
    'proxyConfigPath',
    'statusPagePath',
    'proxyCaddyTls',
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
};

export function fieldsForTab(tab: SettingsTab): readonly SettingsFieldKey[] {
  return TAB_FIELDS[tab];
}

const SECRET_KEYS: readonly SecretSettingKey[] = ['authentikApiToken', 'cloudflareDnsApiToken', 'npmApiPassword', 'githubApiToken', 'webUiOidcClientSecret'];

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
// else the stored one, else the server's own default, auto.
export function effectiveWebUiAuthMode(data: Pick<SettingsResponse, 'settings' | 'environment'>): string {
  return data.environment.webUiAuthMode?.value ?? data.settings.webUiAuthMode ?? 'auto';
}

const ADMIN_GROUP_KEYS: readonly SettingsFieldKey[] = ['authentikAdminGroup', 'authentikBuiltinAdminGroup'];

// Whether saving `next` over `current` needs a confirmation first (FR-023):
// any change to either admin-group field (a clear included, since that
// falls back to the default group), and a webUiAuthMode change that leaves
// authentik. `current` is the stored value for the admin groups and the
// effective mode (effectiveWebUiAuthMode) for webUiAuthMode; `next` is
// null for a clear.
export function needsConfirmation(
  key: SettingsFieldKey,
  current: string | undefined,
  next: string | null | undefined,
): boolean {
  if (ADMIN_GROUP_KEYS.includes(key)) return (current ?? '') !== (next ?? '');
  if (key === 'webUiAuthMode') return (current === 'authentik' || current === 'oidc') && (next || 'auto') !== current;
  return false;
}

// The confirmation dialog's text for a guarded field.
export function confirmationMessage(key: SettingsFieldKey): string {
  if (key === 'webUiAuthMode') {
    return 'Leaving authentik means the web UI will be reachable without signing in through Authentik: requests without forward-auth headers are served as the local operator (auto) or every request is (none). Save anyway?';
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
// on which key changed, so it is taken from every response.
export function mergeSettingsResponse(prev: SettingsResponse, res: SettingsResponse, key: SettingsFieldKey): SettingsResponse {
  const environment = { ...prev.environment };
  const pin = res.environment[key];
  if (pin) environment[key] = pin;
  else delete environment[key];
  if (isSecretField(key)) {
    return { ...prev, environment, secrets: { ...prev.secrets, [key]: res.secrets[key] }, derived: res.derived };
  }
  return {
    ...prev,
    settings: { ...prev.settings, [key]: res.settings[key] },
    sources: { ...prev.sources, [key]: res.sources[key] },
    environment,
    derived: res.derived,
  };
}
