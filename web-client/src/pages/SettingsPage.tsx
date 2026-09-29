import { useEffect, useState } from 'react';
import { apiGet, apiPatch } from '../api/client';
import type { SettingsResponse, SettingsValues } from '../api/types';
import { PageDescription } from '../components/PageDescription';
import { proxyHostText, LAN_GATEWAYS_EMPTY_TEXT, proxyDriverOptions, proxyFieldView } from '../lib/settings-display';

type SettingKey = keyof SettingsValues;

// Each field names what breaks while it is unset, so the page explains its
// own consequences rather than assuming the reader knows which command
// consumes which value. `placeholder` is unused for `proxyDriver`, which
// renders as a <select> instead of an <input> (issue #33) -- kept optional
// rather than adding a second, near-identical field-def shape.
const FIELDS: Array<{ key: SettingKey; label: string; placeholder?: string; help: string }> = [
  {
    key: 'nfsServer',
    label: 'NFS server',
    placeholder: '10.0.0.5',
    help: 'Address of the NAS whose exports guests mount. Unset: sync-inventory skips NFS mount discovery and migrate-nfs-mount is unavailable.',
  },
  {
    key: 'backupStorage',
    label: 'Backup storage',
    placeholder: 'nas-proxmox',
    help: 'Cluster-shared NFS storage that migrate-guest stages backups through. Unset: migrate-guest requires an explicit Backup Storage each run.',
  },
  {
    key: 'dnsServer',
    label: 'LAN DNS server',
    placeholder: '10.0.0.53',
    help: 'Resolver that keeps internal names working from inside a VPN-routed guest. Unset: set-guest-vpn is unavailable.',
  },
  {
    key: 'statusPagePath',
    label: 'Status page path',
    placeholder: '/usr/share/caddy/index.html',
    help: 'Absolute path on the proxy host where the status page is written. Unset: the status page is never rendered.',
  },
  {
    key: 'proxyDriver',
    label: 'Proxy driver',
    help: "Which reverse proxy Bellhop manages. \"No proxy\" means Bellhop writes no proxy configuration: sync-proxy does nothing and the status page is not rendered. Forward-auth entries are still allowed, on the assumption that your own proxy enforces them. When unset, Caddy is the default.",
  },
  {
    key: 'proxyConfigPath',
    label: 'Proxy config path',
    placeholder: '/etc/caddy/Caddyfile',
    help: "Overrides the active driver's own default config path. Unset: that default.",
  },
  {
    key: 'customScriptsRepo',
    label: 'Custom script repository',
    placeholder: 'owner/repo',
    help: 'Public GitHub repository laid out like ProxmoxVED (e.g. a fork branch) that Install App/Update App resolve apps from before falling back to the upstream community-scripts repos. Apps found there override any upstream copy of the same slug. Must be set together with Custom script branch below -- unset either one and the feature is off.',
  },
  {
    key: 'customScriptsBranch',
    label: 'Custom script branch',
    placeholder: 'branch',
    help: 'Branch on that repository to resolve apps from. Must be set together with Custom script repository above.',
  },
];

export function SettingsPage() {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<SettingKey | null>(null);
  const [loading, setLoading] = useState(true);

  const applyResponse = (res: SettingsResponse) => {
    setData(res);
    setDrafts(Object.fromEntries(FIELDS.map((f) => [f.key, res.settings[f.key] ?? ''])));
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

  const save = async (key: SettingKey, value: string | null) => {
    setSavingKey(key);
    setError(null);
    try {
      const res = await apiPatch<SettingsResponse>('/settings', { [key]: value });
      // Merge only the field this save targeted, rather than replacing the
      // whole data/drafts state wholesale -- two saves started back to back
      // (each field's own Save button only disables itself) can resolve out
      // of request order, and applying a whole response by arrival order
      // could visually revert a field that was in fact saved correctly.
      // `derived` is unaffected by which settings key changed, so it's safe
      // to take from every response.
      setData((prev) => (prev ? { ...prev, settings: { ...prev.settings, [key]: res.settings[key] }, derived: res.derived } : res));
      setDrafts((prev) => ({ ...prev, [key]: res.settings[key] ?? '' }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingKey(null);
    }
  };

  if (loading) return <p>Loading...</p>;

  // issue #33 (US3): which of the two driver-dependent fields actually
  // apply, and what they should say, for whichever driver is currently
  // selected in the (possibly unsaved) dropdown -- null while `data` hasn't
  // loaded yet, in which case every field still renders with its static
  // FIELDS text, same as before this feature existed.
  const view = data ? proxyFieldView(drafts.proxyDriver || data.defaultProxyDriver, data.proxyDrivers) : null;

  // Hiding a field is display-only: it is simply left out of this list, so
  // its draft/stored value and its Save/Clear behavior are completely
  // untouched (FR-008) -- nothing here ever resets `drafts` or sends a
  // PATCH because of visibility.
  const visibleFields = FIELDS.filter((field) => {
    if (field.key === 'proxyConfigPath') return !view || view.showConfigPath;
    if (field.key === 'statusPagePath') return !view || view.showStatusPagePath;
    return true;
  });

  return (
    <div>
      <h2>Settings</h2>
      <PageDescription>
        Inventory-wide values a few commands read. Every one of them is optional -- each field
        below says what happens while it is unset. The same values can be set from the CLI with{' '}
        <code>bellhop set-config &lt;key&gt; &lt;value&gt; --apply</code>. Proxy config path and
        Status page path only appear when the selected Proxy driver actually uses them.
      </PageDescription>
      {error && <div className="warning-banner">{error}</div>}
      <div className="settings-fields">
        {visibleFields.map((field) => {
          const placeholder =
            field.key === 'proxyConfigPath' && view ? view.configPathPlaceholder
            : field.key === 'statusPagePath' && view ? view.statusPagePlaceholder
            : field.placeholder;
          const help = field.key === 'proxyConfigPath' && view?.configPathHelp ? view.configPathHelp : field.help;
          return (
            <div key={field.key} className="settings-field">
              <label htmlFor={`setting-${field.key}`}>
                {field.label} <span className="settings-optional">Optional</span>
              </label>
              {field.key === 'proxyDriver' && data ? (
                <select
                  id={`setting-${field.key}`}
                  className="field-input"
                  value={drafts.proxyDriver || data.defaultProxyDriver}
                  onChange={(e) => setDrafts({ ...drafts, proxyDriver: e.target.value })}
                >
                  {proxyDriverOptions(data.proxyDrivers, data.defaultProxyDriver).map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={`setting-${field.key}`}
                  className="field-input"
                  type="text"
                  value={drafts[field.key] ?? ''}
                  placeholder={placeholder}
                  onChange={(e) => setDrafts({ ...drafts, [field.key]: e.target.value })}
                />
              )}
              <p className="settings-help">{help}</p>
              <div className="actions-cell">
                <button
                  type="button"
                  className="button"
                  disabled={savingKey === field.key}
                  onClick={() => save(field.key, drafts[field.key] === '' ? null : drafts[field.key])}
                >
                  {savingKey === field.key ? 'Saving...' : 'Save'}
                </button>
                <button
                  type="button"
                  className="button button-danger"
                  disabled={savingKey === field.key || !data?.settings[field.key]}
                  onClick={() => save(field.key, null)}
                >
                  Clear
                </button>
              </div>
            </div>
          );
        })}
      </div>
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
    </div>
  );
}
