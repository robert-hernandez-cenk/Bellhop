import { useEffect, useState } from 'react';
import { apiGet, apiPatch } from '../api/client';
import type { SecretSettingKey, SettingsResponse, SettingsValues } from '../api/types';
import { PageDescription } from '../components/PageDescription';
import { ConfirmDeleteModal } from '../components/ConfirmDeleteModal';
import {
  proxyHostText,
  LAN_GATEWAYS_EMPTY_TEXT,
  proxyDriverOptions,
  proxyFieldView,
  caddyTlsOptions,
  SETTINGS_TABS,
  fieldsForTab,
  fieldState,
  isSecretField,
  effectiveWebUiAuthMode,
  needsConfirmation,
  confirmationMessage,
  secretStatusText,
  storedCopyText,
  mergeSettingsResponse,
  type SettingsFieldKey,
  type SettingsTab,
  type FieldState,
} from '../lib/settings-display';

type SettingKey = keyof SettingsValues;

// Each field names what breaks while it is unset, so the page explains its
// own consequences rather than assuming the reader knows which command
// consumes which value. `placeholder` is unused for the <select> fields
// (`proxyDriver`/`proxyCaddyTls`, issue #33/#51; `webUiAuthMode`, issue #64)
// and for secrets, whose masked input never shows an example -- kept
// optional rather than adding a second, near-identical field-def shape.
// A Record over every key, so a setting with no label/help fails to compile.
const FIELDS: Record<SettingsFieldKey, { label: string; placeholder?: string; help: string }> = {
  nfsServer: {
    label: 'NFS server',
    placeholder: '10.0.0.5',
    help: 'Address of the NAS whose exports guests mount. Unset: sync-inventory skips NFS mount discovery and migrate-nfs-mount is unavailable.',
  },
  backupStorage: {
    label: 'Backup storage',
    placeholder: 'nas-proxmox',
    help: 'Cluster-shared NFS storage that migrate-guest stages backups through. Unset: migrate-guest requires an explicit Backup Storage each run.',
  },
  dnsServer: {
    label: 'LAN DNS server',
    placeholder: '10.0.0.53',
    help: 'Resolver that keeps internal names working from inside a VPN-routed guest. Unset: set-guest-vpn is unavailable.',
  },
  statusPagePath: {
    label: 'Status page path',
    placeholder: '/usr/share/caddy/index.html',
    help: 'Absolute path on the proxy host where the status page is written. Unset: the status page is never rendered.',
  },
  proxyDriver: {
    label: 'Proxy driver',
    help: "Which reverse proxy Bellhop manages. \"No proxy\" means Bellhop writes no proxy configuration: sync-proxy does nothing and the status page is not rendered. Forward-auth entries are still allowed, on the assumption that your own proxy enforces them. When unset, Caddy is the default.",
  },
  proxyConfigPath: {
    label: 'Proxy config path',
    placeholder: '/etc/caddy/Caddyfile',
    help: "Overrides the active driver's own default config path. Unset: that default.",
  },
  proxyCaddyTls: {
    label: 'Caddy TLS',
    help:
      "How the Caddy drivers obtain a certificate for each site. cloudflare: DNS-01 through Cloudflare, needs a Caddy build with caddy-dns/cloudflare. letsencrypt: Caddy's automatic HTTPS over a public HTTP/TLS-ALPN challenge, needs ports 80/443 reachable from the internet. internal: Caddy's own internal CA -- self-signed, trust its root certificate on your clients. files: the shared certificate/key pair named by the Proxy TLS certificate/key fields below. Unset: cloudflare.",
  },
  proxyTlsCertificate: {
    label: 'Proxy TLS certificate',
    placeholder: '/etc/letsencrypt/live/example.com/fullchain.pem',
    help: "Absolute path on the proxy host to the TLS certificate the nginx driver serves for every site, or a Caddy driver in 'files' Caddy TLS mode. Unset: certbot's own path for the inventory domain.",
  },
  proxyTlsKey: {
    label: 'Proxy TLS key',
    placeholder: '/etc/letsencrypt/live/example.com/privkey.pem',
    help: "Absolute path on the proxy host to the TLS private key the nginx driver serves for every site, or a Caddy driver in 'files' Caddy TLS mode. Unset: certbot's own path for the inventory domain.",
  },
  proxyCertResolver: {
    label: 'Proxy cert resolver',
    placeholder: 'cloudflare',
    help: "The Traefik certificate resolver every Bellhop router names, defined in Traefik's own static configuration. Unset: cloudflare. The reserved value none gives routers TLS with no resolver, so certificates come from Traefik's file provider or its default certificate.",
  },
  proxyApiUrl: {
    label: 'Proxy API URL',
    placeholder: 'http://127.0.0.1:8080',
    help: "Traefik's API as reachable from the proxy host. When set, every apply waits for Traefik to load the file and checks Bellhop's routers, restoring the previous file on failure. Unset: no check.",
  },
  customScriptsRepo: {
    label: 'Custom script repository',
    placeholder: 'owner/repo',
    help: 'Public GitHub repository laid out like ProxmoxVED (e.g. a fork branch) that Install App/Update App resolve apps from before falling back to the upstream community-scripts repos. Apps found there override any upstream copy of the same slug. Must be set together with Custom script branch below -- unset either one and the feature is off.',
  },
  customScriptsBranch: {
    label: 'Custom script branch',
    placeholder: 'branch',
    help: 'Branch on that repository to resolve apps from. Must be set together with Custom script repository above.',
  },
  pveUserRealm: {
    label: 'Proxmox realm',
    placeholder: 'authentik',
    help: 'OpenID realm in Proxmox whose users get access to VMs they create from the web UI. Its username claim must be username or email. Unset: no access is granted.',
  },
  pveCreatorRole: {
    label: 'VM creator role',
    placeholder: 'PVEVMAdmin',
    help: 'Proxmox role granted on a VM to the person who created it from the web UI. Unset: PVEVMAdmin.',
  },
  webUiAuthMode: {
    label: 'Web UI sign-in',
    help: "How the web UI decides who is signed in. auto: use Authentik's forward-auth headers when a request has them, otherwise serve it as the local administrator. authentik: require the forward-auth headers and reject every request without them -- saving this is refused from a session that did not come through Authentik, since every later request would be rejected. none: ignore the headers; every request is the local administrator. If a wrong value locks you out, set WEB_UI_AUTH_MODE in the service environment or run bellhop set-config webUiAuthMode auto --apply on the server. Unset: auto.",
  },
  authentikApiUrl: {
    label: 'Authentik API URL',
    placeholder: 'https://auth.example.com',
    help: "Base address of your Authentik instance, used with the API token below for the Users and Permissions pages, sync-authentik and OIDC clients. Unset: the Authentik integration is off -- user management and sync-authentik are unavailable.",
  },
  authentikApiToken: {
    label: 'Authentik API token',
    help: "API token Bellhop uses for Authentik's REST API, together with the API URL above. Write-only: it is never shown again once saved. Unset: the Authentik integration is off.",
  },
  authentikAdminGroup: {
    label: 'Admin group',
    placeholder: 'bellhop-admins',
    help: "Authentik group whose members are Bellhop administrators (Settings, Users, Permissions and fleet-wide actions). Saving is refused if it would remove your own administrator access. Unset: bellhop-admins.",
  },
  authentikBuiltinAdminGroup: {
    label: 'Built-in admin group',
    placeholder: 'authentik Admins',
    help: "Authentik's own administrator group, also treated as Bellhop administrators so there is always a way in. Saving is refused if it would remove your own administrator access. Unset: authentik Admins.",
  },
  authentikGroupLadder: {
    label: 'Group ladder',
    placeholder: 'bellhop-app-users-open,bellhop-app-users,bellhop-users,authentik Admins',
    help: "Comma-separated Authentik groups, lowest tier first, that a gated entry's auth group picks from; sync-authentik binds each app to its tier and every tier above it. Unset: bellhop-app-users-open,bellhop-app-users,bellhop-users,authentik Admins.",
  },
  authentikOutpostName: {
    label: 'Outpost name',
    placeholder: 'authentik Embedded Outpost',
    help: 'The Authentik outpost sync-authentik adds forward-auth providers to. Unset: authentik Embedded Outpost.',
  },
  authentikOutpostPort: {
    label: 'Outpost port',
    placeholder: '9000',
    help: "Port the proxy's forward-auth check reaches the outpost on, at the authentik: true entry's address. Unset: 9000.",
  },
  authentikAuthorizationFlowSlug: {
    label: 'Authorization flow',
    placeholder: 'default-provider-authorization-implicit-consent',
    help: 'Slug of the Authentik flow providers created by sync-authentik use to authorize a sign-in; the mobile consent step is added to this flow. Unset: default-provider-authorization-implicit-consent.',
  },
  authentikInvalidationFlowSlug: {
    label: 'Invalidation flow',
    placeholder: 'default-invalidation-flow',
    help: 'Slug of the Authentik flow providers created by sync-authentik use to sign out. Unset: default-invalidation-flow.',
  },
  authentikOidcSigningKeyName: {
    label: 'OIDC signing key',
    placeholder: 'authentik Self-signed Certificate',
    help: 'Name of the Authentik certificate-keypair OIDC clients sign their tokens with. Unset: authentik Self-signed Certificate.',
  },
  cloudflareDnsApiToken: {
    label: 'Cloudflare DNS API token',
    help: "Cloudflare token (Zone:Read and DNS:Edit) that prune-acme-challenges uses to delete stale _acme-challenge records left by Caddy's Cloudflare DNS-01 issuance. Write-only. Unset: the cleanup is skipped.",
  },
  npmApiUrl: {
    label: 'Nginx Proxy Manager API URL',
    placeholder: 'http://192.0.2.10:81',
    help: "Address of Nginx Proxy Manager's API, used by the Nginx Proxy Manager proxy driver. Unset: port 81 on the proxy: true entry's address.",
  },
  npmApiEmail: {
    label: 'Nginx Proxy Manager email',
    placeholder: 'admin@example.com',
    help: 'Login email of the Nginx Proxy Manager user Bellhop signs in as; also the contact address for certificates it requests. Unset: the Nginx Proxy Manager driver cannot sync.',
  },
  npmApiPassword: {
    label: 'Nginx Proxy Manager password',
    help: 'Password for the Nginx Proxy Manager user above. Write-only. Unset: the Nginx Proxy Manager driver cannot sync.',
  },
  githubApiToken: {
    label: 'GitHub API token',
    help: "Token sent with every GitHub API request -- the daily app update check, the custom script repository's pin and compare, and the Install App catalog -- so they are no longer limited to GitHub's anonymous 60 requests an hour. Write-only. Unset: requests are anonymous.",
  },
};

const WEB_UI_AUTH_MODE_OPTIONS = [
  { value: 'auto', label: 'auto (default)' },
  { value: 'authentik', label: 'authentik' },
  { value: 'none', label: 'none' },
];

// A secret's own row: its status and source, a masked input that is never
// pre-filled and has no reveal control, and Replace/Clear (FR-010). The
// input lives here so a successful save can empty it.
function SecretField({
  settingKey,
  data,
  state,
  saving,
  onSave,
}: {
  settingKey: SecretSettingKey;
  data: SettingsResponse;
  state: FieldState;
  saving: boolean;
  onSave: (value: string | null) => Promise<boolean>;
}) {
  const [value, setValue] = useState('');
  const field = FIELDS[settingKey];
  const status = data.secrets[settingKey];
  const pinned = state.kind === 'env-pinned';
  return (
    <div className="settings-field">
      <label htmlFor={`setting-${settingKey}`}>
        {field.label}{' '}
        {pinned ? (
          <span className="settings-pinned">Set by environment ({state.variable})</span>
        ) : (
          <span className="settings-optional">Optional</span>
        )}
      </label>
      <p className="settings-secret-status">
        {secretStatusText(status, data.environment[settingKey]?.variable)}
      </p>
      {state.kind === 'env-pinned' && <p className="settings-help">{storedCopyText(state)}</p>}
      {!pinned && (
        <input
          id={`setting-${settingKey}`}
          className="field-input"
          type="password"
          autoComplete="new-password"
          value={value}
          placeholder={status.set ? 'Enter a new value to replace it' : 'Enter a value'}
          onChange={(e) => setValue(e.target.value)}
        />
      )}
      <p className="settings-help">{field.help}</p>
      {!pinned && (
        <div className="actions-cell">
          <button
            type="button"
            className="button"
            disabled={saving || value === ''}
            onClick={async () => {
              if (await onSave(value)) setValue('');
            }}
          >
            {saving ? 'Saving...' : status.set ? 'Replace' : 'Save'}
          </button>
          <button
            type="button"
            className="button button-danger"
            disabled={saving || status.source !== 'settings'}
            onClick={() => onSave(null)}
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
}

export function SettingsPage() {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<SettingsFieldKey | null>(null);
  const [loading, setLoading] = useState(true);
  // Component state only: a reload starts back on General.
  const [tab, setTab] = useState<SettingsTab>('general');
  // A guarded save waiting on the confirmation dialog (FR-023).
  const [pending, setPending] = useState<{ key: SettingsFieldKey; value: string | null } | null>(null);

  const applyResponse = (res: SettingsResponse) => {
    setData(res);
    setDrafts(
      Object.fromEntries(
        Object.keys(FIELDS)
          .filter((key) => !isSecretField(key as SettingsFieldKey))
          .map((key) => [key, res.settings[key as SettingKey] ?? '']),
      ),
    );
  };

  const reload = async () => {
    setError(null);
    try {
      applyResponse(await apiGet<SettingsResponse>('/settings'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
  }, []);

  // Resolves true when the server accepted the write, so a secret field can
  // empty its input; a refusal (400/409) lands in the error banner.
  const save = async (key: SettingsFieldKey, value: string | null): Promise<boolean> => {
    setSavingKey(key);
    setError(null);
    try {
      const res = await apiPatch<SettingsResponse>('/settings', { [key]: value });
      // Merge only the field this save targeted (mergeSettingsResponse):
      // two saves started back to back can resolve out of request order.
      setData((prev) => (prev ? mergeSettingsResponse(prev, res, key) : res));
      if (!isSecretField(key)) setDrafts((prev) => ({ ...prev, [key]: res.settings[key] ?? '' }));
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setSavingKey(null);
    }
  };

  // Routes a save through the confirmation dialog when the change is a
  // guarded one; otherwise saves straight away.
  const requestSave = async (key: SettingsFieldKey, value: string | null): Promise<boolean> => {
    if (data && !isSecretField(key)) {
      const current = key === 'webUiAuthMode' ? effectiveWebUiAuthMode(data) : data.settings[key];
      if (needsConfirmation(key, current, value)) {
        setPending({ key, value });
        return false;
      }
    }
    return save(key, value);
  };

  if (loading) return <p>Loading...</p>;

  // issue #33 (US3): which of the driver-dependent fields actually apply,
  // and what they should say, for whichever driver is currently selected in
  // the (possibly unsaved) dropdown -- null while `data` hasn't loaded yet,
  // in which case every field still renders with its static FIELDS text.
  const selectedDriver = drafts.proxyDriver || data?.defaultProxyDriver;
  // issue #51: same resolution rule as selectedDriver above, for whichever
  // Caddy TLS mode is currently shown -- passed to proxyFieldView so
  // showTlsFields can tell a Caddy driver in 'files' mode from one in any
  // other mode.
  const selectedCaddyTls = drafts.proxyCaddyTls || data?.defaultCaddyTls;
  const view =
    data && selectedDriver
      ? proxyFieldView(selectedDriver, data.proxyDrivers, drafts.proxyCaddyTls || data.defaultCaddyTls)
      : null;

  // Hiding a field is display-only: it is simply left out of this list, so
  // its draft/stored value and its Save/Clear behavior are completely
  // untouched (FR-008) -- nothing here ever resets `drafts` or sends a
  // PATCH because of visibility.
  const isVisible = (key: SettingsFieldKey): boolean => {
    if (key === 'proxyConfigPath') return !view || view.showConfigPath;
    if (key === 'statusPagePath') return !view || view.showStatusPagePath;
    // Before `data` loads there is no driver list to consult, and the Caddy
    // TLS dropdown and TLS fields mean something for specific drivers
    // only -- so unlike the two fields above they stay hidden until a view
    // says the selected driver uses them.
    if (key === 'proxyCaddyTls') return view?.showCaddyTlsField ?? false;
    if (key === 'proxyTlsCertificate' || key === 'proxyTlsKey') return view?.showTlsFields ?? false;
    // Same "hidden until loaded" rule as the TLS fields above -- these two
    // mean something for Traefik alone (issue #35).
    if (key === 'proxyCertResolver') return view?.showCertResolverField ?? false;
    if (key === 'proxyApiUrl') return view?.showApiUrlField ?? false;
    return true;
  };

  const visibleFields = fieldsForTab(tab).filter(isVisible);

  const renderInput = (key: SettingKey, placeholder: string | undefined) => {
    if (key === 'proxyDriver') {
      // Always a <select>, never free text: without the driver list (a
      // failed load) it is disabled with no options rather than an input
      // that would accept any string.
      return (
        <select
          id={`setting-${key}`}
          className="field-input"
          value={selectedDriver ?? ''}
          disabled={!data}
          onChange={(e) => setDrafts({ ...drafts, proxyDriver: e.target.value })}
        >
          {data &&
            proxyDriverOptions(data.proxyDrivers, data.defaultProxyDriver).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
        </select>
      );
    }
    if (key === 'proxyCaddyTls') {
      // Same "always a <select>, disabled with no options until loaded"
      // rule as proxyDriver above (issue #51).
      return (
        <select
          id={`setting-${key}`}
          className="field-input"
          value={selectedCaddyTls ?? ''}
          disabled={!data}
          onChange={(e) => setDrafts({ ...drafts, proxyCaddyTls: e.target.value })}
        >
          {data &&
            caddyTlsOptions(data.caddyTlsModes, data.defaultCaddyTls).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
        </select>
      );
    }
    if (key === 'webUiAuthMode') {
      // A fixed list, so it never waits on `data`; an unset value shows as
      // its default, auto.
      return (
        <select
          id={`setting-${key}`}
          className="field-input"
          value={drafts.webUiAuthMode || 'auto'}
          onChange={(e) => setDrafts({ ...drafts, webUiAuthMode: e.target.value })}
        >
          {WEB_UI_AUTH_MODE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      );
    }
    return (
      <input
        id={`setting-${key}`}
        className="field-input"
        type="text"
        value={drafts[key] ?? ''}
        placeholder={placeholder}
        onChange={(e) => setDrafts({ ...drafts, [key]: e.target.value })}
      />
    );
  };

  const renderField = (key: SettingsFieldKey) => {
    const field = FIELDS[key];
    const state: FieldState = data ? fieldState(key, data) : { kind: 'editable' };
    if (isSecretField(key)) {
      if (!data) return null;
      return (
        <SecretField
          key={key}
          settingKey={key}
          data={data}
          state={state}
          saving={savingKey === key}
          onSave={(value) => requestSave(key, value)}
        />
      );
    }
    const placeholder =
      key === 'proxyConfigPath' && view ? view.configPathPlaceholder
      : key === 'statusPagePath' && view ? view.statusPagePlaceholder
      : field.placeholder;
    const help = key === 'proxyConfigPath' && view?.configPathHelp ? view.configPathHelp : field.help;
    if (state.kind === 'env-pinned') {
      // Pinned by an environment variable: the effective value, read-only,
      // with no Save/Clear -- the server would refuse the write (FR-016).
      return (
        <div key={key} className="settings-field">
          <label htmlFor={`setting-${key}`}>
            {field.label} <span className="settings-pinned">Set by environment ({state.variable})</span>
          </label>
          <input id={`setting-${key}`} className="field-input" type="text" value={state.value ?? ''} readOnly />
          <p className="settings-help">{storedCopyText(state)}</p>
          <p className="settings-help">{help}</p>
        </div>
      );
    }
    return (
      <div key={key} className="settings-field">
        <label htmlFor={`setting-${key}`}>
          {field.label} <span className="settings-optional">Optional</span>
        </label>
        {renderInput(key, placeholder)}
        <p className="settings-help">{help}</p>
        <div className="actions-cell">
          <button
            type="button"
            className="button"
            disabled={savingKey === key || ((key === 'proxyDriver' || key === 'proxyCaddyTls') && !data)}
            onClick={() => requestSave(key, drafts[key] === '' ? null : drafts[key])}
          >
            {savingKey === key ? 'Saving...' : 'Save'}
          </button>
          <button
            type="button"
            className="button button-danger"
            disabled={savingKey === key || !data?.settings[key]}
            onClick={() => requestSave(key, null)}
          >
            Clear
          </button>
        </div>
      </div>
    );
  };

  return (
    <div>
      <h2>Settings</h2>
      <PageDescription>
        Settings are grouped by integration, and every one is optional -- each field says what
        happens while it is unset. Secrets (API tokens and passwords) are write-only: the page shows
        only whether one is set and where it comes from, and never shows the value again. A field
        set by an environment variable is read-only here until that variable is removed. The same
        values can be set from the CLI with{' '}
        <code>bellhop set-config &lt;key&gt; &lt;value&gt; --apply</code>, and a secret with{' '}
        <code>bellhop set-config &lt;secret&gt; --stdin --apply</code>. Proxy fields beyond the
        driver only appear when the selected Proxy driver actually uses them.
      </PageDescription>
      {error && <div className="warning-banner">{error}</div>}
      <div className="tab-strip" role="tablist">
        {SETTINGS_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`tab-button${tab === t.id ? ' active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="settings-fields" role="tabpanel">
        {visibleFields.map(renderField)}
      </div>
      {/* The derived values are what the General (set-guest-vpn's LAN
          gateway) and Proxy (the firewall scope) settings resolve against,
          so they show under both of those tabs. */}
      {(tab === 'general' || tab === 'proxy') && (
        <>
          <h3>Derived (read-only)</h3>
          <PageDescription>
            Not configured anywhere -- read from inventory itself. Shown so it is clear what these
            resolve to today.
          </PageDescription>
          <ul>
            {data?.derived.lanGateways.length ? (
              data.derived.lanGateways.map((g) => (
                <li key={g.host}>
                  LAN gateway for <strong>{g.host}</strong>: {g.gateway}
                </li>
              ))
            ) : (
              <li>{LAN_GATEWAYS_EMPTY_TEXT}</li>
            )}
            <li>Proxy IP (firewall scope): {proxyHostText(data?.derived.proxy ?? null)}</li>
          </ul>
        </>
      )}
      {pending && (
        <ConfirmDeleteModal
          message={confirmationMessage(pending.key)}
          confirmLabel="Save"
          confirmClassName="button"
          onConfirm={async () => {
            await save(pending.key, pending.value);
          }}
          onClose={() => setPending(null)}
        />
      )}
    </div>
  );
}
